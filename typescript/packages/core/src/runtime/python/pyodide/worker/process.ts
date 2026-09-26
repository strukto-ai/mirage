import type { ChildProcess } from '../../../../process/child.ts'
import { RuntimeVFS } from '../../../vfs.ts'
import { resolvePath } from '../../../../utils/path.ts'
import { classify } from '../../../../errors/index.ts'
import type { RuntimeContext } from '../../../types.ts'
import { PipeClosed } from '../../../../shell/errors.ts'
import { PathSpec } from '../../../../types.ts'
import { decodeBase64, encodeBase64 } from '../../../../utils/base64.ts'

interface Request {
  op:
    | 'resolve'
    | 'spawn'
    | 'read'
    | 'write'
    | 'close'
    | 'poll'
    | 'wait'
    | 'communicate'
    | 'kill'
    | 'release'
    | 'finish'
  pid?: number
  argv?: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: number
  stdout?: number
  stderr?: number
  data?: string
  stream?: 'stdout' | 'stderr'
  signal?: number
  timeout?: number | null
}

async function within(done: Promise<unknown>, seconds?: number | null): Promise<boolean> {
  if (seconds === undefined || seconds === null) {
    await done
    return true
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => {
            resolve(false)
          },
          Math.max(0, seconds * 1000),
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function encoded(chunks: Uint8Array[]): string {
  const bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return encodeBase64(bytes)
}

class GuestChild {
  readonly readers: Record<'stdout' | 'stderr', AsyncIterator<Uint8Array>>
  readonly chunks = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] }
  readonly inherited = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] }
  readonly background: Promise<void>[] = []
  communication: Promise<unknown> | null = null
  killed = 0
  constructor(
    readonly child: ChildProcess,
    readonly request: Request,
  ) {
    this.readers = {
      stdout: child.stdout[Symbol.asyncIterator](),
      stderr: child.stderr[Symbol.asyncIterator](),
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      if (request[stream] !== -1)
        this.background.push(
          this.drain(stream, request[stream] === 0 ? this.inherited[stream] : null),
        )
    }
    if (request.stdin !== -1) this.background.push(this.feed(decodeBase64(request.data ?? '')))
  }
  async feed(data: Uint8Array): Promise<void> {
    try {
      await this.child.stdin.write(data)
    } catch (error) {
      if (!(error instanceof PipeClosed)) throw error
    } finally {
      this.child.stdin.close()
    }
  }
  async drain(stream: 'stdout' | 'stderr', target: Uint8Array[] | null): Promise<void> {
    for (;;) {
      const item = await this.readers[stream].next()
      if (item.done) return
      target?.push(item.value)
    }
  }
  code(): number | null {
    const code = this.child.poll()
    return code === null ? null : this.killed ? -this.killed : code
  }
  communicate(data?: string): Promise<unknown> {
    if (this.communication === null) {
      const work: Promise<unknown>[] = [...this.background, this.child.wait()]
      if (this.request.stdin === -1) work.push(this.feed(decodeBase64(data ?? '')))
      for (const stream of ['stdout', 'stderr'] as const)
        if (this.request[stream] === -1) work.push(this.drain(stream, this.chunks[stream]))
      this.communication = Promise.all(work)
    } else if (data !== undefined) throw new Error('cannot send input after communication started')
    return this.communication
  }
}

/** Invocation-owned capabilities. A guest cannot attach to another profile's PID. */
export class GuestProcessTable {
  private readonly children = new Map<number, GuestChild>()
  private closed = false
  private readonly owned = new Set<ChildProcess>()
  constructor(private readonly context: RuntimeContext) {}

