import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { randomUUID } from "node:crypto";
import { copyOfLine } from "../../../../src/core/entryDraft";
import type { EntryLineInput } from "../../../../src/core/documents";
import { entryDraftStore, useEntryDraft } from "../../../../src/hooks/useEntryDraft";
import { EntryLineView } from "../../../../src/ui/EntryViews";

// One purchase line on its own page. `edit` = the key of a line to change; `copy` = the key of a line whose fabric,
// colour, price and details start the new one. «حفظ وبند جديد» adds the line and starts the next one of the same kind.
export default function EntryLine() {
  const draft = useEntryDraft();
  const { edit, copy } = useLocalSearchParams<{ edit?: string; copy?: string }>();
  const editing = edit ? draft.lines.find((l) => l.key === edit) : undefined;
  const copied = copy ? draft.lines.find((l) => l.key === copy) : undefined;
  const [start, setStart] = useState<{ n: number; initial?: Partial<EntryLineInput> }>({
    n: 0,
    ...(editing ? { initial: editing } : copied ? { initial: copyOfLine(copied) } : {}),
  });
  return (
    <EntryLineView
      key={start.n}
      currency={draft.currency}
      editing={Boolean(editing)}
      {...(start.initial ? { initial: start.initial } : {})}
      onCancel={() => router.back()}
      onSave={(line, next) => {
        const lines = entryDraftStore.get().lines;
        entryDraftStore.update({
          lines: editing
            ? lines.map((l) => (l.key === editing.key ? { ...line, key: l.key } : l))
            : [...lines, { ...line, key: randomUUID() }],
        });
        if (next) setStart((s) => ({ n: s.n + 1, initial: copyOfLine(line) }));
        else router.back();
      }}
    />
  );
}
