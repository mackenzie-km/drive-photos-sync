import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import App from "./App";

// Mock child pages so these tests only cover App's routing logic.
vi.mock("./LoginPage", () => ({ default: () => <div>login page</div> }));
vi.mock("./MainPage", () => ({ default: () => <div>main page</div> }));

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading state before the auth check resolves", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})), // never resolves
    );
    render(<App />);
    expect(document.querySelector(".spinner")).toBeInTheDocument();
  });

  it("shows the login page when the user is not logged in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false } as Response)),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText("login page")).toBeInTheDocument(),
    );
  });

  it("shows the main page when the user is logged in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true } as Response)),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText("main page")).toBeInTheDocument(),
    );
  });
});
