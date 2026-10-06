/** Temporary state of one evaluation; never part of a session record. */
export class ExecutionFrame {
  diagnostics: (string | Uint8Array)[] = []
  cmdsubSeq = 0
  cmdsubStatus = 0
  abortSignal: AbortSignal | null = null

  fork(): ExecutionFrame {
    const child = new ExecutionFrame()
    child.abortSignal = this.abortSignal
    return child
  }
}
