// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { util } from 'zod'
import { currentCaller } from '../../../context/session_context.ts'
import { classify, failureText } from '../../../errors/classify.ts'
import { enoent, isWalkError } from '../../../errors/fs.ts'
import { fsErrorLine } from '../../../errors/render.ts'
import { chunks } from '../../../io/cooperative.ts'
import { ByteSpool, spooledPair } from '../../../io/spool.ts'
import { drain } from '../../../io/stream.ts'
import type { ByteSource, IOResult } from '../../../io/types.ts'
import { ByteWriter } from '../../../io/writer.ts'
import { openStream, serveRequests, type Served } from '../../../rs/stream.ts'
import { byteView, textView } from '../../../shell/bytes.ts'
import { shellJoin } from '../../../shell/join.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import type { Context } from '../../config.ts'
import { quoteText } from '../../quote.ts'
import { callerStream } from '../generic_bind/dispatch.ts'
import { dispatchOf } from './links.ts'
import { isStdin, resolveSource } from './stream.ts'

const STDIN_NAMES: ReadonlySet<string> = new Set(['-', '/dev/stdin'])

async function* spooled(spool: ByteSpool): AsyncIterable<Uint8Array> {
  try {
    yield* spool.stream()
  } finally {
    await spool.close()
  }
}

async function close(source: AsyncIterator<Uint8Array>): Promise<void> {
  await source.return?.()
}

/** A failed request's reply: the failure's words and the condition it names, when the vocabulary names one. */
function failure(err: unknown): Record<string, util.JSONType> {
  const errno = classify(err)
  const error = byteView(failureText(err))
  return errno === null ? { error } : { error, errno }
}

/**
 * The files and commands a mirage-rs stream reaches, through the workspace.
 * An input opens on its first read. An operand still holding its
 * command-line spelling reads through the mount's own reader, the way it
 * was resolved, unless another mount serves it; every other name reads
 * through the dispatcher, as writes go through it. Every stdin reader (`-`,
 * `/dev/stdin` and a command run without input of its own) shares one
 * cursor, so none replays what another read. A write is held until the
 * stream flushes it. `dash`: an operand `-` names stdin (see `isStdin`);
 * `command`: the command a failed operand's line names, worded as
 * `fsErrorLine` words it, and that may create no file one of its operands
 * names, empty leaving both to the stream;
 * `local`: whether the mount serves an operand, every one by default, as it
 * resolved them. Mirrors Python's StreamHost.
 */
export class StreamHost {
  readonly errors = new ByteSpool()
  private readonly stdin: AsyncIterator<Uint8Array>
  private readonly caller = currentCaller()
  private readonly inputs = new Map<number, AsyncIterator<Uint8Array>>()
  private readonly named = new Map<number, PathSpec>()
  private readonly spools = new Map<number, ByteSpool>()
  private readonly outputs = new Map<string, ByteWriter>()

  constructor(
    private readonly operands: readonly PathSpec[],
    private readonly stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
    private readonly ctx: Context,
    private readonly dash = true,
    private readonly command = '',
    private readonly local: (path: PathSpec) => boolean = () => true,
  ) {
    this.stdin = resolveSource(ctx.stdin)[Symbol.asyncIterator]()
  }

  async *stdinView(): AsyncIterable<Uint8Array> {
    for (;;) {
      const next = await this.stdin.next()
      if (next.done === true) return
      yield next.value
    }
  }

  /** Read a file; `local`: an operand this mount's backend serves. */
  private async *readPath(name: string | PathSpec, local = false): AsyncIterable<Uint8Array> {
    const dispatch = dispatchOf(this.ctx)
    if (dispatch === undefined && !local) throw enoent(name)
    const path = PathSpec.fromStrPath(name, undefined, this.ctx.cwd)
    yield* local || dispatch === undefined
      ? this.stream(path)
      : callerStream(dispatch, this.caller, path)
  }

  /**
   * Open an input by name: `-` or `/dev/stdin` is stdin; `operand` is the
   * operand, from 1, the name came from; `file` is a file a script names,
   * which no spelling of stdin stands for; `asOperand` is a name standing in
   * for an operand (unzip's `X.zip` for `X`), read as an operand is.
   */
  openInput(
    name: string,
    operand: number | null,
    file = false,
    asOperand = false,
  ): AsyncIterable<Uint8Array> {
    if (file) return this.readPath(name)
    const path =
      this.operand(name, operand) ??
      (asOperand ? PathSpec.fromStrPath(name, undefined, this.ctx.cwd) : undefined)
    if (path !== undefined) {
      if (isStdin(path, this.dash)) return this.stdinView()
      return this.readPath(path, this.local(path))
    }
    if (STDIN_NAMES.has(name)) return this.stdinView()
    return this.readPath(name)
  }

