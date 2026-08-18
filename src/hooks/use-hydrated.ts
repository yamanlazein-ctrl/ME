import { useEffect, useState } from "react";

/** True after the first client render — use to gate content that must not run in SSR. */
export function useHydrated(): boolean {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}
