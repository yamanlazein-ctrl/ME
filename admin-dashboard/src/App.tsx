import { useState, useCallback } from "react";
import { LoginPage } from "@/pages/LoginPage";
import { LicenseListPage } from "@/pages/LicenseListPage";

export default function App() {
  const [loggedIn, setLoggedIn] = useState(() => sessionStorage.getItem("admin_token") !== null);

  const handleLogin = useCallback(() => setLoggedIn(true), []);
  const handleLogout = useCallback(() => {
    sessionStorage.removeItem("admin_token");
    setLoggedIn(false);
  }, []);

  if (!loggedIn) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <LicenseListPage onLogout={handleLogout} />;
}
