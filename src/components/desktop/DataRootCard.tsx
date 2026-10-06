import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { PageCard } from "@/components/layout/PageCard";
import { getDataRoot, type DataRootInfo } from "@/infrastructure/tauri-bridge";

const IS_DESKTOP = import.meta.env.VITE_DESKTOP_DEPLOY === "true";

/**
 * Where this program's data actually lives.
 *
 * The reported "the new build still shows my old customers" is not a stale
 * build: business data lives in `%LOCALAPPDATA%\motard-erp\pgdata`, outside the
 * install folder, and the uninstaller keeps it on purpose so a reinstall reopens
 * the same company. A dev build opens a DIFFERENT root (`motard-erp-dev`) with
 * its own cluster, pipe and secrets. Printing both here is what makes the
 * distinction checkable instead of arguable.
 */
export function DataRootCard() {
  const [info, setInfo] = useState<DataRootInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_DESKTOP) return;
    void getDataRoot()
      .then((r) => {
        setInfo(r);
        setError(r ? null : "تعذّر قراءة مجلد البيانات");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "تعذّر قراءة مجلد البيانات"));
  }, []);

  if (!IS_DESKTOP) return null;

  return (
    <PageCard
      title="بيانات هذا التثبيت"
      description="قاعدة البيانات لا تُحفظ داخل مجلد البرنامج؛ uninstall لا يحذفها. لإعادة الضبط من الصفر استخدم «إعادة الضبط المصنعي» من داخل البرنامج."
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      {info && (
        <div className="space-y-2 text-sm" dir="ltr">
          <p className="flex items-center gap-2 text-sm">
            <HardDrive className="h-4 w-4" />
            <span className="font-mono">{info.dataRoot}</span>
            {info.profile === "dev" ? (
              <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-700">
                DEV BUILD — بيانات تطوير منفصلة عن بيانات الزبون
              </span>
            ) : (
              <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                RELEASE
              </span>
            )}
          </p>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <dt>database</dt>
            <dd className="font-mono">{info.databasePath}</dd>
            <dt>company</dt>
            <dd>{info.companyName ?? "—"}</dd>
            <dt>data id</dt>
            <dd className="font-mono">{info.dataId ?? "—"}</dd>
            <dt>schema</dt>
            <dd className="font-mono">{info.schemaJournalIdx ?? "—"}</dd>
            <dt>pipe</dt>
            <dd className="font-mono">{info.pipe}</dd>
          </dl>
        </div>
      )}
    </PageCard>
  );
}
