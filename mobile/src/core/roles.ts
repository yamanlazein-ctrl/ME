// Roles and offline rights equal the desktop's (constitution VI, FR-05): admin and accountant write offline; warehouse and
// viewer are read-only offline. The accountant holds every admin privilege (`hasAdminPrivileges`); strict `admin` is only for
// revoking devices, granting the admin role and editing an admin account.
export type Role = "admin" | "accountant" | "warehouse" | "viewer";

export function canWriteOffline(role: Role): boolean {
  return role === "admin" || role === "accountant";
}

export function isAdminLike(role: Role): boolean {
  return role === "admin" || role === "accountant";
}

export function isAdmin(role: Role): boolean {
  return role === "admin";
}

/**
 * The role is read from the local users table on EVERY check and never cached in memory, so a role change pulled from the
 * hub applies at once (E18). `read` returns the stored role of a user, or null when the user is unknown.
 */
export async function currentRole(
  read: (userId: string) => Promise<Role | null>,
  userId: string,
): Promise<Role> {
  return (await read(userId)) ?? "viewer";
}
