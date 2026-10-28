import type { ByteSource, IOResult } from '../io/types.ts'
import type { JobConsole } from '../shell/console/index.ts'
import type { TSNodeLike } from '../shell/types.ts'

export type ProcessSubLine = (
  text: string,
  options?: {
    stdin?: ByteSource | null
    sink?: JobConsole
    signal?: AbortSignal
  },
) => Promise<IOResult>

/** Temporary state of one evaluation; never part of a session record. */
export class ExecutionFrame {
  diagnostics: (string | Uint8Array)[] = []
  cmdsubSeq = 0
  cmdsubStatus = 0
  processSub: ((node: TSNodeLike, executeLine: ProcessSubLine) => Promise<string>) | null = null
  // The cancel channel for work running under this evaluation: killing a
  // background job aborts it, and the mount layer folds it into the signal
  // handed to runtimes. fork() carries it so a job's whole subtree shares
  // one channel. Python needs no equivalent: kill cancels the asyncio task
  // and cancellation is ambient.
  abortSignal: AbortSignal | null = null
  // The line's `@line` limit, which fork() carries so a job the line
  // starts runs under it from its own start.
  lineTimeout: number | null = null

  fork(): ExecutionFrame {
    const child = new ExecutionFrame()
    child.abortSignal = this.abortSignal
    child.lineTimeout = this.lineTimeout
    if (this.routing !== undefined) child.routing = this.routing
    return child
  }
}
