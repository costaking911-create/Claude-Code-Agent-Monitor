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
  return { dir: path.resolve(dir), setupCmd, checkCmd, testCountRegex, timeoutSec, autoVerify };
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
  return { projects };
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
    return { projects };
  } catch {
    return { projects: [] };
  }
}

/** Validate and atomically write the config. Returns the stored config. */
function writeConfig(body) {
  const cfg = validateConfig(body);
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
