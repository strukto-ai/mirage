import { createAsyncContext } from '../utils/async_context.ts'
import type { ContextCall } from '../utils/async_context.ts'
import type { ExecutionIdentity } from './types.ts'
import { uuid7 } from '../utils/ids.ts'

const current = createAsyncContext<ExecutionIdentity>()

export function newExecutionId(): string {
  return `exec_${uuid7()}`
}

/** Never attribute an operation to a sibling on hosts without task isolation. */
export function currentExecution(): ExecutionIdentity | null {
  const live = current.liveStores()
  const identity = current.getStore()
  if (identity === undefined || live.some((entry) => entry.id !== identity.id)) return null
  return identity
}

export function currentExecutionId(): string | null {
  return currentExecution()?.id ?? null
}

export function captureExecutionContext(): ContextCall {
  return current.capture()
}

export async function runWithExecution<T>(
  identity: ExecutionIdentity,
  run: () => Promise<T>,
): Promise<T> {
  return current.run(identity, run)
}
