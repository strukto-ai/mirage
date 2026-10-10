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

import { Buffer } from 'node:buffer'
import { constants as fsConstants } from 'node:fs'
import { posix } from 'node:path'
import { classify, failureText } from '@struktoai/mirage-core/errors/classify'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import { MountCore, type FuseAttr } from '@struktoai/mirage-node'
import { eexist, enoent } from '@struktoai/mirage-core/errors/fs'
import type { ServerChannel } from 'ssh2'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_NOT_FOUND,
  RPC_PARSE_ERROR,
} from '../rpc/constants.ts'
import {
  CODEX_AGENT_ID,
  CODEX_CTRL_C,
  CODEX_CTRL_D,
  CODEX_INTERRUPTED,
  CODEX_INTERRUPT_SIGNAL,
  CODEX_MAX_MESSAGE,
  CODEX_READ_SIZE,
  CODEX_RETAINED_OUTPUT,
  CODEX_SHELLS,
  CODEX_SHELL_NAME,
  CODEX_SHELL_PATH,
  CODEX_TERMINATED,
} from './constants.ts'
import { CodexRPCError } from './errors.ts'
import { openLogin, type ChannelRequest } from './session.ts'
import { ChannelInput, ChannelOutput, Mark, deliver } from './stream.ts'

type Message = Record<string, JsonValue>
type Handler = (params: Message) => Promise<JsonValue>

interface Kinds {
  string: string
  boolean: boolean
  number: number
  object: Message
  array: JsonValue[]
}

const FILE_SCHEME = 'file://'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A `file:` URI as a workspace path: absolute and normalized. */
export function toPath(uri: JsonValue): string {
  if (typeof uri !== 'string')
    throw new CodexRPCError(RPC_INVALID_PARAMS, 'a path must be a file: URI')
  // WHATWG reads `file:rel` as `/rel`; a file URI's path must be written
  // absolute, as Python's urlsplit requires.
  if (!/^file:\//i.test(uri)) throw new CodexRPCError(RPC_INVALID_PARAMS, `invalid URI: ${uri}`)
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new CodexRPCError(RPC_INVALID_PARAMS, `invalid URI: ${uri}`)
  }
  if (url.protocol !== 'file:' || !url.pathname.startsWith('/')) {
    throw new CodexRPCError(RPC_INVALID_PARAMS, `invalid URI: ${uri}`)
  }
  return posix.normalize('/' + decodeURIComponent(url.pathname).replace(/^\/+/, ''))
}

/** A workspace path as a `file:` URI, each segment percent-encoded. */
export function toUri(path: string): string {
  const quote = (part: string): string =>
    encodeURIComponent(part).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    )
  return FILE_SCHEME + path.split('/').map(quote).join('/')
}

function isKind(value: JsonValue, kind: keyof Kinds): boolean {
  if (kind === 'array') return Array.isArray(value)
  if (kind === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value)
  if (kind === 'number') return typeof value === 'number' && Number.isInteger(value)
  return typeof value === kind
}

/**
 * One request field, of the type the protocol gives it; `fallback` is its
 * value when absent or null, and without one the field is required.
 */
function arg<K extends keyof Kinds>(
  params: Message,
  name: string,
  kind: K,
  fallback?: Kinds[K],
): Kinds[K] {
  const value = params[name] ?? fallback
  if (value === undefined) {
    throw new CodexRPCError(RPC_INVALID_PARAMS, `missing field \`${name}\``)
  }
  if (!isKind(value, kind)) {
    throw new CodexRPCError(RPC_INVALID_PARAMS, `invalid type for field \`${name}\``)
  }
  return value as Kinds[K]
}

/** A `{name: value}` map of strings, as `env` and `set` carry. */
function strings(value: JsonValue | undefined, name: string): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!isKind(value, 'object')) {
    throw new CodexRPCError(RPC_INVALID_PARAMS, `\`${name}\` must map names to strings`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Message)) {
    if (typeof v !== 'string') {
      throw new CodexRPCError(RPC_INVALID_PARAMS, `\`${name}\` must map names to strings`)
    }
    out[k] = v
  }
  return out
}

/**
 * The variables a process sets over its session's environment. The
 * exec-server builds a process's environment from its own under
 * `envPolicy` and lays `env` over it; here the session's environment is
 * the server's own, so `envPolicy.set` and `env` are laid over it, `env`
 * last.
 */
