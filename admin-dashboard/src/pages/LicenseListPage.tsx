import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchLicenses, fetchActivations, deactivateActivation } from "@/lib/api";
import { CreateLicensePage } from "./CreateLicensePage";
import { Key, ShieldCheck, ShieldX, Clock, Monitor, Loader2, Search, Plus, Trash2, Copy, ChevronLeft } from "lucide-react";
import { toast } from "sonner";
import type { License } from "@/types";
import { PLANS, EDITIONS } from "@/types";

function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return key.slice(0, 8) + "…";
}

const STATUS_MAP: Record<string, { label: string; class: string }> = {
  active: { label: "نشط", class: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  suspended: { label: "معلق", class: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  expired: { label: "منتهي", class: "bg-red-500/10 text-red-400 border-red-500/20" },
  revoked: { label: "ملغي", class: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" },
};

const TYPE_MAP: Record<string, string> = {
  trial: "تجريبي",
  full: "كامل",
  subscription: "اشتراك",
};

export function LicenseListPage({ onLogout }: { onLogout: () => void }) {
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedLicense, setSelectedLicense] = useState<string | null>(null);

  const { data: licenses, isLoading } = useQuery({
    queryKey: ["licenses"],
    queryFn: fetchLicenses,
    refetchInterval: 30_000,
  });

  const filtered = (licenses ?? []).filter(
    (l) =>
      !search ||
      l.key.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-zinc-950">
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Key size={20} className="text-blue-400" />
            <h1 className="text-lg font-semibold text-white">لوحة تحكم التراخيص</h1>
          </div>
          <button
            onClick={onLogout}
            className="text-sm text-zinc-400 hover:text-white px-3 py-1.5 rounded-lg border border-zinc-700 hover:border-zinc-600"
          >
            خروج
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {selectedLicense ? (
          <LicenseDetail
            licenseId={selectedLicense}
            licenses={licenses ?? []}
            onBack={() => setSelectedLicense(null)}
          />
        ) : (
          <>
            <div className="flex items-center justify-between mb-6">
              <div className="relative">
                <Search size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="بحث عن ترخيص…"
                  className="w-64 rounded-lg border border-zinc-700 bg-zinc-800 pl-3 pr-9 py-2 text-sm text-white placeholder:text-zinc-500"
                />
              </div>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1 px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              >
                <Plus size={16} />
                إصدار ترخيص جديد
              </button>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 size={24} className="animate-spin text-zinc-500" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-20">
                <Key size={40} className="mx-auto text-zinc-700 mb-3" />
                <p className="text-zinc-500">لا توجد تراخيص بعد</p>
              </div>
            ) : (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-400">
                      <th className="text-right px-4 py-3 font-medium">المفتاح</th>
                      <th className="text-right px-4 py-3 font-medium">النوع</th>
                      <th className="text-right px-4 py-3 font-medium">الخطة</th>
                      <th className="text-right px-4 py-3 font-medium">الحالة</th>
                      <th className="text-right px-4 py-3 font-medium">الأجهزة</th>
                      <th className="text-right px-4 py-3 font-medium">تاريخ الإصدار</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((l) => (
                      <tr
                        key={l.id}
                        onClick={() => setSelectedLicense(l.id)}
                        className="border-b border-zinc-800/50 hover:bg-zinc-800/50 cursor-pointer transition-colors"
                      >
                        <td className="px-4 py-3">
                          <span className="font-mono text-white">{maskKey(l.key)}</span>
                        </td>
                        <td className="px-4 py-3 text-zinc-300">{TYPE_MAP[l.type] ?? l.type}</td>
                        <td className="px-4 py-3 text-zinc-300">
                          {PLANS.find((p) => p.value === l.plan)?.label ?? l.plan ?? "-"}
                          {l.edition ? ` · ${EDITIONS.find((e) => e.value === l.edition)?.label ?? l.edition}` : ""}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs px-2 py-0.5 rounded border ${STATUS_MAP[l.status]?.class ?? "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"}`}
                          >
                            {STATUS_MAP[l.status]?.label ?? l.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-zinc-300">{l.maxDevices ?? "-"}</td>
                        <td className="px-4 py-3 text-zinc-400">
                          {l.issuedAt ? new Date(l.issuedAt).toLocaleDateString("ar-SA") : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {showCreate && <CreateLicensePage onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function LicenseDetail({
  licenseId,
  licenses,
  onBack,
}: {
  licenseId: string;
  licenses: License[];
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const lic = licenses.find((l) => l.id === licenseId);

  const { data: activationsData, isLoading: actsLoading } = useQuery({
    queryKey: ["activations"],
    queryFn: fetchActivations,
    refetchInterval: 30_000,
  });

  const activations = (activationsData ?? []).filter((a) => a.licenseId === licenseId);

  const deactivateMut = useMutation({
    mutationFn: (activationId: string) => deactivateActivation(activationId),
    onSuccess: () => {
      toast.success("تم إلغاء التفعيل بنجاح");
      qc.invalidateQueries({ queryKey: ["activations"] });
      qc.invalidateQueries({ queryKey: ["licenses"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "فشل إلغاء التفعيل"),
  });

  if (!lic) return null;

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-sm text-zinc-400 hover:text-white mb-4"
      >
        <ChevronLeft size={16} />
        العودة للقائمة
      </button>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-white">تفاصيل الترخيص</h2>

          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-400">المفتاح</span>
              <span className="font-mono text-white">{lic.key}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">النوع</span>
              <span className="text-white">{TYPE_MAP[lic.type] ?? lic.type}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">الإصدار / الخطة</span>
              <span className="text-white">
                {EDITIONS.find((e) => e.value === lic.edition)?.label ?? lic.edition ?? "-"}
                {" / "}
                {PLANS.find((p) => p.value === lic.plan)?.label ?? lic.plan ?? "-"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">نموذج الترخيص</span>
              <span className="text-white">
                {lic.licenseModel === "subscription" ? "اشتراك" : "دائم"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">الحالة</span>
              <span className={`text-xs px-2 py-0.5 rounded border ${STATUS_MAP[lic.status]?.class}`}>
                {STATUS_MAP[lic.status]?.label ?? lic.status}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">الأجهزة</span>
              <span className="text-white">{lic.maxDevices}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">الميزات</span>
              <span className="text-white">{(lic.features ?? []).join("، ") || "-"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">القيود</span>
              <span className="text-white">
                مستخدمون {lic.limits?.users ?? "-"} · أجهزة {lic.limits?.devices ?? "-"} · مخازن{" "}
                {lic.limits?.warehouses ?? "-"}
              </span>
            </div>
            {lic.expiresAt && (
              <div className="flex justify-between">
                <span className="text-zinc-400">تاريخ الانتهاء</span>
                <span className="text-white">
                  {new Date(lic.expiresAt).toLocaleDateString("ar-SA")}
                </span>
              </div>
            )}
          </div>

          <button
            onClick={() => {
              navigator.clipboard.writeText(lic.key);
              toast.success("تم نسخ المفتاح");
            }}
            className="flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300"
          >
            <Copy size={14} />
            نسخ المفتاح
          </button>
        </div>

        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-lg font-semibold text-white">سجل التفعيلات</h2>

          {actsLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 size={20} className="animate-spin text-zinc-500" />
            </div>
          ) : activations.length === 0 ? (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center">
              <Monitor size={32} className="mx-auto text-zinc-700 mb-2" />
              <p className="text-zinc-500">لم يتم تفعيل هذا الترخيص بعد</p>
            </div>
          ) : (
            <div className="space-y-3">
              {activations.map((a) => (
                <div key={a.id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                  <div className="flex items-start justify-between">
                    <div className="space-y-1 text-sm">
                      <div className="flex items-center gap-2">
                        {a.deactivatedAt ? (
                          <ShieldX size={16} className="text-red-400" />
                        ) : (
                          <ShieldCheck size={16} className="text-emerald-400" />
                        )}
                        <span className="text-white font-medium">
                          {a.hostname || "جهاز غير معروف"}
                        </span>
                        {a.deactivatedAt && (
                          <span className="text-xs px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded">
                            ملغي
                          </span>
                        )}
                      </div>
                      <p className="text-zinc-500">
                        البصمة: {a.serverFingerprint?.slice(0, 16) ?? "-"}…
                      </p>
                      <div className="flex items-center gap-4 text-xs text-zinc-500">
                        <span className="flex items-center gap-1">
                          <Clock size={12} />
                          فعّل: {new Date(a.createdAt).toLocaleDateString("ar-SA")}
                        </span>
                        {a.lastSeenAt && (
                          <span>آخر رؤية: {new Date(a.lastSeenAt).toLocaleDateString("ar-SA")}</span>
                        )}
                      </div>
                    </div>
                    {!a.deactivatedAt && (
                      <button
                        onClick={() => deactivateMut.mutate(a.id)}
                        disabled={deactivateMut.isPending}
                        className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded border border-red-500/20 hover:border-red-500/40 transition-colors"
                      >
                        <Trash2 size={12} />
                        إلغاء التفعيل
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
