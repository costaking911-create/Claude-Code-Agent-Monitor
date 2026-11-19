/**
 * @file VerifyPanel.tsx
 * @description SessionDetail panel for the independent "verified" check. The "Verify" button asks
 * the server to re-run the project's test command in a clean git copy (tracked files only) of the session's
 * repo; the verdict comes from the exit code and the test count in the log, never from the agent.
 * Shows the latest verdict, checked commit, uncommitted-changes warning, test count, exit codes,
 * duration, reason, a log tail with "show all", and a short history. Live via the
 * `verification_updated` WebSocket message; when the project has no verify command configured it
 * links to the Settings "verification" section. Phone-first: stacked, wrapping, RTL-safe.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import { formatDateTime, formatDuration } from "../lib/format";
import type { Verification } from "../lib/types";
import { VerificationBadge } from "./VerificationBadge";

/** How many log lines the collapsed log view shows. */
const LOG_TAIL_LINES = 40;
/** How many past runs the history list shows. */
const HISTORY_LIMIT = 5;

/** Error codes the verify endpoint can return that have their own localized message. */
const KNOWN_CODES = new Set(["NOT_FOUND", "NOT_CONFIGURED", "NOT_GIT", "NO_CWD"]);

/** Props for {@link VerifyPanel}. */
export interface VerifyPanelProps {
  /** Session whose verifications are shown. */
  sessionId: string;
  /** Called whenever the latest verification (or its staleness) changes, so the page header can
   *  show the same badge without a second fetch. */
  onLatestChange?: (latest: Verification | null, stale: boolean) => void;
}

/**
 * True when a finished verified run checked a commit other than the repo's current HEAD.
 *
 * @param v - Verification to test.
 * @param head - Current HEAD of the session's repo (null when unknown).
 * @returns Whether the "verified" verdict is out of date.
 */
export function isVerificationStale(v: Verification | null | undefined, head: string | null) {
  if (!v || v.status !== "done" || !head) return false;
  return v.commit_sha !== head;
}

/**
 * Insert or replace a verification in a newest-first list.
 *
 * @param list - Current list (newest first).
 * @param v - Updated or new verification.
 * @returns A new list with `v` in place.
 */
function upsert(list: Verification[], v: Verification): Verification[] {
  const idx = list.findIndex((x) => x.id === v.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = v;
    return next;
  }
  return [v, ...list].sort((a, b) => b.id - a.id);
}

/**
 * The visual check's phone-size screenshot (fetched with the auth header, shown as a thumbnail
 * that opens full size).
 *
 * @param props - The verification id.
 * @returns The screenshot, or nothing when it cannot be loaded.
 */
function VerifyScreenshot({ id }: { id: number }) {
  const { t } = useTranslation("sessions");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    api.verifications.screenshot(id).then(
      (blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      () => undefined
    );
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);
  if (!url) return null;
  return (
    <div className="space-y-1.5">
      <span className="text-xs text-gray-400">{t("verify.screenshot")}</span>
      <a href={url} target="_blank" rel="noreferrer" className="block w-fit">
        <img
          src={url}
          alt={t("verify.screenshotAlt")}
          className="max-h-80 w-auto rounded-lg border border-border"
          loading="lazy"
        />
      </a>
    </div>
  );
}

/**
 * Verification panel for one session.
 *
 * @param props - See {@link VerifyPanelProps}.
 * @returns The panel card.
 */
