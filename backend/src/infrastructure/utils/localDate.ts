/**
 * Business dates are LOCAL calendar dates. `toISOString()` is UTC: in Syria
 * (UTC+3) every document created between 00:00 and 03:00 was dated the
 * previous day, and «اليوم» on the dashboard/cashbox still showed yesterday.
 */
export function localDateISO(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const localToday = (): string => localDateISO(new Date());
