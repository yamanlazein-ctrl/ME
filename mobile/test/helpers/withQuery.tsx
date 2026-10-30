// Views that read through React Query (pickers inside forms) need a client in unit tests.
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function withQuery(el: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{el}</QueryClientProvider>;
}