export function processEnv(params: Message): Record<string, string> {
  const policy = params.envPolicy
  const base =
    policy !== undefined && isKind(policy, 'object')
      ? strings((policy as Message).set, 'envPolicy.set')
      : {}
  return { ...base, ...strings(params.env, 'env') }
}

/**
 * The shell line an argv runs as: a shell's `-c` script (`bash -lc 'ls'`,
 * what Codex sends for every command) runs as the line itself; any other
 * argv is quoted word by word.
 */
export function argvLine(argv: readonly string[]): string {
  const [head, flags, script] = argv
  if (
    argv.length === 3 &&
    head !== undefined &&
    flags !== undefined &&
    script !== undefined &&
    CODEX_SHELLS.has(posix.basename(head)) &&
    flags.startsWith('-') &&
    flags.includes('c')
  ) {
    return script
  }
  return argv.map(shellWord).join(' ')
}

/** One word as a POSIX shell reads it back, the way Python's shlex quotes. */
function shellWord(word: string): string {
  if (word === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(word)) return word
  return `'${word.replaceAll("'", `'"'"'`)}'`
}

/**
 * The JSON-RPC error for a failed operation: a missing path is Codex's
 * not-found, anything else an internal error, worded as GNU words the
 * condition.
 */
function rpcError(err: unknown): CodexRPCError {
  const condition = classify(err)
  const rpc = condition === 'ENOENT' ? RPC_NOT_FOUND : RPC_INTERNAL_ERROR
  return new CodexRPCError(rpc, failureText(err))
}

function notAFile(path: string): CodexRPCError {
  return new CodexRPCError(RPC_INVALID_REQUEST, `path \`${path}\` is not a file`)
}

const isDir = (mode: number): boolean => (mode & fsConstants.S_IFMT) === fsConstants.S_IFDIR
const isFile = (mode: number): boolean => (mode & fsConstants.S_IFMT) === fsConstants.S_IFREG
const isLink = (mode: number): boolean => (mode & fsConstants.S_IFMT) === fsConstants.S_IFLNK

function missing(err: unknown): boolean {
  const condition = classify(err)
  return condition === 'ENOENT' || condition === 'ENOTDIR'
}

async function lookup(core: MountCore, path: string): Promise<FuseAttr | null> {
  try {
    return await core.getattr(path)
  } catch (err) {
    if (missing(err)) return null
    throw err
  }
}

function followed(core: MountCore, path: string): Promise<FuseAttr> {
  return core.getattr(path, true)
}

/** `fs/getMetadata`: what the path points at, and whether it is a link. */
async function metadata(core: MountCore, path: string): Promise<Message> {
  const own = await core.getattr(path)
  const link = isLink(own.mode)
  const st = link ? await followed(core, path) : own
  return {
    isDirectory: isDir(st.mode),
    isFile: isFile(st.mode),
    isSymlink: link,
    size: st.size,
    createdAtMs: st.ctime.getTime(),
    modifiedAtMs: st.mtime.getTime(),
  }
}

async function openFile(core: MountCore, path: string): Promise<number> {
  if (isDir((await followed(core, path)).mode)) throw notAFile(path)
  return core.open(path)
}

async function readFile(core: MountCore, path: string): Promise<Uint8Array> {
  const fd = await openFile(core, path)
  try {
    const parts: Uint8Array[] = []
    let offset = 0
    for (;;) {
      const chunk = await core.read(path, fd, offset, CODEX_READ_SIZE)
      if (chunk.byteLength === 0) break
      parts.push(chunk)
      offset += chunk.byteLength
    }
    return Buffer.concat(parts)
  } finally {
    await core.release(fd)
  }
}

/** `fs/writeFile`: create or replace the file; its directory must exist. */
async function writeFile(core: MountCore, path: string, data: Uint8Array): Promise<void> {
  if ((await lookup(core, posix.dirname(path))) === null) throw enoent(path)
  const fd =
    (await lookup(core, path)) !== null
      ? await core.open(path, fsConstants.O_TRUNC)
      : await core.create(path)
  try {
    if (data.byteLength > 0) await core.write(path, fd, data, 0)
    await core.flush(path, fd)
  } finally {
    await core.release(fd)
  }
}

