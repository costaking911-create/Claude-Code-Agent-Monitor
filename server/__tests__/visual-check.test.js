/**
 * @file Tests for the visual step of "Verified" (server/lib/visual-check.js): PNG decoding and the
 * blank-screen measure, verify.json validation of the `visual` section (loopback-only URL, no
 * newlines), the runner's verdict when the visual check fails, the screenshot route, and — when a
 * Chrome or Edge is installed (not on Linux CI) — a real headless run against tiny pages: a good
 * page passes, a page that throws fails, a blank page fails.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const zlib = require("zlib");
const { spawn } = require("child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "visual-test-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dash.db");
process.env.DASHBOARD_VERIFY_CONFIG = path.join(TMP, "verify.json");
process.env.DASHBOARD_DATA_DIR = path.join(TMP, "data");

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const verifyConfig = require("../lib/verify-config");
const { createVerifyRunner } = require("../lib/verify-runner");
const visual = require("../lib/visual-check");
const routes = require("../routes/verifications");

const REPO = fs.mkdtempSync(path.join(TMP, "repo-"));
const WORK_ROOT = fs.mkdtempSync(path.join(TMP, "work-"));
const LOG_DIR = path.join(TMP, "logs");

let server;
let BASE;

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(new URL(urlPath, BASE), (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            type: res.headers["content-type"],
            body: Buffer.concat(chunks),
          })
        );
      })
      .on("error", reject);
  });
}

/** Encode raw RGB rows as a PNG (filter 0, CRCs left as zero — the decoder does not check them). */
function makePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(type, "ascii"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function fakeGit(args) {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel")
    return { code: 0, stdout: `${REPO}\n` };
  if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: "abc123\n" };
  if (args[0] === "status") return { code: 0, stdout: "" };
  return { code: 1, stdout: "" };
}

function makeRunner(visualCheck) {
  return createVerifyRunner({
    db,
    git: fakeGit,
    extract: async (_sha, _repo, dest) => fs.writeFileSync(path.join(dest, "index.html"), "x"),
    runShell: async () => ({ code: 0, timedOut: false, output: "# pass 4\n" }),
    visualCheck,
    getConfig: () => ({
      projects: [
        {
          dir: REPO,
          setupCmd: "",
          checkCmd: "check",
          testCountRegex: "# pass (\\d+)",
          timeoutSec: 60,
          visual: { path: "/", waitMs: 0, width: 390, height: 844, minVariety: 0.01 },
        },
      ],
    }),
    tmpRoot: WORK_ROOT,
    logDir: LOG_DIR,
    freeBytes: () => 100 * 1024 ** 3,
  });
}

let seq = 0;
function newSession() {
  const id = `visual-sess-${++seq}`;
  stmts.insertSession.run(id, "Test", "completed", REPO, null, null);
  return stmts.getSession.get(id);
}

async function waitDone(runner, id) {
  for (let i = 0; i < 300 && !runner._idle(); i++) await new Promise((r) => setTimeout(r, 10));
  return db.prepare("SELECT * FROM verifications WHERE id = ?").get(id);
}

before(async () => {
  server = await startServer(createApp(), 0);
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
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* a browser may still hold its profile for a moment on Windows */
  }
});

describe("visual check helpers", () => {
  it("decodes a PNG and tells a blank screen from a drawn one", () => {
    const blank = makePng(40, 80, () => [250, 250, 250]);
    const img = visual.decodePng(blank);
    assert.equal(img.width, 40);
    assert.equal(img.height, 80);
    assert.equal(visual.pngVariety(blank), 0);
    const half = makePng(40, 80, (x) => (x < 20 ? [255, 0, 0] : [0, 0, 255]));
    assert.ok(Math.abs(visual.pngVariety(half) - 0.5) < 0.05);
    assert.equal(visual.pngVariety(Buffer.from("not a png")), null);
  });

  it("validates the visual section of verify.json", () => {
    const base = { dir: REPO, checkCmd: "x" };
    const ok = verifyConfig.validateConfig({
      projects: [{ ...base, visual: { readyExpr: "!!document.body", waitMs: 999999 } }],
    }).projects[0].visual;
    assert.equal(ok.waitMs, 120000, "clamped");
    assert.equal(ok.path, "/");
    assert.equal(
      verifyConfig.validateConfig({ projects: [{ ...base, visual: { enabled: false } }] })
        .projects[0].visual,
      undefined
    );
    for (const bad of [
      { serveCmd: "npm start", url: "http://example.com:{port}/" },
      { readyExpr: "a\nb" },
      { path: "no-slash" },
    ]) {
      assert.throws(
        () => verifyConfig.validateConfig({ projects: [{ ...base, visual: bad }] }),
        verifyConfig.ConfigError
      );
    }
  });
});

