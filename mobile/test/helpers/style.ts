/** Flattens a React Native style prop (object, array, nested arrays, falsy entries, style callback) into one object. */
export function flat(style: unknown): Record<string, unknown> {
  if (!style) return {};
  // Pressable's style callback: the resting (not pressed) style.
  if (typeof style === "function")
    return flat((style as (s: { pressed: boolean }) => unknown)({ pressed: false }));
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  return style as Record<string, unknown>;
}
