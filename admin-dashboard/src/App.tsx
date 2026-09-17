import { useState, useCallback } from "react";
import { LoginPage } from "@/pages/LoginPage";
import { LicenseListPage } from "@/pages/LicenseListPage";

/** Owner-only local dashboard: no email/password on loopback. */
function isLoopbackHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}

export default function App() {
  const localOpen = isLoopbackHost();
  const [loggedIn, setLoggedIn] = useState(
    () => localOpen || sessionStorage.getItem("admin_token") !== null,
  );

  const handleLogin = useCallback(() => setLoggedIn(true), []);
  const handleLogout = useCallback(() => {
    if (localOpen) return;
    sessionStorage.removeItem("admin_token");
    setLoggedIn(false);
  }, [localOpen]);

  if (!loggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <LicenseListPage onLogout={localOpen ? undefined : handleLogout} />;
}
