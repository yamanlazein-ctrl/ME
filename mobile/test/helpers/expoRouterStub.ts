// The navigation calls views make, recorded for assertions; screens never mount a real navigator in unit tests.
import { vi } from "vitest";

export const router = {
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  canGoBack: vi.fn(() => false),
};
export const useRouter = () => router;
export const useLocalSearchParams = () => ({});
export const useFocusEffect = () => undefined;
export const Stack = () => null;
/** The options the tab layout passed last (the stub renders nothing). */
export const tabsProps: { last: Record<string, unknown> | null } = { last: null };
export const Tabs = Object.assign(
  (props: Record<string, unknown>) => {
    tabsProps.last = props;
    return null;
  },
  { Screen: () => null },
);
