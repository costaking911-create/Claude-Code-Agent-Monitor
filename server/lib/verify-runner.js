/**
 * @file verify-runner.js
 * @description Independent verification of a session's work ("Verified"). For the session's git
 * repository it takes the current commit, extracts it with `git archive` into a fresh temp folder
 * (tracked files only: no history, no transcript, no local secrets), runs the project's configured
 * setup and check commands there with a timeout, writes all output to a log with secrets masked,
 * and decides the verdict from the check's exit code and the test count parsed from that log —
 * never from anything the agent said. One verification runs at a time; the temp folder is always
 * deleted afterwards and a low-disk guard refuses to start below a free-space floor.
 * The commands come only from verify-config (the dashboard's own config file).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { gitSafeEnv } = require("./git-env");
const verifyConfig = require("./verify-config");

const MAX_PHASE_OUTPUT = 5 * 1024 * 1024;
const MIN_FREE_BYTES = 3 * 1024 ** 3;
const TMP_PREFIX = "ccam-verify-";
const DRAIN_GRACE_MS = 5000;
const HARD_SETTLE_MS = 10000;
const KEEP_LOGS = 200;
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|VAPID|CREDENTIAL|AUTH/i;

class VerifyError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Mask secrets in a block of log text. */
function maskSecrets(text, env = process.env) {
  let s = String(text);
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && SECRET_NAME.test(k)) s = s.split(v).join("***");
  }
  return s
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***")
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox*-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1***")
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?)[^\s"']{4,}/gi,
      "$1***"
    );
}

/** Environment for the verification commands: no dashboard secrets, CI mode. */
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k) || /^DASHBOARD_/i.test(k)) continue;
    env[k] = v;
  }
  env.CI = "1";
  env.CHERE_INVOKING = "1";
  return env;
}

/** Git Bash on Windows (never WSL's System32 bash), `sh` elsewhere. */
function resolveShell() {
  if (process.platform !== "win32") return { file: "/bin/sh", args: ["-c"] };
  const candidates = [
    process.env.DASHBOARD_VERIFY_BASH,
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  const found = candidates.find((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
  if (!found)
    throw new VerifyError("NO_BASH", "Git Bash not found (set DASHBOARD_VERIFY_BASH)", 500);
  return { file: found, args: ["-c"] };
}

/** Kill a process and all of its children. */
function killTree(child) {
  if (!child || !child.pid) return;
  // Kill even when the shell itself has exited: a grandchild may still hold the pipes.
  try {
    if (process.platform === "win32") {
      // Non-blocking: taskkill can take seconds on a busy machine.
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => undefined);
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Default git helper: run git read-only in `cwd`. */
function defaultGit(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: gitSafeEnv(), windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) =>
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: String(stdout || ""),
        })
    );
  });
}

/** Default extractor: `git archive --format=tar <sha> | tar -x -f - -C <dest>`, no shell. */
function defaultExtract(sha, repoDir, dest) {
  return new Promise((resolve, reject) => {
    const tarBin =
      process.platform === "win32"
        ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        : "tar";
    const git = spawn("git", ["archive", "--format=tar", sha], {
      cwd: repoDir,
      env: gitSafeEnv(),
      windowsHide: true,
    });
    const tar = spawn(tarBin, ["-x", "-f", "-", "-C", dest], { windowsHide: true });
    let err = "";
    git.stderr.on("data", (d) => (err += d));
    tar.stderr.on("data", (d) => (err += d));
    git.stdout.pipe(tar.stdin);
    git.on("error", reject);
    tar.on("error", reject);
    let gitCode = null;
    git.on("close", (c) => (gitCode = c));
    tar.on("close", (c) => {
      if (c === 0 && gitCode === 0) resolve();
      else
        reject(
          new Error(`git archive failed: ${err.trim().slice(0, 300) || `exit ${gitCode}/${c}`}`)
        );
    });
  });
}

