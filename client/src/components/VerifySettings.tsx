/**
 * @file VerifySettings.tsx
 * @description Settings card for the independent "verified" check: the list of projects whose
 * tests the server may re-run (folder, optional setup command, check command, test-count regex,
 * timeout). Commands run on this computer and are only ever taken from this config, never from
 * an agent. Loads and saves `GET/PUT /api/verifications/config`, shows the server's validation
 * error and the config file path. Phone-first stacked form, RTL-safe (commands are LTR inputs).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api, ApiError } from "../lib/api";
import type { VerifyProject } from "../lib/types";

/** Default values for a newly added project row. */
const EMPTY_PROJECT: VerifyProject = {
  dir: "",
  setupCmd: "",
  checkCmd: "",
  testCountRegex: "",
  timeoutSec: 600,
  autoVerify: true,
};

/**
 * Editable list of verification projects.
 *
 * @returns The settings card.
 */
export function VerifySettings() {
  const { t } = useTranslation("settings");
  const [projects, setProjects] = useState<VerifyProject[]>([]);
  const [path, setPath] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const cfg = await api.verifications.getConfig();
      setProjects(cfg.projects || []);
      setPath(cfg.path || "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Patch one project row. */
  const update = (index: number, patch: Partial<VerifyProject>) => {
    setProjects((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
    setDirty(true);
    setSaved(false);
  };

  const add = () => {
    setProjects((prev) => [...prev, { ...EMPTY_PROJECT }]);
    setDirty(true);
    setSaved(false);
  };

  const remove = (index: number) => {
    setProjects((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const cfg = await api.verifications.saveConfig(
        projects.map((p) => ({
          ...p,
          dir: p.dir.trim(),
          setupCmd: p.setupCmd.trim(),
          checkCmd: p.checkCmd.trim(),
          testCountRegex: p.testCountRegex.trim(),
          timeoutSec: Number(p.timeoutSec) || 0,
          autoVerify: p.autoVerify !== false,
        }))
      );
      setProjects(cfg.projects || []);
      setPath(cfg.path || path);
      setDirty(false);
      setSaved(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const field = err instanceof ApiError ? err.field : undefined;
      setError(field ? `${msg} (${field})` : msg);
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "input w-full mt-1 min-h-[44px] py-2 text-xs leading-normal font-mono";

  return (
    <div className="card p-4 sm:p-5 space-y-4">
      <p className="text-xs text-amber-200/90">{t("verify.safetyNote")}</p>

      {loading ? (
        <p className="text-xs text-gray-500">{t("verify.loading")}</p>
      ) : (
        <>
          {projects.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              {t("verify.empty")}
            </div>
          ) : (
            <div className="space-y-3">
              {projects.map((p, i) => (
                <div
                  key={i}
                  className="bg-surface-2 border border-border rounded-lg px-3 py-3 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-gray-300">
                      {t("verify.projectN", { n: i + 1 })}
                    </span>
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      className="btn-ghost text-xs inline-flex items-center gap-1 text-red-400 min-h-[44px] px-3"
                      aria-label={t("verify.remove")}
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      {t("verify.remove")}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block sm:col-span-2">
                      <span className="text-[11px] text-gray-500">{t("verify.fieldDir")}</span>
                      <input
                        dir="ltr"
                        value={p.dir}
                        onChange={(e) => update(i, { dir: e.target.value })}
                        placeholder="C:\Users\me\my-project"
                        className={inputClass}
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-gray-500">{t("verify.fieldSetup")}</span>
                      <input
                        dir="ltr"
                        value={p.setupCmd}
                        onChange={(e) => update(i, { setupCmd: e.target.value })}
                        placeholder="npm ci"
                        className={inputClass}
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-gray-500">{t("verify.fieldCheck")}</span>
                      <input
                        dir="ltr"
                        value={p.checkCmd}
                        onChange={(e) => update(i, { checkCmd: e.target.value })}
                        placeholder="npm test"
                        className={inputClass}
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-gray-500">{t("verify.fieldRegex")}</span>
                      <input
                        dir="ltr"
                        value={p.testCountRegex}
                        onChange={(e) => update(i, { testCountRegex: e.target.value })}
                        placeholder="Tests:\s+(\d+) passed"
                        className={inputClass}
                      />
                    </label>
                    <label className="block">
                      <span className="text-[11px] text-gray-500">{t("verify.fieldTimeout")}</span>
                      <input
                        dir="ltr"
                        type="number"
                        min={1}
                        inputMode="numeric"
                        value={Number.isFinite(p.timeoutSec) ? p.timeoutSec : ""}
                        onChange={(e) => update(i, { timeoutSec: Number(e.target.value) })}
                        className={inputClass}
                      />
                    </label>
                    <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={p.autoVerify !== false}
                        onChange={(e) => update(i, { autoVerify: e.target.checked })}
                        className="mt-1 h-5 w-5 shrink-0 accent-accent"
                      />
                      <span>
                        <span className="block text-xs text-gray-200">{t("verify.fieldAuto")}</span>
                        <span className="block text-[11px] text-gray-500">
                          {t("verify.fieldAutoHint")}
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={p.blindReview ? p.blindReview.enabled !== false : false}
                        onChange={(e) =>
                          update(i, {
                            // Keep a custom model/timeout from verify.json across off/on.
                            blindReview: {
                              model: "sonnet",
                              timeoutSec: 600,
                              ...(p.blindReview || {}),
                              enabled: e.target.checked,
                            },
                          })
                        }
                        className="mt-1 h-5 w-5 shrink-0 accent-accent"
                      />
                      <span>
                        <span className="block text-xs text-gray-200">
                          {t("verify.fieldBlindReview")}
                        </span>
                        <span className="block text-[11px] text-gray-500">
                          {t("verify.fieldBlindReviewHint")}
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={add}
              className="btn-ghost border border-border inline-flex items-center gap-1.5 text-xs min-h-[44px] px-4"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              {t("verify.add")}
            </button>
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
              {t("verify.save")}
            </button>
            {saved && <span className="text-xs text-emerald-400">{t("verify.saved")}</span>}
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-400 break-words">
          {t("verify.saveError", { message: error })}
        </p>
      )}

      {path && (
        <p className="text-[11px] text-gray-500 break-all">
          {t("verify.configPath")}{" "}
          <code className="font-mono text-gray-400" dir="ltr">
            {path}
          </code>
        </p>
      )}
    </div>
  );
}
