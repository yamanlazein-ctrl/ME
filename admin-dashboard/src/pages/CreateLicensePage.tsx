import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createLicense } from "@/lib/api";
import { EDITIONS, PLANS, PLAN_FEATURES, FEATURES } from "@/types";
import { toast } from "sonner";
import { X, Plus } from "lucide-react";

interface CreateLicensePageProps {
  onClose: () => void;
}

export function CreateLicensePage({ onClose }: CreateLicensePageProps) {
  const qc = useQueryClient();
  const [companyName, setCompanyName] = useState("");
  const [edition, setEdition] = useState<(typeof EDITIONS)[number]["value"]>("erp");
  const [plan, setPlan] = useState<(typeof PLANS)[number]["value"]>("standard");
  const [licenseModel, setLicenseModel] = useState<"perpetual" | "subscription">("perpetual");
  const [extra, setExtra] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [limits, setLimits] = useState({ users: 20, devices: 2, warehouses: 3 });

  const baseline = useMemo(() => PLAN_FEATURES[plan], [plan]);

  const isChecked = (f: string) =>
    (baseline.includes(f) && !removed.includes(f)) || extra.includes(f);

  const toggle = (f: string) => {
    if (baseline.includes(f)) {
      setRemoved((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));
    } else {
      setExtra((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));
    }
  };

  const mutation = useMutation({
    mutationFn: () =>
      createLicense({
        companyName,
        edition,
        plan,
        licenseModel,
        featureAdd: extra,
        featureRemove: removed,
        limits: { users: limits.users, devices: limits.devices, warehouses: limits.warehouses },
      }),
    onSuccess: () => {
      toast.success("تم إصدار الترخيص بنجاح");
      qc.invalidateQueries({ queryKey: ["licenses"] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "فشل إصدار الترخيص"),
  });

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-white">إصدار ترخيص جديد</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-zinc-300 mb-1">اسم الشركة / العميل</label>
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder:text-zinc-500"
              placeholder="اسم الشركة"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-zinc-300 mb-1">الإصدار (Edition)</label>
              <select
                value={edition}
                onChange={(e) => setEdition(e.target.value as typeof edition)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white"
              >
                {EDITIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-zinc-300 mb-1">الخطة (Plan)</label>
              <select
                value={plan}
                onChange={(e) => setPlan(e.target.value as typeof plan)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white"
              >
                {PLANS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm text-zinc-300 mb-1">نموذج الترخيص</label>
            <select
              value={licenseModel}
              onChange={(e) => setLicenseModel(e.target.value as typeof licenseModel)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white"
            >
              <option value="perpetual">دائم (Perpetual)</option>
              <option value="subscription">اشتراك (Subscription)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-zinc-300 mb-2">الميزات (الأساس من الخطة + تخصيص)</label>
            <div className="grid grid-cols-2 gap-2">
              {FEATURES.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => toggle(f.value)}
                  className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                    isChecked(f.value)
                      ? "border-blue-500 bg-blue-500/20 text-blue-300"
                      : "border-zinc-700 text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">مستخدمون</label>
              <input
                type="number"
                min={1}
                value={limits.users}
                onChange={(e) => setLimits((l) => ({ ...l, users: Number(e.target.value) }))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">أجهزة</label>
              <input
                type="number"
                min={1}
                value={limits.devices}
                onChange={(e) => setLimits((l) => ({ ...l, devices: Number(e.target.value) }))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-white"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">مخازن</label>
              <input
                type="number"
                min={1}
                value={limits.warehouses}
                onChange={(e) => setLimits((l) => ({ ...l, warehouses: Number(e.target.value) }))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-white"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-white rounded-lg border border-zinc-700 hover:border-zinc-600"
          >
            إلغاء
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !companyName.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-50 flex items-center gap-1"
          >
            <Plus size={16} />
            {mutation.isPending ? "جاري الإصدار…" : "إصدار الترخيص"}
          </button>
        </div>
      </div>
    </div>
  );
}
