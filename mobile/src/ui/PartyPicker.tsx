// Choosing a customer or supplier inside a form: a field that shows the choice (and can change it) and a sheet that
// searches by name, code or phone.
import { useState } from "react";
import { usePartyList } from "../hooks/useParties";
import { EmptyState, ListRow, LoadingState, PickerField, SearchBar, Section, Sheet } from "./kit";

export interface PickedParty {
  id: string;
  name: string;
}

export function PartyPicker({
  kind,
  value,
  onPick,
  label,
  error,
}: {
  kind: "customer" | "supplier";
  value: PickedParty | null;
  onPick(party: PickedParty): void;
  label?: string;
  error?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = usePartyList(q, kind);
  const who = kind === "customer" ? "العميل" : "المورد";
  return (
    <>
      <PickerField
        label={label ?? who}
        value={value?.name ?? null}
        placeholder={`اختر ${who}`}
        onPress={() => setOpen(true)}
        testID="party-picker"
        {...(error !== undefined ? { error } : {})}
      />
      <Sheet
        visible={open}
        title={`اختر ${who}`}
        onClose={() => setOpen(false)}
        testID="party-sheet"
      >
        <PartyPickerView
          q={q}
          onQuery={setQ}
          rows={list.data}
          onPick={(p) => {
            onPick(p);
            setOpen(false);
          }}
        />
      </Sheet>
    </>
  );
}

export function PartyPickerView({
  q,
  onQuery,
  rows,
  onPick,
}: {
  q: string;
  onQuery(q: string): void;
  rows:
    Array<{ id: string; name: string; code?: string | null; phone?: string | null }> | undefined;
  onPick(party: PickedParty): void;
}) {
  return (
    <>
      <SearchBar
        value={q}
        onChange={onQuery}
        placeholder="الاسم أو الرمز أو الهاتف"
        testID="picker-search"
      />
      {!rows ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState title="لا نتائج" hint="يمكن إضافة طرف جديد من تبويب العملاء والموردين." />
      ) : (
        <Section padded={false}>
          {rows.slice(0, 50).map((r, i) => (
            <ListRow
              key={r.id}
              testID="party-option"
              title={r.name}
              subtitle={[r.code, r.phone].filter(Boolean).join(" · ") || null}
              onPress={() => onPick({ id: r.id, name: r.name })}
              last={i === Math.min(rows.length, 50) - 1}
            />
          ))}
        </Section>
      )}
    </>
  );
}
