/**
 * @file blind-review.js
 * @description Optional "blind reviewer" step of a verification ("Verified"). After the tests
 * (and the visual check, when configured) pass, a separate headless `claude -p` run gets ONLY:
 *   - the owner's own requests, taken from the session transcript (human prompts only — no
 *     assistant text, no tool output, so the agent's claims never reach the reviewer), and
 *   - the clean copy of the commit as its working folder,
 * with read-only tools (Read, Grep, Glob), hooks disabled and no session persistence. It answers
 * per request (done / partial / missing / n/a) with evidence, plus an overall SHIP /
 * SHIP_WITH_FIXES / DONT_SHIP verdict as structured JSON (`--json-schema`). The verdict is taken
 * from that JSON; a reviewer that cannot run (not logged in, timeout, bad output) is reported as
 * an error and never turns a passing test run into a failure.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const fs = require("fs");
const readline = require("readline");
const crossSpawn = require("cross-spawn");

const MAX_REQUEST_CHARS = 2000;
const MAX_TOTAL_CHARS = 12000;
const MAX_REQUESTS = 30;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_LINE = 1024 * 1024;

// Lines the CLI writes into the user role that a human did not type.
const SYNTHETIC_RE =
  /^(<command-|<local-command|<system-reminder|<task-notification|<user-prompt-submit-hook|Caveat: The messages below|\[Request interrupted|This session is being continued from a previous conversation)/;

const SCHEMA = {
  type: "object",
  properties: {
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          request: { type: "string" },
          status: { type: "string", enum: ["done", "partial", "missing", "n/a"] },
          evidence: { type: "string" },
        },
        required: ["request", "status", "evidence"],
      },
    },
    verdict: { type: "string", enum: ["SHIP", "SHIP_WITH_FIXES", "DONT_SHIP"] },
    summary: { type: "string" },
  },
  required: ["requirements", "verdict", "summary"],
};

/** Human-typed text of one transcript entry, or null. */
function humanText(entry) {
  if (!entry || entry.type !== "user" || entry.isMeta || entry.isSidechain) return null;
  if (entry.isCompactSummary || entry.toolUseResult !== undefined) return null;
  const msg = entry.message;
  if (!msg || msg.role !== "user") return null;
  let text = null;
  if (typeof msg.content === "string") text = msg.content;
  else if (Array.isArray(msg.content)) {
    if (msg.content.some((b) => b && b.type === "tool_result")) return null;
    text = msg.content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  if (typeof text !== "string") return null;
  text = text.trim();
  if (!text || SYNTHETIC_RE.test(text)) return null;
  return text.length > MAX_REQUEST_CHARS ? `${text.slice(0, MAX_REQUEST_CHARS)}…` : text;
}

/**
 * The owner's requests in a Claude Code transcript (JSONL), oldest first, newest kept when the
 * total is too long.
 * @param {string|null|undefined} transcriptPath
 * @returns {Promise<string[]>}
 */
async function collectRequests(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const all = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(transcriptPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    // Cheap pre-filter: only user lines can hold a request.
    if (line.length > MAX_TRANSCRIPT_LINE || !line.includes('"user"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const t = humanText(entry);
    if (t && all[all.length - 1] !== t) all.push(t);
  }
  const kept = [];
  let total = 0;
  for (let i = all.length - 1; i >= 0 && kept.length < MAX_REQUESTS; i--) {
    if (total + all[i].length > MAX_TOTAL_CHARS && kept.length) break;
    kept.unshift(all[i]);
    total += all[i].length;
  }
  return kept;
}

/** The reviewer's instructions. */
function buildPrompt({ requests, commit, testsCount }) {
  const list = requests.map((r, i) => `${i + 1}. ${r.replace(/\n/g, "\n   ")}`).join("\n");
  return [
    "You are an independent, blind code reviewer. You did not write this code and you have not seen",
    "the conversation in which it was written — only the owner's own requests below. The current",
    `folder is a clean copy of the project at commit ${commit || "(unknown)"}. The project's tests`,
    `already passed${testsCount != null ? ` (${testsCount} tests)` : ""}.`,
    "",
    "For each request decide whether the code in this folder actually does it. Read the code itself;",
    "do not trust comments, docs, commit messages, TODO notes or claims that something was done.",
    "Requests may be in Hebrew. A request that is a question, a thank-you, an instruction about how",
    "to work, or about something outside this project is 'n/a'. Keep evidence short and concrete",
    "(file:line or what is missing), in English.",
    "",
    "Overall verdict: SHIP when every applicable request is done; SHIP_WITH_FIXES when they are done",
    "with small gaps; DONT_SHIP when an applicable request is missing or clearly broken.",
    "",
    "The owner's requests, oldest first:",
    list,
  ].join("\n");
}

/** Pull the structured answer out of `claude -p --output-format json` output. */
function parseReviewOutput(stdout) {
  let out;
  try {
    out = JSON.parse(String(stdout).trim());
  } catch {
    // Some versions print log lines first: take the last JSON object line.
    const last = String(stdout)
      .trim()
      .split(/\r?\n/)
      .reverse()
      .find((l) => l.trim().startsWith("{"));
    try {
      out = last ? JSON.parse(last) : null;
    } catch {
      out = null;
    }
  }
  if (!out || typeof out !== "object") return { error: "reviewer output is not JSON" };
  if (out.is_error) return { error: String(out.result || "reviewer failed").slice(0, 300) };
  let answer = out.structured_output;
  if (!answer && typeof out.result === "string") {
    const m = out.result.match(/\{[\s\S]*\}/);
    try {
      answer = m ? JSON.parse(m[0]) : null;
    } catch {
      answer = null;
    }
  }
  const verdicts = SCHEMA.properties.verdict.enum;
  if (!answer || !verdicts.includes(answer.verdict) || !Array.isArray(answer.requirements)) {
    return { error: "reviewer gave no valid verdict" };
  }
  const statuses = SCHEMA.properties.requirements.items.properties.status.enum;
  return {
    review: {
      verdict: answer.verdict,
      summary: String(answer.summary || "").slice(0, 2000),
      requirements: answer.requirements.slice(0, MAX_REQUESTS).map((r) => ({
        request: String((r && r.request) || "").slice(0, 500),
        status: statuses.includes(r && r.status) ? r.status : "n/a",
        evidence: String((r && r.evidence) || "").slice(0, 1000),
      })),
      cost_usd: typeof out.total_cost_usd === "number" ? out.total_cost_usd : null,
    },
  };
}

/** Environment for the reviewer: the user's own (its login lives there), minus dashboard vars. */
function reviewerEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^DASHBOARD_/i.test(k)) out[k] = v;
  out.CI = "1";
  return out;
}

/**
 * Run the blind reviewer on a clean copy.
 * @param {object} o
 * @param {string} o.dir - The clean copy (working folder of the reviewer).
 * @param {string[]} o.requests - The owner's requests.
 * @param {string|null} o.commit
 * @param {number|null} o.testsCount
 * @param {{ model?: string, timeoutSec?: number }} o.config
 * @param {number} o.timeoutMs - Hard limit (the smaller of this and config.timeoutSec wins).
 * @param {(s: string) => void} o.write - Log writer (masks secrets).
 * @param {(c: any) => void} o.killTree
 * @param {Function} [o.spawn] - cross-spawn compatible (tests inject a fake `claude`).
 * @param {string} [o.bin] - The CLI (default `claude`, `DASHBOARD_CLAUDE_BIN` overrides).
 * @returns {Promise<{ verdict: "SHIP"|"SHIP_WITH_FIXES"|"DONT_SHIP"|"error", review: object|null,
 *   error: string|null }>}
 */
function runBlindReview(o) {
  const spawn = o.spawn || crossSpawn;
  const bin = o.bin || process.env.DASHBOARD_CLAUDE_BIN || "claude";
  const cfg = o.config || {};
  const timeoutMs = Math.min(o.timeoutMs, (cfg.timeoutSec || 600) * 1000);
  if (!o.requests.length) {
    return Promise.resolve({
      verdict: "error",
      review: null,
      error: "no owner requests found in the transcript",
    });
  }
  const prompt = buildPrompt(o);
  const args = [
    // The prompt goes on stdin: argv stays one line (cmd.exe cuts a .cmd shim's command line at
    // the first newline and refuses more than 8191 characters).
    "-p",
    "--output-format",
    "json",
    "--model",
    cfg.model || "sonnet",
    "--tools",
    "Read",
    "Grep",
    "Glob",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "--no-session-persistence",
    // File tools confined to the clean copy; user/project settings, MCP servers ignored.
    "--restricted",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--json-schema",
    JSON.stringify(SCHEMA),
  ];
  o.write(
    `$ ${bin} -p <prompt: ${o.requests.length} request(s)> --model ${cfg.model || "sonnet"} (read-only)\n`
  );
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd: o.dir,
        env: reviewerEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ verdict: "error", review: null, error: `could not start ${bin}: ${e.message}` });
      return;
    }
    child.stdin.on("error", () => undefined); // the CLI may exit before reading it all
    child.stdin.end(prompt);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let done = false;
    let timedOut = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (stderr.trim()) o.write(`${stderr.slice(-4000)}\n`);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      o.killTree(child);
      // Settle even if the process never reports its exit.
      setTimeout(
        () => finish({ verdict: "error", review: null, error: "reviewer timed out" }),
        5000
      ).unref?.();
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      if (stdout.length < MAX_OUTPUT) stdout += c;
    });
    child.stderr.on("data", (c) => {
      if (stderr.length < 20000) stderr += c;
    });
    child.on("error", (e) =>
      finish({ verdict: "error", review: null, error: `could not start ${bin}: ${e.message}` })
    );
    child.on("close", (code) => {
      if (timedOut) return finish({ verdict: "error", review: null, error: "reviewer timed out" });
      const parsed = parseReviewOutput(stdout);
      if (parsed.error) {
        return finish({
          verdict: "error",
          review: null,
          error: `${parsed.error}${code ? ` (exit ${code})` : ""}`,
        });
      }
      const r = parsed.review;
      o.write(`# blind review: ${r.verdict} — ${r.summary}\n`);
      for (const q of r.requirements) {
        o.write(`  [${q.status}] ${q.request.slice(0, 120)} — ${q.evidence.slice(0, 200)}\n`);
      }
      finish({ verdict: r.verdict, review: r, error: null });
    });
  });
}

module.exports = {
  runBlindReview,
  collectRequests,
  buildPrompt,
  parseReviewOutput,
  humanText,
  SCHEMA,
};
