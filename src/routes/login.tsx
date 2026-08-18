import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { LoginPage } from "@/components/auth/LoginPage";
import { useCurrentUser } from "@/presentation/hooks/useAuth";

export const Route = createFileRoute("/login")({
  component: LoginRoute,
});

function LoginRoute() {
  const navigate = useNavigate();
  const { data: user, isLoading } = useCurrentUser();

  useEffect(() => {
    if (!isLoading && user) {
      void navigate({ to: "/", replace: true });
    }
  }, [isLoading, user, navigate]);

  return <LoginPage />;
}
