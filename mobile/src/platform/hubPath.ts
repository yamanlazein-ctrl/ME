// `node:path` for ONE importer: hubConfig.ts (POSIX-style virtual paths only: dirname and join).
export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? (i === 0 ? "/" : ".") : p.slice(0, i);
}

export function join(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

export default { dirname, join };