describe("runner with a visual check", () => {
  it("fails the verification when the visual check fails, and serves the screenshot", async () => {
    const png = makePng(10, 10, () => [1, 2, 3]);
    const runner = makeRunner(async (o) => {
      fs.writeFileSync(o.screenshotPath, png);
      o.write("  ✗ exception: boom\n");
      return { ok: false, reason: "visual check: 1 error(s) on the page", errors: ["boom"] };
    });
    routes.setRunner(runner);
    const row = await runner.start(newSession());
    const done = await waitDone(runner, row.id);
    assert.equal(done.verdict, "failed");
    assert.match(done.reason, /visual check/);
    assert.match(fs.readFileSync(done.log_path, "utf8"), /exception: boom/);
    const list = await get(`/api/sessions/${done.session_id}/verifications`);
    assert.equal(JSON.parse(String(list.body)).verifications[0].has_screenshot, true);
    const shot = await get(`/api/verifications/${row.id}/screenshot`);
    assert.equal(shot.status, 200);
    assert.match(shot.type, /image\/png/);
    assert.ok(shot.body.equals(png));
  });

  it("verifies when the visual check passes; 404 without a screenshot", async () => {
    const runner = makeRunner(async () => ({ ok: true, reason: null, errors: [] }));
    const row = await runner.start(newSession());
    const done = await waitDone(runner, row.id);
    assert.equal(done.verdict, "verified");
    assert.equal((await get(`/api/verifications/${row.id}/screenshot`)).status, 404);
    assert.equal((await get(`/api/verifications/abc/screenshot`)).status, 400);
  });
});

const browser = visual.findBrowser();
const realBrowser =
  process.env.DASHBOARD_TEST_BROWSER === "1" || (browser && process.platform !== "linux");

describe("visual check in a real headless browser", { skip: !realBrowser }, () => {
  const proc = {
    shell: { file: process.platform === "win32" ? "cmd.exe" : "/bin/sh", args: ["-c"] },
    killTree: (c) => {
      if (!c || !c.pid) return;
      if (process.platform === "win32")
        spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" }).on(
          "error",
          () => undefined
        );
      else
        try {
          process.kill(-c.pid, "SIGKILL");
        } catch {
          c.kill("SIGKILL");
        }
    },
    env: process.env,
  };
  async function check(name, html, extra = {}, opts = {}) {
    const dir = fs.mkdtempSync(path.join(TMP, `${name}-`));
    fs.writeFileSync(path.join(dir, "index.html"), html);
    const shot = path.join(TMP, `${name}.png`);
    const r = await visual.runVisualCheck({
      dir,
      visual: { path: "/", waitMs: 500, ...extra },
      screenshotPath: shot,
      timeoutMs: 60000,
      write: () => undefined,
      proc,
      ...opts,
    });
    return { ...r, shot };
  }

  it("passes a drawn page and saves its screenshot", async () => {
    const r = await check(
      "good",
      `<!doctype html><body style="margin:0"><div style="height:50vh;background:#c33"></div>
       <div id="ok" style="height:50vh;background:#33c">hello</div></body>`,
      { readyExpr: "!!document.getElementById('ok')" }
    );
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.screenshot, true);
    assert.ok(fs.statSync(r.shot).size > 100);
  });

  it("fails a page that throws", async () => {
    const r = await check(
      "throws",
      `<!doctype html><body style="background:linear-gradient(red,blue)"><script>throw new Error("boom")</script></body>`
    );
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => /boom/.test(e)),
      r.errors.join("\n")
    );
  });

  it("gives up on a page that blocks its main thread, and cleans up", async () => {
    const t0 = Date.now();
    const r = await check(
      "hung",
      `<!doctype html><body style="background:linear-gradient(red,blue)"><script>setTimeout(() => { for (;;); }, 0)</script></body>`,
      { readyExpr: "true", waitMs: 2000 },
      { cdpTimeoutMs: 3000 }
    );
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 60000, "bounded");
  });

  it("the static server refuses a NUL byte instead of crashing", async () => {
    const dir = fs.mkdtempSync(path.join(TMP, "nul-"));
    const { server: s, port } = await visual.startStaticServer(dir);
    const status = await new Promise((resolve) =>
      http.get(`http://127.0.0.1:${port}/a%00b`, (res) => resolve(res.statusCode))
    );
    s.close();
    assert.equal(status, 400);
  });

  it("fails a blank page", async () => {
    const r = await check("blank", `<!doctype html><body style="background:#fff"></body>`);
    assert.equal(r.ok, false);
    assert.match(r.reason, /blank/);
  });
});
