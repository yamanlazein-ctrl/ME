// Test-only screen (tasks T037). Present in the test APK only: the release build leaves EXPO_PUBLIC_SPIKES
// unset and this route redirects to Home.
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Redirect } from "expo-router";
import { runMoneyVectorsHere } from "../src/spikes/moneyVectors";
import { measureArgon2, runS1 } from "../src/spikes/s1";
import { runS2OnDevice, shareS2Export } from "../src/spikes/s2";
import { runS3 } from "../src/spikes/s3";

const ENABLED = process.env.EXPO_PUBLIC_SPIKES === "1";

function Button(props: { label: string; onPress?: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        minHeight: 48,
        padding: 12,
        marginBottom: 8,
        borderRadius: 8,
        backgroundColor: props.disabled ? "#cbd5e1" : "#1d4ed8",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: "#fff", fontSize: 16, textAlign: "center" }}>{props.label}</Text>
    </Pressable>
  );
}

export default function Spikes() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [s2Export, setS2Export] = useState<string | null>(null);
  if (!ENABLED) return <Redirect href="/" />;

  const append = (lines: string[]) => setLog((prev) => [...lines, ...prev]);
  const run = async (fn: () => Promise<string[]>) => {
    setBusy(true);
    try {
      append(await fn());
    } catch (e) {
      append([`ERROR ${e instanceof Error ? e.message : String(e)}`]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 48 }}>
      <Text style={{ fontSize: 20, marginBottom: 12 }}>Spikes (test build)</Text>
      <Button
        label="S1 SQLite"
        disabled={busy}
        onPress={() =>
          run(async () => {
            const lines = (await runS1()).map((l) =>
              `${l.id}: ${l.ok ? "PASS" : "FAIL"} ${l.detail}`.trim(),
            );
            return [...lines, `ARGON2-MS: ${await measureArgon2()}`];
          })
        }
      />
      <Button
        label="S2 Use-cases"
        disabled={busy}
        onPress={() =>
          run(async () => {
            const out = await runS2OnDevice();
            setS2Export(out.exportUri);
            return out.lines;
          })
        }
      />
      {s2Export ? (
        <Button
          label="Export for comparison"
          disabled={busy}
          onPress={() => run(async () => (await shareS2Export(s2Export), ["S2: exported"]))}
        />
      ) : null}
      <Button
        label="S3 PDF"
        disabled={busy}
        onPress={() =>
          run(async () => {
            const r = await runS3();
            return [
              `S3: invoice ${r.invoiceMs} ms, statement (${r.statementRows} rows) ${r.statementMs} ms`,
            ];
          })
        }
      />
      <Button label="متاح بعد المرحلة 7" disabled />
      <Button
        label="Money vectors (Hermes)"
        disabled={busy}
        onPress={() =>
          run(async () => {
            const r = runMoneyVectorsHere();
            return [
              `MONEY-VECTORS-HERMES: ${r.passed}/${r.total}${r.failedIds.length ? ` failed: ${r.failedIds.slice(0, 5).join(", ")}` : ""}`,
            ];
          })
        }
      />
      <View style={{ marginTop: 16 }}>
        {log.map((l, i) => (
          <Text key={i} selectable style={{ fontSize: 14, marginBottom: 4 }}>
            {l}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
