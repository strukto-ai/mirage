import { currentCaller, liveCallers, runWithCaller } from '../context/session_context.ts'
import { uuid7 } from '../utils/ids.ts'

export function newExecutionId(): string {
  return `exec_${uuid7()}`
}

/** Never attribute an operation to a sibling on hosts without task isolation. */
export function currentExecutionId(): string | null {
  const id = currentCaller().executionId
  if (id === null) return null
  const sibling = liveCallers().some((caller) => caller.executionId !== null && caller.executionId !== id)
  return sibling ? null : id
}

export async function runWithExecution<T>(executionId: string, run: () => Promise<T>): Promise<T> {
  return runWithCaller({ ...currentCaller(), executionId }, run)
}
