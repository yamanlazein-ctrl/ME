import type { IExpenseRepository } from "@/application/ports/IExpenseRepository";

export class CancelExpenseUseCase {
  constructor(private readonly repo: IExpenseRepository) {}
  execute(id: string): Promise<void> {
    return this.repo.cancel(id);
  }
}
