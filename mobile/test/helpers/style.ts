/** Flattens a React Native style prop (object, array, nested arrays, falsy entries) into one object. */
export function flat(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flat));
  return style as Record<string, unknown>;
}
