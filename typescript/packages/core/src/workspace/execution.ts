import { YieldBudget } from '../io/yield_budget.ts'
import { makeAbortError } from './abort.ts'

/** One scheduling budget shared by a foreground call and its evaluations. */
export class ExecutionScope {
  private readonly budget = new YieldBudget()

  constructor(private onStart?: () => Promise<void>) {}

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
