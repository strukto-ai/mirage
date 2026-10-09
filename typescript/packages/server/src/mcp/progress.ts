import { ConcurrencyLimiter } from '@struktoai/mirage-core/concurrency/limiter'
import type { StreamName } from '@struktoai/mirage-core/io/types'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import type { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'
import { Session, type Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { ioToStr } from '@struktoai/mirage-core/workspace/tools/io_text'
import {
  MirageToolOperations,
  type ToolResult,
} from '@struktoai/mirage-core/workspace/tools/tool_operations'

export const LIMIT = 2048
export const INTERVAL = 0.25

/** Request-local, bounded text previews; the final result keeps all output. */
export class OutputProgress {
  private readonly decoders = {
    stdout: new TextDecoder('utf-8', { ignoreBOM: true }),
    stderr: new TextDecoder('utf-8', { ignoreBOM: true }),
  }
  private readonly pending = { stdout: '', stderr: '' }
  private last = -Infinity
  private progress = 0
  private readonly lock = new ConcurrencyLimiter(1)
  private timer: ReturnType<typeof setTimeout> | undefined
  private trailing: Promise<void> | undefined
  private failure: { reason: unknown } | undefined
  private cancel: (() => void) | undefined
  private closed = false

  constructor(private readonly send: (progress: number, message: string) => Promise<void>) {}

  bind(cancel: () => void): void {
    this.cancel = cancel
  }

  private schedule(): void {
    if (
      this.closed ||
      this.timer !== undefined ||
      this.trailing !== undefined ||
      !Object.values(this.pending).some(Boolean)
    )
      return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.trailing = this.flush()
          .catch((reason: unknown) => {
            this.failure = { reason }
            this.cancel?.()
          })
          .finally(() => {
            this.trailing = undefined
            if (this.failure === undefined) this.schedule()
          })
      },
      Math.max(0, (INTERVAL - (performance.now() / 1000 - this.last)) * 1000),
    )
  }

  private append(stream: StreamName, text: string): void {
    const joined = Array.from(this.pending[stream] + text)
    this.pending[stream] =
      joined.length <= LIMIT ? joined.join('') : '…' + joined.slice(-(LIMIT - 1)).join('')
  }

  async feed(stream: StreamName, data: Uint8Array): Promise<void> {
    if (this.failure !== undefined) throw this.failure.reason
    this.append(stream, this.decoders[stream].decode(data, { stream: true }))
    if (performance.now() / 1000 - this.last >= INTERVAL) await this.flush()
    this.schedule()
  }

  async flush(): Promise<void> {
    const release = await this.lock.acquire()
    try {
      for (const channel of ['stdout', 'stderr'] as const) {
        const text = this.pending[channel]
        if (text === '') continue
        this.pending[channel] = ''
        this.last = performance.now() / 1000
        await this.send(++this.progress, `[${channel}] ${text}`)
      }
    } finally {
      release()
    }
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
    await this.trailing
    if (this.failure !== undefined) throw this.failure.reason
  }

  async finish(): Promise<void> {
    await this.close()
    for (const channel of ['stdout', 'stderr'] as const)
      this.append(channel, this.decoders[channel].decode())
    await this.flush()
  }
}

/** Drain one SDK execution, preserving its full tool result and cleanup. */
export async function collectExecution(
  execution: ShellExecution,
  progress?: OutputProgress,
): Promise<ExecuteResult> {
  if (progress === undefined) return execution.collect()
  progress.bind(() => {
    execution.cancel()
  })
  try {
    const result = await execution.collect((event) => progress.feed(event.stream, event.data))
    await progress.finish()
    return result
  } finally {
    await progress.close()
  }
}

/** The ordinary tool table with SDK streaming for shell calls. */
export class McpToolOperations extends MirageToolOperations {
  constructor(
    private readonly workspace: Workspace,
    private readonly mcpSessionId: string | null = null,
    staleWriteProtection = true,
  ) {
    super(new Session(workspace, mcpSessionId), staleWriteProtection)
  }

  override async shell(
    command: string,
    signal?: AbortSignal,
    progress?: OutputProgress,
  ): Promise<ToolResult> {
    const execution = await this.workspace.shell(command, {
      stream: true,
      ...(this.mcpSessionId === null ? {} : { sessionId: this.mcpSessionId }),
      ...(signal === undefined ? {} : { signal }),
    })
    const result = await collectExecution(execution, progress)
    return {
      content: [{ type: 'text', text: ioToStr(result) }],
      ...(result.exitCode === 0 ? {} : { isError: true }),
    }
  }
}
