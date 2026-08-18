import type { ReactNode } from "react";
import { useCurrentUser } from "@/presentation/hooks/useAuth";
import { LoginPage } from "@/components/auth/LoginPage";

export function AuthGate({ children }: { children: ReactNode }) {
  const { data: user, isLoading } = useCurrentUser();

  if (isLoading) return null;
  if (!user) return <LoginPage />;
  return <>{children}</>;
}
