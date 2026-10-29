import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Copy, KeyRound, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { hubSync, type HubDevice } from "@/lib/sync-engine";
import { getRegisteredSyncDeviceId } from "@/lib/sync-device";

const KEY = ["sync", "hub-devices"] as const;

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

/**
 * Company devices on the hub (admin only): the enrollment code new devices use,
 * and every registered device with disable / re-enable. Disabling never deletes
 * data — the device just stops syncing until re-enabled.
 */
export function HubDevicesCard() {
  const qc = useQueryClient();
  const self = getRegisteredSyncDeviceId();
  const [confirm, setConfirm] = useState<HubDevice | null>(null);

  const devices = useQuery({ queryKey: [...KEY, "list"], queryFn: () => hubSync.devices() });
  const code = useQuery({ queryKey: [...KEY, "code"], queryFn: () => hubSync.enrollmentCode() });
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  const newCode = useMutation({
    mutationFn: () => hubSync.createEnrollmentCode(),
    onSuccess: async () => {
      toast.success("أُنشئ رمز تسجيل جديد — الرمز السابق لم يعد صالحاً");
      await refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancelCode = useMutation({
    mutationFn: () => hubSync.revokeEnrollmentCode(),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = useMutation({
    mutationFn: (d: HubDevice) =>
      d.revokedAt ? hubSync.reinstateDevice(d.id) : hubSync.revokeDevice(d.id),
    onSuccess: async (_r, d) => {
      toast.success(d.revokedAt ? "أُعيد تفعيل الجهاز" : "عُطِّل الجهاز — توقّفت مزامنته");
      await refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const current = code.data?.current ?? null;
  const expired = current ? Date.parse(current.expiresAt) <= Date.now() : false;
  const items = devices.data?.items ?? [];
  const live = items.filter((d) => !d.revokedAt).length;

  return (
    <PageCard
      title="أجهزة الشركة"
      description={`الأجهزة المسجّلة في المركز (${live} فعّال من ${items.length}). الحد الأقصى يحدده ترخيص المركز.`}
    >
      <div className="mb-5 rounded-lg border border-border p-3 text-sm">
        <div className="mb-2 font-semibold">رمز تسجيل الأجهزة الجديدة</div>
        {code.isLoading ? (
          <p className="text-muted-foreground">جاري التحميل…</p>
        ) : current && !expired && current.uses < current.maxUses ? (
          <div className="flex flex-wrap items-center gap-3">
            <span dir="ltr" className="font-mono text-lg tracking-widest">
              {current.code}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(current.code)
                  .then(() => toast.success("نُسخ الرمز"))
              }
            >
              <Copy className="ml-1 h-4 w-4" /> نسخ
            </Button>
            <span className="text-xs text-muted-foreground">
              صالح حتى {fmt(current.expiresAt)} · استُخدم {current.uses} من {current.maxUses}
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive"
              onClick={() => cancelCode.mutate()}
              disabled={cancelCode.isPending}
            >
              إلغاء الرمز
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground">
            {current ? "الرمز الحالي منتهٍ أو مستنفد." : "لا يوجد رمز فعّال."}
          </p>
        )}
        <Button
          type="button"
          size="sm"
          className="mt-3"
          onClick={() => newCode.mutate()}
          disabled={newCode.isPending}
        >
          {newCode.isPending ? (
            <Loader2 className="ml-1 h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="ml-1 h-4 w-4" />
          )}
          إنشاء رمز جديد
        </Button>
      </div>

      {devices.isError ? (
        <p className="text-sm text-destructive">{(devices.error as Error).message}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border text-right">
                <th className="py-2">الجهاز</th>
                <th className="py-2">معرّف الجهاز</th>
                <th className="py-2">آخر ظهور</th>
                <th className="py-2">الحالة</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="border-b border-border/60">
                  <td className="py-2">
                    {d.label || d.hostname || d.platform}
                    {d.id === self && (
                      <span className="mr-1 text-xs text-muted-foreground">(هذا الجهاز)</span>
                    )}
                  </td>
                  <td className="py-2 font-mono text-xs" dir="ltr" title={d.id}>
                    {d.id.slice(0, 8)}…
                  </td>
                  <td className="py-2">{fmt(d.lastSeenAt)}</td>
                  <td className="py-2">
                    {d.revokedAt ? (
                      <span className="text-destructive">معطَّل</span>
                    ) : (
                      <span className="text-emerald-600">فعّال</span>
                    )}
                  </td>
                  <td className="py-2 text-left">
                    {d.id !== self && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirm(d)}
                        disabled={toggle.isPending}
                      >
                        {d.revokedAt ? (
                          <>
                            <RotateCcw className="ml-1 h-4 w-4" /> إعادة تفعيل
                          </>
                        ) : (
                          <>
                            <Ban className="ml-1 h-4 w-4" /> تعطيل
                          </>
                        )}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {!devices.isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-3 text-center text-muted-foreground">
                    لا توجد أجهزة مسجّلة
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.revokedAt ? "إعادة تفعيل الجهاز؟" : "تعطيل الجهاز؟"}
        description={
          confirm?.revokedAt
            ? "يستأنف الجهاز المزامنة تلقائياً."
            : "يتوقف الجهاز عن الإرسال والاستقبال فوراً. بياناته غير المرسلة تبقى محفوظة عليه ولا يُحذف شيء."
        }
        confirmLabel={confirm?.revokedAt ? "إعادة تفعيل" : "تعطيل"}
        onConfirm={() => {
          if (confirm) toggle.mutate(confirm);
          setConfirm(null);
        }}
      />
    </PageCard>
  );
}
