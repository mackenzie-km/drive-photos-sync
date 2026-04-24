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

function stubFetch(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/sync/status")
        return Promise.resolve({ ok: true, json: () => Promise.resolve(IDLE_STATUS) } as Response);
      if (url in overrides) {
        const val = overrides[url];
        return Promise.resolve(val as Response);
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    }),
  );
}

// Sets up window.gapi and window.google.picker mocks.
// Returns triggerPick() to simulate a user selecting a folder.
function setupPickerMock() {
  let pickerCallback: ((data: unknown) => void) | null = null;

  (window as any).gapi = {
    load: (_: string, cb: () => void) => cb(),
  };

  (window as any).google = {
    picker: {
      DocsView: class {
        setIncludeFolders() { return this; }
        setSelectFolderEnabled() { return this; }
        setMimeTypes() { return this; }
      },
      PickerBuilder: class {
        addView() { return this; }
        setOAuthToken() { return this; }
        setDeveloperKey() { return this; }
        setCallback(cb: (data: unknown) => void) { pickerCallback = cb; return this; }
        build() { return { setVisible: () => {} }; }
      },
      Action: { PICKED: "picked" },
    },
  };

  return {
    triggerPick: (id: string, name: string) =>
      pickerCallback?.({ action: "picked", docs: [{ id, name }] }),
  };
}

describe("MainPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the start sync button", async () => {
    stubFetch();
    render(<MainPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /start sync/i })).toBeInTheDocument();
    });
  });

  it("shows an error banner when starting a sync fails", async () => {
    stubFetch({
      "/picker/config": { ok: true, json: () => Promise.resolve({ access_token: "tok", api_key: "key" }) },
      "/sync/start": { ok: false, json: () => Promise.resolve({ error: "Already running" }) },
    });
    const { triggerPick } = setupPickerMock();

    render(<MainPage />);
    await waitFor(() => screen.getByRole("button", { name: /select a folder/i }));
    fireEvent.click(screen.getByRole("button", { name: /select a folder/i }));
    await waitFor(() => {
      triggerPick("folder-1", "My Photos");
      expect(screen.getByRole("button", { name: /start sync/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /start sync/i }));

    await waitFor(() => {
      expect(screen.getByText(/there was an issue completing this sync/i)).toBeInTheDocument();
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

  // ── Picker & folder selection ─────────────────────────────────────────────

  it("renders 'Select a Folder' button instead of a folder name initially", async () => {
    stubFetch();
    render(<MainPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /select a folder/i })).toBeInTheDocument();
    });
  });

  it("disables Start Sync when no folder is selected", async () => {
    stubFetch();
    render(<MainPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /start sync/i })).toBeDisabled();
    });
  });

  it("enables Start Sync after a folder is picked", async () => {
    stubFetch({
      "/picker/config": { ok: true, json: () => Promise.resolve({ access_token: "tok", api_key: "key" }) },
    });
    const { triggerPick } = setupPickerMock();

    render(<MainPage />);
    await waitFor(() => screen.getByRole("button", { name: /select a folder/i }));
    expect(screen.getByRole("button", { name: /start sync/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /select a folder/i }));

    await waitFor(() => {
      triggerPick("folder-1", "My Photos");
      expect(screen.getByRole("button", { name: /start sync/i })).toBeEnabled();
    });
  });

  it("shows truncated folder name in picker button when name exceeds 10 characters", async () => {
    stubFetch({
      "/picker/config": { ok: true, json: () => Promise.resolve({ access_token: "tok", api_key: "key" }) },
    });
    const { triggerPick } = setupPickerMock();

    render(<MainPage />);
    await waitFor(() => screen.getByRole("button", { name: /select a folder/i }));
    fireEvent.click(screen.getByRole("button", { name: /select a folder/i }));

    await waitFor(() => {
      triggerPick("folder-1", "Summer Vacation 2024");
      expect(screen.getByRole("button", { name: /selected: summer vacation…/i })).toBeInTheDocument();
    });
  });

  it("shows full folder name in picker button when name is 10 characters or fewer", async () => {
    stubFetch({
      "/picker/config": { ok: true, json: () => Promise.resolve({ access_token: "tok", api_key: "key" }) },
    });
    const { triggerPick } = setupPickerMock();

    render(<MainPage />);
    await waitFor(() => screen.getByRole("button", { name: /select a folder/i }));
    fireEvent.click(screen.getByRole("button", { name: /select a folder/i }));

    await waitFor(() => {
      triggerPick("folder-2", "Photos");
      expect(screen.getByRole("button", { name: /selected: photos/i })).toBeInTheDocument();
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
