/**
 * @file Tests for the automatic disk cleanup (server/lib/disk-janitor.js + /api/disk): only old
 * entries in the configured folders are removed, dry runs delete nothing, the run stops once the
 * target is reached, the scheduler cleans only below the floor and at most every 30 minutes,
 * settings are clamped, and the routes refuse cross-site requests.
 * Every path is inside a throwaway temp folder.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "janitor-test-"));
process.env.DASHBOARD_DB_PATH = path.join(ROOT, "dash.db");
process.env.DASHBOARD_DISK_JANITOR_CONFIG = path.join(ROOT, "disk-janitor.json");
process.env.DASHBOARD_DATA_DIR = path.join(ROOT, "data");

const { createApp, startServer } = require("../index");
const janitorLib = require("../lib/disk-janitor");
const diskRoutes = require("../routes/disk");

const GB = janitorLib.GB;
const DAY = 24 * 60 * 60 * 1000;

/** Create a file of `bytes` with an mtime `ageDays` in the past. */
function put(file, bytes, ageDays) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(file, t, t);
  // Age the folders created for it too (a folder's mtime changes when an entry is added),
  // but never the sandbox roots that hold fresh entries of other tests.
  for (let d = path.dirname(file); !ROOTS.has(d) && d.startsWith(ROOT); d = path.dirname(d)) {
    const st = fs.statSync(d);
    if (st.mtimeMs > t.getTime()) fs.utimesSync(d, t, t);
  }
}

const ROOTS = new Set();
function sandbox(name) {
  const base = fs.mkdtempSync(path.join(ROOT, `${name}-`));
  const env = {
    tmpDir: path.join(base, "Temp"),
    homeDir: path.join(base, "home"),
    localAppData: path.join(base, "local"),
    downloadsDir: path.join(base, "home", "Downloads"),
    projectDirs: () => [path.join(base, "proj")],
  };
  fs.mkdirSync(env.tmpDir, { recursive: true });
  for (const d of [base, env.tmpDir, env.homeDir, env.localAppData, env.downloadsDir]) ROOTS.add(d);
  ROOTS.add(path.join(env.tmpDir, "claude"));
  return { base, env };
}

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
        path: url.pathname,
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
        res.on("end", () =>
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null })
        );
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  server = await startServer(createApp(), 0);
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  try {
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
});

describe("disk janitor steps", () => {
  it("removes only old temporary entries and never the Claude folder or fresh files", async () => {
    const { env } = sandbox("steps");
    put(path.join(env.tmpDir, "old-dir", "a.bin"), 1000, 5);
    put(path.join(env.tmpDir, "fresh.bin"), 1000, 0);
    put(path.join(env.tmpDir, "claude", "x", "sess-old", "f.txt"), 500, 10);
    put(path.join(env.tmpDir, "claude", "x", "sess-new", "f.txt"), 500, 1);
    put(path.join(env.downloadsDir, "ClaudeCodeMonitor-Setup-2.4.6-x64.exe"), 2000, 2);
    put(path.join(env.downloadsDir, "wedding.mp4"), 3000, 100);
    put(path.join(env.localAppData, "npm-cache", "_cacache", "content-v2", "x"), 700, 3);
    put(path.join(env.homeDir, ".openclaw", "tmp", "job", "big.bin"), 4000, 9);
    put(path.join(path.dirname(env.tmpDir), "proj", ".next", "cache", "c.bin"), 800, 2);

    const j = janitorLib.createDiskJanitor({
      env,
      freeBytes: () => 0,
      totalBytes: () => 100 * GB,
      getConfig: () => janitorLib.normalizeConfig({}),
    });
    const r = await j.cleanup({ reason: "test" });
    const exists = (p) => fs.existsSync(p);
    assert.equal(exists(path.join(env.tmpDir, "old-dir")), false);
    assert.equal(exists(path.join(env.tmpDir, "fresh.bin")), true, "fresh temp kept");
    assert.equal(exists(path.join(env.tmpDir, "claude", "x", "sess-old")), false);
    assert.equal(
      exists(path.join(env.tmpDir, "claude", "x", "sess-new")),
      true,
      "active session kept"
    );
    assert.equal(
      exists(path.join(env.downloadsDir, "ClaudeCodeMonitor-Setup-2.4.6-x64.exe")),
      false
    );
    assert.equal(
      exists(path.join(env.downloadsDir, "wedding.mp4")),
      true,
      "personal file never touched"
    );
    assert.equal(exists(path.join(env.localAppData, "npm-cache", "_cacache")), false);
    assert.equal(exists(path.join(env.homeDir, ".openclaw", "tmp", "job")), false);
    assert.ok(r.freed >= 1000 + 500 + 2000 + 700 + 4000);
  });

  it("dry run measures but deletes nothing", async () => {
    const { env } = sandbox("dry");
    put(path.join(env.tmpDir, "old.bin"), 1234, 9);
    const j = janitorLib.createDiskJanitor({ env, freeBytes: () => 0, totalBytes: () => GB });
    const r = await j.cleanup({ dryRun: true });
    assert.equal(r.freed, 1234);
    assert.equal(fs.existsSync(path.join(env.tmpDir, "old.bin")), true);
  });

  it("stops once the target free space is reached", async () => {
    const { env } = sandbox("target");
    put(path.join(env.tmpDir, "old.bin"), 100, 9);
    const ran = [];
    const steps = ["a", "b", "c"].map((id) => ({
      id,
      run: async () => {
        ran.push(id);
        return { freed: 3 * GB, removed: 1 };
      },
    }));
    const j = janitorLib.createDiskJanitor({
      env,
      steps,
      freeBytes: () => 1 * GB,
      getConfig: () => ({ enabled: true, floorGb: 3, targetGb: 5 }),
    });
    await j.cleanup();
    assert.deepEqual(ran, ["a", "b"], "a: 1+3=4 GB < 5, b: 7 GB ≥ 5 → stop before c");
  });
});

