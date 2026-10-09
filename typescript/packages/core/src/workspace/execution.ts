import { YieldBudget } from '../io/yield_budget.ts'
import { makeAbortError } from '../concurrency/limiter.ts'
import { newExecutionId } from '../execution/context.ts'

/** Identity and scheduling budget shared by a call and its evaluations. */
export class ExecutionScope {
  private readonly budget = new YieldBudget()

  constructor(
    private onStart?: () => Promise<void>,
    readonly id: string = newExecutionId(),
  ) {}

  /** Publish admission once, after acquiring the session and before effects. */
  async start(): Promise<void> {
    const onStart = this.onStart
    this.onStart = undefined
    await onStart?.()
  }

  async checkpoint(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw makeAbortError(signal)
    await this.budget.run()
    if (signal?.aborted) throw makeAbortError(signal)
  }
}
