// `node:crypto` for ONE importer: backend/src/application/use-cases/sync/hubConfig.ts. Besides the four calls
// every other file may use, hubConfig encrypts the stored hub credential with AES-256-GCM. Same wire format as Node
// (iv, ciphertext, 16-byte tag) using the audited pure-JS @noble/ciphers.
import { Buffer } from "buffer";
import { gcm } from "@noble/ciphers/aes.js";

export { createHash, randomBytes, randomUUID, timingSafeEqual } from "./nodeCrypto";

type Input = string | Uint8Array;
const toBytes = (data: Input): Uint8Array =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;

class GcmCipher {
  private chunks: Uint8Array[] = [];
  private tag: Buffer | null = null;

  constructor(
    private readonly key: Uint8Array,
    private readonly iv: Uint8Array,
  ) {}

  update(data: Input): Buffer {
    this.chunks.push(toBytes(data));
    return Buffer.alloc(0);
  }

  final(): Buffer {
    const sealed = gcm(this.key, this.iv).encrypt(Buffer.concat(this.chunks));
    this.tag = Buffer.from(sealed.slice(sealed.length - 16));
    return Buffer.from(sealed.slice(0, sealed.length - 16));
  }

  getAuthTag(): Buffer {
    if (!this.tag) throw new Error("getAuthTag() before final()");
    return this.tag;
  }
}

class GcmDecipher {
  private chunks: Uint8Array[] = [];
  private tag: Uint8Array | null = null;

  constructor(
    private readonly key: Uint8Array,
    private readonly iv: Uint8Array,
  ) {}

  setAuthTag(tag: Uint8Array): this {
    this.tag = tag;
    return this;
  }

  update(data: Input): Buffer {
    this.chunks.push(toBytes(data));
    return Buffer.alloc(0);
  }

  final(): Buffer {
    if (!this.tag) throw new Error("Unsupported state or unable to authenticate data");
    const sealed = Buffer.concat([...this.chunks, this.tag]);
    try {
      return Buffer.from(gcm(this.key, this.iv).decrypt(sealed));
    } catch {
      throw new Error("Unsupported state or unable to authenticate data");
    }
  }
}

export function createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): GcmCipher {
  if (algorithm !== "aes-256-gcm") throw new Error(`hubCrypto: unsupported cipher ${algorithm}`);
  return new GcmCipher(key, iv);
}

export function createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): GcmDecipher {
  if (algorithm !== "aes-256-gcm") throw new Error(`hubCrypto: unsupported cipher ${algorithm}`);
  return new GcmDecipher(key, iv);
}
