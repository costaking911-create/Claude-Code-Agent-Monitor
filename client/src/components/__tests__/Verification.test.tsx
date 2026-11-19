/**
 * @file Verification.test.tsx
 * @description Tests for the "verified" state UI: VerificationBadge renders the right pill for
 * each verification state (verified, stale, failed, error, checking, none), and VerifyPanel loads
 * the session's verifications, shows the dirty warning / tests / log tail, starts a check, links
 * to Settings when the project is not configured, and applies live `verification_updated` pushes.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { Verification, WSMessage } from "../../lib/types";

const list = vi.fn();
const start = vi.fn();
const log = vi.fn();
const screenshot = vi.fn();
const subscribers: Array<(msg: WSMessage) => void> = [];

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: {
      verifications: {
        list: (...a: unknown[]) => list(...a),
        start: (...a: unknown[]) => start(...a),
        log: (...a: unknown[]) => log(...a),
        screenshot: (...a: unknown[]) => screenshot(...a),
      },
    },
  };
});

vi.mock("../../lib/eventBus", () => ({
  eventBus: {
    subscribe: (fn: (msg: WSMessage) => void) => {
      subscribers.push(fn);
      return () => {
        const i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
  },
}));

import { ApiError } from "../../lib/api";
import { VerificationBadge } from "../VerificationBadge";
import { VerifyPanel } from "../VerifyPanel";

/** Build a verification fixture. */
function v(over: Partial<Verification> = {}): Verification {
  return {
    id: 1,
    session_id: "s1",
    project_dir: "/repo",
    commit_sha: "abcdef1234567",
    dirty: 0,
    setup_cmd: null,
    check_cmd: "npm test",
    setup_exit: null,
    check_exit: 0,
    tests_count: 12,
    timed_out: 0,
    status: "done",
    verdict: "verified",
    reason: null,
    created_at: "2026-11-18T10:00:00.000Z",
    started_at: "2026-11-18T10:00:00.000Z",
    ended_at: "2026-11-18T10:00:30.000Z",
    ...over,
  };
}

describe("VerificationBadge", () => {
  it.each([
    [v(), false, "Verified"],
    [v(), true, "Verified (old)"],
    [v({ verdict: "failed" }), false, "Not verified"],
    [v({ verdict: "error" }), false, "Verification error"],
    [v({ status: "running", verdict: null }), false, "Checking…"],
    [v({ status: "queued", verdict: null }), true, "Checking…"],
  ])("renders the pill for %#", (verification, stale, label) => {
    render(<VerificationBadge verification={verification} stale={stale} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("renders nothing without a verification", () => {
    const { container } = render(<VerificationBadge verification={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("VerifyPanel", () => {
  beforeEach(() => {
    list.mockReset();
    start.mockReset();
    log.mockReset();
    subscribers.length = 0;
  });

  const renderPanel = (onLatestChange?: (l: Verification | null, s: boolean) => void) =>
    render(
      <MemoryRouter>
        <VerifyPanel sessionId="s1" onLatestChange={onLatestChange} />
      </MemoryRouter>
    );

  it("shows the latest verdict, dirty warning, tests and a log tail", async () => {
    list.mockResolvedValue({
      verifications: [v({ dirty: 1 })],
      current_head: "abcdef1234567",
    });
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    log.mockResolvedValue(lines);
    const onLatest = vi.fn();
    renderPanel(onLatest);

    expect(await screen.findByText("Verified")).toBeInTheDocument();
    expect(screen.getByText(/only what was saved was checked/)).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    await screen.findByText(/line 60/);
    const pre = () => document.querySelector("pre")?.textContent ?? "";
    expect(pre().split("\n")).toHaveLength(40);
    expect(pre().startsWith("line 21\n")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Show all \(60 lines\)/ }));
    expect(pre().split("\n")).toHaveLength(60);
    expect(pre().startsWith("line 1\n")).toBe(true);
    expect(onLatest).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 }), false);
  });

  it("shows the visual check screenshot when there is one", async () => {
    list.mockResolvedValue({
      verifications: [v({ has_screenshot: true })],
      current_head: "abcdef1234567",
    });
    log.mockResolvedValue("ok");
    screenshot.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const created = vi.fn(() => "blob:shot");
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    renderPanel();
    const img = await screen.findByAltText("The app as it opened in the check");
    expect(img).toHaveAttribute("src", "blob:shot");
    expect(screenshot).toHaveBeenCalledWith(1);
    expect(screen.getByText("Screenshot at phone size")).toBeInTheDocument();
  });

  it("marks a verified run on an older commit as stale", async () => {
    list.mockResolvedValue({ verifications: [v()], current_head: "ffff000" });
    log.mockResolvedValue("");
    renderPanel();
    expect(await screen.findByText("Verified (old)")).toBeInTheDocument();
  });

  it("starts a check and disables the button while it runs", async () => {
    list.mockResolvedValue({ verifications: [], current_head: null });
    start.mockResolvedValue({ verification: v({ id: 2, status: "queued", verdict: null }) });
    renderPanel();
    const button = await screen.findByRole("button", { name: "Verify" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(start).toHaveBeenCalledWith("s1");
    const busy = await screen.findByRole("button", { name: "Checking…" });
    expect(busy).toBeDisabled();
  });

  it("links to Settings when the project is not configured", async () => {
    list.mockResolvedValue({ verifications: [], current_head: null });
    start.mockRejectedValue(new ApiError("nope", 409, "NOT_CONFIGURED"));
    renderPanel();
    const button = await screen.findByRole("button", { name: "Verify" });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    const link = await screen.findByRole("link", { name: "Open settings" });
    expect(link).toHaveAttribute("href", "/settings#verification");
  });

  it("applies live verification_updated pushes for this session", async () => {
    list.mockResolvedValue({ verifications: [], current_head: null });
    renderPanel();
    await screen.findByText(/Not verified yet/);
    act(() => {
      for (const fn of subscribers) {
        fn({
          type: "verification_updated",
          data: v({ id: 5, status: "running", verdict: null }),
          timestamp: "",
        });
        fn({
          type: "verification_updated",
          data: v({ id: 6, session_id: "other" }),
          timestamp: "",
        });
      }
    });
    expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();
  });
});
