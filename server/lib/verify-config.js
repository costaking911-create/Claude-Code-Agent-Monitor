/**
 * @file verify-config.js
 * @description Per-project configuration for independent task verification ("Verified").
 * The commands that a verification runs live ONLY in `verify.json` next to the dashboard's `.env`
 * (outside every project, so an agent working in a repository cannot change what verifies it).
 * They are edited through the authenticated settings API and are never taken from model output,
 * hook payloads or the repository itself.
 *
 *   DASHBOARD_VERIFY_CONFIG=/abs/path/verify.json   override the file location (tests)
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const fs = require("fs");
const path = require("path");

const MAX_PROJECTS = 50;
const MAX_CMD = 2000;
const MAX_REGEX = 200;
const MIN_TIMEOUT = 30;
const MAX_TIMEOUT = 3600;
const DEFAULT_TIMEOUT = 900;
// node --test (TAP "# pass N" / spec "ℹ pass N"), vitest/jest ("Tests  N passed").
const DEFAULT_REGEX = "(?:# pass|ℹ pass|Tests?:?)\\s+(\\d+)";

/** Absolute path of verify.json. */
function configPath() {
  if (process.env.DASHBOARD_VERIFY_CONFIG) return path.resolve(process.env.DASHBOARD_VERIFY_CONFIG);
  const envPath = path.resolve(
    process.env.DASHBOARD_ENV_PATH || path.resolve(__dirname, "..", "..", ".env")
  );
  return path.join(path.dirname(envPath), "verify.json");
}

/** Normalise a directory for comparison (case-insensitive on Windows, no trailing slash). */
function normDir(dir) {
  let s = path.resolve(String(dir || "")).replace(/[\\/]+$/, "");
  if (process.platform === "win32") s = s.replace(/\//g, "\\").toLowerCase();
  return s;
}

class ConfigError extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
  }
}

/**
 * Validate and normalise one project entry. Throws ConfigError.
 * @param {any} p
 * @param {number} i - Index, for the error field.
 */
function validateProject(p, i) {
  if (!p || typeof p !== "object")
    throw new ConfigError("project must be an object", `projects[${i}]`);
  const field = (k) => `projects[${i}].${k}`;
  const dir = typeof p.dir === "string" ? p.dir.trim() : "";
  if (!dir || !path.isAbsolute(dir))
    throw new ConfigError("dir must be an absolute path", field("dir"));
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new ConfigError("dir does not exist", field("dir"));
  const str = (k, required) => {
    const v = p[k] == null ? "" : String(p[k]).trim();
    if (required && !v) throw new ConfigError(`${k} is required`, field(k));
    if (v.length > MAX_CMD || /[\r\n\0]/.test(v))
      throw new ConfigError(`${k} is invalid`, field(k));
    return v;
  };
  const setupCmd = str("setupCmd", false);
  const checkCmd = str("checkCmd", true);
  const testCountRegex =
    p.testCountRegex == null || p.testCountRegex === "" ? DEFAULT_REGEX : String(p.testCountRegex);
  if (testCountRegex.length > MAX_REGEX)
    throw new ConfigError("testCountRegex is too long", field("testCountRegex"));
  try {
    const re = new RegExp(testCountRegex);
    if (!/\((?!\?)/.test(re.source)) throw new Error("no group");
  } catch {
    throw new ConfigError(
      "testCountRegex must be a valid regex with one capture group",
      field("testCountRegex")
    );
  }
  let timeoutSec = Number(p.timeoutSec ?? DEFAULT_TIMEOUT);
  if (!Number.isFinite(timeoutSec)) timeoutSec = DEFAULT_TIMEOUT;
  timeoutSec = Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, Math.round(timeoutSec)));
  // Verify automatically after a session's turn ends (on a new commit). On unless set to false.
  const autoVerify = p.autoVerify !== false;
  const out = {
    dir: path.resolve(dir),
    setupCmd,
    checkCmd,
    testCountRegex,
    timeoutSec,
    autoVerify,
  };
  const visual = validateVisual(p.visual, field("visual"));
  if (visual) out.visual = visual;
  const blindReview = validateBlindReview(p.blindReview, field("blindReview"));
  if (blindReview) out.blindReview = blindReview;
  return out;
}

