import { createAsyncContext } from '../utils/async_context.ts'

const pending = createAsyncContext<Set<Promise<unknown>>>()

/** Retain ownership when an abort releases a caller before its operation ends. */
export function retainOperation(promise: Promise<unknown>): void {
  const scope = pending.getStore()
  if (scope === undefined) return
  scope.add(promise)
  void promise.then(
    () => scope.delete(promise),
    () => scope.delete(promise),
  )
}

export async function withProcessCleanup<T>(run: () => Promise<T>): Promise<T> {
  const operations = new Set<Promise<unknown>>()
  return pending.run(operations, async () => {
    try {
      return await run()
    } finally {
      while (operations.size > 0) await Promise.allSettled([...operations])
    }
  })
}
