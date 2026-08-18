/**
 * Port: Password hashing abstraction.
 * 
 * Allows swapping hashing algorithms without changing use cases.
 * Production uses Argon2 (infrastructure/auth/PasswordHasher.ts).
 * Tests can inject a mock for fast verification.
 */
export interface IPasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}