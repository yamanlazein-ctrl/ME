// Phone adapter for the one `node:net` call the bundled code makes: `isIP`, used by
// backend/src/infrastructure/orm/sqlite/types.ts to validate `inet` values. Metro maps `node:net` here ONLY
// for that importer (metro.config.js); any other file importing `node:net` still fails the bundle.
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIPv6(input: string): boolean {
  let text = input;
  const zone = text.indexOf("%");
  if (zone !== -1) {
    if (zone === text.length - 1) return false;
    text = text.slice(0, zone);
  }
  const groupsMax = 8;
  const lastColon = text.lastIndexOf(":");
  if (lastColon === -1) return false;
  const last = text.slice(lastColon + 1);
  if (last.includes(".")) {
    if (!IPV4.test(last)) return false;
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return false;
  const parts = text.split("::");
  const side = (s: string): string[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) ? groups : null;
  };
  if (parts.length === 1) {
    const g = side(text);
    return g !== null && g.length === groupsMax;
  }
  const head = side(parts[0] ?? "");
  const rest = side(parts[1] ?? "");
  return head !== null && rest !== null && head.length + rest.length < groupsMax;
}

export function isIP(input: string): 0 | 4 | 6 {
  if (typeof input !== "string") return 0;
  if (IPV4.test(input)) return 4;
  return isIPv6(input) ? 6 : 0;
}

export function isIPv4(input: string): boolean {
  return isIP(input) === 4;
}

export function isIPv6Address(input: string): boolean {
  return isIP(input) === 6;
}