  async call(payload: string): Promise<string> {
    try {
      const request = JSON.parse(payload) as Request
      const value = await this.operation(request)
      const inherited = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] }
      for (const entry of this.children.values()) {
        for (const stream of ['stdout', 'stderr'] as const)
          inherited[stream].push(...entry.inherited[stream].splice(0))
      }
      const consumed = Object.fromEntries(
        [...this.children].map(([pid, entry]) => [pid, entry.child.stdin.bytesRead]),
      )
      return JSON.stringify({
        ...value,
        consumed,
        inherited_stdout: encoded(inherited.stdout),
        inherited_stderr: encoded(inherited.stderr),
      })
    } catch (error) {
      const code = error instanceof PipeClosed ? 'EPIPE' : classify(error)
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        code: code ?? 'EIO',
      })
    }
  }

  private async operation(request: Request): Promise<Record<string, unknown>> {
    if (request.op === 'finish') {
      await this.close()
      return {}
    }
    if (request.op === 'resolve' || request.op === 'spawn') {
      if (request.op === 'spawn') this.context.processes?.checkSpawn()
      const vfs = new RuntimeVFS(this.context.dispatch, this.context.resolver)
      const head = request.argv?.[0]
      if (typeof head !== 'string' || !head)
        throw Object.assign(new Error('empty executable'), { code: 'ENOENT' })
      const cwd = request.cwd ?? '/'
      const paths = head.includes('/')
        ? [resolvePath(head, cwd)]
        : (request.env?.PATH ?? '/usr/bin')
            .split(':')
            .map((dir) => resolvePath(`${dir || '.'}/${head}`, cwd))
      let found: string | null = null
      let denied = false
      for (const path of paths) {
        try {
          const stat = await vfs.stat(path)
          if (!stat.isDir && (stat.mode & 0o111) !== 0) {
            found = path
            break
          }
          denied = true
        } catch (error) {
          const code = classify(error)
          if (code === 'EACCES' || code === 'EPERM') denied = true
          else if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
        }
      }
      if (request.op === 'resolve') return { path: found }
      if (found === null)
        throw Object.assign(new Error(`executable not found: ${head}`), {
          code: denied ? 'EACCES' : 'ENOENT',
        })
      const directory = await vfs.stat(cwd)
      if (!directory.isDir)
        throw Object.assign(new Error(`not a directory: ${cwd}`), { code: 'ENOTDIR' })
      request.argv = [found, ...(request.argv ?? []).slice(1)]

      if (this.context.processes?.spawn === undefined)
        throw new Error('runtime has no process spawn door')
      if (
        !Array.isArray(request.argv) ||
        request.argv.length === 0 ||
        !request.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
      )
        throw new Error('invalid argv')
      if (typeof request.cwd !== 'string' || !request.cwd.startsWith('/'))
        throw new Error('invalid cwd')
      if (this.closed) throw new Error('guest invocation has ended')
      const child = this.context.processes.spawn({
        argv: request.argv,
        cwd: PathSpec.fromStrPath(request.cwd),
        env: request.env ?? {},
        replaceEnv: true,
        mergeStderr: request.stderr === -2,
      })
      this.owned.add(child)
      const entry = new GuestChild(child, request)
      this.children.set(child.pid, entry)
      return { pid: child.pid, returncode: entry.code() }
    }
    const entry = this.children.get(request.pid ?? -1)
    if (entry === undefined) throw new Error('unknown subprocess handle')
    const { child } = entry
    switch (request.op) {
      case 'release':
        if (child.poll() === null) throw new Error('cannot release a live child')
        this.children.delete(child.pid)
        return {}
      case 'poll':
        return { returncode: entry.code() }
      case 'kill':
        if (child.poll() === null) {
          entry.killed = request.signal === 15 ? 15 : 9
          child.terminate()
        }
        return { returncode: entry.code() }
      case 'close':
        if (request.stream === undefined) child.stdin.close()
        else child.closeOutput(request.stream)
        return {}
      case 'write':
        await child.stdin.write(decodeBase64(request.data ?? ''))
        return {}
      case 'read': {
        const stream = request.stream
        if (stream !== 'stdout' && stream !== 'stderr') throw new Error('invalid stream')
        if (entry.request[stream] !== -1 || entry.communication !== null)
          throw new Error('pipe is not readable')
        const chunk = await entry.readers[stream].next()
        return { data: chunk.done ? '' : encodeBase64(chunk.value) }
      }
      case 'wait': {
        const complete = await within(
          Promise.all([child.wait(), ...entry.background]),
          request.timeout,
        )
        return { timeout: !complete, returncode: entry.code() }
      }
      case 'communicate': {
        const complete = await within(entry.communicate(request.data), request.timeout)
        return {
          timeout: !complete,
          returncode: entry.code(),
          stdout: encoded(entry.chunks.stdout),
          stderr: encoded(entry.chunks.stderr),
        }
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const child of this.owned) child.terminate()
    await Promise.all(
      [...this.children.values()].map(async (entry) => {
        await entry.child.wait()
        await Promise.all(entry.background)
        if (entry.communication !== null) await entry.communication
      }),
    )
  }
}
