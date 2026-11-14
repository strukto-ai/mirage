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

import { withoutAbortSignal, type Context } from '@earendil-works/chord/context'
import {
  err,
  ExecutionError,
  FileError,
  LineScanner,
  ok,
  StreamDecoder,
  toError,
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  type FileChange,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  type LineScan,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellSpillOptions,
  type TextLine,
  type TextLineReader,
  type WatchTarget,
} from '@earendil-works/pi-durable/env'
import { isMissingPath } from '@struktoai/mirage-core/errors/fs'
import { posixPhrase } from '@struktoai/mirage-core/errors/posix'
import { PipeClosed } from '@struktoai/mirage-core/io/errors'
import { BytePipe } from '@struktoai/mirage-core/io/pipe'
import type { StreamName } from '@struktoai/mirage-core/io/types'
import { FileType, type FileStat } from '@struktoai/mirage-core/types'
import { posixNormpath, resolvePath } from '@struktoai/mirage-core/utils/path'
import { singleQuote } from '@struktoai/mirage-core/utils/quote'
import type { Files } from '@struktoai/mirage-core/workspace/files'
import type { ShellExecution } from '@struktoai/mirage-core/workspace/shell_execution'
import { decisionLine } from '@struktoai/mirage-core/workspace/tools/io_text'
import { ensureParents } from '@struktoai/mirage-core/workspace/tools/tool_operations'
import type { ExecuteResult, Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { toFileError } from './errors.ts'
import { PollingWatcher, resolveTargets } from './watch.ts'

/**
 * Options for `MirageExecutionEnv`: `cwd` (default `/`), `sessionId`,
 * `id` and `watch.pollIntervalMs` (default 2000).
 */
export interface MirageExecutionEnvOptions {
  /** The directory relative paths and commands start from. */
  cwd?: string
  /**
   * The session every call acts as, so its profile judges it; the
   * workspace's default session when absent.
   */
  sessionId?: string
  /**
   * Pi's file namespace: equal ids see the same files at the same paths.
   * Every environment over one workspace shares one by default.
   */
  id?: string
  /** How `watch` polls: the interval between snapshots, as Pi's own polling watcher takes it. */
  watch?: { pollIntervalMs?: number }
}

const KINDS: Partial<Record<FileType, FileKind>> = {
  [FileType.FILE]: 'file',
  [FileType.DIRECTORY]: 'directory',
  [FileType.SYMLINK]: 'symlink',
}

const MAX_SYMLINKS = 40

const SPILL_BUFFER_BYTES = 1024 * 1024

const ids = new WeakMap<Workspace, string>()

function workspaceId(ws: Workspace): string {
  let id = ids.get(ws)
  if (id === undefined) {
    id = `mirage:${crypto.randomUUID()}`
    ids.set(ws, id)
  }
  return id
}

function abortedResult(context: Context, path?: string): Result<never, FileError> | undefined {
  return context.abortSignal?.aborted === true
    ? err(new FileError('aborted', 'aborted', path))
    : undefined
}

function closedResult(what: string, path: string): Result<never, FileError> {
  return err(new FileError('invalid', `${what} is closed`, path))
}

function infoOf(path: string, stat: FileStat, size?: number): Result<FileInfo, FileError> {
  const kind = KINDS[stat.type]
  if (kind === undefined) return err(new FileError('invalid', 'Unsupported file type', path))
  const mtimeMs = stat.modified === null ? Number.NaN : Date.parse(stat.modified)
  return ok({
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    kind,
    size: size ?? stat.size ?? 0,
    mtimeMs: Number.isNaN(mtimeMs) ? 0 : mtimeMs,
  })
}

/** Lines of one file, pulled from Mirage's streamed read as the caller asks. */
class MirageTextLineReader implements TextLineReader {
  private readonly decoder = new StreamDecoder()
  private buffered = ''
  private ended = false
  private closed = false

  constructor(
    private readonly chunks: AsyncIterator<Uint8Array>,
    private readonly path: string,
  ) {}

  async readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
    const aborted = abortedResult(context, this.path)
    if (aborted !== undefined) return aborted
    if (this.closed) return closedResult('Text line reader', this.path)
    try {
      for (;;) {
        const newline = this.buffered.indexOf('\n')
        if (newline !== -1) {
          const text = this.buffered.slice(0, newline)
          this.buffered = this.buffered.slice(newline + 1)
          return ok({ text, terminated: true })
        }
        if (this.ended) {
          if (this.buffered.length === 0) return ok(undefined)
          const text = this.buffered
          this.buffered = ''
          return ok({ text, terminated: false })
        }
        const next = await this.chunks.next()
        if (next.done === true) {
          this.buffered += this.decoder.decode()
          this.ended = true
        } else {
          this.buffered += this.decoder.decode(next.value)
        }
        const afterRead = abortedResult(context, this.path)
        if (afterRead !== undefined) return afterRead
      }
    } catch (error) {
      return err(toFileError(error, this.path))
    }
  }

  async close(_context: Context): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.buffered = ''
    await this.chunks.return?.()
  }
}

