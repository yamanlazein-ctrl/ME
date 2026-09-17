/**
 * F08 (Phase 1 foundation audit): the 4-digit PIN login only validated
 * `/^\d{4}$/` — any 4 digits, including "0000" — with nothing rejecting the
 * handful of PINs an attacker tries first. Enforced only when a user SETS a
 * PIN (SetPinSchema), never on login/verification — changing that would
 * lock out anyone who already has a weak PIN instead of prompting them to
 * change it.
 */
const ALL_SAME_DIGIT = new Set(
  Array.from({ length: 10 }, (_, d) => String(d).repeat(4)),
);

const SEQUENTIAL = new Set([
  "0123",
  "1234",
  "2345",
  "3456",
  "4567",
  "5678",
  "6789",
  "9876",
  "8765",
  "7654",
  "6543",
  "5432",
  "4321",
  "3210",
]);

export function isWeakPin(pin: string): boolean {
  return ALL_SAME_DIGIT.has(pin) || SEQUENTIAL.has(pin);
}
