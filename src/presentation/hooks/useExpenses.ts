import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { toast } from "sonner";
import type { CreateExpenseInput, ExpenseFilter } from "@/core/dtos/ExpenseDTO";
import { isOk } from "@/core/result";
import type { ValidationError } from "@/core/errors/DomainError";

const KEYS = {
  root: ["expenses"] as const,
  list: (f?: ExpenseFilter) => ["expenses", "list", f ?? {}] as const,
  names: ["expenses", "names"] as const,
};

export function useExpensesList(filter?: ExpenseFilter) {
  return useQuery({
    queryKey: KEYS.list(filter),
    queryFn: ({ signal }) => {
      void signal;
      return container.expenses.list.execute(filter);
    },
  });
}

export function useExpenseNamesList() {
  return useQuery({
    queryKey: KEYS.names,
    queryFn: ({ signal }) => {
      void signal;
      return container.expenses.names.list();
    },
    initialData: [] as string[],
  });
}

export function useAddExpenseName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => container.expenses.names.add(name),
    onSuccess: () => {
      toast.success("تم إضافة اسم المصروف");
      qc.invalidateQueries({ queryKey: KEYS.names });
    },
    onError: (e: Error) => {
      toast.error(`فشل إضافة اسم المصروف: ${e.message}`);
    },
  });
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation<
    { ok: true } | { ok: false; error: ValidationError },
    Error,
    CreateExpenseInput
  >({
    mutationFn: async (input) => {
      const res = await container.expenses.create.execute(input);
      return isOk(res) ? { ok: true } : { ok: false, error: res.error };
    },
    onSuccess: (res) => {
      if (res.ok) {
        toast.success("تم إنشاء المصروف");
        qc.invalidateQueries({ queryKey: KEYS.root });
        // Expenses write a ledger entry (type=expense); cash expenses affect cashbox/dashboard.
        qc.invalidateQueries({ queryKey: ["ledger"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
      } else {
        toast.error(res.error.message ?? res.error as unknown as string);
      }
    },
  });
}

export function useCancelExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => container.expenses.cancel.execute(id),
    onSuccess: () => {
      toast.error("تم إلغاء المصروف");
      qc.invalidateQueries({ queryKey: KEYS.root });
      qc.invalidateQueries({ queryKey: ["ledger"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => {
      toast.error(`فشل إلغاء المصروف: ${e.message}`);
    },
  });
}

export const expenses: unknown[] = [];
