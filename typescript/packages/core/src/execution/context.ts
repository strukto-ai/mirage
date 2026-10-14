import { createAsyncContext } from '../utils/async_context.ts'
import type { ContextCall } from '../utils/async_context.ts'
import { uuid7 } from '../utils/ids.ts'

const current = createAsyncContext<string>()

export function newExecutionId(): string {
  return `exec_${uuid7()}`
}

/** Never attribute an operation to a sibling on hosts without task isolation. */
export function currentExecutionId(): string | null {
  const id = current.getStore()
  if (id === undefined || current.liveStores().some((entry) => entry !== id)) return null
  return id
}

export function captureExecutionContext(): ContextCall {
  return current.capture()
}

export async function runWithExecution<T>(executionId: string, run: () => Promise<T>): Promise<T> {
  return current.run(executionId, run)
}
