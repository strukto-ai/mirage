import type { CallStack } from '../shell/call_stack.ts'
import type { TSNodeLike } from '../shell/types.ts'
import type { ExecuteFn } from './expand/node.ts'

/** Temporary state of one evaluation; never part of a session record. */
export class ExecutionFrame {
  diagnostics: (string | Uint8Array)[] = []
  cmdsubSeq = 0
  cmdsubStatus = 0
  processSub:
    | ((node: TSNodeLike, executeFn: ExecuteFn, callStack: CallStack | null) => Promise<string>)
    | null = null
  // The cancel channel for work running under this evaluation: killing a
  // background job aborts it, and the mount layer folds it into the signal
  // handed to runtimes. fork() carries it so a job's whole subtree shares
  // one channel. Python needs no equivalent: kill cancels the asyncio task
  // and cancellation is ambient.
  abortSignal: AbortSignal | null = null

  fork(): ExecutionFrame {
    const child = new ExecutionFrame()
    child.abortSignal = this.abortSignal
    return child
  }
}