/**
 * Default shell runner. Resolves { code, timedOut, output } where output is capped.
 * @param {string} cmd @param {string} cwd @param {number} timeoutMs
 */
function defaultRunShell(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let shell;
    try {
      shell = resolveShell();
    } catch (e) {
      resolve({ code: null, timedOut: false, output: `${e.message}\n` });
      return;
    }
    const child = spawn(shell.file, [...shell.args, cmd], {
      cwd,
      env: childEnv(),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let truncated = false;
    const onData = (d) => {
      if (output.length >= MAX_PHASE_OUTPUT) {
        truncated = true;
        return;
      }
      output += d.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let timedOut = false;
    let settled = false;
    let exitCode = null;
    let drainTimer = null;
    let hardTimer = null;
    const finish = (code, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      clearTimeout(hardTimer);
      // A background process the command left behind must not keep the run (or the queue) alive.
      killTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      if (truncated) output += "\n[… output truncated …]\n";
      resolve({ code: timedOut ? null : code, timedOut, output: output + extra });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Whatever happens to the pipes, settle shortly after the kill.
      hardTimer = setTimeout(() => finish(null, "\n[killed: timeout]\n"), HARD_SETTLE_MS);
    }, timeoutMs);
    child.on("error", (e) => finish(null, `\n${e.message}\n`));
    // `exit` fires when the shell ends; `close` waits for every holder of the pipes. Give the
    // pipes a short grace period to drain, then settle on the exit code regardless.
    child.on("exit", (code) => {
      exitCode = code;
      drainTimer = setTimeout(
        () => finish(exitCode, "\n[a background process kept the output open — stopped]\n"),
        DRAIN_GRACE_MS
      );
    });
    child.on("close", (code) => finish(exitCode ?? code));
  });
}

/** Last test count matched by the project's regex in the check output (null when none). */
function parseTestCount(output, regexSource) {
  let re;
  try {
    re = new RegExp(regexSource, "g");
  } catch {
    return null;
  }
  let last = null;
  let m;
  let guard = 0;
  while ((m = re.exec(output)) && guard++ < 100000) {
    if (m.index === re.lastIndex) re.lastIndex++;
    const n = Number(m[1]);
    if (Number.isFinite(n)) last = n;
  }
  return last;
}

/**
 * Create a runner. Every side effect is injectable for tests.
 * @param {object} deps
 */