async function makeDirectory(core: MountCore, path: string): Promise<void> {
  if ((await lookup(core, path)) !== null) throw eexist(path)
  if ((await lookup(core, posix.dirname(path))) === null) throw enoent(path)
  await core.mkdir(path)
}

async function children(core: MountCore, path: string): Promise<string[]> {
  return (await core.readdir(path)).filter((n) => n !== '.' && n !== '..')
}

/** `fs/readDirectory`: each entry with the kind it points at. */
async function directory(core: MountCore, path: string): Promise<JsonValue[]> {
  const entries: JsonValue[] = []
  for (const name of await children(core, path)) {
    let st: FuseAttr
    try {
      st = await followed(core, posix.join(path, name))
    } catch (err) {
      // Vanished between the listing and its stat, as SFTP's listing
      // leaves it out; anything else is a real failure.
      if (!missing(err)) throw err
      continue
    }
    entries.push({ fileName: name, isDirectory: isDir(st.mode), isFile: isFile(st.mode) })
  }
  return entries
}

/**
 * What a walk reports an entry as, or null to leave it out: a link counts
 * only when followed, and only as a directory.
 */
async function walkKind(core: MountCore, path: string, follow: boolean): Promise<string | null> {
  const { mode } = await core.getattr(path)
  if (isLink(mode)) {
    if (!follow || !isDir((await followed(core, path)).mode)) return null
    return 'directory'
  }
  return isDir(mode) ? 'directory' : 'file'
}

/**
 * `fs/walk`: the tree breadth first, each directory's entries in name
 * order, within the request's limits. Depth 0 is the root's own entries.
 * A directory that cannot be read is reported under `errors` and the walk
 * goes on.
 */
async function walk(core: MountCore, root: string, options: Message): Promise<Message> {
  const maxDepth = arg(options, 'maxDepth', 'number')
  const maxDirectories = arg(options, 'maxDirectories', 'number')
  const maxEntries = arg(options, 'maxEntries', 'number')
  const follow = arg(options, 'followDirectorySymlinks', 'boolean')
  if (maxDirectories <= 0 || maxEntries <= 0) {
    throw new CodexRPCError(RPC_INVALID_REQUEST, 'filesystem walk limits must be greater than zero')
  }
  const entries: JsonValue[] = []
  const errors: JsonValue[] = []
  const result = (truncated: boolean): Message => ({ entries, errors, truncated })
  if (!isDir((await followed(core, root)).mode)) return result(false)
  const pending: [string, number][] = [[root, 0]]
  let read = 0
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    if (read >= maxDirectories) return result(true)
    const [path, depth] = next
    read += 1
    let names: string[]
    try {
      names = (await children(core, path)).sort(compareCodePoints)
    } catch (err) {
      errors.push({ path: toUri(path), message: rpcError(err).message })
      continue
    }
    for (const name of names) {
      const child = posix.join(path, name)
      const kind = await walkKind(core, child, follow)
      if (kind === null) continue
      if (entries.length >= maxEntries) return result(true)
      entries.push({ path: toUri(child), kind })
      if (kind === 'directory' && depth < maxDepth) pending.push([child, depth + 1])
    }
  }
  return result(false)
}

const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')

function unb64(text: string, name: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new CodexRPCError(RPC_INVALID_PARAMS, `\`${name}\` is not base64`)
  }
  return new Uint8Array(Buffer.from(text, 'base64'))
}

/** What Codex writes to a process, as the line's stdin; closing ends it. */
class ProcessInput implements AsyncIterable<Uint8Array> {
  closed = false
  private readonly queue: Uint8Array[] = []
  private wake: (() => void) | null = null

  write(data: Uint8Array): void {
    this.queue.push(data)
    this.wake?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const data = this.queue.shift()
      if (data !== undefined) {
        yield data
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.wake = null
    }
  }
}

/**
 * One started process: its recent output and how it ended. Output is kept
 * for `process/read` up to `CODEX_RETAINED_OUTPUT` bytes, the oldest chunks
 * dropped first; notifications carry all of it.
 */
class CodexProcess {
  readonly chunks: [number, number, Message][] = []
  retained = 0
  seq = 0
  exitCode: number | null = null
  closed = false
  stopCode: number | null = null
  controller: AbortController | null = null
  done: Promise<void> | null = null
  private waiters: (() => void)[] = []