/**
 * Positional reads of the bytes a file held when it was opened. Mirage
 * hands out no open file handles, so the reader keeps a copy, and a rename
 * or rewrite of its path afterwards never reaches it.
 */
class MirageBinaryReader implements BinaryReader {
  private closed = false

  constructor(
    private readonly bytes: Uint8Array,
    private readonly opened: FileInfo,
  ) {}

  private refused(context: Context): Result<never, FileError> | undefined {
    return (
      abortedResult(context, this.opened.path) ??
      (this.closed ? closedResult('Binary reader', this.opened.path) : undefined)
    )
  }

  private slice(offset: number, length: number, context: Context): Result<Uint8Array, FileError> {
    const refused = this.refused(context)
    if (refused !== undefined) return refused
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      return err(
        new FileError(
          'invalid',
          'Offset and length must be non-negative safe integers',
          this.opened.path,
        ),
      )
    }
    return ok(this.bytes.slice(offset, offset + length))
  }

  private scan(
    options: { startLine: number; endLine?: number },
    context: Context,
  ): Result<LineScan, FileError> {
    const refused = this.refused(context)
    if (refused !== undefined) return refused
    let scanner: LineScanner
    try {
      scanner = new LineScanner(options.startLine, options.endLine)
    } catch (error) {
      return err(new FileError('invalid', 'Invalid line range', this.opened.path, toError(error)))
    }
    scanner.push(this.bytes)
    return ok(scanner.finish())
  }

  info(context: Context): Promise<Result<FileInfo, FileError>> {
    return Promise.resolve(this.refused(context) ?? ok(this.opened))
  }

  read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
    return Promise.resolve(this.slice(offset, length, context))
  }

  scanLines(
    options: { startLine: number; endLine?: number },
    context: Context,
  ): Promise<Result<LineScan, FileError>> {
    return Promise.resolve(this.scan(options, context))
  }

  close(_context: Context): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** Pages of one directory's entries, named when it was opened and read as they are paged. */
class MirageDirReader implements DirReader {
  private position = 0
  private closed = false

  constructor(
    private readonly files: Files,
    private readonly names: readonly string[],
    private readonly path: string,
  ) {}

  async next(
    maxEntries: number,
    context: Context,
  ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const aborted = abortedResult(context, this.path)
    if (aborted !== undefined) return aborted
    if (this.closed) return closedResult('Directory reader', this.path)
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      return err(new FileError('invalid', 'maxEntries must be a positive safe integer', this.path))
    }
    const entries: FileInfo[] = []
    while (this.position < this.names.length && entries.length < maxEntries) {
      const path = this.names[this.position] ?? ''
      this.position += 1
      const info = await lstatInfo(this.files, path)
      if (info === null) continue
      if (!info.ok) return info
      entries.push(info.value)
    }
    return ok({ entries, done: this.position >= this.names.length })
  }

  close(_context: Context): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** A path's own row (a link is itself), or null when it is gone. */
async function lstatInfo(files: Files, path: string): Promise<Result<FileInfo, FileError> | null> {
  try {
    const info = infoOf(path, await files.stat(path, undefined, { nofollow: true }))
    return info.ok ? info : null
  } catch (error) {
    if (isMissingPath(error)) return null
    return err(toFileError(error, path))
  }
}