  /** The operand a name is, when it still holds its spelling. */
  private operand(name: string, operand: number | null): PathSpec | undefined {
    if (operand === null || operand <= 0 || operand > this.operands.length) return undefined
    const path = this.operands[operand - 1]
    return path?.rawPath === name ? path : undefined
  }

  /** Commit one file's writes, or every file's; the first failure stops it, and its reply, naming the file, is returned. */
  async flushOutput(name?: string): Promise<Record<string, util.JSONType> | null> {
    const names = name === undefined ? [...this.outputs.keys()] : [name]
    for (const key of names) {
      const writer = this.outputs.get(key)
      this.outputs.delete(key)
      if (writer === undefined) continue
      try {
        await writer.finish()
      } catch (error) {
        if (!isWalkError(error)) throw error
        return { ...failure(error), path: key }
      }
    }
    return null
  }

  /** Do one request a stream makes. */
  async serve(request: Readonly<Record<string, util.JSONType>>, data: Uint8Array): Promise<Served> {
    const fd = typeof request.fd === 'number' ? request.fd : null
    switch (request.op) {
      case 'read':
        if (fd !== null) return this.read(fd, request)
        break
      case 'close': {
        const source = fd === null ? undefined : this.inputs.get(fd)
        const spool = fd === null ? undefined : this.spools.get(fd)
        if (fd !== null) {
          this.inputs.delete(fd)
          this.spools.delete(fd)
        }
        if (source !== undefined) await close(source)
        if (spool !== undefined) await spool.close()
        return { reply: {} }
      }
      case 'write':
        return this.write(request, data)
      case 'unlink':
      case 'mkdir':
      case 'stat':
        return this.pathOp(request.op, typeof request.path === 'string' ? request.path : '')
      case 'fill':
        if (typeof request.into === 'number') return this.fill(request.into, request)
        break
      case 'flush': {
        const failed = await this.flushOutput(
          typeof request.path === 'string' ? request.path : undefined,
        )
        return { reply: failed ?? {} }
      }
      case 'spool':
        if (fd !== null) {
          let spool = this.spools.get(fd)
          if (spool === undefined) {
            spool = new ByteSpool()
            this.spools.set(fd, spool)
          }
          await spool.append(data)
          return { reply: {} }
        }
        break
      case 'emit':
        if (fd !== null && typeof request.skip === 'number' && typeof request.size === 'number') {
          const held = this.spools.get(fd)
          return { reply: {}, output: held?.stream(request.skip, request.size) ?? null }
        }
        if (fd !== null) {
          const spool = this.spools.get(fd)
          this.spools.delete(fd)
          return { reply: {}, output: spool === undefined ? null : spooled(spool) }
        }
        break
      case 'run':
        return this.run(request)
    }
    throw new Error(`unknown stream request: ${JSON.stringify(request.op)}`)
  }

  /**
   * The input a read or a fill opens: an operand, a name, or a spool past its
   * first `skip` bytes, where nothing spooled reads as empty.
   */
  private open(
    fd: number,
    request: Readonly<Record<string, util.JSONType>>,
  ): AsyncIterableIterator<Uint8Array> | undefined {
    if (typeof request.spool === 'number') {
      const skip = typeof request.skip === 'number' ? request.skip : 0
      return this.spools.get(request.spool)?.stream(skip)
    }
    if (typeof request.path !== 'string') return undefined
    const operand = typeof request.operand === 'number' ? request.operand : null
    const name = textView(request.path)
    const named = this.command === '' ? undefined : this.operand(name, operand)
    if (named !== undefined) this.named.set(fd, named)
    // Each pull loses to the abort, and a producer left mid-pull is closed
    // without a wait.
    const opened = this.openInput(name, operand, request.file === true, request.as_operand === true)
    return chunks(opened, this.ctx.signal, false)
  }

  /**
   * A failed input's reply, or a throw for what is not the file's own: the
   * failure's words, and the line the command words for an operand.
   */
  private failed(fd: number, err: unknown): Served {
    if (classify(err) === null) throw err
    const reply = failure(err)
    const named = this.named.get(fd)
    this.named.delete(fd)
    if (named !== undefined) reply.line = byteView(fsErrorLine(this.command, named, err))
    return { reply }
  }

