import type { Context } from '@deepseek-ai/cordis'
import {
  SubprocessRuntime,
  type SubprocessSpawnSpec,
  type SubprocessHandle,
  type SubprocessOutputMode,
  type SubprocessOutputReader,
  type SubprocessTerminalSpawnSpec,
  type SubprocessTerminalHandle,
} from '@deepseek-ai/dsh-subprocess'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PathSpec } from '@struktoai/mirage-core/types'
import type { ChildProcess } from '@struktoai/mirage-core/process/child'
import type { Workspace } from '@struktoai/mirage-node'
import './service.ts'

class Tail implements SubprocessOutputReader {
  private bytes = Buffer.alloc(0)
  private offset = 0
  constructor(private readonly max: number) {}
  append(chunk: Uint8Array): void {
    this.offset += chunk.length
    this.bytes = Buffer.concat([this.bytes, chunk]).subarray(-this.max)
    if (this.max === 0) this.bytes = Buffer.alloc(0)
  }
  readFrom(fromByte: number) {
    if (!Number.isSafeInteger(fromByte) || fromByte < 0 || fromByte > this.offset)
      throw new Error('invalid output offset')
    const start = this.offset - this.bytes.length
    return {
      text: this.bytes.subarray(Math.max(0, fromByte - start)).toString('utf8'),
      nextOffset: this.offset,
      lossy: fromByte < start,
    }
  }
}

function validateOutput(mode: SubprocessOutputMode): void {
  if (mode === 'pipe' || mode === 'inherit') return
  if (!Number.isSafeInteger(mode.maxBytes) || mode.maxBytes < 0)
    throw new Error('invalid output budget')
  if (mode.spill !== undefined)
    throw new Error('subprocess spill is unsupported; use ctx.spill for recovery')
}

function waitBounded(done: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve, reject) => {
    const aborted = () => {
      resolve(false)
    }
    signal?.addEventListener('abort', aborted, { once: true })
    void done
      .then(() => {
        resolve(true)
      }, reject)
      .finally(() => signal?.removeEventListener('abort', aborted))
  })
}

export interface MirageSubprocessConfig {
  /** Existing workspace session; omitted selects the default session. */
  sessionId?: string
}

