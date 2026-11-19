/**
 * @file DiskSettings.test.tsx
 * @description Tests for the disk cleanup settings card and the free-space indicator: loading,
 * load error, free space with the below-floor warning, preview calls the API with dryRun true and
 * shows the per-step result, "clean now" asks for confirmation before calling the API, the switch
 * and GB fields save through the config API, history and owner-decision suggestions render, and
 * the indicator links to Settings › Disk with the right level.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { DiskCleanupEntry, DiskStatus, WSMessage } from "../../lib/types";

const status = vi.fn();
const cleanup = vi.fn();
const saveConfig = vi.fn();
const subscribers: Array<(msg: WSMessage) => void> = [];

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    api: {
      disk: {
        status: (...a: unknown[]) => status(...a),
        cleanup: (...a: unknown[]) => cleanup(...a),
        saveConfig: (...a: unknown[]) => saveConfig(...a),
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
import { formatDiskBytes, resetDiskStatusCache } from "../../lib/disk";
import { DiskSettings } from "../DiskSettings";
import { DiskIndicator } from "../DiskIndicator";

const GB = 1024 ** 3;

/** Build a disk status fixture. */
function makeStatus(over: Partial<DiskStatus> = {}): DiskStatus {
  return {
    path: "C:\\monitor\\disk-janitor.json",
    free_bytes: 8 * GB,
    total_bytes: 64 * GB,
    config: { enabled: true, floorGb: 3, targetGb: 5 },
    below_floor: false,
    running: false,
    history: [],
    suggestions: [],
    ...over,
  };
}

/** Build a cleanup entry fixture. */
function makeEntry(over: Partial<DiskCleanupEntry> = {}): DiskCleanupEntry {
  return {
    at: "2026-11-18T10:00:00.000Z",
    reason: "preview",
    dry_run: true,
    free_before: 2 * GB,
    free_after: 2 * GB,
    freed: 1.5 * GB,
    steps: [
      { id: "temp_old", freed: GB, removed: 120 },
      { id: "npm_cache", freed: 0.5 * GB, removed: 3 },
      { id: "next_cache", freed: 0, removed: 0, error: "EBUSY" },
    ],
    ...over,
  };
}

beforeEach(() => {
  status.mockReset();
  cleanup.mockReset();
  saveConfig.mockReset();
  subscribers.length = 0;
  resetDiskStatusCache();
});

describe("formatDiskBytes", () => {
  it("formats GB, MB and unknown sizes", () => {
    expect(formatDiskBytes(1.5 * GB)).toBe("1.5 GB");
    expect(formatDiskBytes(300 * 1024 ** 2)).toBe("300 MB");
    expect(formatDiskBytes(0)).toBe("0 MB");
    expect(formatDiskBytes(null)).toBe("—");
  });
});

describe("DiskSettings", () => {
  it("shows loading, then free space and the never-deleted note", async () => {
    status.mockResolvedValue(makeStatus());
    render(<DiskSettings />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("8.0 GB")).toBeInTheDocument();
    expect(screen.getByText("64.0 GB")).toBeInTheDocument();
    expect(screen.getByText(/Never deleted: code, conversation history/)).toBeInTheDocument();
    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("data-level", "ok");
  });

  it("shows a load error", async () => {
    status.mockRejectedValue(new ApiError("boom", 500));
    render(<DiskSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("warns in red below the floor", async () => {
    status.mockResolvedValue(makeStatus({ free_bytes: 2 * GB, below_floor: true }));
    render(<DiskSettings />);
    expect(await screen.findByText("Below the minimum. Clean up now.")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("data-level", "critical");
  });

  it("preview calls the API with dryRun true and shows the step results", async () => {
    status.mockResolvedValue(makeStatus());
    let resolve: (v: unknown) => void = () => {};
    cleanup.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<DiskSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(cleanup).toHaveBeenCalledWith(true);
    // Both actions are disabled while the cleanup runs.
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clean now" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("nothing is deleted");
    resolve({ ...makeStatus({ history: [makeEntry()] }), result: makeEntry() });
    expect(
      await screen.findByText("Preview – nothing was deleted. Would free \u20661.5 GB\u2069")
    ).toBeInTheDocument();
    expect(screen.getByText("Old temporary files")).toBeInTheDocument();
    expect(screen.getByText("npm cache")).toBeInTheDocument();
    expect(screen.getByText("EBUSY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).not.toBeDisabled();
  });

  it("asks for confirmation before a real cleanup", async () => {
    status.mockResolvedValue(makeStatus());
    cleanup.mockResolvedValue({
      ...makeStatus(),
      result: makeEntry({ reason: "manual", dry_run: false }),
    });
    render(<DiskSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Clean now" }));
    expect(cleanup).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Only temporary and re-creatable files are deleted");
    fireEvent.click(within(dialog).getByText("Cancel"));
    expect(cleanup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clean now" }));
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Clean now" }));
    await waitFor(() => expect(cleanup).toHaveBeenCalledWith(false));
    expect(await screen.findByText("Done – freed \u20661.5 GB\u2069")).toBeInTheDocument();
  });

  it("saves the switch and the GB fields", async () => {
    status.mockResolvedValue(makeStatus());
    saveConfig.mockResolvedValue(
      makeStatus({ config: { enabled: false, floorGb: 4, targetGb: 5 } })
    );
    render(<DiskSettings />);
    const sw = await screen.findByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    fireEvent.change(screen.getByLabelText("Minimum free (GB)"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith({ enabled: false, floorGb: 4, targetGb: 5 })
    );
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows history and the suggestions that need a decision", async () => {
    status.mockResolvedValue(
      makeStatus({
        history: [makeEntry({ reason: "auto", dry_run: false })],
        suggestions: [
          { id: "hibernation", hint: "powercfg" },
          { id: "app_data", hint: "Deepchart" },
        ],
      })
    );
    render(<DiskSettings />);
    expect(await screen.findByText("Needs your decision")).toBeInTheDocument();
    expect(screen.getByText("Hibernation file")).toBeInTheDocument();
    expect(screen.getByText(/Deepchart/)).toBeInTheDocument();
    expect(screen.getByText("Automatic")).toBeInTheDocument();
  });

  it("reloads on a live disk_cleanup message", async () => {
    status.mockResolvedValue(makeStatus());
    render(<DiskSettings />);
    await screen.findByText("8.0 GB");
    status.mockResolvedValue(makeStatus({ free_bytes: 12 * GB }));
    subscribers.forEach((fn) =>
      fn({ type: "disk_cleanup", data: makeEntry(), timestamp: "2026-11-18T10:00:00.000Z" })
    );
    expect(await screen.findByText("12.0 GB")).toBeInTheDocument();
  });
});

describe("DiskIndicator", () => {
  it("links to Settings › Disk and is amber below the target", async () => {
    status.mockResolvedValue(makeStatus({ free_bytes: 4 * GB }));
    render(
      <MemoryRouter>
        <DiskIndicator variant="chip" />
      </MemoryRouter>
    );
    const link = await screen.findByRole("link");
    expect(link).toHaveAttribute("href", "/settings#disk");
    expect(link).toHaveAttribute("data-level", "low");
    expect(link).toHaveTextContent("4.0 GB");
  });

  it("renders nothing when the request fails", async () => {
    status.mockRejectedValue(new Error("offline"));
    const { container } = render(
      <MemoryRouter>
        <DiskIndicator variant="row" />
      </MemoryRouter>
    );
    await waitFor(() => expect(status).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