  /** Read an input whole into spool `into` and answer its length. */
  private async fill(
    into: number,
    request: Readonly<Record<string, util.JSONType>>,
  ): Promise<Served> {
    let spool = this.spools.get(into)
    if (spool === undefined) {
      spool = new ByteSpool()
      this.spools.set(into, spool)
    }
    const source = this.open(into, request)
    try {
      if (source !== undefined) await spool.fill(source)
    } catch (err) {
      return this.failed(into, err)
    }
    this.named.delete(into)
    return { reply: { size: spool.size } }
  }

  private async read(
    fd: number,
    request: Readonly<Record<string, util.JSONType>>,
  ): Promise<Served> {
    if (typeof request.spool === 'number' && typeof request.size === 'number') {
      // A window comes whole, and nothing stays open.
      const held = this.spools.get(request.spool)
      const skip = typeof request.skip === 'number' ? request.skip : 0
      if (held === undefined || skip >= held.size) return { reply: {} }
      return { reply: {}, data: await held.read(skip, Math.min(request.size, held.size - skip)) }
    }
    let source = this.inputs.get(fd)
    if (source === undefined) {
      source = this.open(fd, request)
      if (source !== undefined) this.inputs.set(fd, source)
    }
    if (source === undefined) return { reply: { end: true } }
    let next: IteratorResult<Uint8Array>
    const parts: Uint8Array[] = []
    try {
      next = await source.next()
      // A file read whole gathers chunks to `least` bytes a reply, the last
      // of them sent with the end of the input.
      const least = typeof request.least === 'number' ? request.least : 0
      for (let size = 0; next.done !== true; next = await source.next()) {
        parts.push(next.value)
        size += next.value.byteLength
        if (size >= least) break
      }
    } catch (err) {
      this.inputs.delete(fd)
      return this.failed(fd, err)
    }
    const reply = next.done === true ? { end: true } : {}
    if (next.done === true) {
      this.inputs.delete(fd)
      this.named.delete(fd)
    }
    if (parts.length === 0) return { reply }
    const [only, ...more] = parts
    return { reply, data: only !== undefined && more.length === 0 ? only : parts }
  }

  /**
   * Write to a file: `append` adds to it, otherwise it is emptied first,
   * every held write committed before; `atomic` replaces it whole, once
   * flushed, with what this and later writes carry, and `create` writes it
   * whole as they carry it, `whole` from this write's bytes alone; `spool`
   * writes that spool's bytes past its first `skip` and drops it, or, with
   * `size`, that many of them and keeps it, with `create` the file whole
   * from them.
   */
  private async write(
    request: Readonly<Record<string, util.JSONType>>,
    data: Uint8Array,
  ): Promise<Served> {
    const dispatch = dispatchOf(this.ctx)
    if (dispatch === undefined) return { reply: { fatal: 'file output requires a workspace' } }
    const name = typeof request.path === 'string' ? request.path : ''
    const path = PathSpec.fromStrPath(textView(name), undefined, this.ctx.cwd)
    // GNU split refuses an output that is its input before it empties it;
    // csplit is refused alike, where GNU's empties its input.
    if (request.create === true && this.command !== '') {
      if (this.operands.some((spec) => spec.virtual === path.virtual)) {
        const line = `'${quoteText(textView(name))}' would overwrite input`
        const refused = byteView(`${this.command}: ${line}; aborting\n`)
        return { reply: { error: refused, line: refused } }
      }
    }
    if (request.whole === true) {
      try {
        await dispatch('write', path, [data])
      } catch (error) {
        if (!isWalkError(error)) throw error
        return { reply: failure(error) }
      }
      return { reply: {} }
    }
    const skip = typeof request.skip === 'number' ? request.skip : 0
    const size = typeof request.size === 'number' ? request.size : undefined
    if (request.create === true && typeof request.spool === 'number' && size !== undefined) {
      // A window of a spool is the whole file, written as one call.
      const held = this.spools.get(request.spool)
      try {
        await dispatch('write', path, [held?.stream(skip, size) ?? new Uint8Array()])
      } catch (error) {
        if (!isWalkError(error)) throw error
        return { reply: failure(error) }
      }
      return { reply: {} }
    }
    const spool = typeof request.spool === 'number' ? this.spools.get(request.spool) : undefined
    if (typeof request.spool === 'number' && size === undefined) this.spools.delete(request.spool)
    try {
      const atomic = request.atomic === true
      if (atomic || request.create === true) {
        await this.outputs.get(name)?.abort()
        this.outputs.delete(name)
        // The replacement opens now, so a refusal is reported before the
        // stream reads on.
        const replacement = new ByteWriter(async (source) => {
          await dispatch('write', path, [source], atomic ? { atomic } : {})
        })
        try {
          await replacement.opened()
        } catch (error) {
          await replacement.abort()
          throw error
        }
        this.outputs.set(name, replacement)
      } else if (request.append !== true) {
        const failed = await this.flushOutput()
        if (failed !== null) return { reply: failed }
        await dispatch('write', path, [new Uint8Array()])
      }
      let writer = this.outputs.get(name)
      if (writer === undefined && (data.byteLength > 0 || spool !== undefined)) {
        writer = new ByteWriter(async (source) => {
          await dispatch('append', path, [source])
        })
        this.outputs.set(name, writer)
      }
      if (writer !== undefined && data.byteLength > 0) await writer.write(data)
      if (writer !== undefined && spool !== undefined) {
        for await (const chunk of spool.stream(skip, size)) await writer.write(chunk)
      }
    } catch (error) {
      if (!isWalkError(error)) throw error
      return { reply: failure(error) }
    } finally {
      if (size === undefined) await spool?.close()
    }
    return { reply: {} }
  }

