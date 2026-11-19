/**
 * @file verifications.js
 * @description API for independent task verification ("Verified"). A client can only ask to
 * verify a session — it never sends a command: what runs comes from the dashboard's own
 * verify.json (edited through the config endpoints here). Mounted at /api/sessions (for
 * /:id/verify and /:id/verifications) and at /api/verifications (latest, log, config).
 * State-changing requests must come from the dashboard's own page (same-host Origin check), on
 * top of the global DASHBOARD_TOKEN guard.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Router } = require("express");
const { db, stmts } = require("../db");
const { broadcast } = require("../websocket");
const { getDataDir } = require("../lib/claude-home");
const { notifyTurn } = require("../lib/turn-notify");
const verifyConfig = require("../lib/verify-config");
const {
  createVerifyRunner,
  publicRow,
  screenshotPath,
  VerifyError,
} = require("../lib/verify-runner");

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

let runner = null;
/** The process-wide runner (created on first use; tests may replace it). */
function getRunner() {
  if (!runner) {
    runner = createVerifyRunner({
      db,
      broadcast,
      notify: (session, kind, detail) => notifyTurn(db, session, kind, detail),
      logDir: path.join(getDataDir(), "verifications"),
    });
    runner.recover();
  }
  return runner;
}
function setRunner(r) {
  runner = r;
}

/**
 * Reject browser requests from another site. Allowed: no Origin/Referer (CLI), a loopback
 * origin, or an origin whose host equals this request's Host / X-Forwarded-Host (the dashboard's
 * own page, also when served over Tailscale HTTPS).
 */
function sameHostGuard(req, res, next) {
  const raw = req.headers.origin || req.headers.referer;
  if (!raw) return next();
  let host;
  let hostname;
  try {
    const u = new URL(raw);
    host = u.host.toLowerCase();
    hostname = u.hostname.toLowerCase();
  } catch {
    host = null;
  }
  const own = [req.headers.host, req.headers["x-forwarded-host"]]
    .filter(Boolean)
    .map((h) => String(h).split(",")[0].trim().toLowerCase());
  if (host && (LOOPBACK.has(hostname) || own.includes(host))) return next();
  return res
    .status(403)
    .json({ error: { code: "EBADORIGIN", message: "cross-origin requests are not allowed" } });
}

const sessionRoutes = Router();

sessionRoutes.post("/:id/verify", sameHostGuard, async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (Object.keys(body).length > 0) {
    return res.status(400).json({
      error: {
        code: "INVALID",
        message: "this endpoint takes no body; commands come from verify.json",
      },
    });
  }
  const session = stmts.getSession.get(req.params.id);
  if (!session)
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "session not found" } });
  try {
    const verification = await getRunner().start(session);
    return res.status(202).json({ verification });
  } catch (e) {
    if (e instanceof VerifyError) {
      return res.status(e.status).json({ error: { code: e.code, message: e.message } });
    }
    return res
      .status(500)
      .json({ error: { code: "INTERNAL", message: "could not start verification" } });
  }
});

sessionRoutes.get("/:id/verifications", async (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session)
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "session not found" } });
  const rows = db
    .prepare("SELECT * FROM verifications WHERE session_id = ? ORDER BY id DESC LIMIT 20")
    .all(session.id)
    .map(publicRow);
  const current_head = rows.length ? await getRunner().currentHead(session.cwd) : null;
  res.json({ verifications: rows, current_head });
});

const verificationRoutes = Router();

verificationRoutes.get("/latest", (req, res) => {
  const ids = String(req.query.session_ids || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);
  const latest = {};
  if (ids.length) {
    const marks = ids.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT v.* FROM verifications v
         JOIN (SELECT session_id, MAX(id) AS id FROM verifications WHERE session_id IN (${marks}) GROUP BY session_id) m
           ON m.id = v.id`
      )
      .all(...ids);
    for (const r of rows) latest[r.session_id] = publicRow(r);
  }
  res.json({ latest });
});

verificationRoutes.get("/config", (_req, res) => {
  res.json({ path: verifyConfig.configPath(), projects: verifyConfig.readConfig().projects });
});

verificationRoutes.put("/config", sameHostGuard, (req, res) => {
  try {
    const cfg = verifyConfig.writeConfig(req.body);
    res.json({ path: verifyConfig.configPath(), projects: cfg.projects });
  } catch (e) {
    if (e instanceof verifyConfig.ConfigError) {
      return res
        .status(400)
        .json({ error: { code: "INVALID", message: e.message, field: e.field } });
    }
    res.status(500).json({ error: { code: "INTERNAL", message: "could not save verify.json" } });
  }
});

verificationRoutes.get("/:id/log", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: { code: "INVALID", message: "bad id" } });
  }
  const row = db.prepare("SELECT log_path FROM verifications WHERE id = ?").get(id);
  if (!row)
    return res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "verification not found" } });
  if (!row.log_path) return res.type("text/plain").send("");
  try {
    const fd = fs.openSync(row.log_path, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, MAX_LOG_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const prefix = size > len ? "[… earlier output omitted …]\n" : "";
      res.type("text/plain; charset=utf-8").send(prefix + buf.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "log file is gone" } });
  }
});

// The visual check's phone-size screenshot (PNG), when the project has one configured.
verificationRoutes.get("/:id/screenshot", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: { code: "INVALID", message: "bad id" } });
  }
  const row = db.prepare("SELECT log_path FROM verifications WHERE id = ?").get(id);
  const file = row ? screenshotPath(row) : null;
  if (!file)
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "no screenshot" } });
  res.set("Cache-Control", "private, max-age=3600");
  res.type("image/png").sendFile(path.resolve(file), (err) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "screenshot is gone" } });
    }
  });
});

module.exports = { sessionRoutes, verificationRoutes, sameHostGuard, getRunner, setRunner };
