/**
 * @file Tests for independent task verification ("Verified"): verify.json validation, secret
 * masking, test-count parsing, the runner's verdict rules (exit code + test count from the log,
 * low-disk refusal, temp copy always deleted) with injected fake git/extract/shell, and the
 * /api/sessions/:id/verify + /api/verifications routes (no command text accepted, cross-site
 * requests refused, config round trip).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "verify-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dash.db");
process.env.DASHBOARD_VERIFY_CONFIG = path.join(TMP, "verify.json");
process.env.DASHBOARD_DATA_DIR = path.join(TMP, "data");

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const verifyConfig = require("../lib/verify-config");
const {
  createVerifyRunner,
  maskSecrets,
  parseTestCount,
  defaultRunShell,
} = require("../lib/verify-runner");
const routes = require("../routes/verifications");

const REPO = fs.mkdtempSync(path.join(TMP, "repo-"));
const WORK_ROOT = fs.mkdtempSync(path.join(TMP, "work-"));
const LOG_DIR = path.join(TMP, "logs");

let server;
let BASE;

function request(urlPath, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Fake read-only git: every cwd is REPO at commit abc123, clean. */
async function fakeGit(args) {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
    return { code: 0, stdout: `${REPO}\n` };
  if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: "abc123\n" };
  if (args[0] === "status") return { code: 0, stdout: "" };
  return { code: 1, stdout: "" };
}

function makeRunner(shellResults, extra = {}) {
  const calls = { extractDirs: [], notified: [] };
  const runner = createVerifyRunner({
    db,
    git: fakeGit,
    extract: async (_sha, _repo, dest) => {
      calls.extractDirs.push(dest);
      fs.writeFileSync(path.join(dest, "file.txt"), "x");
    },
    runShell: async (cmd) =>
      shellResults[cmd] || { code: 127, timedOut: false, output: "not found" },
    notify: (_s, kind, detail) => calls.notified.push([kind, detail]),
    getConfig: () => ({
      projects: [
        {
          dir: REPO,
          setupCmd: "setup",
          checkCmd: "check",
          testCountRegex: "# pass (\\d+)",
          timeoutSec: 60,
        },
      ],
    }),
    tmpRoot: WORK_ROOT,
    logDir: LOG_DIR,
    freeBytes: () => 100 * 1024 ** 3,
    ...extra,
  });
  return { runner, calls };
}

let seq = 0;
function newSession() {
  const id = `verify-sess-${++seq}`;
  stmts.insertSession.run(id, "Test", "completed", REPO, null, null);
  return stmts.getSession.get(id);
}

async function waitDone(runner, id) {
  for (let i = 0; i < 200 && !runner._idle(); i++) await new Promise((r) => setTimeout(r, 10));
  return db.prepare("SELECT * FROM verifications WHERE id = ?").get(id);
}

before(async () => {
  const app = createApp();
  server = await startServer(app, 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a background process from the shell tests may still hold a folder on Windows */
  }
});

describe("verify-config", () => {
  it("accepts a valid project and clamps the timeout", () => {
    const cfg = verifyConfig.validateConfig({
      projects: [{ dir: REPO, checkCmd: "npm test", timeoutSec: 5 }],
    });
    assert.equal(cfg.projects[0].timeoutSec, 30);
    assert.equal(cfg.projects[0].testCountRegex, verifyConfig.DEFAULT_REGEX);
  });
  it("rejects relative or missing dirs, empty check commands, newlines and bad regexes", () => {
    const bad = [
      { dir: "relative", checkCmd: "x" },
      { dir: path.join(TMP, "nope"), checkCmd: "x" },
      { dir: REPO, checkCmd: "" },
      { dir: REPO, checkCmd: "a\nb" },
      { dir: REPO, checkCmd: "x", testCountRegex: "(" },
      { dir: REPO, checkCmd: "x", testCountRegex: "\\d+" },
    ];
    for (const p of bad) {
      assert.throws(() => verifyConfig.validateConfig({ projects: [p] }), verifyConfig.ConfigError);
    }
  });
  it("matches a project by its folder", () => {
    const cfg = { projects: [{ dir: REPO }] };
    assert.ok(verifyConfig.findProject(REPO + path.sep, cfg));
    assert.equal(verifyConfig.findProject(TMP, cfg), null);
  });
});