  /** Unlink, make (one level) or stat a path; a stat answers what stands there, `dir` or `file`, or why it found nothing. */
  private async pathOp(op: 'unlink' | 'mkdir' | 'stat', name: string): Promise<Served> {
    const dispatch = dispatchOf(this.ctx)
    if (dispatch === undefined) return { reply: { fatal: 'file output requires a workspace' } }
    let found: unknown
    try {
      ;[found] = await dispatch(op, PathSpec.fromStrPath(textView(name), undefined, this.ctx.cwd))
    } catch (error) {
      if (!isWalkError(error)) throw error
      return { reply: failure(error) }
    }
    if (op !== 'stat' || found === null || found === undefined) return { reply: {} }
    return { reply: { kind: (found as FileStat).type === FileType.DIRECTORY ? 'dir' : 'file' } }
  }

  /**
   * Run a command line in a subshell of the session, as sh -c would; `eval`
   * takes the line whole, so an empty one, a comment or a line ending in a
   * backslash runs as `sh -c` would run it.
   */
  private async run(request: Readonly<Record<string, util.JSONType>>): Promise<Served> {
    const shell = this.ctx.shell
    if (shell === undefined) return { reply: { fatal: 'running a command requires a workspace' } }
    // A pipe nothing was printed to has no spool, and is still its command's whole input.
    const spool =
      typeof request.stdin === 'number'
        ? (this.spools.get(request.stdin) ?? new ByteSpool())
        : undefined
    if (typeof request.stdin === 'number') this.spools.delete(request.stdin)
    const source: ByteSource = spool === undefined ? this.stdinView() : spool.stream()
    const command = textView(typeof request.command === 'string' ? request.command : '')
    let stdout: ByteSource | null
    let stderr: ByteSource | null
    let status: number
    try {
      const io = await shell(`( ${shellJoin(['eval', command])} )`, source)
      ;[stdout, stderr] = await spooledPair(io.stdout, io.stderr)
      status = io.exitCode
    } finally {
      await spool?.close()
    }
    await this.errors.fill(stderr ?? new Uint8Array())
    if (typeof request.stdout === 'number') {
      this.inputs.set(request.stdout, chunks(stdout ?? new Uint8Array())[Symbol.asyncIterator]())
      return { reply: { status } }
    }
    return { reply: { status }, output: stdout }
  }

  /** Let go of every input, spool and uncommitted write. */
  async close(): Promise<void> {
    const writers = [...this.outputs.values()]
    this.outputs.clear()
    for (const writer of writers) await writer.abort()
    const inputs = [...this.inputs.values()]
    this.inputs.clear()
    for (const source of inputs) await close(source)
    const spools = [...this.spools.values()]
    this.spools.clear()
    for (const spool of spools) await spool.close()
  }
}

/**
 * Run a stream that reaches files through `host`, yielding its output as it
 * settles; output closed early still lets what it wrote to its files land.
 * Mirrors Python's `hosted_stream`.
 */
export async function* hostedStream(
  kind: string,
  config: Readonly<Record<string, util.JSONType>>,
  host: StreamHost,
  io: IOResult,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  // The engine opens on the first pull, so output closed before one holds
  // no Wasm handle.
  const engine = await openStream(kind, config)
  let closed = true
  try {
    yield* serveRequests(engine, host, signal)
    closed = false
  } catch (err) {
    closed = false
    throw err
  } finally {
    try {
      if (closed && engine.cancel()) await drain(serveRequests(engine, host, signal))
      io.exitCode = engine.status()
    } finally {
      io.stderr = await host.errors.output()
      await host.close()
      engine.close()
    }
  }
}
