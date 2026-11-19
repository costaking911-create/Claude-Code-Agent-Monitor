/**
 * @file DiskSettings.tsx
 * @description Settings card for the automatic disk cleanup: free-space bar (red below the
 * floor), the "automatic cleanup" switch with floor/target in GB (`PUT /api/disk/config`), a
 * preview (dry run) and a confirmed "clean now" (`POST /api/disk/cleanup`, which can take 1–2
 * minutes), the per-step result, recent runs, and bigger savings that need the owner's decision.
 * Cleanup only removes temporary or re-creatable files. Refreshes on the live `disk_cleanup`
 * message. Phone-first, RTL-safe (sizes and paths are LTR).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Eye, HardDrive, Loader2, Lightbulb, Trash2 } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { formatDateTime } from "../lib/format";
import { diskLevel, formatDiskBytes, resetDiskStatusCache } from "../lib/disk";
import type { DiskCleanupEntry, DiskStatus } from "../lib/types";
import { ConfirmModal } from "./ConfirmModal";

/** Error text from an API failure. */
function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Keep a size like "2.8 GB" in reading order inside a right-to-left sentence. */
const ltr = (s: string) => `\u2066${s}\u2069`;

/** Form values for the settings (kept as strings while typing). */
interface DiskForm {
  enabled: boolean;
  floorGb: string;
  targetGb: string;
}

/**
 * Disk cleanup settings card.
 *
 * @returns The settings card.
 */
