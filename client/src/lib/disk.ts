/**
 * @file disk.ts
 * @description Small helpers shared by the disk cleanup settings card and the sidebar/top-bar
 * free-space indicator: byte formatting in GB/MB (1024-based, like the server), the
 * ok/low/critical level against the configured target and floor, and a short-lived shared
 * `GET /api/disk` load so several indicators on one screen make one request.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { api } from "./api";
import type { DiskStatus } from "./types";

const MB = 1024 ** 2;
export const GB = 1024 ** 3;

/**
 * Format a byte count as "12.3 GB" or "456 MB" (numbers and units are not translated).
 *
 * @param bytes - Byte count; null/undefined/NaN renders as an em dash.
 * @returns The formatted size.
 */
export function formatDiskBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const b = Math.max(0, bytes);
  if (b >= GB) return `${(b / GB).toFixed(b >= 100 * GB ? 0 : 1)} GB`;
  if (b >= MB) return `${Math.round(b / MB)} MB`;
  if (b === 0) return "0 MB";
  return "<1 MB";
}

/** How worried to be about the free space. */
export type DiskLevel = "ok" | "low" | "critical" | "unknown";

/**
 * Level of the free space: critical below the floor, low below the target, else ok.
 *
 * @param status - The disk status (or null while loading).
 * @returns The level.
 */
export function diskLevel(status: DiskStatus | null): DiskLevel {
  if (!status || status.free_bytes == null) return "unknown";
  if (status.below_floor || status.free_bytes < status.config.floorGb * GB) return "critical";
  if (status.free_bytes < status.config.targetGb * GB) return "low";
  return "ok";
}

let inflight: Promise<DiskStatus> | null = null;
let cached: { at: number; value: DiskStatus } | null = null;
const SHARE_MS = 15_000;

/**
 * Load `GET /api/disk`, sharing one request (and its result for 15 s) between callers.
 *
 * @param force - Skip the short cache (after a cleanup finished).
 * @returns The disk status.
 */
export function loadDiskStatus(force = false): Promise<DiskStatus> {
  if (!force && cached && Date.now() - cached.at < SHARE_MS) return Promise.resolve(cached.value);
  if (!force && inflight) return inflight;
  const p = api.disk.status().then(
    (value) => {
      cached = { at: Date.now(), value };
      if (inflight === p) inflight = null;
      return value;
    },
    (err) => {
      if (inflight === p) inflight = null;
      throw err;
    }
  );
  inflight = p;
  return p;
}

const listeners = new Set<(value: DiskStatus) => void>();

/**
 * Be told when the settings card has a fresh status (after saving or a cleanup), so the
 * indicators update their color at once instead of at their next 5-minute check.
 *
 * @param fn - Called with the new status.
 * @returns Unsubscribe.
 */
export function onDiskStatus(fn: (value: DiskStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Forget the shared result (tests), or replace it with a fresh one and tell the indicators. */
export function resetDiskStatusCache(value?: DiskStatus): void {
  inflight = null;
  cached = value ? { at: Date.now(), value } : null;
  if (value) for (const fn of listeners) fn(value);
}
