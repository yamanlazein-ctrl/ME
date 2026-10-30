// "Share PDF": builds the document's PDF and opens the system share sheet (WhatsApp or any app). It never claims the
// document was delivered — only that the sheet opened.
import { useState } from "react";
import { View } from "react-native";
import { shareDocument, type DocRef } from "../print/sendToCustomer";
import { Button, Notice } from "./kit";

export function SharePdfButton({
  docRef,
  label = "مشاركة PDF (واتساب وغيره)",
  variant = "secondary",
}: {
  docRef: DocRef;
  label?: string;
  variant?: "primary" | "secondary";
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  return (
    <View style={{ gap: 8 }}>
      <Button
        label={label}
        variant={variant}
        icon="share-social-outline"
        busyLabel="جارٍ تجهيز الملف…"
        testID="share-pdf"
        onPress={async () => {
          setResult(null);
          try {
            setResult(await shareDocument(docRef));
          } catch (e) {
            setResult({ ok: false, message: e instanceof Error ? e.message : "تعذّر تجهيز الملف" });
          }
        }}
      />
      {result ? (
        <Notice kind={result.ok ? "info" : "error"} text={result.message} testID="share-result" />
      ) : null}
    </View>
  );
}
