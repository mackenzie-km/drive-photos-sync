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

// Minimal EventSource stub: on construction, waits a microtask (so the
// component has finished assigning onmessage/onerror/onopen, mirroring how
// the real connection's first push always arrives after handlers are wired
// up) then emits whatever status stubEventSource() was last called with.
let currentEventStatus: unknown = IDLE_STATUS;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    queueMicrotask(() => this.emit(currentEventStatus));
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function stubEventSource(status: unknown = IDLE_STATUS) {
  currentEventStatus = status;
  MockEventSource.instances = [];
  vi.stubGlobal(
    "EventSource",
    MockEventSource as unknown as typeof EventSource,
  );
}

function stubFetch(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url in overrides) {
        const val = overrides[url];
        return Promise.resolve(val as Response);
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    }),
  );
}

// Sets up window.gapi, window.google.picker, and window.google.accounts.oauth2 mocks
function setupPickerMock(
  options: { tokenResponse?: { access_token?: string } } = {},
) {
  const tokenResponse = options.tokenResponse ?? {
    access_token: "mock-drive-token",
  };
  let pickerCallback: ((data: unknown) => void) | null = null;

  (window as any).gapi = {
    load: (_: string, cb: () => void) => cb(),
  };

  (window as any).google = {
    accounts: {
      oauth2: {
        initTokenClient: ({
          callback,
        }: {
          callback: (response: unknown) => void;
        }) => ({
          requestAccessToken: () => callback(tokenResponse),
        }),
      },
    },
    picker: {
      DocsView: class {
        setIncludeFolders() {
          return this;
        }
        setSelectFolderEnabled() {
          return this;
        }
        setMimeTypes() {
          return this;
        }
      },
      PickerBuilder: class {
        addView() {
          return this;
        }
        setOAuthToken() {
          return this;
        }
        setDeveloperKey() {
          return this;
        }
        setCallback(cb: (data: unknown) => void) {
          pickerCallback = cb;
          return this;
        }
        build() {
          return { setVisible: () => {} };
        }
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
    stubEventSource();
  });

  it("renders the start sync button", async () => {
    stubFetch();
    render(<MainPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /start/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows an error banner when starting a sync fails", async () => {
    stubFetch({
      "/picker/config": {
        ok: true,
        json: () => Promise.resolve({ access_token: "tok", api_key: "key" }),
      },
      "/sync/start": {
        ok: false,
        json: () => Promise.resolve({ error: "Already running" }),
      },
    });
    const { triggerPick } = setupPickerMock();

    render(<MainPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /choose folder/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));
    await waitFor(() => {
      triggerPick("folder-1", "My Photos");
      expect(screen.getByRole("button", { name: /start/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/there was an issue completing this sync/i),
      ).toBeInTheDocument();
    });
  });

  it("displays file counts from the API with no undefined or NaN values", async () => {
    const fileCounts = {
      uploaded: 42,
      uninitialized: 17,
      failed: 8,
      skipped: 3,
    };
    stubEventSource({ ...IDLE_STATUS, fileCounts });

    render(<MainPage />);

    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument(); // uploaded
      expect(screen.getByText("17")).toBeInTheDocument(); // pending
      expect(screen.getByText("8")).toBeInTheDocument(); // failed
      expect(screen.getByText("3")).toBeInTheDocument(); // skipped
    });
    expect(screen.queryByText("undefined")).not.toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("defaults all file counts to 0 when the API omits them", async () => {
    stubEventSource({ ...IDLE_STATUS, fileCounts: {} });

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
      {
        id: "f1",
        name: "beach-vacation.jpg",
        mime_type: "image/jpeg",
        size: 1048576,
        synced_at: 1000,
      },
      {
        id: "f2",
        name: "birthday-party.png",
        mime_type: "image/png",
        size: 2621440,
        synced_at: 2000,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/sync/files")
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ files }),
          } as Response);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<MainPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /show uploaded files/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /show uploaded files/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("beach-vacation.jpg")).toBeInTheDocument();
      expect(screen.getByText("birthday-party.png")).toBeInTheDocument();
      expect(screen.getByText("1.0 MB")).toBeInTheDocument();
      expect(screen.getByText("2.5 MB")).toBeInTheDocument();
    });
  });

  // ── Abort ──────────────────────────────────────────────────────────────────

  it("shows a spinner instead of the Abort label while waiting for abort to take effect", async () => {
    stubEventSource({
      status: "uploading",
      currentFile: "photo.jpg",
      runId: 1,
      latestRun: null,
      fileCounts: { uploaded: 1 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/sync/abort")
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ message: "Abort signal sent" }),
          } as Response);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<MainPage />);
    const abortButton = await screen.findByRole("button", { name: /abort/i });
    fireEvent.click(abortButton);

    await waitFor(() => expect(abortButton).toBeDisabled());
    expect(abortButton.querySelector(".spinner-sm")).toBeInTheDocument();

    // Simulate the run actually finishing — the spinner/button should go
    // away once status leaves "uploading"/"discovering".
    MockEventSource.instances[0].emit({
      status: "aborted",
      currentFile: null,
      runId: 1,
      latestRun: null,
      fileCounts: {},
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /abort/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /choose folder/i })).toBeInTheDocument();
    });
  });

  it("resets to the plain Abort label if the abort request fails", async () => {
    stubEventSource({
      status: "discovering",
      currentFile: null,
      runId: 1,
      latestRun: null,
      fileCounts: {},
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/sync/abort") return Promise.reject(new Error("network error"));
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<MainPage />);
    const abortButton = await screen.findByRole("button", { name: /abort/i });
    fireEvent.click(abortButton);

    await waitFor(() => {
      expect(screen.getByText(/could not stop sync/i)).toBeInTheDocument();
    });
    expect(abortButton).toBeEnabled();
    expect(abortButton.querySelector(".spinner-sm")).not.toBeInTheDocument();
  });

  // ── Picker & folder selection ─────────────────────────────────────────────

  it("renders 'Choose Folder' button instead of a folder name initially", async () => {
    stubFetch();
    render(<MainPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /choose folder/i }),
      ).toBeInTheDocument();
    });
  });

  it("disables Start Sync when no folder is selected", async () => {
    stubFetch();
    render(<MainPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /start/i }),
      ).toBeDisabled();
    });
  });

  it("enables Start Sync after a folder is picked", async () => {
    stubFetch({
      "/picker/config": {
        ok: true,
        json: () => Promise.resolve({ access_token: "tok", api_key: "key" }),
      },
    });
    const { triggerPick } = setupPickerMock();

    render(<MainPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /choose folder/i }),
    );
    expect(screen.getByRole("button", { name: /start/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => {
      triggerPick("folder-1", "My Photos");
      expect(screen.getByRole("button", { name: /start/i })).toBeEnabled();
    });
  });

  it("shows truncated folder name in picker button when name exceeds 10 characters", async () => {
    stubFetch({
      "/picker/config": {
        ok: true,
        json: () => Promise.resolve({ access_token: "tok", api_key: "key" }),
      },
    });
    const { triggerPick } = setupPickerMock();

    render(<MainPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /choose folder/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => {
      triggerPick("folder-1", "Summer Vacation 2024");
      expect(
        screen.getByRole("button", { name: /summer vacation…/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows full folder name in picker button when name is 10 characters or fewer", async () => {
    stubFetch({
      "/picker/config": {
        ok: true,
        json: () => Promise.resolve({ access_token: "tok", api_key: "key" }),
      },
    });
    const { triggerPick } = setupPickerMock();

    render(<MainPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /choose folder/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => {
      triggerPick("folder-2", "Photos");
      expect(
        screen.getByRole("button", { name: /📁 photos/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows an error banner when loading uploaded files fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/sync/files")
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({}),
          } as Response);
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<MainPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /show uploaded files/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /show uploaded files/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/could not load uploaded files/i),
      ).toBeInTheDocument();
    });
  });

  // ── Pending-backlog resume (no folder re-selection required) ──────────────
  it("enables Resume Sync with no folder selected when there is a pending backlog", async () => {
    stubEventSource({ ...IDLE_STATUS, fileCounts: { uninitialized: 5 } });
    stubFetch();

    render(<MainPage />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /resume/i }),
      ).toBeEnabled();
    });
  });

  it("silently mints a token and resumes without opening the folder picker", async () => {
    stubEventSource({ ...IDLE_STATUS, fileCounts: { uninitialized: 5 } });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/picker/config")
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ client_id: "cid" }),
        } as Response);
      if (url === "/sync/start")
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ runId: 1 }),
        } as Response);
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    setupPickerMock();

    render(<MainPage />);
    await waitFor(() => screen.getByRole("button", { name: /resume/i }));
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));

    await waitFor(() => {
      const startCall = fetchMock.mock.calls.find(
        ([url]) => url === "/sync/start",
      );
      expect(startCall).toBeTruthy();
      const body = JSON.parse((startCall![1] as RequestInit).body as string);
      expect(body.folderId).toBeNull();
      expect(body.driveAccessToken).toBe("mock-drive-token");
    });
  });

  it("shows a reconnect error and does not start a sync when the silent token request fails", async () => {
    stubEventSource({ ...IDLE_STATUS, fileCounts: { uninitialized: 5 } });
    const fetchMock = vi.fn((url: string) => {
      if (url === "/picker/config")
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ client_id: "cid" }),
        } as Response);
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    setupPickerMock({ tokenResponse: {} });

    render(<MainPage />);
    await waitFor(() => screen.getByRole("button", { name: /resume/i }));
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));

    await waitFor(() => {
      expect(screen.getByText(/reconnect to drive/i)).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.some(([url]) => url === "/sync/start")).toBe(
      false,
    );
  });

  // ── Clear pending ──────────────────────────────────────────────────────────

  it("renders Clear pending only when idle and there are pending files", async () => {
    stubEventSource({ ...IDLE_STATUS, fileCounts: { uninitialized: 5 } });
    stubFetch();

    render(<MainPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /clear/i }),
      ).toBeInTheDocument();
    });
  });

  it("does not render Clear pending when there are no pending files", async () => {
    stubEventSource({ ...IDLE_STATUS, fileCounts: { uninitialized: 0 } });
    stubFetch();

    render(<MainPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /choose folder/i }),
    );
    expect(
      screen.queryByRole("button", { name: /clear/i }),
    ).not.toBeInTheDocument();
  });

  it("calls /sync/pending/clear when Clear pending is clicked", async () => {
    stubEventSource({ ...IDLE_STATUS, fileCounts: { uninitialized: 5 } });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/sync/pending/clear")
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ message: "Pending files cleared" }),
        } as Response);
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MainPage />);
    await waitFor(() => screen.getByRole("button", { name: /clear/i }));
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => url === "/sync/pending/clear"),
      ).toBe(true);
    });
  });
});
