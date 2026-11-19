/**
 * @file Tests for the blind reviewer of "Verified" (server/lib/blind-review.js): only human
 * requests are taken from a transcript (never assistant text or tool output), the CLI is started
 * read-only in the clean copy with hooks off, its structured JSON answer is parsed, failures and
 * timeouts become an "error" review, and the runner fails a run only on DONT_SHIP — a reviewer
 * that cannot run leaves a passing run verified. A fake `claude` (a Node script) stands in for
 * the real CLI.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "blind-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dash.db");
process.env.DASHBOARD_VERIFY_CONFIG = path.join(TMP, "verify.json");
process.env.DASHBOARD_DATA_DIR = path.join(TMP, "data");

const { db, stmts } = require("../db");
const { createVerifyRunner, publicRow } = require("../lib/verify-runner");
const br = require("../lib/blind-review");

const REPO = fs.mkdtempSync(path.join(TMP, "repo-"));
const WORK_ROOT = fs.mkdtempSync(path.join(TMP, "work-"));
const LOG_DIR = path.join(TMP, "logs");

const line = (o) => JSON.stringify(o);
function writeTranscript(name, entries) {
  const p = path.join(TMP, `${name}.jsonl`);
  fs.writeFileSync(p, entries.map(line).join("\n") + "\n");
  return p;
}

// A stand-in for `claude`: records its argv/cwd and prints what FAKE_MODE asks for.
const FAKE = path.join(TMP, "fake-claude.js");
fs.writeFileSync(
  FAKE,
  `const fs = require("fs");
const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, prompt, cwd: process.cwd() }));
const mode = process.env.FAKE_MODE;
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "auth") console.log(JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate" }));
else if (mode === "garbage") console.log("not json at all");
else console.log(JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.02, structured_output: {
  verdict: mode === "dont" ? "DONT_SHIP" : "SHIP",
  summary: mode === "dont" ? "the button is missing" : "all done",
  requirements: [{ request: "add a button", status: mode === "dont" ? "missing" : "done", evidence: "app.js:3" }],
} }));
});
`
);

function fakeSpawn(mode) {
  const record = path.join(TMP, `record-${mode}-${Date.now()}.json`);
  const fn = (_bin, args, opts) =>
    spawn(process.execPath, [FAKE, ...args], {
      ...opts,
      env: { ...opts.env, FAKE_MODE: mode, FAKE_RECORD: record },
    });
  return { fn, record };
}

const killTree = (c) => {
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" }).on(
        "error",
        () => undefined
      );
    else c.kill("SIGKILL");
  } catch {
    /* gone */
  }
};

after(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* ignore */
  }
});

describe("collectRequests", () => {
  it("keeps only what the owner typed", async () => {
    const p = writeTranscript("t1", [
      { type: "user", message: { role: "user", content: "תוסיף כפתור שמירה" } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Done! I added it." }] },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "secret file text" }] },
      },
      { type: "user", isMeta: true, message: { role: "user", content: "meta line" } },
      { type: "user", message: { role: "user", content: "<system-reminder>x</system-reminder>" } },
      { type: "user", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "and make it blue" }] },
      },
      { type: "user", message: { role: "user", content: "and make it blue" } },
    ]);
    assert.deepEqual(await br.collectRequests(p), ["תוסיף כפתור שמירה", "and make it blue"]);
    assert.deepEqual(await br.collectRequests(path.join(TMP, "missing.jsonl")), []);
    assert.deepEqual(await br.collectRequests(null), []);
  });

  it("keeps the newest requests when there are too many", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      type: "user",
      message: { role: "user", content: `request ${i} ${"x".repeat(900)}` },
    }));
    const got = await br.collectRequests(writeTranscript("t2", many));
    assert.ok(got.length < 60 && got.length > 0);
    assert.match(got[got.length - 1], /^request 59 /);
  });
});

describe("parseReviewOutput", () => {
  it("reads structured output, JSON inside the text, and errors", () => {
    const ok = br.parseReviewOutput(
      line({
        structured_output: {
          verdict: "SHIP_WITH_FIXES",
          summary: "s",
          requirements: [{ request: "r", status: "weird", evidence: "e" }],
        },
      })
    );
    assert.equal(ok.review.verdict, "SHIP_WITH_FIXES");
    assert.equal(ok.review.requirements[0].status, "n/a", "unknown status is normalised");
    const inText = br.parseReviewOutput(
      line({ result: 'Here: ```json\n{"verdict":"SHIP","summary":"","requirements":[]}\n```' })
    );
    assert.equal(inText.review.verdict, "SHIP");
    assert.match(
      br.parseReviewOutput(line({ is_error: true, result: "no login" })).error,
      /no login/
    );
    assert.ok(br.parseReviewOutput("garbage").error);
    assert.ok(br.parseReviewOutput(line({ structured_output: { verdict: "MAYBE" } })).error);
  });
});

