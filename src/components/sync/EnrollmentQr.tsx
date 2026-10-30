import { QRCodeSVG } from "qrcode.react";
import { enrollmentQrPayload } from "./enrollmentQrPayload";

export function EnrollmentQr({ hub, code }: { hub: string; code: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-md bg-white p-2">
      <QRCodeSVG value={enrollmentQrPayload(hub, code)} size={140} data-testid="enroll-qr" />
      <span className="text-[11px] text-black">امسحه من تطبيق الهاتف</span>
    </div>
  );
}
