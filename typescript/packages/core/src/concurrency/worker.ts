import { z } from 'zod'
import { abortable, makeAbortError } from '../utils/abort.ts'

interface Port {
  post(data: unknown): void
  close(): Promise<void>
}

const Reply = z.object({ ok: z.boolean(), value: z.unknown() })
type Reply = z.infer<typeof Reply>

async function createPort(
  done: (reply: Reply) => void,
  failed: (error: Error) => void,
): Promise<Port> {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node
  if (node !== undefined) {
    const { Worker: NodeWorker } = await import('node:worker_threads')
    const url = new URL(
      import.meta.url.endsWith('.ts') ? './worker_entry.ts' : './worker_entry.js',
      import.meta.url,
    )
    const worker = new NodeWorker(url, {
      execArgv: url.pathname.endsWith('.ts')
        ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning']
        : [],
    })
    worker.on('message', (raw: unknown) => {
      const reply = Reply.safeParse(raw)
      if (reply.success) done(reply.data)
      else failed(new Error('invalid computation worker reply', { cause: reply.error }))
    })
    worker.on('messageerror', failed)
    worker.on('error', failed)
    worker.on('exit', (code: number) => {
      failed(new Error(`computation worker exited (${String(code)})`))
    })
    return {
      post: (data) => {
        worker.postMessage(data)
      },
      close: async () => {
        await worker.terminate()
      },
    }
  }
  const { Worker } = globalThis
  const worker = new Worker(new URL('./worker_entry.js', import.meta.url), {
    type: 'module',
  })
  worker.onmessage = (event: MessageEvent<unknown>) => {
    const reply = Reply.safeParse(event.data)
    if (reply.success) done(reply.data)
    else failed(new Error('invalid computation worker reply', { cause: reply.error }))
  }
  worker.onmessageerror = () => {
    failed(new Error('cannot decode computation worker reply'))
  }
  worker.onerror = (event) => {
    failed(new Error(event.message))
  }
  return {
    post: (data) => {
      worker.postMessage(data)
    },
    close: () => {
      worker.terminate()
      return Promise.resolve()
    },
  }
}

/** An invocation-owned worker for computations that cannot yield inside their engine. */
export class Worker {
  private port: Promise<Port> | undefined
  private closing: Promise<void> | undefined
  private closeSettled = false
  private closeFailed = false
  private terminal: Error | undefined
  private waiting: { resolve: (reply: Reply) => void; reject: (error: unknown) => void }[] = []

  async call<T>(name: string, args: readonly unknown[], signal?: AbortSignal): Promise<T> {
    try {
      signal?.throwIfAborted()
      if (this.terminal !== undefined) throw this.terminal
      if (this.closeSettled && !this.closeFailed && this.port === undefined) {
        this.closing = undefined
        this.closeSettled = false
      }
      if (this.closing !== undefined) throw new Error('computation worker is closing')
      const port = (this.port ??= this.open())
      const ready = await abortable(port, signal)
      this.checkReady(port, signal)
      const reply = new Promise<Reply>((resolve, reject) => {
        this.waiting.push({ resolve, reject })
        try {
          ready.post({ name, args })
        } catch (error) {
          reject(
            error instanceof Error ? error : new Error('cannot post computation', { cause: error }),
          )
        }
      })
      const { ok, value } = await abortable(reply, signal)
      if (!ok)
        throw value instanceof Error ? value : new Error('Computation failed', { cause: value })
      return value as T
    } catch (error) {
      try {
        await this.close()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'computation worker failed to stop')
      }
      throw error
    }
  }

  close(retry = false): Promise<void> {
    if (retry && this.closeSettled && this.closeFailed) {
      this.closing = undefined
      this.closeSettled = false
      this.closeFailed = false
    }
    if (this.closing !== undefined) return this.closing
    for (const waiter of this.waiting.splice(0)) waiter.reject(makeAbortError())
    const port = this.port
    const stopping = Promise.resolve().then(async () => {
      if (port !== undefined) {
        let ready: Port
        try {
          ready = await port
        } catch {
          this.port = undefined
          return
        }
        await ready.close()
        if (this.port === port) this.port = undefined
      }
    })
    this.closing = stopping
    void stopping.then(
      () => {
        this.closeSettled = true
      },
      () => {
        this.closeSettled = true
        this.closeFailed = true
      },
    )
    return stopping
  }

  private checkReady(port: Promise<Port>, signal?: AbortSignal): void {
    if (port !== this.port || this.closing !== undefined) throw makeAbortError(signal)
    if (this.terminal !== undefined) throw this.terminal
  }

  private open(): Promise<Port> {
    return createPort(
      (reply) => this.waiting.shift()?.resolve(reply),
      (error) => {
        if (this.closing !== undefined) return
        this.terminal = error
        for (const waiter of this.waiting.splice(0)) waiter.reject(error)
      },
    )
  }
}
