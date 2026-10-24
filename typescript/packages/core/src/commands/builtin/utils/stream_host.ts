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
import { enoent, fsStrerror, isFsError, isWalkError } from '../../../errors/fs.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import { chunks } from '../../../io/cooperative.ts'
import { ByteSpool, spooledPair } from '../../../io/spool.ts'
import type { ByteSource } from '../../../io/types.ts'
import { ByteWriter } from '../../../io/writer.ts'
import type { Served } from '../../../rs/stream.ts'
import { textView } from '../../../shell/bytes.ts'
import { shellJoin } from '../../../shell/join.ts'
import { PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
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

/**
 * The files and commands a mirage-rs stream reaches, through the workspace.
 * An input opens on its first read. An operand still holding its
 * command-line spelling reads through the mount's own reader, the way it
 * was resolved, unless another mount serves it; every other name reads
 * through the dispatcher, as writes go through it. Every stdin reader (`-`,
 * `/dev/stdin` and a command run without input of its own) shares one
 * cursor, so none replays what another read. A file opened for reading,
 * and a command, see every write made before it. Mirrors Python's
 * StreamHost.
 */
export class StreamHost {
  readonly errors = new ByteSpool()
  private readonly stdin: AsyncIterator<Uint8Array>
  private readonly caller = currentCaller()
  private readonly inputs = new Map<number, AsyncIterator<Uint8Array>>()
  private readonly spools = new Map<number, ByteSpool>()
  private readonly outputs = new Map<string, ByteWriter>()

  constructor(
    private readonly operands: readonly PathSpec[],
    private readonly stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
    private readonly ctx: Context,
    private readonly local: (path: PathSpec) => boolean,
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

  /** Open an input by name: `-` or `/dev/stdin` is stdin; `operand` is the operand, from 1, the name came from. */
  openInput(name: string, operand: number | null): AsyncIterable<Uint8Array> {
    if (operand !== null && operand > 0 && operand <= this.operands.length) {
      const path = this.operands[operand - 1]
      if (path?.rawPath === name) {
        if (isStdin(path)) return this.stdinView()
        return this.readPath(path, this.local(path))
      }
    }
    if (STDIN_NAMES.has(name)) return this.stdinView()
    return this.readPath(name)
  }

  /** Commit one file's writes, or every file's; the first failure stops it, and its message is returned. */
  async flushOutput(name?: string): Promise<string | null> {
    const names = name === undefined ? [...this.outputs.keys()] : [name]
    for (const key of names) {
      const writer = this.outputs.get(key)
      this.outputs.delete(key)
      if (writer === undefined) continue
      try {
        await writer.finish()
      } catch (error) {
        if (!isWalkError(error)) throw error
        const detail = fsStrerror(error) ?? 'Cannot write output file'
        return `cannot open "${key}" for output (${detail})`
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
        if (fd !== null) this.inputs.delete(fd)
        if (source !== undefined) await close(source)
        return { reply: {} }
      }
      case 'write':
        return this.write(request, data)
      case 'flush': {
        const failure = await this.flushOutput(
          typeof request.path === 'string' ? request.path : undefined,
        )
        return { reply: failure === null ? {} : { fatal: failure } }
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

  private async read(
    fd: number,
    request: Readonly<Record<string, util.JSONType>>,
  ): Promise<Served> {
    let source = this.inputs.get(fd)
    if (source === undefined && typeof request.path === 'string') {
      const failure = await this.flushOutput()
      if (failure !== null) return { reply: { fatal: failure } }
      const operand = typeof request.operand === 'number' ? request.operand : null
      source = this.openInput(textView(request.path), operand)[Symbol.asyncIterator]()
      this.inputs.set(fd, source)
    }
    if (source === undefined) return { reply: { end: true } }
    let next: IteratorResult<Uint8Array>
    try {
      next = await source.next()
    } catch (err) {
      this.inputs.delete(fd)
      if (!isFsError(err)) throw err
      return { reply: { error: fsStrerror(err) ?? posixPhrase('ENOENT') } }
    }
    if (next.done === true) {
      this.inputs.delete(fd)
      return { reply: { end: true } }
    }
    return { reply: {}, data: next.value }
  }

  private async write(
    request: Readonly<Record<string, util.JSONType>>,
    data: Uint8Array,
  ): Promise<Served> {
    const dispatch = dispatchOf(this.ctx)
    if (dispatch === undefined) return { reply: { fatal: 'file output requires a workspace' } }
    const name = typeof request.path === 'string' ? request.path : ''
    const path = PathSpec.fromStrPath(textView(name), undefined, this.ctx.cwd)
    try {
      if (request.append !== true) {
        const failure = await this.flushOutput()
        if (failure !== null) return { reply: { fatal: failure } }
        await dispatch('write', path, [new Uint8Array()])
      }
      if (data.byteLength > 0) {
        let writer = this.outputs.get(name)
        if (writer === undefined) {
          writer = new ByteWriter(async (source) => {
            await dispatch('append', path, [source])
          })
          this.outputs.set(name, writer)
        }
        await writer.write(data)
      }
    } catch (error) {
      if (!isWalkError(error)) throw error
      return { reply: { error: fsStrerror(error) ?? 'Cannot write output file' } }
    }
    return { reply: {} }
  }

  /**
   * Run a command line in a subshell of the session, as sh -c would; `eval`
   * takes the line whole, so an empty one, a comment or a line ending in a
   * backslash runs as `sh -c` would run it.
   */
  private async run(request: Readonly<Record<string, util.JSONType>>): Promise<Served> {
    const shell = this.ctx.shell
    if (shell === undefined) return { reply: { fatal: 'running a command requires a workspace' } }
    const failure = await this.flushOutput()
    if (failure !== null) return { reply: { fatal: failure } }
    const spool = typeof request.stdin === 'number' ? this.spools.get(request.stdin) : undefined
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
