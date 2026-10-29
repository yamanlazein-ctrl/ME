import { useEffect, useState } from "react";
import { getSessionService } from "../core/sessionService";
import type { Role } from "../core/roles";

/** The signed-in user's role (read from the stored session on mount). */
export function useRole(): Role {
  const [role, setRole] = useState<Role>("viewer");
  useEffect(() => {
    void getSessionService().then(async (s) => {
      const session = await s.current();
      if (session) setRole(session.role);
    });
  }, []);
  return role;
}
