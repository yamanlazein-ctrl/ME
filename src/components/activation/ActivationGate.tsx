import { useState } from "react";
import { ActivationScreen } from "./ActivationScreen";
import { isActivated } from "@/lib/license-state";

const DEV_BYPASS = import.meta.env.MODE === "development";

export function ActivationGate({ children }: { children: React.ReactNode }) {
  const [activated, setActivated] = useState<boolean>(() => isActivated() || DEV_BYPASS);

  if (!activated) {
    return <ActivationScreen onActivated={() => setActivated(true)} />;
  }

  return <>{children}</>;
}
