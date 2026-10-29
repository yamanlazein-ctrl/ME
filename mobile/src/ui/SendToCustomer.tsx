// "Send to customer" button: PDF + the customer's chat on WhatsApp. With no saved phone it asks for one.
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { whatsappDigits } from "../core/share";
import {
  prepareSend,
  savePartyPhone,
  send,
  type DocRef,
  type PreparedSend,
} from "../print/sendToCustomer";
import { PhonePrompt } from "./PhonePrompt";
import { colors, radius, spacing, TOUCH_TARGET } from "./theme";

export function SendToCustomer({
  docRef,
  label = "إرسال للعميل",
}: {
  docRef: DocRef;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<PreparedSend | null>(null);
  const [asking, setAsking] = useState(false);
  const [phone, setPhone] = useState("");
  const [save, setSave] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const dispatch = async (p: PreparedSend, number: string) => {
    const r = await send(p, number);
    setResult(
      r.route === "whatsapp"
        ? "فُتح واتساب على محادثة العميل — اضغط إرسال هناك"
        : "تعذّر فتح واتساب مباشرة، فُتحت مشاركة الملف",
    );
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const p = await prepareSend(docRef);
      setPrepared(p);
      if (p.phone && whatsappDigits(p.phone)) await dispatch(p, p.phone);
      else setAsking(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر التحضير");
    } finally {
      setBusy(false);
    }
  };

  const sendTyped = async () => {
    if (!prepared) return;
    if (!whatsappDigits(phone)) return setError("رقم الهاتف غير صالح");
    setBusy(true);
    setError(null);
    try {
      if (save) await savePartyPhone(prepared, phone);
      await dispatch(prepared, phone);
      setAsking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر الإرسال");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="send-to-customer"
        disabled={busy}
        onPress={() => void start()}
        style={{
          minHeight: TOUCH_TARGET,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: colors.primary,
          borderRadius: radius.md,
          marginTop: spacing.md,
        }}
      >
        <Text style={{ color: colors.primaryForeground }}>{busy ? "جارٍ التحضير…" : label}</Text>
      </Pressable>
      {asking && prepared ? (
        <PhonePrompt
          partyName={prepared.partyName}
          value={phone}
          save={save}
          busy={busy}
          error={error}
          onChange={setPhone}
          onToggleSave={() => setSave((s) => !s)}
          onSend={() => void sendTyped()}
          onCancel={() => setAsking(false)}
        />
      ) : error ? (
        <Text testID="send-error" style={{ color: colors.negative, marginTop: spacing.sm }}>
          {error}
        </Text>
      ) : null}
      {result ? (
        <Text testID="send-result" style={{ marginTop: spacing.sm }}>
          {result}
        </Text>
      ) : null}
    </View>
  );
}
