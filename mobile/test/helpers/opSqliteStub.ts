// Test-only stand-in: the native module does not exist under Node; tests pass `connection` to the shim.
export function open(): never {
  throw new Error("op-sqlite is not available under Node; pass a test connection");
}
