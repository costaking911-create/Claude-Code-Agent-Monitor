/**
 * @file disk-janitor.js
 * @description Automatic disk cleanup for small, nearly full machines. Every ~10 minutes (and on
 * demand) it checks free space on the drive that holds the temp folder; below the floor (default
 * 3 GB) it runs SAFE steps in order — only re-creatable or clearly temporary data, oldest first —
 * until the target (default 5 GB) is reached. Never touches source code, git repositories,
 * transcripts in ~/.claude/projects, the dashboard database, the Recycle Bin or personal folders.
 * Every run (and every dry-run preview) is recorded with what each step freed. Settings live in
 * `disk-janitor.json` next to the dashboard `.env` (DASHBOARD_DISK_JANITOR_CONFIG overrides).
 * Bigger savings that need the owner's decision (Windows Update cache, hibernation, large app
 * data) are reported as suggestions only.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const GB = 1024 ** 3;
const DAY = 24 * 60 * 60 * 1000;
const DEFAULTS = { enabled: true, floorGb: 3, targetGb: 5 };
const CHECK_EVERY_MS = 10 * 60 * 1000;
const MIN_GAP_BETWEEN_AUTO_RUNS_MS = 30 * 60 * 1000;
/** After an automatic run that freed less than LITTLE_BYTES, the next one waits SLOW_GAP_MS. */
const LITTLE_BYTES = 100 * 1024 ** 2;
const SLOW_GAP_MS = 6 * 60 * 60 * 1000;
const HISTORY_MAX = 50;
const WALK_LIMIT = 300000;

/* ------------------------------------------------------------------ config */

function configPath() {
  if (process.env.DASHBOARD_DISK_JANITOR_CONFIG) {
    return path.resolve(process.env.DASHBOARD_DISK_JANITOR_CONFIG);
  }
  const envPath = path.resolve(
    process.env.DASHBOARD_ENV_PATH || path.resolve(__dirname, "..", "..", ".env")
  );
  return path.join(path.dirname(envPath), "disk-janitor.json");
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function normalizeConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const floorGb = clampNum(r.floorGb, 0.5, 100, DEFAULTS.floorGb);
  const targetGb = Math.max(floorGb, clampNum(r.targetGb, 0.5, 200, DEFAULTS.targetGb));
  return { enabled: r.enabled !== false, floorGb, targetGb };
}

function readConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(configPath(), "utf8")));
  } catch {
    return normalizeConfig({});
  }
}

function writeConfig(body) {
  const cfg = normalizeConfig(body);
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return cfg;
}

/* ------------------------------------------------------------------ fs helpers */

/** Size and newest mtime of a file or folder tree (bounded; links are not followed). */
async function measure(p, fsp = fs.promises) {
  let size = 0;
  // Conservative age: the newest mtime of every file AND folder inside, so a folder a running
  // program still adds to or removes from never counts as old.
  let newestFile = 0;
  let newestDir = 0;
  let files = 0;
  let seen = 0;
  const stack = [p];
  while (stack.length && seen < WALK_LIMIT) {
    const cur = stack.pop();
    let st;
    try {
      st = await fsp.lstat(cur);
    } catch {
      continue;
    }
    seen++;
    if (st.isSymbolicLink()) {
      files++;
      newestFile = Math.max(newestFile, st.mtimeMs || 0);
      continue;
    }
    if (st.isDirectory()) {
      newestDir = Math.max(newestDir, st.mtimeMs || 0);
      let names = [];
      try {
        names = await fsp.readdir(cur);
      } catch {
        names = [];
      }
      for (const n of names) stack.push(path.join(cur, n));
    } else {
      size += st.size || 0;
      files++;
      newestFile = Math.max(newestFile, st.mtimeMs || 0);
    }
  }
  // A walk cut off by the limit is never treated as old.
  const newest = stack.length ? Number.MAX_SAFE_INTEGER : Math.max(newestFile, newestDir);
  return { size, newest, files };
}

