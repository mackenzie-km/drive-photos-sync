import { Component } from "react";
import type { ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[app crash]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100svh",
            fontFamily: "sans-serif",
            gap: "12px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <p style={{ fontSize: "2rem" }}>😵</p>
          <p style={{ fontWeight: 600, fontSize: "1.1rem", color: "#141414" }}>
            Something went wrong.
          </p>
          <p style={{ color: "#666", fontSize: "0.95rem" }}>
            Try refreshing the page. If it keeps happening, contact support.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: "8px" }}
          >
            Refresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