/**
 * One command's complete output, held until it passes either bound, then
 * streamed to a temporary file in one write. Until that write reads (it
 * waits out a workspace capture, as every new top-level call does), the
 * output stays held, so the command keeps draining and a capture its line
 * holds up can end; once it reads, at most `SPILL_BUFFER_BYTES` wait for it.
 */
class OutputSpill {
  path: string | undefined
  error: ExecutionError | undefined
  private held: Uint8Array[] = []
  private seenBytes = 0
  private newlines = 0
  private pipe: BytePipe | undefined
  private reading = false
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly files: Files,
    private readonly bounds: ShellSpillOptions,
    private readonly create: () => Promise<Result<string, FileError>>,
  ) {}

  /** Take one chunk, waiting only for room in the pipe once the file's write reads. */
  async add(chunk: Uint8Array): Promise<void> {
    if (this.error !== undefined || chunk.length === 0) return
    this.held.push(chunk)
    if (this.pipe === undefined) {
      this.seenBytes += chunk.length
      for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, at + 1))
        this.newlines += 1
      const lines = this.newlines + (chunk[chunk.length - 1] === 0x0a ? 0 : 1)
      if (this.seenBytes <= this.bounds.afterBytes && lines <= this.bounds.afterLines) return
      this.start()
    }
    if (this.reading) await this.pass()
  }

  /** Wait until the file holds every chunk taken, or the write failed. */
  async finish(): Promise<void> {
    if (this.pipe === undefined) return
    await this.pass()
    this.pipe.end()
    await this.writing
  }

  private start(): void {
    const pipe = new BytePipe(SPILL_BUFFER_BYTES)
    this.pipe = pipe
    void pipe.asked().then(() => {
      this.reading = true
    })
    this.writing = (async () => {
      const created = await this.create()
      if (!created.ok) throw created.error
      this.path = created.value
      await this.files.write(created.value, pipe.stream(true))
    })().catch((error: unknown) => {
      pipe.closeReader()
      this.fail(toFileError(error, this.path))
    })
  }

  private async pass(): Promise<void> {
    const pipe = this.pipe
    if (pipe === undefined) return
    for (let chunk = this.held.shift(); chunk !== undefined; chunk = this.held.shift()) {
      if (this.error !== undefined) return
      try {
        await pipe.write(chunk)
      } catch (error) {
        if (!(error instanceof PipeClosed)) throw error
        this.held = []
        return
      }
    }
  }

  private fail(cause: FileError): void {
    this.held = []
    this.error = new ExecutionError(
      'unknown',
      `Failed to preserve complete shell output: ${cause.message}`,
      cause,
    )
  }
}

/**
 * Pi Durable's `ExecutionEnv` over a Mirage workspace: Pi's tools read and
 * write the workspace's mounts through its dispatcher, and run their
 * commands in its shell, as one session.
 */
export class MirageExecutionEnv implements ExecutionEnv {
  readonly id: string
  cwd: string
  private readonly session: Session
  private readonly files: Files
  private readonly pollIntervalMs: number
  private readonly running = new Set<ShellExecution>()

  constructor(ws: Workspace, options: MirageExecutionEnvOptions = {}) {
    this.session = new Session(ws, options.sessionId ?? null)
    this.files = this.session.vfs
    this.id = options.id ?? workspaceId(ws)
    this.cwd = options.cwd ?? '/'
    this.pollIntervalMs = options.watch?.pollIntervalMs ?? 2000
  }

  private resolve(path: string): string {
    return resolvePath(path, this.cwd)
  }

  private async attempt<T>(
    path: string,
    context: Context,
    run: () => Promise<T>,
  ): Promise<Result<T, FileError>> {
    const aborted = abortedResult(context, path)
    if (aborted !== undefined) return aborted
    try {
      return ok(await run())
    } catch (error) {
      return err(toFileError(error, path))
    }
  }

  absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return Promise.resolve(ok(this.resolve(path)))
  }

  joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return Promise.resolve(ok(posixNormpath(parts.join('/'))))
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = this.resolve(path)
    return this.attempt(resolved, context, async () =>
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(await this.files.read(resolved)),
    )
  }

  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    const resolved = this.resolve(path)
    return this.attempt(resolved, context, async () => {
      const chunks = await this.files.read(resolved, { stream: true })
      return new MirageTextLineReader(chunks[Symbol.asyncIterator](), resolved)
    })
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([])
    const opened = await this.openTextLineReader(path, context)
    if (!opened.ok) return opened
    const lines: string[] = []
    try {
      while (options?.maxLines === undefined || lines.length < options.maxLines) {
        const line = await opened.value.readLine(context)
        if (!line.ok) return line
        if (line.value === undefined) break
        lines.push(line.value.text)
      }
      return ok(lines)
    } finally {
      await opened.value.close(context)
    }
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const resolved = this.resolve(path)
    return this.attempt(resolved, context, () => this.files.read(resolved))
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const resolved = this.resolve(path)
    const opened = await this.attempt(resolved, context, async () => {
      if (options?.noFollow === true) {
        const own = await this.files.stat(resolved, undefined, { nofollow: true })
        if (own.type === FileType.SYMLINK)
          throw new FileError('invalid', 'Refusing to follow a symbolic link', resolved)
      }
      const stat = await this.files.stat(resolved)
      if (stat.type === FileType.DIRECTORY)
        throw new FileError('is_directory', `${resolved}: Is a directory`, resolved)
      if (stat.type !== FileType.FILE)
        throw new FileError('invalid', 'Not a regular file', resolved)
      const bytes = await this.files.read(resolved)
      const info = infoOf(resolved, stat, bytes.length)
      if (!info.ok) throw info.error
      return new MirageBinaryReader(bytes, info.value)
    })
    return opened.ok ? (abortedResult(context, resolved) ?? opened) : opened
  }

  async writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    return this.attempt(resolved, context, async () => {
      await ensureParents(this.files, resolved)
      await this.files.write(resolved, content)
    })
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    return this.attempt(resolved, context, async () => {
      await ensureParents(this.files, resolved)
      await this.files.append(
        resolved,
        typeof content === 'string' ? new TextEncoder().encode(content) : content,
      )
    })
  }

  /** The file a path names, refused unless it is a regular file that is there. */
  private async regularFile(path: string): Promise<void> {
    const stat = await this.files.stat(path)
    if (stat.type === FileType.DIRECTORY)
      throw new FileError('is_directory', `${path}: Is a directory`, path)
  }

  async truncateFile(
    path: string,
    size: number,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    if (!Number.isSafeInteger(size) || size < 0) {
      return err(
        new FileError('invalid', 'File size must be a non-negative safe integer', resolved),
      )
    }
    return this.attempt(resolved, context, async () => {
      await this.regularFile(resolved)
      await this.files.truncate(resolved, size)
    })
  }

  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    return this.attempt(resolved, context, () => this.regularFile(resolved))
  }

  /**
   * Refuse a path that is a mount root or holds one, as the shell refuses
   * `rm` and `mv` of a mountpoint: busy, before anything under it moves.
   */
  private refuseMount(path: string): void {
    if (this.files.isMount(path) || this.files.submounts(path).length > 0)
      throw new FileError('unknown', `${path}: ${posixPhrase('EBUSY')}`, path)
  }

  async renameFile(
    sourcePath: string,
    destinationPath: string,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const source = this.resolve(sourcePath)
    const destination = this.resolve(destinationPath)
    return this.attempt(source, context, async () => {
      this.refuseMount(source)
      await this.files.rename(source, destination)
    })
  }

  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const resolved = this.resolve(path)
    const stat = await this.attempt(resolved, context, () =>
      this.files.stat(resolved, undefined, { nofollow: true }),
    )
    return stat.ok ? infoOf(resolved, stat.value) : stat
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const resolved = this.resolve(path)
    const names = await this.attempt(resolved, context, () => this.files.readdir(resolved))
    if (!names.ok) return names
    const infos: FileInfo[] = []
    for (const name of names.value) {
      const aborted = abortedResult(context, resolved)
      if (aborted !== undefined) return aborted
      const info = await lstatInfo(this.files, name)
      if (info === null) continue
      if (!info.ok) return info
      infos.push(info.value)
    }
    return ok(infos)
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const resolved = this.resolve(path)
    return this.attempt(
      resolved,
      context,
      async () => new MirageDirReader(this.files, await this.files.readdir(resolved), resolved),
    )
  }

  async watch(
    targets: readonly WatchTarget[],
    onChange: (change: FileChange) => void,
    context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    const opened = await this.attempt(this.cwd, context, () =>
      PollingWatcher.open(
        this.files,
        resolveTargets(targets, (path) => this.resolve(path)),
        onChange,
        this.pollIntervalMs,
      ),
    )
    if (!opened.ok) return opened
    const aborted = abortedResult(context)
    if (aborted === undefined) return opened
    await opened.value.stop(context)
    return aborted
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const typed = path.startsWith('/') ? path : `${this.cwd}/${path}`
    return this.attempt(typed, context, async () => {
      const pending = typed.split('/')
      let resolved = '/'
      let directory = true
      let links = 0
      for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
        if (!directory) throw new FileError('not_directory', `${typed}: Not a directory`, typed)
        if (part === '' || part === '.') continue
        if (part === '..') {
          resolved = resolvePath('..', resolved)
          continue
        }
        const next = resolvePath(part, resolved)
        const stat = await this.files.stat(next, undefined, { nofollow: true })
        if (stat.type !== FileType.SYMLINK) {
          resolved = next
          directory = stat.type === FileType.DIRECTORY
          continue
        }
        links += 1
        if (links > MAX_SYMLINKS)
          throw new FileError('invalid', `${typed}: Too many levels of symbolic links`, typed)
        const target = await this.files.readlink(next)
        if (target.startsWith('/')) resolved = '/'
        pending.unshift(...target.split('/'))
      }
      return resolved
    })
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path, context)
    if (info.ok) return ok(true)
    if (info.error.code === 'not_found') return ok(false)
    return err(info.error)
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    return this.attempt(resolved, context, async () => {
      if (options?.recursive === false) {
        await this.files.mkdir(resolved)
        return
      }
      if (await this.files.isDir(resolved)) return
      await ensureParents(this.files, resolved)
      try {
        await this.files.mkdir(resolved)
      } catch (error) {
        if (!(await this.files.isDir(resolved))) throw error
      }
    })
  }

  private async removeTree(path: string): Promise<void> {
    for (const child of await this.files.readdir(path)) {
      const stat = await this.files.stat(child, undefined, { nofollow: true })
      if (stat.type === FileType.DIRECTORY) await this.removeTree(child)
      else await this.files.unlink(child)
    }
    await this.files.rmdir(path)
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = this.resolve(path)
    return this.attempt(resolved, context, async () => {
      let stat: FileStat
      try {
        stat = await this.files.stat(resolved, undefined, { nofollow: true })
      } catch (error) {
        if (options?.force === true && isMissingPath(error)) return
        throw error
      }
      if (stat.type !== FileType.DIRECTORY) {
        await this.files.unlink(resolved)
        return
      }
      if (options?.recursive !== true)
        throw new FileError('is_directory', `${resolved}: Is a directory`, resolved)
      this.refuseMount(resolved)
      await this.removeTree(resolved)
    })
  }

  async createTempDir(
    prefix: string | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    return this.attempt('', context, async () => {
      const made = await this.session.shell(
        `mktemp -d --tmpdir ${singleQuote(`${prefix ?? 'tmp-'}XXXXXX`)}`,
        { record: false },
      )
      if (made.exitCode !== 0) throw new FileError('unknown', made.stderrText.trimEnd())
      return made.stdoutText.trimEnd()
    })
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const dir = await this.createTempDir('tmp-', context)
    if (!dir.ok) return dir
    const path = `${dir.value}/${options?.prefix ?? ''}${crypto.randomUUID()}${options?.suffix ?? ''}`
    return this.attempt(path, context, async () => {
      await this.files.write(path, '')
      return path
    })
  }

  /** The line an argv runs as: each word quoted, after its program is found. */
  private async argvLine(
    argv: readonly string[],
    cwd: string,
  ): Promise<Result<string, ExecutionError>> {
    const [program] = argv
    if (program === undefined)
      return err(new ExecutionError('spawn_error', 'Empty argv: no program to run'))
    const found = await this.session.shell(`command -v -- ${singleQuote(program)}`, {
      cwd,
      record: false,
    })
    if (found.exitCode !== 0)
      return err(new ExecutionError('spawn_error', `${program}: command not found`))
    return ok(argv.map(singleQuote).join(' '))
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted === true) return err(new ExecutionError('aborted', 'aborted'))
    const signal = context.abortSignal
    const timeout = options?.timeout
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
      return err(
        new ExecutionError('timeout', 'Invalid timeout: must be a finite number of seconds'),
      )
    }
    const cwd = options?.cwd === undefined ? this.cwd : this.resolve(options.cwd)
    const timer = timeout === undefined ? undefined : AbortSignal.timeout(timeout * 1000)
    const signals = [signal, timer].filter((s): s is AbortSignal => s !== undefined)
    const env = options?.env
    let execution: ShellExecution
    try {
      if (!(await this.files.isDir(cwd))) {
        return err(new ExecutionError('spawn_error', `Working directory does not exist: ${cwd}`))
      }
      let line = command
      if (typeof line !== 'string') {
        const argv = await this.argvLine(line, cwd)
        if (!argv.ok) return argv
        line = argv.value
      }
      execution = await this.session.shell(line, {
        stream: true,
        cwd,
        ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
        ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
      })
    } catch (error) {
      return err(new ExecutionError('spawn_error', toError(error).message, toError(error)))
    }
    this.running.add(execution)
    const decoders = { stdout: new StreamDecoder(), stderr: new StreamDecoder() }
    const preserve = withoutAbortSignal(context)
    const spill =
      options?.spill === undefined
        ? undefined
        : new OutputSpill(this.files, options.spill, async () => {
            const dir = await this.createTempDir('tmp-', preserve)
            return dir.ok ? ok(`${dir.value}/pi-output-${crypto.randomUUID()}.log`) : dir
          })
    let failure: ExecutionError | undefined
    const emit = (text: string, stream: StreamName): void => {
      if (text === '' || failure !== undefined || options?.onOutput === undefined) return
      try {
        options.onOutput(text, context, { stream })
      } catch (error) {
        failure = new ExecutionError('callback_error', toError(error).message, toError(error))
        execution.cancel()
      }
    }
    let result: ExecuteResult | undefined
    let thrown: unknown
    try {
      for await (const event of execution.events) {
        emit(decoders[event.stream].decode(event.data), event.stream)
        await spill?.add(event.data)
      }
      result = await execution.wait()
    } catch (error) {
      thrown = error
    } finally {
      this.running.delete(execution)
    }
    emit(decoders.stdout.decode(), 'stdout')
    emit(decoders.stderr.decode(), 'stderr')
    if (result !== undefined) emit(decisionLine(result.decision), 'stderr')
    await spill?.finish()
    if (failure !== undefined) return err(failure)
    const spillPath = spill?.path
    const interrupted =
      timer?.aborted === true
        ? new ExecutionError('timeout', `timeout:${String(timeout)}`)
        : signal?.aborted === true
          ? new ExecutionError('aborted', 'aborted')
          : undefined
    if (interrupted !== undefined) {
      if (spillPath !== undefined) interrupted.spillPath = spillPath
      return err(interrupted)
    }
    if (spill?.error !== undefined) return err(spill.error)
    if (result === undefined)
      return err(new ExecutionError('unknown', toError(thrown).message, toError(thrown)))
    return ok({ exitCode: result.exitCode, ...(spillPath === undefined ? {} : { spillPath }) })
  }

  cleanup(_context: Context): Promise<void> {
    for (const execution of this.running) execution.cancel()
    this.running.clear()
    return Promise.resolve()
  }
}
