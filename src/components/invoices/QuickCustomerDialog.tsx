import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { addCustomer } from "@/presentation/hooks/useParties";

export function QuickCustomerDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setPhone("");
      setEmail("");
      setErr(null);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return setErr("الاسم مطلوب.");
    try {
      const c = await addCustomer({ name: name.trim(), phone: phone.trim(), email: email.trim() });
      onCreated(c.id);
    } catch {
      // addCustomer already surfaces the error via toast.
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-md">
        <DialogHeader>
          <DialogTitle>عميل جديد سريع</DialogTitle>
          <DialogDescription>
            أضف عميلاً بسرعة دون مغادرة الفاتورة. يمكن إكمال بياناته لاحقاً.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">الاسم *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-10" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">الهاتف</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="h-10 tabular-nums"
              />
            </div>
            <div>
              <Label className="text-xs">البريد الإلكتروني</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} className="h-10" />
            </div>
          </div>
          {err && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          )}
        </div>
        <DialogFooter className="flex-row-reverse gap-2">
          <Button
            onClick={submit}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            حفظ وتحديد
          </Button>
          <Button variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
