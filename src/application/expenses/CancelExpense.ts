import type { IExpenseRepository } from "@/application/ports/IExpenseRepository";

export class CancelExpenseUseCase {
  constructor(private readonly repo: IExpenseRepository) {}
  async execute(id: string): Promise<void> {
    const current = await this.repo.findById(id);
    if (!current) {
      throw new Error("المصروف غير موجود");
    }
    return this.repo.cancel(id, current.version ?? 1);
  }
}
