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
  if (!loggedIn) return <LoginPage />;
  return <MainPage />;
}