const clampNum = (v, min, max, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/**
 * Optional blind reviewer (server/lib/blind-review.js): a read-only `claude -p` that sees only
 * the owner's requests and the clean copy. `null`/`false`/missing = off. Throws ConfigError.
 * @param {any} v
 * @param {string} f - Error field prefix.
 */
function validateBlindReview(v, f) {
  if (v == null || v === false) return null;
  if (v === true) v = {};
  if (typeof v !== "object" || Array.isArray(v))
    throw new ConfigError("blindReview must be an object", f);
  // Switched off in the settings screen: keep its model/timeout for when it is switched on again.
  const enabled = v.enabled !== false;
  const model = v.model == null || v.model === "" ? "sonnet" : String(v.model).trim();
  // Passed to the CLI as one argument (no shell); a plain model name that cannot look like a flag.
  if (!/^[A-Za-z][A-Za-z0-9._:[\]-]{0,79}$/.test(model))
    throw new ConfigError("model is invalid", `${f}.model`);
  const out = { model, timeoutSec: Math.round(clampNum(v.timeoutSec, 60, 1800, 600)) };
  if (!enabled) out.enabled = false;
  return out;
}

/**
 * Optional visual check (server/lib/visual-check.js): open the app at phone size after the tests
 * pass. `null`/`false`/missing = off. Throws ConfigError.
 * @param {any} v
 * @param {string} f - Error field prefix.
 */
function validateVisual(v, f) {
  if (v == null || v === false) return null;
  if (typeof v !== "object" || Array.isArray(v))
    throw new ConfigError("visual must be an object", f);
  if (v.enabled === false) return null;
  const text = (k, max) => {
    const s = v[k] == null ? "" : String(v[k]).trim();
    if (s.length > max || /[\r\n\0]/.test(s)) throw new ConfigError(`${k} is invalid`, `${f}.${k}`);
    return s;
  };
  const serveCmd = text("serveCmd", MAX_CMD);
  const pagePath = text("path", 500) || "/";
  if (!pagePath.startsWith("/")) throw new ConfigError("path must start with /", `${f}.path`);
  const url = text("url", 500);
  if (url) {
    // Only the local copy is ever opened: a loopback address with the {port} placeholder.
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\{port\}(\/|$)/.test(url))
      throw new ConfigError("url must be http://127.0.0.1:{port}/…", `${f}.url`);
  }
  const readyExpr = text("readyExpr", 1000);
  const out = {
    path: pagePath,
    waitMs: Math.round(clampNum(v.waitMs, 0, 120000, 5000)),
    width: Math.round(clampNum(v.width, 240, 1600, 390)),
    height: Math.round(clampNum(v.height, 320, 3000, 844)),
    minVariety: clampNum(v.minVariety, 0, 1, 0.01),
  };
  if (serveCmd) out.serveCmd = serveCmd;
  if (serveCmd && url) out.url = url;
  if (readyExpr) out.readyExpr = readyExpr;
  return out;
}

/** Validate a whole config body ({ projects: [...] }). Throws ConfigError. */
function validateConfig(body) {
  const list = body && Array.isArray(body.projects) ? body.projects : null;
  if (!list) throw new ConfigError("projects must be an array", "projects");
  if (list.length > MAX_PROJECTS) throw new ConfigError("too many projects", "projects");
  const projects = list.map(validateProject);
  const seen = new Set();
  projects.forEach((p, i) => {
    const k = normDir(p.dir);
    if (seen.has(k)) throw new ConfigError("duplicate dir", `projects[${i}].dir`);
    seen.add(k);
  });
  const out = { projects };
  const queueFile = validateQueueFile(body.queueFile);
  if (queueFile) out.queueFile = queueFile;
  return out;
}

/**
 * The owner's task queue (Markdown table) whose 🔎 rows are flipped when their commit is
 * verified (server/lib/queue-sync.js). Absolute path to a .md file, or empty for none.
 */
function validateQueueFile(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > 500 || /[\r\n\0]/.test(s) || !path.isAbsolute(s) || !/\.md$/i.test(s))
    throw new ConfigError("queueFile must be an absolute path to a .md file", "queueFile");
  return path.resolve(s);
}

/** Read the config; a missing or broken file reads as no projects. */
function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const list = Array.isArray(raw?.projects) ? raw.projects : [];
    const projects = [];
    list.forEach((p, i) => {
      try {
        projects.push(validateProject(p, i));
      } catch {
        /* skip an entry that no longer validates (e.g. folder deleted) */
      }
    });
    const out = { projects };
    try {
      const queueFile = validateQueueFile(raw && raw.queueFile);
      if (queueFile) out.queueFile = queueFile;
    } catch {
      /* ignore a broken queueFile */
    }
    return out;
  } catch {
    return { projects: [] };
  }
}

/** Validate and atomically write the config. Returns the stored config. */
function writeConfig(body) {
  const cfg = validateConfig(body);
  // The settings screen sends only the projects: keep the queue file it does not know about.
  if (!body || !Object.prototype.hasOwnProperty.call(body, "queueFile")) {
    const kept = readConfig().queueFile;
    if (kept) cfg.queueFile = kept;
  }
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return cfg;
}

/** The configured project whose dir equals the given git top-level, or null. */
function findProject(topLevel, cfg = readConfig()) {
  if (!topLevel) return null;
  const k = normDir(topLevel);
  return cfg.projects.find((p) => normDir(p.dir) === k) || null;
}

module.exports = {
  configPath,
  readConfig,
  writeConfig,
  validateConfig,
  findProject,
  normDir,
  ConfigError,
  DEFAULT_REGEX,
};
