/**
 * @file VerificationBadge.tsx
 * @description Small pill showing a session's latest independent verification ("verified"
 * state): green "Verified", grey "Verified (old)" when the repo moved past the checked commit,
 * red "Not verified", amber "Verification error", or a blue spinner while queued/running.
 * Renders nothing when the session has never been verified. Used in the Sessions list and the
 * SessionDetail header next to the status badge.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { Verification } from "../lib/types";

/** Visual state of the pill, derived from a {@link Verification}. */
export type VerificationBadgeState = "verified" | "stale" | "failed" | "error" | "checking";

/**
 * Map a verification to the pill state. A verified run is "stale" when the caller knows the repo
 * HEAD has moved past the checked commit.
 *
 * @param v - Latest verification, or null/undefined when none exists.
 * @param stale - True when the checked commit is no longer the repo HEAD.
 * @returns The pill state, or null when nothing should render.
 */
export function verificationBadgeState(
  v: Verification | null | undefined,
  stale = false
): VerificationBadgeState | null {
  if (!v) return null;
  if (v.status === "queued" || v.status === "running") return "checking";
  if (v.verdict === "verified") return stale ? "stale" : "verified";
  if (v.verdict === "failed") return "failed";
  if (v.verdict === "error") return "error";
  return null;
}

/** Per-state colors (same badge shape as the session status badge). */
const STYLES: Record<VerificationBadgeState, string> = {
  verified: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  stale: "text-gray-400 bg-gray-500/10 border-gray-500/20",
  failed: "text-red-400 bg-red-500/10 border-red-500/20",
  error: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  checking: "text-sky-400 bg-sky-500/10 border-sky-500/20",
};

/** Props for {@link VerificationBadge}. */
export interface VerificationBadgeProps {
  /** Latest verification for the session (null/undefined renders nothing). */
  verification: Verification | null | undefined;
  /** True when the checked commit is no longer the repo HEAD. */
  stale?: boolean;
}

/**
 * Pill for a session's latest verification verdict.
 *
 * @param props - See {@link VerificationBadgeProps}.
 * @returns The pill, or null when the session has no verification.
 */
export function VerificationBadge({ verification, stale = false }: VerificationBadgeProps) {
  const { t } = useTranslation("sessions");
  const state = verificationBadgeState(verification, stale);
  if (!state) return null;
  const label = t(`verify.badge.${state}`);
  const iconClass = "w-3 h-3 flex-shrink-0";
  return (
    <span
      className={`badge ${STYLES[state]} whitespace-nowrap`}
      title={verification?.reason || label}
      data-verification-state={state}
    >
      {state === "checking" && (
        <Loader2 className={`${iconClass} animate-spin`} aria-hidden="true" />
      )}
      {(state === "verified" || state === "stale") && (
        <CheckCircle2 className={iconClass} aria-hidden="true" />
      )}
      {state === "failed" && <XCircle className={iconClass} aria-hidden="true" />}
      {state === "error" && <AlertTriangle className={iconClass} aria-hidden="true" />}
      {label}
    </span>
  );
}