export function VerifyPanel({ sessionId, onLatestChange }: VerifyPanelProps) {
  const { t } = useTranslation("sessions");
  const [items, setItems] = useState<Verification[]>([]);
  const [head, setHead] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const onLatestRef = useRef(onLatestChange);
  onLatestRef.current = onLatestChange;

  const load = useCallback(async () => {
    try {
      const res = await api.verifications.list(sessionId);
      setItems(res.verifications);
      setHead(res.current_head);
    } catch {
      // Older servers without the endpoint: keep the panel usable (empty).
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    setItems([]);
    setHead(null);
    setLog(null);
    setErrorCode(null);
    setErrorText(null);
    load();
  }, [load]);

  // Live updates for this session's runs; a finished run also refreshes the repo HEAD.
  useEffect(() => {
    return eventBus.subscribe((msg) => {
      if (msg.type !== "verification_updated") return;
      const v = msg.data as Verification;
      if (!v || v.session_id !== sessionId) return;
      setItems((prev) => upsert(prev, v));
      if (v.status === "done") load();
    });
  }, [sessionId, load]);

  const latest = items[0] ?? null;
  const stale = isVerificationStale(latest, head);
  const busy = latest?.status === "queued" || latest?.status === "running";

  useEffect(() => {
    onLatestRef.current?.(latest, stale);
  }, [latest, stale]);

  // Fetch the log once the latest run is finished.
  const latestId = latest?.id;
  const latestDone = latest?.status === "done";
  useEffect(() => {
    if (latestId == null || !latestDone) {
      setLog(null);
      return;
    }
    let cancelled = false;
    setLogLoading(true);
    api.verifications
      .log(latestId)
      .then((text) => {
        if (!cancelled) setLog(text);
      })
      .catch(() => {
        if (!cancelled) setLog(null);
      })
      .finally(() => {
        if (!cancelled) setLogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [latestId, latestDone]);

  const start = async () => {
    setStarting(true);
    setErrorCode(null);
    setErrorText(null);
    try {
      const res = await api.verifications.start(sessionId);
      setItems((prev) => upsert(prev, res.verification));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      if (code && KNOWN_CODES.has(code)) setErrorCode(code);
      else setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const logLines = log ? log.replace(/\s+$/, "").split(/\r?\n/) : [];
  const shownLog =
    showAll || logLines.length <= LOG_TAIL_LINES
      ? logLines.join("\n")
      : logLines.slice(-LOG_TAIL_LINES).join("\n");

  return (
    <section className="card p-4 sm:p-5 space-y-3" aria-label={t("verify.title")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <ShieldCheck className="w-4 h-4 text-gray-500 flex-shrink-0" aria-hidden="true" />
          <h3 className="text-sm font-medium text-gray-200">{t("verify.title")}</h3>
          <VerificationBadge verification={latest} stale={stale} />
        </div>
        <button
          type="button"
          onClick={start}
          disabled={busy || starting || loading}
          className="btn-primary inline-flex items-center gap-1.5 text-xs min-h-[44px] px-4 disabled:opacity-50"
        >
          {busy || starting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          )}
          {busy ? t("verify.checking") : t("verify.button")}
        </button>
      </div>
      <p className="text-xs text-gray-500">{t("verify.description")}</p>

      {errorCode === "NOT_CONFIGURED" && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
          {t("verify.errors.NOT_CONFIGURED")}{" "}
          <Link to="/settings#verification" className="text-accent hover:underline">
            {t("verify.openSettings")}
          </Link>
        </div>
      )}
      {errorCode && errorCode !== "NOT_CONFIGURED" && (
        <p role="alert" className="text-xs text-red-400">
          {t(`verify.errors.${errorCode}`)}
        </p>
      )}
      {errorText && (
        <p role="alert" className="text-xs text-red-400 break-words">
          {t("verify.errors.generic", { message: errorText })}
        </p>
      )}

      {loading ? (
        <p className="text-xs text-gray-500">{t("verify.loading")}</p>
      ) : !latest ? (
        <p className="text-xs text-gray-500">{t("verify.empty")}</p>
      ) : (
        <div className="space-y-3">
          {stale && <p className="text-xs text-gray-400">{t("verify.staleNote")}</p>}
          {latest.dirty === 1 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span>{t("verify.dirtyWarning")}</span>
            </div>
          )}
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-xs">
            <Fact label={t("verify.commit")}>
              <span className="font-mono" dir="ltr">
                {latest.commit_sha ? latest.commit_sha.slice(0, 7) : "—"}
              </span>
            </Fact>
            <Fact label={t("verify.tests")}>
              {latest.tests_count != null ? latest.tests_count : "—"}
            </Fact>
            <Fact label={t("verify.exitCodes")}>
              <span className="font-mono" dir="ltr">
                {latest.setup_cmd ? `${latest.setup_exit ?? "—"} / ` : ""}
                {latest.check_exit ?? "—"}
              </span>
            </Fact>
            <Fact label={t("verify.duration")}>
              {latest.started_at && latest.ended_at
                ? formatDuration(latest.started_at, latest.ended_at)
                : "—"}
            </Fact>
          </dl>
          {latest.timed_out === 1 && (
            <p className="text-xs text-amber-300">{t("verify.timedOut")}</p>
          )}
          {latest.reason && (latest.verdict === "failed" || latest.verdict === "error") && (
            <p className="text-xs text-gray-300 break-words">
              <span className="text-gray-500">{t("verify.reason")}: </span>
              <span dir="ltr">{latest.reason}</span>
            </p>
          )}
          <p className="text-[11px] text-gray-500 break-all">
            <span>{t("verify.command")}: </span>
            <code className="font-mono text-gray-400" dir="ltr">
              {latest.check_cmd}
            </code>
          </p>

          {latestDone && latest.has_screenshot && <VerifyScreenshot id={latest.id} />}

          {latestDone && (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-gray-400">{t("verify.log")}</span>
                {logLines.length > LOG_TAIL_LINES && (
                  <button
                    type="button"
                    onClick={() => setShowAll((s) => !s)}
                    className="text-xs text-accent hover:underline"
                  >
                    {showAll
                      ? t("verify.showTail", { n: LOG_TAIL_LINES })
                      : t("verify.showAll", { n: logLines.length })}
                  </button>
                )}
              </div>
              {logLoading ? (
                <p className="text-xs text-gray-500">{t("verify.loading")}</p>
              ) : log ? (
                <pre
                  dir="ltr"
                  className="max-h-80 overflow-auto rounded-lg bg-surface-2 border border-border p-2 text-[11px] leading-snug text-gray-300 font-mono whitespace-pre-wrap break-all"
                >
                  {shownLog}
                </pre>
              ) : (
                <p className="text-xs text-gray-500">{t("verify.noLog")}</p>
              )}
            </div>
          )}

          {items.length > 1 && (
            <div className="space-y-1.5">
              <span className="text-xs text-gray-400">{t("verify.history")}</span>
              <ul className="space-y-1">
                {items.slice(1, 1 + HISTORY_LIMIT).map((v) => (
                  <li
                    key={v.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500"
                  >
                    <VerificationBadge verification={v} stale={isVerificationStale(v, head)} />
                    <span>{formatDateTime(v.created_at)}</span>
                    {v.commit_sha && (
                      <span className="font-mono" dir="ltr">
                        {v.commit_sha.slice(0, 7)}
                      </span>
                    )}
                    {v.tests_count != null && (
                      <span>{t("verify.testsCount", { n: v.tests_count })}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One label/value cell of the facts grid.
 *
 * @param props - `label` text and the value as children.
 * @returns A `<div>` with `<dt>`/`<dd>`.
 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-200 truncate">{children}</dd>
    </div>
  );
}