describe("log helpers", () => {
  it("masks secrets by env value and by pattern", () => {
    const out = maskSecrets(
      "tok=supersecretvalue123 ghp_abcdefghijklmnopqrstuvwxyz Authorization: Bearer abcdefghijklmnop",
      {
        MY_TOKEN: "supersecretvalue123",
      }
    );
    assert.ok(!out.includes("supersecretvalue123"));
    assert.ok(!out.includes("ghp_abcdefghijklmnopqrstuvwxyz"));
    assert.ok(!out.includes("abcdefghijklmnop"));
  });
  it("takes the last test count", () => {
    assert.equal(parseTestCount("# pass 3\n...\n# pass 41\n", "# pass (\\d+)"), 41);
    assert.equal(parseTestCount("nothing here", "# pass (\\d+)"), null);
  });
});

describe("verify runner", () => {
  it("verifies when the check exits 0 with tests, and deletes the clean copy", async () => {
    const { runner, calls } = makeRunner({
      setup: { code: 0, timedOut: false, output: "installed\n" },
      check: {
        code: 0,
        timedOut: false,
        output: "# pass 12\n# fail 0\nMY_PASSWORD=hunter22hunter\n",
      },
    });
    const row = await runner.start(newSession());
    assert.equal(row.status, "queued");
    assert.equal(row.commit_sha, "abc123");
    const done = await waitDone(runner, row.id);
    assert.equal(done.verdict, "verified");
    assert.equal(done.tests_count, 12);
    assert.equal(done.check_exit, 0);
    assert.equal(fs.existsSync(calls.extractDirs[0]), false, "temp copy must be deleted");
    const log = fs.readFileSync(done.log_path, "utf8");
    assert.match(log, /# pass 12/);
    assert.ok(!log.includes("hunter22hunter"));
    assert.deepEqual(calls.notified[0], ["verified", ""]);
  });

  it("tells onFinished about the finished row (the task queue is updated from there)", async () => {
    const finished = [];
    const { runner } = makeRunner(
      {
        setup: { code: 0, timedOut: false, output: "" },
        check: { code: 0, timedOut: false, output: "# pass 2\n" },
      },
      { onFinished: (row) => finished.push(row) }
    );
    const row = await runner.start(newSession());
    await waitDone(runner, row.id);
    assert.equal(finished.length, 1);
    assert.equal(finished[0].verdict, "verified");
    assert.equal(finished[0].commit_sha, "abc123");
  });

  it("fails on a non-zero exit even if the output claims success", async () => {
    const { runner, calls } = makeRunner({
      setup: { code: 0, timedOut: false, output: "" },
      check: { code: 1, timedOut: false, output: "All done! # pass 5\n" },
    });
    const row = await runner.start(newSession());
    const done = await waitDone(runner, row.id);
    assert.equal(done.verdict, "failed");
    assert.match(done.reason, /exit 1/);
    assert.equal(calls.notified[0][0], "verify_failed");
  });

  it("fails when no tests ran or no count is found", async () => {
    for (const output of ["# pass 0\n", "looks fine to me\n"]) {
      const { runner } = makeRunner({
        setup: { code: 0, timedOut: false, output: "" },
        check: { code: 0, timedOut: false, output },
      });
      const row = await runner.start(newSession());
      const done = await waitDone(runner, row.id);
      assert.equal(done.verdict, "failed");
    }
  });

  it("stops at a failing setup and on timeouts", async () => {
    const { runner } = makeRunner({ setup: { code: null, timedOut: true, output: "" } });
    const row = await runner.start(newSession());
    const done = await waitDone(runner, row.id);
    assert.equal(done.verdict, "failed");
    assert.equal(done.timed_out, 1);
    assert.equal(done.check_exit, null);
  });

  it("refuses to start below the free-disk floor", async () => {
    const { runner, calls } = makeRunner({}, { freeBytes: () => 1024 ** 3 });
    const row = await runner.start(newSession());
    const done = await waitDone(runner, row.id);
    assert.equal(done.verdict, "error");
    assert.match(done.reason, /low disk/);
    assert.equal(calls.extractDirs.length, 0);
  });

  it("refuses a session whose project is not configured", async () => {
    const { runner } = makeRunner({}, { getConfig: () => ({ projects: [] }) });
    await assert.rejects(runner.start(newSession()), (e) => e.code === "NOT_CONFIGURED");
  });

  it("recovers rows left running by a restart", () => {
    const s = newSession();
    db.prepare(
      "INSERT INTO verifications (session_id, project_dir, check_cmd, status) VALUES (?, ?, 'x', 'running')"
    ).run(s.id, REPO);
    const { runner } = makeRunner({});
    runner.recover();
    const r = db.prepare("SELECT * FROM verifications WHERE session_id = ?").get(s.id);
    assert.equal(r.status, "done");
    assert.equal(r.verdict, "error");
  });
});

describe("auto-verify after a turn ends", () => {
  const idleSession = () => {
    const s = newSession();
    stmts.setSessionAwaitingInput.run(new Date().toISOString(), "stop", s.id);
    return stmts.getSession.get(s.id);
  };
  const ok = {
    setup: { code: 0, timedOut: false, output: "" },
    check: { code: 0, timedOut: false, output: "# pass 2\n" },
  };
  const gitAt = (sha) => async (args) => {
    if (args[1] === "HEAD") return { code: 0, stdout: `${sha}\n` };
    return fakeGit(args);
  };

  it("verifies a new commit, then skips the same commit for any session", async () => {
    const { runner } = makeRunner(ok, { git: gitAt("auto111") });
    const first = await runner.autoVerifyNow(idleSession().id);
    assert.ok(first, "a new commit is verified");
    const done = await waitDone(runner, first.id);
    assert.equal(done.verdict, "verified");
    assert.equal(await runner.autoVerifyNow(idleSession().id), null, "same commit is not re-run");
  });

  it("skips quietly on low disk, and retries a commit whose earlier run only errored", async () => {
    const low = makeRunner(ok, { git: gitAt("auto222"), freeBytes: () => 0 });
    assert.equal(await low.runner.autoVerifyNow(idleSession().id), null, "no row, no push");
    const s = idleSession();
    db.prepare(
      "INSERT INTO verifications (session_id, project_dir, commit_sha, check_cmd, status, verdict) VALUES (?, ?, 'auto222', 'x', 'done', 'error')"
    ).run(s.id, REPO);
    const { runner } = makeRunner(ok, { git: gitAt("auto222") });
    const r = await runner.autoVerifyNow(s.id);
    assert.ok(r, "an errored run does not block a retry");
    await waitDone(runner, r.id);
  });

  it("does not start while the session is in the middle of a turn", async () => {
    const { runner } = makeRunner(ok, { git: gitAt("auto555") });
    assert.equal(await runner.autoVerifyNow(newSession().id), null);
  });

  it("skips projects with autoVerify off and unconfigured projects, without throwing", async () => {
    const off = makeRunner(ok, {
      git: gitAt("auto333"),
      getConfig: () => ({
        projects: [
          {
            dir: REPO,
            checkCmd: "check",
            testCountRegex: "# pass (\d+)",
            timeoutSec: 60,
            autoVerify: false,
          },
        ],
      }),
    });
    assert.equal(await off.runner.autoVerifyNow(idleSession().id), null);
    const none = makeRunner(ok, { git: gitAt("auto333"), getConfig: () => ({ projects: [] }) });
    assert.equal(await none.runner.autoVerifyNow(idleSession().id), null);
  });

  it("scheduleAuto waits, and a new turn end restarts the wait", async () => {
    const { runner } = makeRunner(ok, { git: gitAt("auto444"), autoDelayMs: 150 });
    const s = idleSession();
    runner.scheduleAuto(s);
    await new Promise((r) => setTimeout(r, 80));
    runner.scheduleAuto(s);
    await new Promise((r) => setTimeout(r, 100));
    const count = () =>
      db.prepare("SELECT COUNT(*) AS n FROM verifications WHERE session_id = ?").get(s.id).n;
    assert.equal(count(), 0, "still waiting after the restart");
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 100 && !runner._idle(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(count(), 1);
  });

  it("keeps the autoVerify flag (default on) in verify.json", () => {
    const cfg = verifyConfig.validateConfig({
      projects: [
        { dir: REPO, checkCmd: "x" },
        { dir: TMP, checkCmd: "x", autoVerify: false },
      ],
    });
    assert.equal(cfg.projects[0].autoVerify, true);
    assert.equal(cfg.projects[1].autoVerify, false);
  });

  it("startup sweep removes only temp copies whose owner process is gone", async () => {
    const live = fs.mkdtempSync(path.join(WORK_ROOT, "ccam-verify-"));
    fs.writeFileSync(path.join(live, ".ccam-verify-owner"), String(process.pid));
    const dead = fs.mkdtempSync(path.join(WORK_ROOT, "ccam-verify-"));
    fs.writeFileSync(path.join(dead, ".ccam-verify-owner"), "999999");
    const fresh = fs.mkdtempSync(path.join(WORK_ROOT, "ccam-verify-"));
    const { runner } = makeRunner(ok);
    runner.recover();
    for (let i = 0; i < 100 && fs.existsSync(dead); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.existsSync(dead), false, "dead owner removed");
    assert.equal(fs.existsSync(live), true, "live owner kept");
    assert.equal(fs.existsSync(fresh), true, "unmarked recent copy kept");
  });
});

describe("verification routes", () => {
  it("refuses a body (commands never come from the request)", async () => {
    const s = newSession();
    const r = await request(`/api/sessions/${s.id}/verify`, {
      method: "POST",
      body: { checkCmd: "rm -rf /" },
    });
    assert.equal(r.status, 400);
  });
  it("404s an unknown session", async () => {
    const r = await request("/api/sessions/nope/verify", { method: "POST", body: {} });
    assert.equal(r.status, 404);
  });
  it("refuses cross-site requests", async () => {
    const s = newSession();
    const r = await request(`/api/sessions/${s.id}/verify`, {
      method: "POST",
      body: {},
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(r.status, 403);
  });
  it("queues, lists, serves the log and the latest map", async () => {
    const { runner } = makeRunner({
      setup: { code: 0, timedOut: false, output: "" },
      check: { code: 0, timedOut: false, output: "# pass 3\n" },
    });
    routes.setRunner(runner);
    const s = newSession();
    const host = new URL(BASE).host;
    const r = await request(`/api/sessions/${s.id}/verify`, {
      method: "POST",
      body: {},
      headers: { Origin: `https://${host}` },
    });
    assert.equal(r.status, 202);
    assert.equal(r.body.verification.log_path, undefined);
    await waitDone(runner, r.body.verification.id);
    const list = await request(`/api/sessions/${s.id}/verifications`);
    assert.equal(list.body.verifications[0].verdict, "verified");
    assert.equal(list.body.current_head, "abc123");
    const log = await request(`/api/verifications/${r.body.verification.id}/log`);
    assert.match(log.body, /# pass 3/);
    const latest = await request(`/api/verifications/latest?session_ids=${s.id},other`);
    assert.equal(latest.body.latest[s.id].verdict, "verified");
  });
  it("round-trips the config and reports validation errors", async () => {
    const bad = await request("/api/verifications/config", {
      method: "PUT",
      body: { projects: [{ dir: "x" }] },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.field, "projects[0].dir");
    const ok = await request("/api/verifications/config", {
      method: "PUT",
      body: { projects: [{ dir: REPO, setupCmd: "npm ci", checkCmd: "npm test" }] },
    });
    assert.equal(ok.status, 200);
    const got = await request("/api/verifications/config");
    assert.equal(got.body.projects[0].checkCmd, "npm test");
    assert.equal(got.body.path, process.env.DASHBOARD_VERIFY_CONFIG);
  });
});

describe("real shell runner", () => {
  it("returns after the shell exits even if a background process keeps the output open", async () => {
    const t0 = Date.now();
    const r = await defaultRunShell(
      'node -e "setTimeout(() => {}, 15000)" & echo started',
      WORK_ROOT,
      60000
    );
    assert.equal(r.code, 0);
    assert.match(r.output, /started/);
    assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
  });
  it("kills a command that runs past its timeout", async () => {
    const t0 = Date.now();
    const r = await defaultRunShell('node -e "setTimeout(() => {}, 60000)"', WORK_ROOT, 1000);
    assert.equal(r.timedOut, true);
    assert.equal(r.code, null);
    assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
  });
});
