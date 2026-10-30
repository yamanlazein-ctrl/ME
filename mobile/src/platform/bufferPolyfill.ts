// Hermes has no Node `Buffer`; shared backend code uses it for base64url cursors (keyset paging, JWT parts), hex/base64 and
// byte comparison. The `buffer` package supplies it; its missing "base64url" encoding is added here (Node semantics: URL-safe
// alphabet, no padding).
import { Buffer as PolyBuffer } from "buffer";

type Encoding = BufferEncoding | "base64url";

function fromBase64Url(text: string): string {
  const std = text.replace(/-/g, "+").replace(/_/g, "/");
  return std + "=".repeat((4 - (std.length % 4)) % 4);
}

let installed = false;

export function installBuffer(): typeof PolyBuffer {
  if (installed) return PolyBuffer;
  installed = true;
  const originalFrom = PolyBuffer.from.bind(PolyBuffer) as (
    ...args: unknown[]
  ) => InstanceType<typeof PolyBuffer>;
  (PolyBuffer as unknown as { from: unknown }).from = (
    value: unknown,
    encoding?: unknown,
    length?: unknown,
  ) =>
    typeof value === "string" && encoding === "base64url"
      ? originalFrom(fromBase64Url(value), "base64")
      : originalFrom(value, encoding, length);
  const proto = PolyBuffer.prototype as unknown as {
    toString(encoding?: Encoding, start?: number, end?: number): string;
  };
  const originalToString = proto.toString;
  proto.toString = function (this: unknown, encoding?: Encoding, start?: number, end?: number) {
    if (encoding === "base64url") {
      return originalToString
        .call(this, "base64", start, end)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    }
    return originalToString.call(this, encoding, start, end);
  };
  const g = globalThis as unknown as { Buffer?: unknown };
  g.Buffer ??= PolyBuffer;
  return PolyBuffer;
}

installBuffer();