  constructor(
    readonly processId: string,
    readonly tty: boolean,
    readonly stdin: ProcessInput | null,
  ) {}

  nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  /** Keep a chunk for `process/read`, dropping the oldest past the bound. */
  keep(seq: number, size: number, chunk: Message): void {
    this.chunks.push([seq, size, chunk])
    this.retained += size
    while (this.retained > CODEX_RETAINED_OUTPUT) {
      const dropped = this.chunks.shift()
      if (dropped === undefined) break
      this.retained -= dropped[1]
    }
  }

  changed(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  /** Resolves on the next change, or after `ms`. */
  until(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      this.waiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/**
 * One codex-exec channel: Codex's exec-server over one session.
 *
 * Codex runs its agent where it is and sends each tool call here: a
 * process runs as a line in the channel's session, and a file call lands
 * on the MountCore SFTP uses, so both see the tree, modes and policies a
 * shell in that session sees. Requests are answered one at a time, in
 * order, as the exec-server answers them by default, except `process/read`,
 * which may wait for output and so runs beside them. A process runs on in
 * the background and reports through notifications; once it has closed,
 * `process/terminate` forgets it, as Codex sends after every command.
 */
class CodexChannel {
  private readonly input: ChannelInput
  private readonly output: ChannelOutput
  private readonly core: MountCore
  private readonly processes = new Map<string, CodexProcess>()
  private readonly handles = new Map<string, [string, number]>()
  private starts: [CodexProcess, string, string, Record<string, string>][] = []
  private readonly reads = new Set<Promise<void>>()
  private readonly methods: Record<string, Handler>

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly entry: WorkspaceEntry,
    private readonly sessionId: string,
    private readonly channel: ServerChannel,
  ) {
    const ws = entry.runner.ws
    this.input = new ChannelInput(channel, false, CODEX_MAX_MESSAGE)
    this.output = new ChannelOutput(channel, false)
    this.core = new MountCore(ws.vfs, { session: ws.getSession(sessionId) })
    this.methods = {
      initialize: () => this.initialize(),
      'environment/info': () => this.environmentInfo(),
      'process/start': (p) => this.processStart(p),
      'process/read': (p) => this.processRead(p),
      'process/write': (p) => this.processWrite(p),
      'process/signal': (p) => this.processSignal(p),
      'process/terminate': (p) => this.processTerminate(p),
      'fs/getMetadata': async (p) => metadata(this.core, toPath(arg(p, 'path', 'string'))),
      'fs/canonicalize': (p) => this.canonicalize(p),
      'fs/readFile': async (p) => ({
        dataBase64: b64(await readFile(this.core, toPath(arg(p, 'path', 'string')))),
      }),
      'fs/writeFile': (p) => this.writeFile(p),
      'fs/createDirectory': (p) => this.createDirectory(p),
      'fs/readDirectory': async (p) => ({
        entries: await directory(this.core, toPath(arg(p, 'path', 'string'))),
      }),
      'fs/walk': async (p) =>
        walk(this.core, toPath(arg(p, 'path', 'string')), arg(p, 'options', 'object')),
      'fs/remove': (p) => this.remove(p),
      'fs/copy': (p) => this.copy(p),
      'fs/open': (p) => this.open(p),
      'fs/readBlock': (p) => this.readBlock(p),
      'fs/close': (p) => this.close(p),
    }
  }

  private live(): boolean {
    const wid = this.entry.id
    return this.registry.has(wid) && this.registry.get(wid) === this.entry
  }

  /** Answer requests until the channel's input ends; the exit status to report. */
  async serve(): Promise<number> {
    this.input.start()
    try {
      for (;;) {
        const item = await this.input.readline()
        if (item === Mark.LIMIT) {
          this.channel.stderr.write('mirage: codex-exec message too long\n')
          return 1
        }
        if (item === Mark.EOF) return 0
        if (typeof item !== 'string') await this.receive(decoder.decode(item))
      }
    } finally {
      await this.shutdown()
    }
  }

  private async shutdown(): Promise<void> {
    for (const proc of this.processes.values()) proc.controller?.abort()
    await Promise.all(
      [...this.processes.values()].flatMap((p) => (p.done === null ? [] : [p.done])),
    )
    await Promise.all(this.reads)
    for (const [, fd] of this.handles.values()) await this.core.release(fd)
    this.handles.clear()
    this.input.close()
    if (this.live()) await this.entry.runner.ws.closeSession(this.sessionId)
  }

  private async send(message: Message): Promise<void> {
    await this.output.write(encoder.encode(JSON.stringify(message) + '\n'))
  }

  private async receive(text: string): Promise<void> {
    if (text.trim() === '') return
    let message: JsonValue
    try {
      message = JSON.parse(text) as JsonValue
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      await this.send({ id: null, error: { code: RPC_PARSE_ERROR, message: reason } })
      return
    }
    if (!isKind(message, 'object')) return
    const request = message as Message
    const method = request.method
    // A message without a method is a response, and one without an id a
    // notification (`initialized`); neither is answered.
    if (typeof method !== 'string' || !('id' in request)) return
    const id = request.id ?? null
    if (method === 'process/read') {
      // A read may wait for output; stdin and signals sent behind it must
      // not wait with it.
      const read = this.answer(id, method, request.params)
      this.reads.add(read)
      void read.finally(() => this.reads.delete(read))
      return
    }
    await this.answer(id, method, request.params)
    const starts = this.starts
    this.starts = []
    for (const [proc, line, cwd, env] of starts) this.launch(proc, line, cwd, env)
  }

  private async answer(
    id: JsonValue,
    method: string,
    params: JsonValue | undefined,
  ): Promise<void> {
    let result: JsonValue
    try {
      result = await this.dispatch(method, params)
    } catch (err) {
      const error = err instanceof CodexRPCError ? err : rpcError(err)
      await this.send({ id, error: { code: error.code, message: error.message } })
      return
    }
    await this.send({ id, result })
  }

  private async dispatch(method: string, params: JsonValue | undefined): Promise<JsonValue> {
    const handler = this.methods[method]
    if (handler === undefined) {
      throw new CodexRPCError(RPC_METHOD_NOT_FOUND, `unsupported method \`${method}\``)
    }
    const given = params ?? {}
    if (!isKind(given, 'object'))
      throw new CodexRPCError(RPC_INVALID_PARAMS, 'params must be an object')
    return handler(given as Message)
  }

  /** Run a file operation's shell line, unrecorded, as the session. */
  private async line(line: string): Promise<void> {
    const result = await this.entry.runner.ws.shell(line, {
      sessionId: this.sessionId,
      record: false,
    })
    if (result.exitCode !== 0) {
      const err = decoder.decode(result.stderr).trim()
      throw new CodexRPCError(
        RPC_INTERNAL_ERROR,
        err === '' ? `exit ${String(result.exitCode)}` : err,
      )
    }
  }

  private initialize(): Promise<JsonValue> {
    return Promise.resolve({ sessionId: this.sessionId })
  }

  private environmentInfo(): Promise<JsonValue> {
    const cwd = this.entry.runner.ws.getSession(this.sessionId).cwd
    return Promise.resolve({
      shell: { name: CODEX_SHELL_NAME, path: CODEX_SHELL_PATH },
      cwd: toUri(cwd),
      capabilities: {},
    })
  }

  private processStart(params: Message): Promise<JsonValue> {
    const processId = arg(params, 'processId', 'string')
    const argv = arg(params, 'argv', 'array')
    if (argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      throw new CodexRPCError(RPC_INVALID_PARAMS, '`argv` must be a non-empty list of strings')
    }
    const cwd = toPath(arg(params, 'cwd', 'string'))
    const env = processEnv(params)
    const tty = arg(params, 'tty', 'boolean', false)
    const pipe = arg(params, 'pipeStdin', 'boolean', false)
    if (this.processes.has(processId)) {
      throw new CodexRPCError(RPC_INVALID_REQUEST, `process ${processId} already exists`)
    }
    const proc = new CodexProcess(processId, tty, tty || pipe ? new ProcessInput() : null)
    this.processes.set(processId, proc)
    this.starts.push([proc, argvLine(argv), cwd, env])
    return Promise.resolve({ processId, sandboxType: 'none' })
  }

  private launch(proc: CodexProcess, line: string, cwd: string, env: Record<string, string>): void {
    const controller = new AbortController()
    proc.controller = controller
    proc.done = this.run(proc, controller, line, cwd, env)
  }

  private async run(
    proc: CodexProcess,
    controller: AbortController,
    line: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<void> {
    let code: number
    try {
      const execution = await this.entry.runner.ws.shell(line, {
        sessionId: this.sessionId,
        stdin: proc.stdin ?? new Uint8Array(0),
        agentId: CODEX_AGENT_ID,
        signal: controller.signal,
        cwd,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        stream: true,
      })
      try {
        code = (await deliver(execution, (data, stderr) => this.emit(proc, data, stderr))).exitCode
      } finally {
        await execution.close()
      }
    } catch (err) {
      if (controller.signal.aborted) {
        code = CODEX_INTERRUPTED
      } else {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`codex: process failed on ${this.entry.id}: ${message}`)
        await this.emit(proc, encoder.encode(`mirage: ${message}\n`), true)
        code = 1
      }
    }
    if (controller.signal.aborted) code = proc.stopCode ?? CODEX_INTERRUPTED
    proc.exitCode = code
    proc.stdin?.close()
    await this.send({
      method: 'process/exited',
      params: {
        processId: proc.processId,
        seq: proc.nextSeq(),
        exitCode: code,
        sandboxDenied: false,
      },
    })
    proc.closed = true
    proc.changed()
    await this.send({
      method: 'process/closed',
      params: { processId: proc.processId, seq: proc.nextSeq() },
    })
    if (proc.stopCode === CODEX_TERMINATED) this.processes.delete(proc.processId)
  }

  private async emit(proc: CodexProcess, data: Uint8Array, stderr: boolean): Promise<void> {
    if (data.byteLength === 0) return
    const stream = proc.tty ? 'pty' : stderr ? 'stderr' : 'stdout'
    const seq = proc.nextSeq()
    const chunk: Message = { seq, stream, chunk: b64(data) }
    proc.keep(seq, data.byteLength, chunk)
    proc.changed()
    await this.send({ method: 'process/output', params: { processId: proc.processId, ...chunk } })
  }

  private known(params: Message): CodexProcess {
    const processId = arg(params, 'processId', 'string')
    const proc = this.processes.get(processId)
    if (proc === undefined) {
      throw new CodexRPCError(RPC_INVALID_REQUEST, `unknown process id ${processId}`)
    }
    return proc
  }

  private stop(proc: CodexProcess, code: number): boolean {
    if (proc.exitCode !== null || proc.controller === null) return false
    if (proc.stopCode === null) {
      proc.stopCode = code
      proc.controller.abort()
    }
    return true
  }

  private async processRead(params: Message): Promise<JsonValue> {
    const proc = this.known(params)
    const after = arg(params, 'afterSeq', 'number', 0)
    const waitMs = arg(params, 'waitMs', 'number', 0)
    const fresh = (): JsonValue[] => proc.chunks.filter(([seq]) => seq > after).map(([, , c]) => c)
    if (fresh().length === 0 && !proc.closed && waitMs > 0) await proc.until(waitMs)
    return {
      chunks: fresh(),
      nextSeq: proc.seq + 1,
      exited: proc.exitCode !== null,
      exitCode: proc.exitCode,
      closed: proc.closed,
      failure: null,
      sandboxDenied: false,
    }
  }

  private processWrite(params: Message): Promise<JsonValue> {
    const proc = this.processes.get(arg(params, 'processId', 'string'))
    if (proc === undefined) return Promise.resolve({ status: 'unknownProcess' })
    const data = unb64(arg(params, 'chunk', 'string', ''), 'chunk')
    if (proc.stdin === null || proc.stdin.closed) return Promise.resolve({ status: 'stdinClosed' })
    if (proc.tty && data.includes(CODEX_CTRL_C)) this.stop(proc, CODEX_INTERRUPTED)
    else if (proc.tty && data.length === 1 && data[0] === CODEX_CTRL_D) proc.stdin.close()
    else if (data.byteLength > 0) proc.stdin.write(data)
    return Promise.resolve({ status: 'accepted' })
  }

  private processSignal(params: Message): Promise<JsonValue> {
    const proc = this.known(params)
    const signal = arg(params, 'signal', 'string')
    if (signal !== CODEX_INTERRUPT_SIGNAL) {
      throw new CodexRPCError(
        RPC_INVALID_PARAMS,
        `unknown variant \`${signal}\`, expected \`${CODEX_INTERRUPT_SIGNAL}\``,
      )
    }
    this.stop(proc, CODEX_INTERRUPTED)
    return Promise.resolve({})
  }

  private processTerminate(params: Message): Promise<JsonValue> {
    const processId = arg(params, 'processId', 'string')
    const proc = this.processes.get(processId)
    if (proc === undefined) return Promise.resolve({ running: false })
    if (proc.closed) {
      this.processes.delete(processId)
      return Promise.resolve({ running: false })
    }
    return Promise.resolve({ running: this.stop(proc, CODEX_TERMINATED) })
  }

  private async canonicalize(params: Message): Promise<JsonValue> {
    const path = toPath(arg(params, 'path', 'string'))
    // The stat goes first: it refuses a link the session cannot see before
    // its target is named.
    await this.core.getattr(path, true)
    return { path: toUri(this.core.identity(path)) }
  }

  private async writeFile(params: Message): Promise<JsonValue> {
    const path = toPath(arg(params, 'path', 'string'))
    await writeFile(this.core, path, unb64(arg(params, 'dataBase64', 'string'), 'dataBase64'))
    return {}
  }

  private async createDirectory(params: Message): Promise<JsonValue> {
    const path = toPath(arg(params, 'path', 'string'))
    if (arg(params, 'recursive', 'boolean', false))
      await this.line(`mkdir -p -- ${shellWord(path)}`)
    else await makeDirectory(this.core, path)
    return {}
  }

  private async remove(params: Message): Promise<JsonValue> {
    const path = toPath(arg(params, 'path', 'string'))
    const recursive = arg(params, 'recursive', 'boolean', false)
    const force = arg(params, 'force', 'boolean', false)
    const st = await lookup(this.core, path)
    if (st === null) {
      if (force) return {}
      throw rpcError(enoent(path))
    }
    if (!isDir(st.mode)) await this.core.unlink(path)
    else if (recursive) await this.line(`rm -r -- ${shellWord(path)}`)
    else await this.core.rmdir(path)
    return {}
  }

  private async copy(params: Message): Promise<JsonValue> {
    const source = toPath(arg(params, 'sourcePath', 'string'))
    const destination = toPath(arg(params, 'destinationPath', 'string'))
    const tree = isDir((await followed(this.core, source)).mode)
    if (tree && !arg(params, 'recursive', 'boolean', false)) {
      throw new CodexRPCError(
        RPC_INVALID_REQUEST,
        'fs/copy requires recursive: true when sourcePath is a directory',
      )
    }
    const flag = tree ? '-R ' : ''
    await this.line(`cp ${flag}-- ${shellWord(source)} ${shellWord(destination)}`)
    return {}
  }

  private async open(params: Message): Promise<JsonValue> {
    const path = toPath(arg(params, 'path', 'string'))
    const handleId = arg(params, 'handleId', 'string')
    if (this.handles.has(handleId)) {
      throw new CodexRPCError(
        RPC_INVALID_REQUEST,
        `file read handle \`${handleId}\` already exists`,
      )
    }
    this.handles.set(handleId, [path, await openFile(this.core, path)])
    return { handleId }
  }

  private async readBlock(params: Message): Promise<JsonValue> {
    const handleId = arg(params, 'handleId', 'string')
    const offset = arg(params, 'offset', 'number')
    const length = arg(params, 'len', 'number')
    const opened = this.handles.get(handleId)
    if (opened === undefined) {
      throw new CodexRPCError(RPC_NOT_FOUND, `unknown file read handle \`${handleId}\``)
    }
    const chunk = await this.core.read(opened[0], opened[1], offset, length)
    return { chunk: b64(chunk), eof: chunk.byteLength < length }
  }

  private async close(params: Message): Promise<JsonValue> {
    const handleId = arg(params, 'handleId', 'string')
    const opened = this.handles.get(handleId)
    this.handles.delete(handleId)
    if (opened !== undefined) await this.core.release(opened[1])
    return {}
  }
}

/**
 * Serve one codex-exec channel in the workspace the login names, in a
 * fresh session as `openLogin` opens it.
 */
export async function serveCodex(
  registry: WorkspaceRegistry,
  channel: ServerChannel,
  request: ChannelRequest,
): Promise<void> {
  const opened = await openLogin(registry, channel, request, 'codex')
  if (opened === null) return
  const [entry, sessionId] = opened
  const status = await new CodexChannel(registry, entry, sessionId, channel).serve()
  channel.exit(status)
  channel.end()
}
