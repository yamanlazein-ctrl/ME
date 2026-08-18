import { hash, verify } from "@node-rs/argon2";

export class Argon2PasswordHasher {
  async hash(password: string): Promise<string> {
    return hash(password, {
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
      algorithm: 2, // Argon2id
    });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    return verify(hash, password);
  }
}