export function DiskSettings() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<DiskStatus | null>(null);
  const [form, setForm] = useState<DiskForm>({ enabled: true, floorGb: "", targetGb: "" });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<"preview" | "clean" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<DiskCleanupEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  /** Apply a fresh status; keeps the form while the user is editing it. */
  const apply = useCallback((s: DiskStatus) => {
    setStatus(s);
    resetDiskStatusCache(s);
    if (!dirtyRef.current) {
      setForm({
        enabled: s.config.enabled,
        floorGb: String(s.config.floorGb),
        targetGb: String(s.config.targetGb),
      });
    }
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await api.disk.status());
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
    } finally {
      setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    load();
    // Keep the free space current while the screen stays open (same pace as the indicators).
    const id = window.setInterval(load, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [load]);

  // "Saved" fades after a few seconds.
  useEffect(() => {
    if (!saved) return;
    const id = window.setTimeout(() => setSaved(false), 4000);
    return () => window.clearTimeout(id);
  }, [saved]);

  // A cleanup finished somewhere (automatic run, another tab): refresh.
  useEffect(
    () =>
      eventBus.subscribe((msg) => {
        if (msg.type === "disk_cleanup") load();
      }),
    [load]
  );

  const patch = (p: Partial<DiskForm>) => {
    setForm((prev) => ({ ...prev, ...p }));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const floorGb = Number(form.floorGb);
      const targetGb = Number(form.targetGb);
      const next = await api.disk.saveConfig({
        enabled: form.enabled,
        floorGb: Number.isFinite(floorGb) ? floorGb : 0,
        targetGb: Number.isFinite(targetGb) ? targetGb : 0,
      });
      dirtyRef.current = false;
      setDirty(false);
      apply(next);
      setSaved(true);
    } catch (err) {
      setError(t("disk.saveError", { message: errText(err) }));
    } finally {
      setSaving(false);
    }
  };

  const run = async (dryRun: boolean) => {
    setConfirmOpen(false);
    setBusy(dryRun ? "preview" : "clean");
    setError(null);
    try {
      const res = await api.disk.cleanup(dryRun);
      setResult(res.result);
      apply(res);
    } catch (err) {
      setError(t("disk.cleanupError", { message: errText(err) }));
    } finally {
      setBusy(null);
    }
  };

  const running = busy !== null || Boolean(status?.running);
  const level = diskLevel(status);
  const free = status?.free_bytes ?? null;
  const total = status?.total_bytes ?? null;
  const freePct = free != null && total ? Math.min(100, Math.max(0, (free / total) * 100)) : null;
  const barColor =
    level === "critical" ? "bg-red-500" : level === "low" ? "bg-amber-400" : "bg-emerald-500";
  const inputClass = "input w-full mt-1 min-h-[44px] py-2 text-sm leading-normal";

  return (
    <div className="card p-4 sm:p-5 space-y-5">
      {loading ? (
        <p className="text-xs text-gray-500">{t("disk.loading")}</p>
      ) : loadError || !status ? (
        <p role="alert" className="text-xs text-red-400 break-words">
          {t("disk.loadError", { message: loadError || "" })}
        </p>
      ) : (
        <>
          {/* Free space */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="inline-flex items-center gap-2 text-gray-200">
                <HardDrive className="w-4 h-4 text-gray-500" aria-hidden="true" />
                {free == null ? (
                  t("disk.freeUnknown")
                ) : (
                  <span>
                    {t("disk.freeLabel")}{" "}
                    <bdi dir="ltr" className="font-semibold">
                      {formatDiskBytes(free)}
                    </bdi>
                    {total != null && (
                      <span className="text-gray-500">
                        {" "}
                        {t("disk.ofTotal")} <bdi dir="ltr">{formatDiskBytes(total)}</bdi>
                      </span>
                    )}
                  </span>
                )}
              </span>
            </div>
            {freePct != null && (
              <div
                className="h-2.5 w-full rounded-full bg-surface-3 border border-border overflow-hidden"
                role="meter"
                aria-label={t("disk.freeLabel")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(freePct)}
                data-level={level}
              >
                <div
                  className={`h-full rounded-full ${barColor}`}
                  style={{ width: `${Math.max(freePct, 2)}%` }}
                />
              </div>
            )}
            {level === "critical" && <p className="text-xs text-red-400">{t("disk.belowFloor")}</p>}
            {level === "low" && <p className="text-xs text-amber-300">{t("disk.belowTarget")}</p>}
          </div>

          <p className="text-xs text-gray-400">{t("disk.neverDeleted")}</p>

          {/* Settings */}
          <div className="bg-surface-2 border border-border rounded-lg px-3 py-3 space-y-3">
            <button
              type="button"
              role="switch"
              aria-checked={form.enabled}
              onClick={() => patch({ enabled: !form.enabled })}
              className="w-full flex items-center justify-between gap-3 min-h-[44px] text-start"
            >
              <span>
                <span className="block text-sm text-gray-200">{t("disk.auto")}</span>
                <span className="block text-[11px] text-gray-500">{t("disk.autoHint")}</span>
              </span>
              <span
                aria-hidden="true"
                className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors ${
                  form.enabled ? "bg-accent" : "bg-surface-3 border border-border"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[inset-inline-start] ${
                    form.enabled ? "start-[1.375rem]" : "start-0.5"
                  }`}
                />
              </span>
            </button>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] text-gray-500">{t("disk.floor")}</span>
                <input
                  dir="ltr"
                  type="number"
                  min={0.5}
                  step={0.5}
                  inputMode="decimal"
                  value={form.floorGb}
                  onChange={(e) => patch({ floorGb: e.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="block">
                <span className="text-[11px] text-gray-500">{t("disk.target")}</span>
                <input
                  dir="ltr"
                  type="number"
                  min={0.5}
                  step={0.5}
                  inputMode="decimal"
                  value={form.targetGb}
                  onChange={(e) => patch({ targetGb: e.target.value })}
                  className={inputClass}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={save}
                disabled={saving || !dirty}
                className="btn-primary inline-flex items-center gap-1.5 text-xs min-h-[44px] px-4 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {t("disk.save")}
              </button>
              {saved && <span className="text-xs text-emerald-400">{t("disk.saved")}</span>}
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => run(true)}
                disabled={running}
                className="btn-ghost border border-border inline-flex items-center gap-1.5 text-xs min-h-[44px] px-4 disabled:opacity-50"
              >
                {busy === "preview" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {t("disk.preview")}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={running}
                className="btn-primary inline-flex items-center gap-1.5 text-xs min-h-[44px] px-4 disabled:opacity-50"
              >
                {busy === "clean" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {t("disk.cleanNow")}
              </button>
            </div>
            {running && (
              <p role="status" className="text-xs text-gray-400 inline-flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                {busy === "preview" ? t("disk.previewRunning") : t("disk.running")}
              </p>
            )}
          </div>

          {/* Result of the last run from this screen */}
          {result && (
            <div className="space-y-2" data-testid="disk-result">
              <h4 className="text-xs font-medium text-gray-300">
                {result.dry_run
                  ? t("disk.resultPreview", { size: ltr(formatDiskBytes(result.freed)) })
                  : t("disk.resultDone", { size: ltr(formatDiskBytes(result.freed)) })}
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500">
                      <th className="text-start font-normal py-1.5 pe-2">{t("disk.colStep")}</th>
                      <th className="text-end font-normal py-1.5 px-2">{t("disk.colFreed")}</th>
                      <th className="text-end font-normal py-1.5 ps-2">{t("disk.colRemoved")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.steps.map((s) => (
                      <tr key={s.id} className="border-t border-border">
                        <td className="py-1.5 pe-2 text-gray-200">
                          {t(`disk.steps.${s.id}`, { defaultValue: s.id })}
                          {s.error && (
                            <span className="block text-[11px] text-red-400 break-words">
                              {t("disk.stepError")} <bdi dir="ltr">{s.error}</bdi>
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-end text-gray-300" dir="ltr">
                          {formatDiskBytes(s.freed)}
                        </td>
                        <td className="py-1.5 ps-2 text-end text-gray-400" dir="ltr">
                          {s.removed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-red-400 break-words">
              {error}
            </p>
          )}

          {/* Recent runs */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-gray-300">{t("disk.historyTitle")}</h4>
            {status.history.length === 0 ? (
              <p className="text-xs text-gray-500">{t("disk.historyEmpty")}</p>
            ) : (
              <ul className="space-y-1.5">
                {status.history.map((h) => (
                  <li
                    key={`${h.at}-${h.reason}`}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs bg-surface-2 border border-border rounded-lg px-3 py-2"
                  >
                    <span className="text-gray-300">
                      {t(`disk.reasons.${h.reason}`, { defaultValue: h.reason })}
                      <span className="text-gray-500">
                        {" · "}
                        <bdi dir="ltr">{formatDateTime(h.at)}</bdi>
                      </span>
                    </span>
                    <span className="text-gray-400">
                      {h.dry_run ? t("disk.historyWould") : t("disk.historyFreed")}{" "}
                      <bdi dir="ltr" className="text-gray-200">
                        {formatDiskBytes(h.freed)}
                      </bdi>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Bigger savings that need the owner's decision */}
          {status.suggestions.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-amber-200/90 inline-flex items-center gap-1.5">
                <Lightbulb className="w-3.5 h-3.5" aria-hidden="true" />
                {t("disk.suggestionsTitle")}
              </h4>
              <p className="text-[11px] text-gray-500">{t("disk.suggestionsHint")}</p>
              <ul className="space-y-1.5">
                {status.suggestions.map((s) => (
                  <li
                    key={s.id}
                    className="text-xs bg-surface-2 border border-border rounded-lg px-3 py-2"
                  >
                    <span className="block text-gray-200">
                      {t(`disk.suggestions.${s.id}.title`, { defaultValue: s.id })}
                    </span>
                    <span className="block text-gray-500">
                      {t(`disk.suggestions.${s.id}.text`, { defaultValue: s.hint })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {status.path && (
            <p className="text-[11px] text-gray-500 break-all">
              {t("disk.configPath")}{" "}
              <code className="font-mono text-gray-400" dir="ltr">
                {status.path}
              </code>
            </p>
          )}
        </>
      )}

      <ConfirmModal
        open={confirmOpen}
        title={t("disk.confirmTitle")}
        message={t("disk.confirmMessage")}
        confirmLabel={t("disk.confirmYes")}
        cancelLabel={t("disk.confirmCancel")}
        destructive={false}
        onConfirm={() => run(false)}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
