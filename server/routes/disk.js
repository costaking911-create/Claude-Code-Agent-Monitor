/**
 * @file disk.js
 * @description API for the automatic disk cleanup (server/lib/disk-janitor.js), mounted at
 * /api/disk: GET / (free space, settings, recent runs, suggestions), POST /cleanup
 * (`{ dryRun: true }` previews without deleting), PUT /config. State-changing requests must
 * come from the dashboard's own page (same-host Origin check) on top of the global token guard.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const path = require("path");
const { Router } = require("express");
const { db } = require("../db");
const { broadcast } = require("../websocket");
const { getDataDir } = require("../lib/claude-home");
const { notifyDisk } = require("../lib/turn-notify");
const verifyConfig = require("../lib/verify-config");
const janitorLib = require("../lib/disk-janitor");
const { sameHostGuard } = require("./verifications");

let janitor = null;
/** The process-wide janitor (created on first use; tests may replace it). */
function getJanitor() {
  if (!janitor) {
    janitor = janitorLib.createDiskJanitor({
      broadcast,
      notify: (entry, stillLow) => notifyDisk(db, entry, stillLow),
      historyFile: path.join(getDataDir(), "disk-janitor-history.json"),
      env: { projectDirs: () => verifyConfig.readConfig().projects.map((p) => p.dir) },
    });
  }
  return janitor;
}
function setJanitor(j) {
  janitor = j;
}

const router = Router();

router.get("/", (_req, res) => {
  res.json({ path: janitorLib.configPath(), ...getJanitor().status() });
});

router.post("/cleanup", sameHostGuard, async (req, res) => {
  const dryRun = Boolean(req.body && req.body.dryRun);
  try {
    const result = await getJanitor().cleanup({ dryRun, reason: dryRun ? "preview" : "manual" });
    res.json({ result, ...getJanitor().status() });
  } catch {
    res.status(500).json({ error: { code: "INTERNAL", message: "cleanup failed" } });
  }
});

router.put("/config", sameHostGuard, (req, res) => {
  try {
    const config = janitorLib.writeConfig(req.body || {});
    res.json({ path: janitorLib.configPath(), ...getJanitor().status(), config });
  } catch {
    res.status(500).json({ error: { code: "INTERNAL", message: "could not save settings" } });
  }
});

module.exports = { router, getJanitor, setJanitor };