/** Remove a path; returns whether it is gone (locked files make this false). */
async function removePath(p, fsp = fs.promises) {
  try {
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    /* fall through to the existence check */
  }
  try {
    await fsp.lstat(p);
    return false;
  } catch {
    return true;
  }
}

/**
 * Delete direct children of `dir` whose whole tree is older than `maxAgeMs` (newest mtime inside).
 * `skip(name)` keeps an entry. Returns { freed, removed, kept }.
 */
async function pruneChildren(dir, { maxAgeMs, skip = () => false, dryRun, now, fsp }) {
  const out = { freed: 0, removed: 0, kept: 0 };
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (skip(name)) continue;
    const full = path.join(dir, name);
    const m = await measure(full, fsp);
    if (!m.newest || now - m.newest < maxAgeMs) continue;
    if (dryRun) {
      out.freed += m.size;
      out.removed++;
      continue;
    }
    if (await removePath(full, fsp)) {
      out.freed += m.size;
      out.removed++;
    } else {
      out.kept++;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ steps */

/**
 * The cleanup steps, safest first. Each step: { id, run(ctx) → { freed, removed, kept? } }.
 * Paths come from the environment so tests can point them at a temp folder.
 */
function defaultSteps(env = {}) {
  const tmp = env.tmpDir || os.tmpdir();
  const home = env.homeDir || os.homedir();
  const local = env.localAppData || process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const downloads = env.downloadsDir || path.join(home, "Downloads");
  const extraInstallerDirs = env.installerDirs || [];
  const projectDirs = env.projectDirs || (() => []);

  const isOurInstaller = (n) => /^ClaudeCodeMonitor-.*\.(exe|zip|blockmap)$/i.test(n);

  return [
    {
      // Leftover clean copies from verifications whose owner process is gone.
      id: "verify_copies",
      run: (c) =>
        pruneChildren(tmp, {
          ...c,
          maxAgeMs: 6 * 60 * 60 * 1000,
          skip: (n) => !n.startsWith("ccam-verify-"),
        }),
    },
    {
      // Downloaded Monitor builds: always re-downloadable from CI.
      id: "monitor_installers",
      run: async (c) => {
        const sum = { freed: 0, removed: 0, kept: 0 };
        for (const dir of [downloads, tmp, ...extraInstallerDirs]) {
          const r = await pruneChildren(dir, {
            ...c,
            maxAgeMs: DAY,
            skip: (n) => !isOurInstaller(n),
          });
          sum.freed += r.freed;
          sum.removed += r.removed;
          sum.kept += r.kept;
        }
        return sum;
      },
    },
    {
      // Temp files and folders untouched for 3+ days (not Claude session folders, not our copies).
      id: "temp_old",
      run: (c) =>
        pruneChildren(tmp, {
          ...c,
          maxAgeMs: 3 * DAY,
          skip: (n) => n === "claude" || n.startsWith("ccam-verify-"),
        }),
    },
    {
      // Scratch folders of Claude sessions idle for 7+ days.
      id: "claude_scratch_old",
      run: async (c) => {
        const sum = { freed: 0, removed: 0, kept: 0 };
        const root = path.join(tmp, "claude");
        let groups = [];
        try {
          groups = await c.fsp.readdir(root);
        } catch {
          return sum;
        }
        for (const g of groups) {
          const r = await pruneChildren(path.join(root, g), { ...c, maxAgeMs: 7 * DAY });
          sum.freed += r.freed;
          sum.removed += r.removed;
          sum.kept += r.kept;
        }
        return sum;
      },
    },
    {
      // npm download cache. Not `_npx`: a package run through npx every day (e.g. an MCP server)
      // keeps its old mtime, so its age says nothing about use.
      id: "npm_cache",
      run: async (c) => {
        const sum = { freed: 0, removed: 0, kept: 0 };
        const base = path.join(local, "npm-cache");
        // `_cacache` goes as a whole (like `npm cache clean`) only when nothing in it was touched
        // for 2 days, so no install can be using it right now.
        for (const [dir, age, skip] of [[base, 2 * DAY, (n) => n !== "_cacache"]]) {
          const r = await pruneChildren(dir, { ...c, maxAgeMs: age, skip });
          sum.freed += r.freed;
          sum.removed += r.removed;
          sum.kept += r.kept;
        }
        return sum;
      },
    },
    {
      // Other tools' temp and updater download folders.
      id: "tool_temp",
      run: async (c) => {
        const sum = { freed: 0, removed: 0, kept: 0 };
        for (const dir of [
          path.join(home, ".openclaw", "tmp"),
          path.join(local, "agent-orchestrator-updater"),
        ]) {
          const r = await pruneChildren(dir, { ...c, maxAgeMs: 7 * DAY });
          sum.freed += r.freed;
          sum.removed += r.removed;
          sum.kept += r.kept;
        }
        return sum;
      },
    },
    {
      // Next.js build cache in the configured projects (rebuilt automatically).
      id: "next_cache",
      run: async (c) => {
        const sum = { freed: 0, removed: 0, kept: 0 };
        for (const dir of projectDirs()) {
          const cache = path.join(dir, ".next", "cache");
          const m = await measure(cache, c.fsp);
          if (!m.size || c.now - m.newest < DAY) continue;
          if (c.dryRun || (await removePath(cache, c.fsp))) {
            sum.freed += m.size;
            sum.removed++;
          } else sum.kept++;
        }
        return sum;
      },
    },
  ];
}

/** Bigger savings that need the owner's decision; reported, never done automatically. */
function suggestions() {
  if (process.platform !== "win32") return [];
  return [
    { id: "windows_update", hint: "Disk Cleanup › Windows Update Cleanup (admin)" },
    { id: "hibernation", hint: "powercfg /h /type reduced (admin)" },
    { id: "downloads", hint: "Old videos / installers in Downloads" },
    { id: "worktrees", hint: "Old git worktrees in project .claude/worktrees" },
    { id: "app_data", hint: "Large app databases (e.g. Deepchart) – clean inside the app" },
  ];
}

/* ------------------------------------------------------------------ janitor */

function createDiskJanitor(deps = {}) {
  const fsp = deps.fsp || fs.promises;
  const now = deps.now || (() => Date.now());
  const notify = deps.notify || (() => {});
  const broadcast = deps.broadcast || (() => {});
  const getConfig = deps.getConfig || readConfig;
  const historyFile = deps.historyFile;
  const steps = deps.steps || defaultSteps(deps.env);
  const freeBytes =
    deps.freeBytes ||
    (() => {
      const s = fs.statfsSync(deps.env?.tmpDir || os.tmpdir());
      return Number(s.bavail) * Number(s.bsize);
    });
  const totalBytes =
    deps.totalBytes ||
    (() => {
      const s = fs.statfsSync(deps.env?.tmpDir || os.tmpdir());
      return Number(s.blocks) * Number(s.bsize);
    });

  /** @type {{ promise: Promise<any>, dryRun: boolean } | null} */
  let running = null;
  let lastAuto = 0;
  let lastAutoFreed = Infinity;
  let lastLowWarning = 0;

  function readHistory() {
    if (!historyFile) return [];
    try {
      const list = JSON.parse(fs.readFileSync(historyFile, "utf8"));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  function saveHistory(entry) {
    if (!historyFile) return;
    try {
      const list = [entry, ...readHistory()].slice(0, HISTORY_MAX);
      fs.mkdirSync(path.dirname(historyFile), { recursive: true });
      fs.writeFileSync(historyFile, JSON.stringify(list, null, 1), "utf8");
    } catch {
      /* history is best effort */
    }
  }

  function status() {
    let free = null;
    let total = null;
    try {
      free = freeBytes();
      total = totalBytes();
    } catch {
      /* unknown */
    }
    const cfg = getConfig();
    return {
      free_bytes: free,
      total_bytes: total,
      config: cfg,
      below_floor: free != null && free < cfg.floorGb * GB,
      running: Boolean(running),
      history: readHistory().slice(0, 10),
      suggestions: suggestions(),
    };
  }

  /**
   * Run the steps in order until the target is reached (a dry run measures every step).
   * @param {{ dryRun?: boolean, reason?: string }} opts
   */
  async function cleanup({ dryRun = false, reason = "manual" } = {}) {
    if (running) {
      // A preview in progress never stands in for a real run: wait for it, then clean.
      if (running.dryRun && !dryRun) {
        await running.promise.catch(() => undefined);
        return cleanup({ dryRun, reason });
      }
      return running.promise;
    }
    const promise = (async () => {
      const cfg = getConfig();
      const startedAt = new Date(now()).toISOString();
      const freeBefore = safeFree();
      const target = cfg.targetGb * GB;
      const results = [];
      let freedTotal = 0;
      for (const step of steps) {
        if (!dryRun && freeBefore != null && freeBefore + freedTotal >= target) break;
        let r;
        try {
          r = await step.run({ dryRun, now: now(), fsp });
        } catch (e) {
          r = { freed: 0, removed: 0, error: String(e && e.message ? e.message : e).slice(0, 200) };
        }
        freedTotal += r.freed || 0;
        results.push({ id: step.id, ...r });
      }
      const entry = {
        at: startedAt,
        reason,
        dry_run: dryRun,
        free_before: freeBefore,
        free_after: dryRun ? freeBefore : safeFree(),
        freed: freedTotal,
        steps: results,
      };
      if (!dryRun) saveHistory(entry);
      broadcast("disk_cleanup", entry);
      return entry;
    })();
    running = { promise, dryRun };
    try {
      return await promise;
    } finally {
      if (running && running.promise === promise) running = null;
    }
  }

  function safeFree() {
    try {
      return freeBytes();
    } catch {
      return null;
    }
  }

  /** One scheduler tick: clean automatically when below the floor (at most every 30 min). */
  async function tick() {
    const cfg = getConfig();
    if (!cfg.enabled) return null;
    const free = safeFree();
    if (free == null || free >= cfg.floorGb * GB) return null;
    // When the last automatic run found almost nothing, wait longer before scanning again.
    const gap = lastAutoFreed < LITTLE_BYTES ? SLOW_GAP_MS : MIN_GAP_BETWEEN_AUTO_RUNS_MS;
    if (now() - lastAuto < gap) return null;
    lastAuto = now();
    const entry = await cleanup({ reason: "auto" });
    lastAutoFreed = entry.freed || 0;
    const stillLow = entry.free_after != null && entry.free_after < cfg.floorGb * GB;
    // Push when something was freed; the "still almost full" reminder at most once a day.
    let send = (entry.freed || 0) >= LITTLE_BYTES;
    if (!send && stillLow && now() - lastLowWarning >= DAY) send = true;
    if (send && stillLow) lastLowWarning = now();
    if (send) {
      try {
        notify(entry, stillLow);
      } catch {
        /* never fail on a push */
      }
    }
    return entry;
  }

  function start() {
    const boot = setTimeout(() => void tick().catch(() => undefined), 60 * 1000);
    if (boot.unref) boot.unref();
    const timer = setInterval(() => void tick().catch(() => undefined), CHECK_EVERY_MS);
    if (timer.unref) timer.unref();
    return () => {
      clearTimeout(boot);
      clearInterval(timer);
    };
  }

  return { status, cleanup, tick, start };
}

module.exports = {
  createDiskJanitor,
  defaultSteps,
  measure,
  pruneChildren,
  readConfig,
  writeConfig,
  normalizeConfig,
  configPath,
  GB,
};