function createVerifyRunner(deps = {}) {
  const db = deps.db;
  const broadcast = deps.broadcast || (() => {});
  const notify = deps.notify || (() => {});
  const git = deps.git || defaultGit;
  const extract = deps.extract || defaultExtract;
  const runShell = deps.runShell || defaultRunShell;
  const getConfig = deps.getConfig || verifyConfig.readConfig;
  const tmpRoot = deps.tmpRoot || os.tmpdir();
  const logDir = deps.logDir;
  const minFreeBytes = deps.minFreeBytes ?? MIN_FREE_BYTES;
  const keepLogs = deps.keepLogs ?? KEEP_LOGS;
  const freeBytes =
    deps.freeBytes ||
    ((dir) => {
      const s = fs.statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    });

  const stmt = {
    insert: db.prepare(
      `INSERT INTO verifications (session_id, project_dir, commit_sha, dirty, setup_cmd, check_cmd, status)
       VALUES (?, ?, ?, ?, ?, ?, 'queued')`
    ),
    get: db.prepare("SELECT * FROM verifications WHERE id = ?"),
    running: db.prepare(
      "UPDATE verifications SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ),
    finish: db.prepare(
      `UPDATE verifications SET status = 'done', verdict = ?, reason = ?, setup_exit = ?, check_exit = ?,
         tests_count = ?, timed_out = ?, log_path = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`
    ),
    active: db.prepare(
      "SELECT id FROM verifications WHERE session_id = ? AND status IN ('queued','running') LIMIT 1"
    ),
  };

  /** @type {{ row: any, project: any, repoDir: string }[]} */
  const queue = [];
  let busy = false;

  const publish = (id) => {
    const row = stmt.get.get(id);
    if (row) broadcast("verification_updated", publicRow(row));
    return row;
  };

  /** Resolve the git work tree and the configured project for a session cwd. */
  async function resolveProject(cwd) {
    if (!cwd) throw new VerifyError("NO_CWD", "session has no working directory");
    let isDir = false;
    try {
      isDir = fs.statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new VerifyError("NO_CWD", "session working directory no longer exists");
    const top = await git(["rev-parse", "--show-toplevel"], cwd);
    if (top.code !== 0 || !top.stdout.trim())
      throw new VerifyError("NOT_GIT", "not a git repository");
    const repoDir = path.resolve(top.stdout.trim());
    const cfg = getConfig();
    let project = verifyConfig.findProject(repoDir, cfg);
    if (!project) {
      // A worktree (e.g. .claude/worktrees/x) belongs to the main repository's configuration.
      const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
      if (common.code === 0 && common.stdout.trim()) {
        project = verifyConfig.findProject(path.dirname(path.resolve(common.stdout.trim())), cfg);
      }
    }
    if (!project)
      throw new VerifyError("NOT_CONFIGURED", "no verification configured for this project");
    return { repoDir, project };
  }

  /**
   * Queue a verification for a session. Resolves the queued row.
   * @param {{ id: string, cwd?: string|null }} session
   */
  async function start(session) {
    const existing = stmt.active.get(session.id);
    if (existing) return publicRow(stmt.get.get(existing.id));
    const { repoDir, project } = await resolveProject(session.cwd);
    const head = await git(["rev-parse", "HEAD"], repoDir);
    if (head.code !== 0) throw new VerifyError("NOT_GIT", "repository has no commit yet");
    const status = await git(["status", "--porcelain", "--untracked-files=no"], repoDir);
    const dirty = status.code === 0 && status.stdout.trim() ? 1 : 0;
    const info = stmt.insert.run(
      session.id,
      repoDir,
      head.stdout.trim(),
      dirty,
      project.setupCmd || null,
      project.checkCmd
    );
    const row = publish(info.lastInsertRowid);
    queue.push({ row, project, repoDir, session });
    pump();
    return publicRow(row);
  }

  function pump() {
    if (busy || queue.length === 0) return;
    busy = true;
    const job = queue.shift();
    runJob(job)
      .catch(() => undefined)
      .finally(() => {
        busy = false;
        pump();
      });
  }

  async function runJob({ row, project, repoDir, session }) {
    stmt.running.run(row.id);
    publish(row.id);
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${row.id}.log`);
    const log = [];
    const write = (s) => log.push(maskSecrets(s));
    let verdict = "error";
    let reason = null;
    let setupExit = null;
    let checkExit = null;
    let testsCount = null;
    let timedOut = 0;
    let tmp = null;
    const deadline = Date.now() + project.timeoutSec * 1000;
    const left = () => Math.max(1000, deadline - Date.now());
    try {
      write(
        `# Verification #${row.id}\n# repo: ${repoDir}\n# commit: ${row.commit_sha}${row.dirty ? " (working tree had uncommitted changes — not included)" : ""}\n`
      );
      let free = Infinity;
      try {
        free = freeBytes(tmpRoot);
      } catch {
        free = Infinity;
      }
      if (free < minFreeBytes) {
        reason = `low disk space: ${(free / 1024 ** 3).toFixed(1)} GB free (needs ${(minFreeBytes / 1024 ** 3).toFixed(0)} GB)`;
        return;
      }
      tmp = fs.mkdtempSync(path.join(tmpRoot, TMP_PREFIX));
      await extract(row.commit_sha, repoDir, tmp);
      write(`# clean copy extracted (git archive)\n`);
      if (project.setupCmd) {
        write(`\n$ ${project.setupCmd}\n`);
        const r = await runShell(project.setupCmd, tmp, left());
        write(r.output);
        setupExit = r.code;
        if (r.timedOut) {
          timedOut = 1;
          verdict = "failed";
          reason = `setup timed out after ${project.timeoutSec}s`;
          return;
        }
        if (r.code !== 0) {
          verdict = "failed";
          reason = `setup failed (exit ${r.code})`;
          return;
        }
      }
      write(`\n$ ${project.checkCmd}\n`);
      const r = await runShell(project.checkCmd, tmp, left());
      write(r.output);
      checkExit = r.code;
      testsCount = parseTestCount(r.output, project.testCountRegex);
      if (r.timedOut) {
        timedOut = 1;
        verdict = "failed";
        reason = `tests timed out after ${project.timeoutSec}s`;
      } else if (r.code !== 0) {
        verdict = "failed";
        reason = `tests failed (exit ${r.code})`;
      } else if (testsCount == null) {
        verdict = "failed";
        reason = "no test count found in the log";
      } else if (testsCount === 0) {
        verdict = "failed";
        reason = "0 tests ran";
      } else {
        verdict = "verified";
      }
    } catch (e) {
      verdict = "error";
      reason = String(e && e.message ? e.message : e).slice(0, 300);
    } finally {
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        } catch {
          write(`\n# warning: could not delete ${tmp}\n`);
        }
      }
      write(`\n# verdict: ${verdict}${reason ? ` — ${reason}` : ""}\n`);
      try {
        fs.writeFileSync(logPath, log.join(""), "utf8");
      } catch {
        /* log is best effort */
      }
      pruneLogs();
      stmt.finish.run(verdict, reason, setupExit, checkExit, testsCount, timedOut, logPath, row.id);
      publish(row.id);
      try {
        notify(session, verdict === "verified" ? "verified" : "verify_failed", reason || "");
      } catch {
        /* never fail a verification on a push */
      }
    }
  }

  /** Keep only the newest KEEP_LOGS log files (the disk is shared with everything else). */
  function pruneLogs() {
    try {
      const ids = fs
        .readdirSync(logDir)
        .map((n) => /^(\d+)\.log$/.exec(n))
        .filter(Boolean)
        .map((m) => Number(m[1]))
        .sort((a, b) => b - a);
      for (const id of ids.slice(keepLogs)) {
        fs.rmSync(path.join(logDir, `${id}.log`), { force: true });
      }
    } catch {
      /* best effort */
    }
  }

  /** On startup: rows left queued/running by a restart become errors; stale temp copies go. */
  function recover() {
    db.prepare(
      `UPDATE verifications SET status = 'done', verdict = 'error', reason = 'dashboard restarted during verification',
         ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('queued','running')`
    ).run();
    try {
      for (const name of fs.readdirSync(tmpRoot)) {
        if (name.startsWith(TMP_PREFIX)) {
          fs.rmSync(path.join(tmpRoot, name), { recursive: true, force: true, maxRetries: 2 });
        }
      }
    } catch {
      /* best effort */
    }
  }

  /** Current HEAD of the repository a session works in (for the "stale" check), or null. */
  async function currentHead(cwd) {
    if (!cwd) return null;
    try {
      const r = await git(["rev-parse", "HEAD"], cwd);
      return r.code === 0 ? r.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }

  return { start, recover, currentHead, _idle: () => !busy && queue.length === 0 };
}

/** Row as sent to clients (no local file path). */
function publicRow(row) {
  if (!row) return row;
  const { log_path: _logPath, review_log_path: _reviewLog, ...rest } = row;
  return rest;
}

module.exports = {
  createVerifyRunner,
  maskSecrets,
  parseTestCount,
  publicRow,
  childEnv,
  defaultRunShell,
  VerifyError,
};
