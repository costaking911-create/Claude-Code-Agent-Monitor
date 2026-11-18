/**
 * @file turn-notify.js
 * @description Server-side phone notifications when a Claude Code session finishes its turn or is
 * blocked waiting for the user. Unlike the in-page notifications (which need a dashboard tab open),
 * these go out from the server through Web Push to every subscribed device, so a phone with the
 * installed dashboard PWA is notified even when the app is closed.
 *
 * Opt-in through the environment (e.g. the desktop app's `.env`):
 *   DASHBOARD_PUSH_EVENTS=stop,waiting,error   which moments notify (default: off)
 *     (verification results — kinds verified / verify_failed — are sent whenever any kind is
 *      enabled, since the user asked for them; or alone with DASHBOARD_PUSH_EVENTS=verify)
 *   DASHBOARD_PUSH_LANG=he                     message language: en (default) or he
 *   DASHBOARD_PUSH_NATIVE=0                    also show a desktop notification (default 1)
 * Repeats for the same session and kind are throttled.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const path = require("path");
const { sendPushToAll } = require("./push");

/** Minimum gap between two notifications of the same kind for one session. */
const THROTTLE_MS = 45_000;

/** @type {Map<string, number>} `${sessionId}|${kind}` → last sent (ms). */
const lastSent = new Map();

const TEXT = {
  en: {
    stop: (p, s) => [`✅ ${p}`, `${s} finished — ready for your next message`],
    waiting: (p, s, m) => [`❓ ${p}`, `${s} is waiting for you${m ? `: ${m}` : ""}`],
    error: (p, s) => [`⛔ ${p}`, `${s} stopped with an error`],
    verified: (p, s) => [`🟢 Verified: ${p}`, `${s} — tests re-run independently and passed`],
    verify_failed: (p, s, m) => [`🔴 Not verified: ${p}`, `${s}${m ? ` — ${m}` : ""}`],
  },
  he: {
    stop: (p, s) => [`✅ ${p}`, `${s} – הסתיים, מחכה להודעה הבאה שלך`],
    waiting: (p, s, m) => [`❓ ${p}`, `${s} – מחכה לך${m ? `: ${m}` : ""}`],
    error: (p, s) => [`⛔ ${p}`, `${s} – נעצר עם שגיאה`],
    verified: (p, s) => [`🟢 אומת: ${p}`, `${s} – הבדיקות רצו שוב בנפרד ועברו`],
    verify_failed: (p, s, m) => [`🔴 לא אומת: ${p}`, `${s}${m ? ` – ${m}` : ""}`],
  },
};

/** Kinds enabled through DASHBOARD_PUSH_EVENTS. */
function enabledKinds() {
  const kinds = new Set(
    String(process.env.DASHBOARD_PUSH_EVENTS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  // A verification is started by the user, so its result notifies whenever push is on at all.
  if (kinds.size > 0) {
    kinds.add("verified");
    kinds.add("verify_failed");
  }
  return kinds;
}

/** Project name for a working directory, folding `.claude/worktrees/<x>` into the repository. */
function projectName(cwd) {
  if (!cwd) return "Claude Code";
  const root = String(cwd).replace(
    /[\\/](?:\.claude[\\/]worktrees|\.worktrees)[\\/][^\\/]+(?:[\\/].*)?$/i,
    ""
  );
  return path.basename(root) || root;
}

/** Shorten free text for a notification line. */
function clip(text, max) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Notify subscribed devices that a session reached a turn boundary.
 *
 * @param {import("better-sqlite3").Database} db - Dashboard database (push subscriptions).
 * @param {{ id: string, name?: string|null, cwd?: string|null } | undefined} session - The session row.
 * @param {"stop"|"waiting"|"error"|"verified"|"verify_failed"} kind - What happened.
 * @param {string} [detail] - Optional extra text (e.g. the permission prompt).
 * @returns {boolean} Whether a notification was dispatched.
 */
function notifyTurn(db, session, kind, detail) {
  if (!session || !enabledKinds().has(kind)) return false;
  const key = `${session.id}|${kind}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < THROTTLE_MS) return false;
  lastSent.set(key, now);
  if (lastSent.size > 2000) lastSent.clear();

  const lang = String(process.env.DASHBOARD_PUSH_LANG || "en").toLowerCase() === "he" ? "he" : "en";
  const label = clip(session.name || `Session ${String(session.id).slice(0, 8)}`, 60);
  const [title, body] = TEXT[lang][kind](projectName(session.cwd), label, clip(detail, 80));
  const native = process.env.DASHBOARD_PUSH_NATIVE !== "0";
  // Fire and forget: the hook request must never wait on a push service.
  sendPushToAll(db, title, body, {
    native,
    url: `/sessions/${encodeURIComponent(session.id)}`,
    tag: kind.startsWith("verif") ? `verify-${session.id}` : `session-${session.id}`,
  }).catch(() => undefined);
  return true;
}

module.exports = { notifyTurn, projectName, _lastSent: lastSent };