describe("disk janitor scheduler", () => {
  it("cleans only below the floor, backs off when little was freed, and limits pushes", async () => {
    let free = 10 * GB;
    let freedPerRun = 0;
    let t = 1_000_000_000;
    const notes = [];
    const j = janitorLib.createDiskJanitor({
      steps: [{ id: "x", run: async () => ({ freed: freedPerRun, removed: 0 }) }],
      freeBytes: () => free,
      now: () => t,
      getConfig: () => ({ enabled: true, floorGb: 3, targetGb: 5 }),
      notify: (entry, stillLow) => notes.push(stillLow),
    });
    assert.equal(await j.tick(), null, "above the floor: nothing");
    free = 2 * GB;
    assert.ok(await j.tick(), "below the floor: runs");
    assert.deepEqual(notes, [true], "nothing freed, still low → one warning");
    t += 31 * 60 * 1000;
    assert.equal(await j.tick(), null, "freed almost nothing → waits 6 hours, not 30 minutes");
    t += 6 * 60 * 60 * 1000;
    assert.ok(await j.tick(), "runs again after 6 hours");
    assert.deepEqual(notes, [true], "no second 'still low' push within a day");
    freedPerRun = 1 * GB;
    t += 6 * 60 * 60 * 1000;
    assert.ok(await j.tick());
    assert.equal(notes.length, 2, "something freed → push");
    t += 31 * 60 * 1000;
    assert.ok(await j.tick(), "after a useful run the normal 30-minute gap applies");
  });

  it("a preview in progress never replaces a real cleanup", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const calls = [];
    const j = janitorLib.createDiskJanitor({
      steps: [
        {
          id: "x",
          run: async (c) => {
            calls.push(c.dryRun);
            if (c.dryRun) await gate;
            return { freed: 5, removed: 1 };
          },
        },
      ],
      freeBytes: () => 0,
      getConfig: () => ({ enabled: true, floorGb: 3, targetGb: 5 }),
    });
    const preview = j.cleanup({ dryRun: true });
    const real = j.cleanup({ dryRun: false });
    release();
    assert.equal((await preview).dry_run, true);
    assert.equal((await real).dry_run, false, "the real request gets a real run");
    assert.deepEqual(calls, [true, false]);
  });

  it("does nothing when disabled", async () => {
    const j = janitorLib.createDiskJanitor({
      steps: [],
      freeBytes: () => 0,
      getConfig: () => ({ enabled: false, floorGb: 3, targetGb: 5 }),
    });
    assert.equal(await j.tick(), null);
  });

  it("clamps settings and keeps target ≥ floor", () => {
    assert.deepEqual(janitorLib.normalizeConfig({ floorGb: 8, targetGb: 2 }), {
      enabled: true,
      floorGb: 8,
      targetGb: 8,
    });
    assert.equal(janitorLib.normalizeConfig({ floorGb: "x" }).floorGb, 3);
    assert.equal(janitorLib.normalizeConfig({ enabled: false }).enabled, false);
  });
});

describe("disk routes", () => {
  it("reports status, previews, saves settings, refuses cross-site", async () => {
    const { env } = sandbox("routes");
    put(path.join(env.tmpDir, "old.bin"), 2048, 9);
    diskRoutes.setJanitor(
      janitorLib.createDiskJanitor({
        env,
        freeBytes: () => 2 * GB,
        totalBytes: () => 100 * GB,
        historyFile: path.join(ROOT, "hist.json"),
      })
    );
    const st = await request("/api/disk");
    assert.equal(st.status, 200);
    assert.equal(st.body.below_floor, true);
    const prev = await request("/api/disk/cleanup", { method: "POST", body: { dryRun: true } });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.result.dry_run, true);
    assert.ok(fs.existsSync(path.join(env.tmpDir, "old.bin")), "preview deletes nothing");
    const bad = await request("/api/disk/cleanup", {
      method: "POST",
      body: {},
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(bad.status, 403);
    const saved = await request("/api/disk/config", {
      method: "PUT",
      body: { enabled: false, floorGb: 4, targetGb: 6 },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(janitorLib.readConfig(), { enabled: false, floorGb: 4, targetGb: 6 });
    const real = await request("/api/disk/cleanup", { method: "POST", body: {} });
    assert.equal(real.status, 200);
    assert.equal(fs.existsSync(path.join(env.tmpDir, "old.bin")), false);
    assert.equal((await request("/api/disk")).body.history.length, 1);
  });
});