/** One workspace execution world. No host PATH, native descendants, or PTY claims. */
export class MirageSubprocess extends SubprocessRuntime {
  static readonly inject = ['mirage']
  private readonly handles = new Set<SubprocessHandle>()
  private closed = false
  constructor(
    ctx: Context,
    private readonly config: MirageSubprocessConfig = {},
  ) {
    super(ctx)
    ctx.effect(() => async () => {
      this.closed = true
      const handles = [...this.handles]
      for (const handle of handles) handle.terminate()
      await Promise.all(handles.map((handle) => handle.waitForExit()))
    })
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.includes('/') && !command.startsWith('/'))
      throw new Error('relative executable paths are unsupported')
    signal?.throwIfAborted()
    const ws = await this.ctx.mirage.ready
    this.checkWorld()
    const child = ws.spawn(
      { argv: ['which', command], ...(env === undefined ? {} : { env }) },
      this.config.sessionId,
    )
    const abort = () => {
      child.terminate()
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) abort()
      const result = await child.communicate()
      signal?.throwIfAborted()
      if (result.exitCode !== 0) throw new Error(`executable not found: ${command}`)
      return new TextDecoder().decode(result.stdout).trim()
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted()
    this.checkWorld()
    if (this.closed) throw new Error('subprocess service is closed')
    if (
      spec.argv.length === 0 ||
      !spec.argv[0] ||
      spec.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    )
      throw new Error('invalid argv')
    if (!spec.cwd.startsWith('/') || spec.cwd.includes('\0'))
      throw new Error('cwd must be an absolute workspace path')
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > 2147483647)
      throw new Error('invalid graceMs')
    validateOutput(spec.stdio.stdout)
    validateOutput(spec.stdio.stderr)
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(spec.env ?? {})) {
      if (value === undefined) throw new Error('environment tombstones are unsupported')
      if (name.includes('=') || name.includes('\0') || value.includes('\0'))
        throw new Error('invalid environment')
      env[name] = value
    }
    const stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
    const stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    const outTail =
      typeof spec.stdio.stdout === 'object' ? new Tail(spec.stdio.stdout.maxBytes) : undefined
    const errTail =
      typeof spec.stdio.stderr === 'object' ? new Tail(spec.stdio.stderr.maxBytes) : undefined
    let child: ChildProcess | undefined
    let workspace: Workspace | undefined
    let cancelled = false
    const terminate = () => {
      cancelled = true
      child?.terminate()
      stdin?.destroy()
      stdout?.destroy()
      stderr?.destroy()
    }
    spec.signal?.addEventListener('abort', terminate, { once: true })
    const drain = async (
      source: AsyncIterable<Uint8Array>,
      pipe: PassThrough | undefined,
      tail: Tail | undefined,
      inherited: NodeJS.WriteStream,
    ) => {
      if (pipe !== undefined) {
        await pipeline(source, pipe)
        return
      }
      for await (const chunk of source) {
        if (tail !== undefined) tail.append(chunk)
        else if (!inherited.write(chunk))
          await new Promise<void>((resolve) => inherited.once('drain', resolve))
      }
    }
    const done = this.ctx.mirage.ready
      .then(async (ws) => {
        workspace = ws
        this.checkWorld()
        if (cancelled || spec.signal?.aborted || this.closed)
          throw new Error('subprocess cancelled before start')
        child = ws.spawn(
          { argv: spec.argv, cwd: PathSpec.fromStrPath(spec.cwd), env },
          this.config.sessionId,
        )
        const launched = child
        let finished = false
        void launched.wait().then(() => {
          finished = true
          stdin?.end()
        })
        const feed = async () => {
          try {
            if (stdin !== undefined)
              for await (const chunk of stdin)
                await launched.stdin.write(new Uint8Array(chunk as Buffer))
            else if (typeof spec.stdio.stdin === 'object')
              await launched.stdin.write(new TextEncoder().encode(spec.stdio.stdin.data))
          } catch (error) {
            if (!finished && !cancelled) throw error
          } finally {
            launched.stdin.close()
          }
        }
        const [info] = await Promise.all([
          launched.wait(),
          feed(),
          drain(launched.stdout, stdout, outTail, process.stdout),
          drain(launched.stderr, stderr, errTail, process.stderr),
        ])
        if (info.failure !== null) throw new Error(info.failure)
        return { exitCode: info.exitCode, signal: null }
      })
      .catch((error: unknown) => {
        terminate()
        throw error
      })
      .finally(() => spec.signal?.removeEventListener('abort', terminate))
    const range = async () => {
      try {
        await done
      } catch {
        /* done reports failures; cleanup still observes the range. */
      }
      if (workspace !== undefined && child !== undefined) {
        const pid = child.pid
        for (;;) {
          const active = workspace.processes
            .live()
            .filter((process) => process.info.groupId === pid)
          if (active.length === 0) break
          await Promise.all(active.map((process) => process.join()))
        }
      }
    }
    const exited = range()
    const handle: SubprocessHandle = {
      stdin,
      stdout,
      stderr,
      collected: {
        ...(outTail === undefined ? {} : { stdout: outTail }),
        ...(errTail === undefined ? {} : { stderr: errTail }),
      },
      done,
      terminate,
      waitForExit: (signal) => waitBounded(exited, signal),
    }
    this.handles.add(handle)
    void exited.then(() => this.handles.delete(handle))
    return handle
  }

  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('Mirage has no terminal allocation capability'))
  }
  private checkWorld(): void {
    if (!this.ctx.mirage.vfsOnly)
      throw new Error(
        'Mirage subprocess requires workspace runtimes; native descendant tracking is unavailable',
      )
  }
}
