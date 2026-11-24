import { SharedInput } from '../io/async_line_iterator.ts'
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

/**
 * The one program writing a pipe a pipeline stage reads: the pipe, as the
 * stage is handed it; the program's words, null for one only known when it
 * runs; and the folder the pipeline started in, which the program runs from
 * whatever folder its reader moves to. `machine` is the machine the program
 * runs on, asked once for the pipe (`placed`): null before it is asked, and
 * for a program Mirage runs itself.
 */
export interface PipeWriter {
  readonly pipe: ByteSource
  readonly words: readonly (string | null)[]
  readonly cwd: string
  placed: boolean
  machine: string | null
  /**
   * Whether the config names that machine for the program (`configPins`),
   * rather than Mirage picking it; asked with `machine`.
   */
  pinned: boolean
  /**
   * The writer of the pipe the program reads in turn, whose machine its run
   * prefers, so it is placed as it runs (`gen | filter | sink`); null for a
   * first stage reading no pipe.
   */
  readonly upstream: PipeWriter | null
}

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
  // The one program that writes that pipe (`gen | tee log`), null when the
  // stage before is anything else, and in a pipeline with no process table:
  // what the stage writes is about the machine that program runs on. A child
  // shell that reads the same pipe keeps it (`gen | (tee log)`).
  stdinWriter: PipeWriter | null = null
  // The id of the command a job runs as a whole, whose redirects its shell
  // never puts back: it ends with the command, so bash keeps no copy of what
  // they replace.
  ending: number | null = null
  // The machines holding each folder a command of the line stood in, by
  // folder, asked once for the whole line and shared by every frame it forks
  // (`folderHolders`).
  folderHolders = new Map<string, string[]>()

  /**
   * A child evaluation's frame. `stdin` is the input a child shell reads in
   * its parent's place (a subshell, a pipeline's first stage), whose writer
   * the child keeps when it is the pipe this frame's stage reads; null for
   * one that reads none of it (a substitution, a job). It shares the machines
   * the line found holding its folders.
   */
  fork(stdin: ByteSource | null = null): ExecutionFrame {
    const child = new ExecutionFrame()
    child.stdinWriter = this.pipeWriterOf(stdin)
    child.abortSignal = this.abortSignal
    child.lineTimeout = this.lineTimeout
    child.shell = this.shell
    child.substitution = this.substitution
    if (this.routing !== undefined) child.routing = this.routing
    if (this.runsOnMachine !== undefined) child.runsOnMachine = this.runsOnMachine
    child.folderHolders = this.folderHolders
    return child
  }

  /**
   * The program writing the pipe this frame's stage reads, while `stdin` is
   * still that pipe; null once a redirect, a here-document or a closed
   * descriptor replaced it.
   *
   * @param stdin the input a command reads.
   */
  pipeWriterOf(stdin: ByteSource | null): PipeWriter | null {
    const given = stdin instanceof SharedInput ? stdin.lines.input : stdin
    return this.stdinWriter !== null && given === this.stdinWriter.pipe ? this.stdinWriter : null
  }
}
