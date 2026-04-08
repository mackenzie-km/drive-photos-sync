import { useEffect, useState } from "react";
import "./App.css";
import LoginPage from "./LoginPage";
import MainPage from "./MainPage";

export default function App() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/auth/me")
      .then((r) => setLoggedIn(r.ok))
      .catch(() => setLoggedIn(false));
  }, []);

  if (loggedIn === null)
    return (
      <div className="spinner-container">
        <div className="spinner" />
      </div>
    );

  return (
    <>
      <div className="container">
        <h1>
          <span className="h1-emoji">📸</span> Tag and Sync
        </h1>
        {loggedIn ? <MainPage /> : <LoginPage />}
      </div>
      <footer className="footer">
        <p>
          Made with care by{" "}
          <a href="https://www.mackenziekg.dev" target="_blank" rel="noreferrer">
            mackenziekg.dev
          </a>{" "}
          in 2026. All rights reserved. See my{" "}
          <a
            href="https://sync.mackenziekg.dev/privacy.html"
            target="_blank"
            rel="noreferrer"
          >
            Privacy Policy
          </a>
        </p>
      </footer>
    </>
  );
}
