import { canWriteOffline, type Role } from "./roles";

export const TABS = [
  { name: "index", title: "الرئيسية" },
  { name: "parties", title: "العملاء والموردون" },
  { name: "add", title: "إضافة" },
  { name: "inventory", title: "المخزون" },
  { name: "more", title: "المزيد" },
];

/** Tabs for a role (UX-04): the Add tab is write-only, so read-only roles do not get it. */
export function visibleTabs(role: Role): { name: string; title: string }[] {
  return canWriteOffline(role) ? TABS : TABS.filter((t) => t.name !== "add");
}
