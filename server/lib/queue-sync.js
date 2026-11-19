/**
 * @file queue-sync.js
 * @description Connects "Verified" to the owner's task queue: a Markdown table
 * (`| # | project | task | status | added | result |`) whose path is `queueFile` in
 * verify.json. When a session finishes a task it marks the row "🔎" (waiting for verification) and
 * writes the commit's short sha into the result cell. When a verification of that commit ends,
 * this module flips such rows to ✅ (verified) or ⛔ (the check failed, with the reason) — so a
 * task is only "done" once the dashboard itself has checked it, never on the agent's word.
 * Only rows whose status cell is exactly "🔎" and whose result mentions the sha are touched; the
 * rest of the file is kept byte for byte. The write is atomic (temp file + rename).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const fs = require("fs");
const path = require("path");

const WAITING = "🔎";
const MAX_FILE = 2 * 1024 * 1024;

/** Split a Markdown table row into its cells (without the outer pipes), or null. */
function cells(line) {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return null;
  return t.slice(1, -1).split("|");
}

/**
 * Update the rows that wait for this commit.
 * @param {object} o
 * @param {string} o.file - Absolute path of the queue (.md).
 * @param {string} o.commitSha - Full or short sha of the verified commit.
 * @param {"verified"|"failed"|"error"} o.verdict
 * @param {string|null} [o.reason]
 * @param {(f: string) => string} [o.read] - Injected for tests.
 * @returns {{ changed: number }}
 */
function markQueue(o) {
  const sha = String(o.commitSha || "").slice(0, 7);
  if (!o.file || !/^[0-9a-f]{7}$/i.test(sha)) return { changed: 0 };
  // An "error" verdict (low disk, restart…) says nothing about the work: leave the row waiting.
  if (o.verdict !== "verified" && o.verdict !== "failed") return { changed: 0 };
  let text;
  try {
    const st = fs.statSync(o.file);
    if (!st.isFile() || st.size > MAX_FILE) return { changed: 0 };
    text = fs.readFileSync(o.file, "utf8");
  } catch {
    return { changed: 0 };
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let changed = 0;
  const shaRe = new RegExp(`\\b${sha}`, "i");
  for (let i = 0; i < lines.length; i++) {
    const c = cells(lines[i]);
    if (!c || c.length < 6) continue;
    if (c[3].trim() !== WAITING || !shaRe.test(c[5])) continue;
    const ok = o.verdict === "verified";
    c[3] = ` ${ok ? "✅" : "⛔"} `;
    const note = ok
      ? "אומת ✔"
      : `האימות נכשל: ${String(o.reason || "")
          .replace(/[|\r\n]+/g, " ")
          .slice(0, 160)}`;
    c[5] = ` ${c[5].trim()} · ${note} `;
    const indent = lines[i].match(/^\s*/)[0];
    lines[i] = `${indent}|${c.join("|")}|`;
    changed++;
  }
  if (!changed) return { changed: 0 };
  const tmp = path.join(path.dirname(o.file), `.${path.basename(o.file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, lines.join(eol), "utf8");
  fs.renameSync(tmp, o.file);
  return { changed };
}

module.exports = { markQueue, WAITING };
