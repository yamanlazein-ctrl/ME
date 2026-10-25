// Test-only in-memory stand-in for expo-secure-store.
export const store = new Map<string, string>();
export const getItemAsync = async (k: string): Promise<string | null> => store.get(k) ?? null;
export const setItemAsync = async (k: string, v: string): Promise<void> => void store.set(k, v);
export const deleteItemAsync = async (k: string): Promise<void> => void store.delete(k);
