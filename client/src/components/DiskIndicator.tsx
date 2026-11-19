/**
 * @file DiskIndicator.tsx
 * @description Small free-disk-space chip for the sidebar footer and the phone top bar: shows
 * the free GB (amber below the cleanup target, red below the floor) and links to the disk
 * cleanup section of Settings. Loads `GET /api/disk` (shared between instances), re-checks every
 * 5 minutes and after a live `disk_cleanup` message. Renders nothing when the size is unknown
 * or the request fails, so it never gets in the way.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { HardDrive } from "lucide-react";
import { eventBus } from "../lib/eventBus";
import { diskLevel, formatDiskBytes, loadDiskStatus, onDiskStatus } from "../lib/disk";
import type { DiskStatus } from "../lib/types";

const REFRESH_MS = 5 * 60 * 1000;

/** Props for {@link DiskIndicator}. */
interface DiskIndicatorProps {
  /** "row" = full-width sidebar row, "icon" = collapsed sidebar, "chip" = phone top bar. */
  variant: "row" | "icon" | "chip";
}

/**
 * Free disk space indicator linking to Settings › Disk cleanup.
 *
 * @param props See {@link DiskIndicatorProps}.
 * @returns The indicator, or null when the free space is unknown.
 */
export function DiskIndicator({ variant }: DiskIndicatorProps) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<DiskStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = (force: boolean) => {
      loadDiskStatus(force).then(
        (s) => alive && setStatus(s),
        () => {
          /* indicator stays hidden or keeps the last value */
        }
      );
    };
    refresh(false);
    const id = window.setInterval(() => refresh(true), REFRESH_MS);
    const unsub = eventBus.subscribe((msg) => {
      if (msg.type === "disk_cleanup") refresh(true);
    });
    const unsubStatus = onDiskStatus((s) => alive && setStatus(s));
    return () => {
      alive = false;
      window.clearInterval(id);
      unsub();
      unsubStatus();
    };
  }, []);

  if (!status || status.free_bytes == null) return null;
  const level = diskLevel(status);
  const size = formatDiskBytes(status.free_bytes);
  const label = t("disk.indicatorTitle", { size });
  const tone =
    level === "critical"
      ? "text-red-400 border-red-500/40 bg-red-500/10"
      : level === "low"
        ? "text-amber-300 border-amber-500/40 bg-amber-500/10"
        : "text-gray-400 border-border bg-surface-2";

  if (variant === "icon") {
    return (
      <Link
        to="/settings#disk"
        title={label}
        aria-label={label}
        data-level={level}
        className={`w-8 h-8 mx-auto flex items-center justify-center rounded-lg border transition-colors hover:bg-surface-3 ${tone}`}
      >
        <HardDrive className="w-3.5 h-3.5" aria-hidden="true" />
      </Link>
    );
  }

  return (
    <Link
      to="/settings#disk"
      title={label}
      aria-label={label}
      data-level={level}
      className={`inline-flex items-center gap-1.5 rounded-lg border text-xs transition-colors hover:bg-surface-3 min-h-[44px] ${
        variant === "row" ? "w-full justify-between px-2.5" : "px-2.5"
      } ${tone}`}
    >
      <span className="inline-flex items-center gap-1.5 min-w-0">
        <HardDrive className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
        {variant === "row" && <span className="font-medium truncate">{t("disk.indicator")}</span>}
      </span>
      <bdi dir="ltr" className="font-medium whitespace-nowrap">
        {size}
      </bdi>
    </Link>
  );
}