describe("runBlindReview", () => {
  const base = (spawnFn, extra = {}) => ({
    dir: WORK_ROOT,
    requests: ["add a button"],
    commit: "abc123",
    testsCount: 5,
    config: { model: "sonnet", timeoutSec: 60 },
    timeoutMs: 60000,
    write: () => undefined,
    killTree,
    spawn: spawnFn,
    ...extra,
  });

  it("starts the CLI read-only in the clean copy and returns its verdict", async () => {
    const { fn, record } = fakeSpawn("ship");
    const r = await br.runBlindReview(base(fn));
    assert.equal(r.verdict, "SHIP");
    assert.equal(r.review.requirements[0].status, "done");
    const rec = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(path.resolve(rec.cwd), path.resolve(WORK_ROOT));
    const tools = rec.args.slice(rec.args.indexOf("--tools") + 1, rec.args.indexOf("--tools") + 4);
    assert.deepEqual(tools, ["Read", "Grep", "Glob"]);
    assert.ok(rec.args.includes("--no-session-persistence"));
    assert.ok(rec.args[rec.args.indexOf("--settings") + 1].includes("disableAllHooks"));
    const prompt = rec.prompt;
    assert.ok(!rec.args.some((a) => a.includes("\n")), "argv stays one line (prompt on stdin)");
    assert.ok(rec.args.includes("--restricted") && rec.args.includes("--strict-mcp-config"));
    assert.match(prompt, /1\. add a button/);
    assert.ok(!rec.args.some((a) => /Bash|Edit|Write/.test(a)), "no write tools");
  });

  it("reports login failures, bad output, no requests and timeouts as errors", async () => {
    assert.match((await br.runBlindReview(base(fakeSpawn("auth").fn))).error, /authenticate/);
    assert.equal((await br.runBlindReview(base(fakeSpawn("garbage").fn))).verdict, "error");
    assert.match(
      (await br.runBlindReview(base(fakeSpawn("ship").fn, { requests: [] }))).error,
      /no owner requests/
    );
    const t0 = Date.now();
    const hung = await br.runBlindReview(
      base(fakeSpawn("hang").fn, { config: { timeoutSec: 60 }, timeoutMs: 1500 })
    );
    assert.equal(hung.verdict, "error");
    assert.match(hung.error, /timed out/);
    assert.ok(Date.now() - t0 < 15000);
  });
});

describe("runner with a blind reviewer", () => {
  async function fakeGit(args) {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
      return { code: 0, stdout: `${REPO}\n` };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: "abc123\n" };
    if (args[0] === "status") return { code: 0, stdout: "" };
    return { code: 1, stdout: "" };
  }
  function makeRunner(reviewResult, seen) {
    return createVerifyRunner({
      db,
      git: fakeGit,
      extract: async (_sha, _repo, dest) => fs.writeFileSync(path.join(dest, "a.txt"), "x"),
      runShell: async () => ({ code: 0, timedOut: false, output: "# pass 3\n" }),
      blindReview: async (o) => {
        seen.push(o);
        return reviewResult;
      },
      getConfig: () => ({
        projects: [
          {
            dir: REPO,
            setupCmd: "",
            checkCmd: "check",
            testCountRegex: "# pass (\\d+)",
            timeoutSec: 60,
            blindReview: { model: "sonnet", timeoutSec: 60 },
          },
        ],
      }),
      tmpRoot: WORK_ROOT,
      logDir: LOG_DIR,
      freeBytes: () => 100 * 1024 ** 3,
    });
  }
  let n = 0;
  function newSession(transcript) {
    const id = `blind-sess-${++n}`;
    stmts.insertSession.run(id, "Test", "completed", REPO, null, null);
    db.prepare("UPDATE sessions SET transcript_path = ? WHERE id = ?").run(transcript, id);
    return stmts.getSession.get(id);
  }
  async function run(runner, session) {
    const row = await runner.start(session);
    for (let i = 0; i < 300 && !runner._idle(); i++) await new Promise((r) => setTimeout(r, 10));
    return db.prepare("SELECT * FROM verifications WHERE id = ?").get(row.id);
  }
  const transcript = () =>
    writeTranscript(`r${Date.now()}`, [
      { type: "user", message: { role: "user", content: "add a button, password=hunter2hunter2" } },
    ]);

  it("fails the run on DONT_SHIP and keeps the review on the row", async () => {
    const seen = [];
    const done = await run(
      makeRunner(
        {
          verdict: "DONT_SHIP",
          review: { verdict: "DONT_SHIP", summary: "button missing", requirements: [] },
          error: null,
        },
        seen
      ),
      newSession(transcript())
    );
    assert.equal(done.verdict, "failed");
    assert.match(done.reason, /blind review: button missing/);
    assert.equal(done.review_verdict, "DONT_SHIP");
    assert.equal(publicRow(done).review.summary, "button missing");
    assert.equal(seen[0].requests.length, 1);
    assert.ok(!seen[0].requests[0].includes("hunter2hunter2"), "secrets masked before review");
  });

  it("keeps a passing run verified when the reviewer cannot run", async () => {
    const seen = [];
    const done = await run(
      makeRunner({ verdict: "error", review: null, error: "Failed to authenticate" }, seen),
      newSession(transcript())
    );
    assert.equal(done.verdict, "verified");
    assert.equal(done.review_verdict, "error");
    assert.match(publicRow(done).review.error, /authenticate/);
  });
});
