import type { ByteSource, IOResult } from '../io/types.ts'
import type { ProcessHandle } from '../execution/process/handle.ts'
import type { JobConsole } from '../shell/console/index.ts'
import type { TSNodeLike } from '../shell/types.ts'
import type { SessionState } from './session/session.ts'

export type ProcessSubLine = (
  text: string,
  options?: {
    stdin?: ByteSource | null
    sink?: JobConsole
    signal?: AbortSignal
    started?: (process: ProcessHandle, session: SessionState) => void
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
  lineTimeout: number | null = null
  // The process whose shell the evaluation runs in (a line, a subshell, a
  // pipeline stage, a nested shell, a job that runs commands of its own),
  // each program of which a signal the shell ignores still reaches; null
  // where the evaluation is one program run in place (`sleep 3 &`).
  shell: ProcessHandle | null = null
  // The report lines of the jobs a signal ended that the running command
  // reaped, which go out after its stderr, around a redirect of its own; a
  // command substitution's shell, and the shells it forks, make none
  // (`substitution`).
  reports: Uint8Array[] = []
  substitution = false
  // The processes the running command's substitutions started, each with the
  // `/dev/fd` path a `<( )` gave it, null for a `$( )`, which its program
  // reads; the commands a command runs (a function's body) keep its `<( )`,
  // as bash's inherit the descriptor.
  writers: (readonly [string | null, number])[] = []
  // The pipe a pipeline stage reads, which a program the stage starts reads
  // too while its standard input is still that pipe.
  stdin: ByteSource | null = null

  fork(): ExecutionFrame {
    const child = new ExecutionFrame()
    child.abortSignal = this.abortSignal
    child.lineTimeout = this.lineTimeout
    child.shell = this.shell
    child.substitution = this.substitution
    if (this.routing !== undefined) child.routing = this.routing
    if (this.runsOnMachine !== undefined) child.runsOnMachine = this.runsOnMachine
    return child
  }
}
