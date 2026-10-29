import { useEffect, useState } from "react";
import { PinLoginError, type RosterUser } from "../src/core/session";
import { getSessionService } from "../src/core/sessionService";
import { signalUnlocked } from "../src/core/lockSignal";
import { notifyBootChanged } from "../src/hooks/useBoot";
import { LoginView, PIN_LENGTH, type PinStep } from "../src/ui/LoginView";

export default function Login() {
  const [users, setUsers] = useState<RosterUser[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [pinStep, setPinStep] = useState<PinStep>("enter");
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"pin" | "password">("pin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const select = (id: string | null) => {
    setSelectedId(id);
    setPin("");
    setChosen("");
    setError(null);
    const user = users.find((u) => u.id === id);
    setPinStep(user && user.hasPin === false ? "choose" : "enter");
  };

  useEffect(() => {
    void getSessionService()
      .then((s) => s.roster())
      .then((list) => {
        setUsers(list);
        const only = list.length === 1 ? list[0] : undefined;
        if (only) {
          setSelectedId(only.id);
          setPinStep(only.hasPin === false ? "choose" : "enter");
        }
      })
      .catch(() => setError("تعذّر جلب المستخدمين من المركز. تحقق من الاتصال ثم أعد فتح التطبيق"));
  }, []);

  const finish = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      signalUnlocked();
      notifyBootChanged();
    } catch (e) {
      setError(e instanceof PinLoginError ? e.message : "تعذّر تسجيل الدخول");
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  const submitPin = async (value: string) => {
    const service = await getSessionService();
    const user = users.find((u) => u.id === selectedId);
    if (!user) return setError("اختر المستخدم أولاً");
    if (value.length !== PIN_LENGTH) return setError("الرقم السري 4 أرقام");
    if (pinStep === "choose") {
      setChosen(value);
      setPin("");
      setPinStep("confirm");
      return;
    }
    if (pinStep === "confirm") {
      if (value !== chosen) {
        setChosen("");
        setPin("");
        setPinStep("choose");
        return setError("الرقمان غير متطابقين. اختر الرقم السري من جديد");
      }
      await finish(async () => {
        try {
          await service.setPin(user.id, value);
        } catch (e) {
          // A refused PIN (weak, …) goes back to choosing; the hub's reason is shown.
          setChosen("");
          setPinStep("choose");
          throw e;
        }
        setUsers((list) => list.map((u) => (u.id === user.id ? { ...u, hasPin: true } : u)));
        setPinStep("enter");
        await service.pinLogin(user.id, value);
      });
      return;
    }
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
      pinStep={pinStep}
      error={error}
      busy={busy}
      mode={mode}
      email={email}
      password={password}
      onSelect={select}
      onKey={(k) => {
        if (busy) return;
        setError(null);
        if (k === "⌫") setPin((p) => p.slice(0, -1));
        else if (k === "✓") void submitPin(pin);
        else setPin((p) => (p.length < PIN_LENGTH ? p + k : p));
      }}
      onToggleMode={() => {
        setError(null);
        setMode((m) => (m === "pin" ? "password" : "pin"));
      }}
      onChangeCredentials={(c) => {
        if (c.email !== undefined) setEmail(c.email);
        if (c.password !== undefined) setPassword(c.password);
      }}
      onSubmit={() =>
        finish(async () => (await getSessionService()).passwordLogin(email.trim(), password))
      }
    />
  );
}
