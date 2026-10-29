import { useEffect, useState } from "react";
import { PinLoginError, type RosterUser } from "../src/core/session";
import { getSessionService } from "../src/core/sessionService";
import { signalUnlocked } from "../src/core/lockSignal";
import { notifyBootChanged } from "../src/hooks/useBoot";
import { LoginView, PIN_LENGTH_MAX } from "../src/ui/LoginView";

export default function Login() {
  const [users, setUsers] = useState<RosterUser[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"pin" | "password">("pin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    void getSessionService()
      .then((s) => s.roster())
      .then((list) => {
        setUsers(list);
        if (list.length === 1 && list[0]) setSelectedId(list[0].id);
      });
  }, []);

  const finish = async (run: () => Promise<unknown>) => {
    try {
      await run();
      signalUnlocked();
      notifyBootChanged();
    } catch (e) {
      setError(e instanceof PinLoginError ? e.message : "تعذّر تسجيل الدخول");
      setPin("");
    }
  };

  const submitPin = async (value: string) => {
    const service = await getSessionService();
    const user = users.find((u) => u.id === selectedId);
    if (!user) return setError("اختر المستخدم أولاً");
    // Online first; when the hub is unreachable, the stored PIN verifier signs the user in offline (FR-05).
    await finish(async () => {
      try {
        await service.pinLogin(user.id, value);
      } catch (e) {
        if (e instanceof PinLoginError && e.kind === "network") {
          await service.offlineLogin(user.id, value, user);
        } else {
          throw e;
        }
      }
    });
  };

  return (
    <LoginView
      users={users}
      selectedId={selectedId}
      pin={pin}
      error={error}
      mode={mode}
      email={email}
      password={password}
      onSelect={(id) => {
        setSelectedId(id);
        setError(null);
      }}
      onKey={(k) => {
        setError(null);
        if (k === "⌫") setPin((p) => p.slice(0, -1));
        else if (k === "✓") void submitPin(pin);
        else setPin((p) => (p.length < PIN_LENGTH_MAX ? p + k : p));
      }}
      onToggleMode={() => setMode((m) => (m === "pin" ? "password" : "pin"))}
      onChangeCredentials={(c) => {
        if (c.email !== undefined) setEmail(c.email);
        if (c.password !== undefined) setPassword(c.password);
      }}
      onSubmit={() =>
        void finish(async () => (await getSessionService()).passwordLogin(email.trim(), password))
      }
    />
  );
}
