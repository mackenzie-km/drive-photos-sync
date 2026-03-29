import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import MainPage from "./MainPage";

const IDLE_STATUS = {
  status: "idle",
  currentFile: null,
  runId: null,
  latestRun: null,
  fileCounts: {},
};

describe("MainPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the start sync button", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve(IDLE_STATUS) } as Response),
      ),
    );
    render(<MainPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /start sync/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows an error banner when starting a sync fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url === "/sync/status")
          return Promise.resolve({ ok: true, json: () => Promise.resolve(IDLE_STATUS) } as Response);
        if (url === "/sync/start" && init?.method === "POST")
          return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "Already running" }) } as Response);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<MainPage />);
    await waitFor(() => screen.getByRole("button", { name: /start sync/i }));
    fireEvent.click(screen.getByRole("button", { name: /start sync/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/there was an issue completing this sync/i),
      ).toBeInTheDocument();
    });
  });

  it("displays file counts from the API with no undefined or NaN values", async () => {
    const fileCounts = { uploaded: 42, uninitialized: 17, failed: 8, skipped: 3 };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/sync/status")
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ...IDLE_STATUS, fileCounts }),
          } as Response);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<MainPage />);

    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument(); // uploaded
      expect(screen.getByText("17")).toBeInTheDocument(); // pending
      expect(screen.getByText("8")).toBeInTheDocument();  // failed
      expect(screen.getByText("3")).toBeInTheDocument();  // skipped
    });
    expect(screen.queryByText("undefined")).not.toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("defaults all file counts to 0 when the API omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/sync/status")
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ...IDLE_STATUS, fileCounts: {} }),
          } as Response);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<MainPage />);

    await waitFor(() => {
      // All four stat boxes should show 0, not undefined/NaN
      const zeros = screen.getAllByText("0");
      expect(zeros.length).toBeGreaterThanOrEqual(4);
    });
    expect(screen.queryByText("undefined")).not.toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("shows file names and sizes when uploaded files are revealed", async () => {
    const files = [
      { id: "f1", name: "beach-vacation.jpg", mime_type: "image/jpeg", size: 1048576,  synced_at: 1000 },
      { id: "f2", name: "birthday-party.png", mime_type: "image/png",  size: 2621440,  synced_at: 2000 },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/sync/status")
          return Promise.resolve({ ok: true, json: () => Promise.resolve(IDLE_STATUS) } as Response);
        if (url === "/sync/files")
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ files }) } as Response);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<MainPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /show uploaded files/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /show uploaded files/i }));

    await waitFor(() => {
      expect(screen.getByText("beach-vacation.jpg")).toBeInTheDocument();
      expect(screen.getByText("birthday-party.png")).toBeInTheDocument();
      expect(screen.getByText("1.0 MB")).toBeInTheDocument();
      expect(screen.getByText("2.5 MB")).toBeInTheDocument();
    });
  });

  it("shows an error banner when loading uploaded files fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/sync/status")
          return Promise.resolve({ ok: true, json: () => Promise.resolve(IDLE_STATUS) } as Response);
        if (url === "/sync/files")
          return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<MainPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /show uploaded files/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /show uploaded files/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/could not load uploaded files/i),
      ).toBeInTheDocument();
    });
  });
});
