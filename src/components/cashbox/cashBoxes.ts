import { Banknote, DollarSign, Euro } from "lucide-react";
import type { Currency } from "@/domain/types";

/** Three independent cash boxes — never mixed or FX-converted. */
export const CASH_BOXES: {
  code: Currency;
  Icon: typeof Banknote;
  accent: string;
  chip: string;
}[] = [
  {
    code: "SYP",
    Icon: Banknote,
    accent: "from-emerald-500/15 via-transparent to-transparent",
    chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  {
    code: "USD",
    Icon: DollarSign,
    accent: "from-sky-500/15 via-transparent to-transparent",
    chip: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  {
    code: "EUR",
    Icon: Euro,
    accent: "from-violet-500/15 via-transparent to-transparent",
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  },
];
