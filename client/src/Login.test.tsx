import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import LoginPage from "./LoginPage";

vi.mock("./assets/stack-of-photos.png", () => ({ default: "stack-of-photos.png" }));

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("renders the sign-in button", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<LoginPage />);
    expect(
      screen.getByRole("button", { name: /sign in with google/i }),
    ).toBeInTheDocument();
  });

  it("shows an error banner when the auth URL fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network error"))),
    );
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/could not reach the server/i),
      ).toBeInTheDocument();
    });
  });

  it("shows an error banner when redirected back with auth_error in the URL", async () => {
    window.history.replaceState({}, "", "/?auth_error=access_denied");
    vi.stubGlobal("fetch", vi.fn());
    render(<LoginPage />);
    await waitFor(() => {
      expect(
        screen.getByText(/sign-in was cancelled or failed/i),
      ).toBeInTheDocument();
    });
  });
});
