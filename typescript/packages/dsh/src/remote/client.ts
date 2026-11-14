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
import { fsError } from '@struktoai/mirage-core/errors/fs'
import { FileStat } from '@struktoai/mirage-core/types'
import type {
  JsonValue,
  PolicyDecision,
  PolicyDecisionKind,
  FileType,
} from '@struktoai/mirage-core/types'
import type { ShellExplanation } from '@struktoai/mirage-core/policy/types'
import { snakeToCamel } from '@struktoai/mirage-core/utils/normalize'
import { ExecuteResult } from '@struktoai/mirage-core/workspace/workspace/types'

/** Where a remote workspace lives and how to reach it. */
export interface MirageRemote {
  /** The Mirage server's origin, e.g. `https://api.strukto.ai` or `http://127.0.0.1:8765`. */
  url: string
  /** The workspace id on that server. */
  workspace: string
  /** A bearer token, sent as `Authorization: Bearer <token>`. */
  token?: string
  /** Extra headers on every request. */
  headers?: Record<string, string>
  /** The fetch to call; the global one by default (a Worker can pass a service binding's). */
  fetch?: typeof fetch
}

/** A session as the server answers for one. */
export interface RemoteSession {
  sessionId: string
  cwd: string
}

/** One command for {@link MirageClient.shell}. */
export interface RemoteShellCall {
  sessionId?: string
  /** A directory for this command only; the server runs it in a subshell there. */
  cwd?: string
  stdin?: Uint8Array
  /** Keep the line out of the session's history. */
  record?: boolean
  signal?: AbortSignal
  /**
   * Receives each output chunk as the server streams it. Given, the chunks
   * are handed on and not kept, so the result's stdout and stderr are empty.
   */
  onOutput?: (channel: 'stdout' | 'stderr', data: Uint8Array) => Promise<void>
}

/** One session's file calls on a remote workspace. */
export interface RemoteFiles {
  stat(path: string): Promise<FileStat>
  read(path: string, options?: { offset?: number; size?: number | null }): Promise<Uint8Array>
  write(path: string, data: string | Uint8Array): Promise<void>
  unlink(path: string): Promise<void>
  isDir(path: string): Promise<boolean>
  readdir(path: string): Promise<string[]>
  readlink(path: string): Promise<string | null>
}

interface WireDecision {
  kind: string
  reason: string
  policy: string
  ask_id: string | null
}

interface WireResult {
  exit_code: number
  stdout: string
  stderr: string
  decision: WireDecision | null
}

// Mirage's server answers `{"error": {...}}`; a host fronting it may answer
// `{"detail": "..."}` for its own refusals (auth, limits, a stopped world).
interface WireError {
  error?: { code?: string; message?: string; errno?: string; param?: string }
  detail?: string
}

type WireStat = Partial<Record<keyof FileStat, unknown>> & { name: string; type: string }

/** A failure the server answered with, in its own error envelope. */
export class MirageRemoteError extends Error {
  readonly status: number
  readonly code: string

  /**
   * @param status the HTTP status.
   * @param code the server's error code (`not_found`, `invalid_value`, ...).
   * @param message the server's message.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'MirageRemoteError'
    this.status = status
    this.code = code
  }
}

function decisionOf(wire: WireDecision | null): PolicyDecision | null {
  if (wire === null) return null
  return {
    kind: wire.kind as PolicyDecisionKind,
    reason: wire.reason,
    policy: wire.policy,
    askId: wire.ask_id,
  }
}

function resultOf(wire: WireResult, stdout: Uint8Array, stderr: Uint8Array): ExecuteResult {
  return new ExecuteResult(stdout, stderr, wire.exit_code, decisionOf(wire.decision))
}

function statOf(wire: WireStat): FileStat {
  const { name, type, ...rest } = wire
  return new FileStat({ ...(rest as Partial<FileStat>), name, type: type as FileType })
}

function camelKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(camelKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [snakeToCamel(key), camelKeys(inner)]),
  )
}

function trimTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1
  return url.slice(0, end)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const [only] = chunks
  return chunks.length === 1 && only !== undefined ? only : Buffer.concat(chunks)
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let pending = ''
  let finished = false
  try {
    yield* records()
    finished = true
  } finally {
    // A consumer that stops early (a failed `onOutput`, a record that does
    // not parse) closes the response, so the server hears the line is gone.
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  async function* records(): AsyncGenerator<Record<string, unknown>> {
    for (;;) {
      const { done, value } = await reader.read()
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line !== '') yield JSON.parse(line) as Record<string, unknown>
        newline = pending.indexOf('\n')
      }
      if (done) break
    }
    if (pending.trim() !== '') yield JSON.parse(pending) as Record<string, unknown>
  }
}

/**
 * The Mirage server API for one workspace, over HTTP: its shell, its
 * sessions and its VFS calls. Every call goes through `fetch`, so the client
 * runs wherever fetch does, a Worker included.
 *
 * A VFS failure the server classifies as a POSIX condition comes back as
 * mirage's own `FsError` (`code` is the errno, `virtualPath` the path), so a
 * caller handles it exactly as it would the same failure from a local
 * workspace.
 */
export class MirageClient {
  private readonly base: string
  private readonly headers: Record<string, string>
  private readonly send: typeof fetch

  /** @param remote where the workspace lives and how to reach it. */
  constructor(remote: MirageRemote) {
    this.base = `${trimTrailingSlashes(remote.url)}/v1/workspaces/${encodeURIComponent(remote.workspace)}`
    this.headers = {
      ...(remote.token !== undefined ? { authorization: `Bearer ${remote.token}` } : {}),
      ...(remote.headers ?? {}),
    }
    this.send = remote.fetch ?? ((input, init) => fetch(input, init))
  }

  private url(path: string, sessionId?: string, query: Record<string, string> = {}): string {
    const params = new URLSearchParams(query)
    if (sessionId !== undefined) params.set('session_id', sessionId)
    const qs = params.toString()
    return `${this.base}${path}${qs === '' ? '' : `?${qs}`}`
  }

  private async failure(response: Response, path?: string): Promise<Error> {
    let body: WireError = {}
    try {
      body = (await response.json()) as WireError
    } catch (err) {
      return new MirageRemoteError(
        response.status,
        'unreadable',
        `${response.status.toString()} ${response.statusText}: ${String(err)}`,
      )
    }
    const error = body.error ?? {}
    const message = error.message ?? body.detail ?? response.statusText
    if (error.errno !== undefined && path !== undefined) return fsError(path, error.errno, message)
    return new MirageRemoteError(response.status, error.code ?? 'unknown', message)
  }

  private async json<T>(
    path: string,
    body: unknown,
    opts: {
      sessionId?: string
      signal?: AbortSignal
      method?: string
      errorPath?: string
      query?: Record<string, string>
    } = {},
  ): Promise<T> {
    const response = await this.send(this.url(path, opts.sessionId, opts.query), {
      method: opts.method ?? 'POST',
      headers: {
        ...this.headers,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    if (!response.ok) throw await this.failure(response, opts.errorPath)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  private vfs<T>(
    call: string,
    body: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const path =
      typeof body.path === 'string'
        ? body.path
        : typeof body.src === 'string'
          ? body.src
          : undefined
    return this.json<T>(`/vfs/${call}`, body, {
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(path !== undefined ? { errorPath: path } : {}),
    })
  }

  /**
   * Run one command line and stream its output.
   *
   * The output arrives through `onOutput` as the server produces it, and is
   * then not kept: the caller bounds it, so the result carries the exit code
   * and decision with empty stdout and stderr. Without `onOutput` the result
   * carries the whole output. Aborting `signal` closes the request, which
   * cancels the line on the server.
   *
   * @param command the command line.
   * @param call where and how it runs.
   * @returns the line's result.
   */
  async shell(command: string, call: RemoteShellCall = {}): Promise<ExecuteResult> {
    const request = {
      command,
      ...(call.cwd !== undefined ? { cwd: call.cwd } : {}),
      ...(call.record !== undefined ? { record: call.record } : {}),
    }
    let init: RequestInit
    if (call.stdin !== undefined) {
      const form = new FormData()
      form.append('request', JSON.stringify(request))
      form.append('stdin', new Blob([call.stdin]))
      init = { method: 'POST', headers: this.headers, body: form }
    } else {
      init = {
        method: 'POST',
        headers: { ...this.headers, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }
    }
    if (call.signal !== undefined) init.signal = call.signal
    const response = await this.send(this.url('/shell', call.sessionId, { stream: 'true' }), init)
    if (!response.ok) throw await this.failure(response)
    if (response.body === null)
      throw new MirageRemoteError(response.status, 'empty', 'shell answered no body')
    const stdout: Uint8Array[] = []
    const stderr: Uint8Array[] = []
    for await (const record of ndjson(response.body)) {
      if (typeof record.stream === 'string' && typeof record.data === 'string') {
        const channel = record.stream === 'stderr' ? 'stderr' : 'stdout'
        const data = new Uint8Array(Buffer.from(record.data, 'base64'))
        if (call.onOutput !== undefined) await call.onOutput(channel, data)
        else (channel === 'stderr' ? stderr : stdout).push(data)
        continue
      }
      if (typeof record.status !== 'string') continue
      if (record.status === 'done' && record.result !== null && typeof record.result === 'object') {
        return resultOf(record.result as WireResult, concat(stdout), concat(stderr))
      }
      if (record.status === 'canceled') {
        throw call.signal?.reason ?? new MirageRemoteError(499, 'canceled', 'the line was canceled')
      }
      const error = typeof record.error === 'string' ? record.error : JSON.stringify(record.error)
      throw new MirageRemoteError(500, 'internal', `the line failed: ${error}`)
    }
    throw new MirageRemoteError(502, 'truncated', 'the shell stream ended without a status record')
  }

  /**
   * What a line would do, without running it: the server's own explanation,
   * in the camelCase shape a local workspace answers with.
   *
   * @param line the command line to judge.
   * @param sessionId the session to judge it in; the default when empty.
   * @returns the line's explanation.
   */
  async explain(line: string, sessionId = ''): Promise<ShellExplanation> {
    const said = await this.json<JsonValue>(
      '/shell',
      { command: line },
      { query: { explain: 'true' }, ...(sessionId === '' ? {} : { sessionId }) },
    )
    return camelKeys(said) as unknown as ShellExplanation
  }

  /** The workspace's sessions. */
  async sessions(signal?: AbortSignal): Promise<RemoteSession[]> {
    type Wire = { session_id: string; cwd: string }[]
    const page = await this.json<{ items: Wire } | Wire>('/sessions', undefined, {
      method: 'GET',
      ...(signal !== undefined ? { signal } : {}),
    })
    // Mirage's server pages a list as `{"items": [...]}`; a host may answer the bare array.
    const items = Array.isArray(page) ? page : page.items
    return items.map((s) => ({ sessionId: s.session_id, cwd: s.cwd }))
  }

  /**
   * One session.
   *
   * @param sessionId its id.
   * @returns the session and where it is.
   */
  async session(sessionId: string, signal?: AbortSignal): Promise<RemoteSession> {
    const found = (await this.sessions(signal)).find((s) => s.sessionId === sessionId)
    if (found === undefined)
      throw new MirageRemoteError(404, 'not_found', `no session ${sessionId}`)
    return found
  }

  /**
   * Create a session.
   *
   * @param sessionId its id.
   * @param opts its mount grants or profile, as the server takes them.
   */
  async createSession(
    sessionId: string,
    opts: { mounts?: Record<string, string>; profile?: string } = {},
  ): Promise<RemoteSession> {
    const made = await this.json<{ session_id: string; cwd: string }>('/sessions', {
      session_id: sessionId,
      ...opts,
    })
    return { sessionId: made.session_id, cwd: made.cwd }
  }

  /**
   * Read a file's bytes.
   *
   * @param path the workspace path.
   * @param opts a window to read, and the session to read as.
   */
  async read(
    path: string,
    opts: { offset?: number; size?: number; sessionId?: string; signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    const body = {
      path,
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      ...(opts.size !== undefined ? { size: opts.size } : {}),
    }
    const answer = await this.vfs<{ data: string }>('read', body, opts.sessionId, opts.signal)
    return new Uint8Array(Buffer.from(answer.data, 'base64'))
  }

  /** Replace a file's bytes. */
  async write(
    path: string,
    data: Uint8Array,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.vfs('write', { path, data: Buffer.from(data).toString('base64') }, sessionId, signal)
  }

  /** Append bytes to a file. */
  async append(
    path: string,
    data: Uint8Array,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.vfs(
      'append',
      { path, data: Buffer.from(data).toString('base64') },
      sessionId,
      signal,
    )
  }

  /** A path's metadata, links followed. */
  async stat(path: string, sessionId?: string, signal?: AbortSignal): Promise<FileStat> {
    const answer = await this.vfs<{ entry: WireStat }>('stat', { path }, sessionId, signal)
    return statOf(answer.entry)
  }

  /** A directory's entries, as full paths. */
  async readdir(path: string, sessionId?: string, signal?: AbortSignal): Promise<string[]> {
    return (await this.vfs<{ items: string[] }>('readdir', { path }, sessionId, signal)).items
  }

  /** Whether a path names a directory. */
  async isDir(path: string, sessionId?: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.vfs<{ is_dir: boolean }>('is_dir', { path }, sessionId, signal)).is_dir
  }

  /** Whether a path exists. */
  async exists(path: string, sessionId?: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.vfs<{ exists: boolean }>('exists', { path }, sessionId, signal)).exists
  }

  /** Create a directory. */
  async mkdir(path: string, sessionId?: string, signal?: AbortSignal): Promise<void> {
    await this.vfs('mkdir', { path }, sessionId, signal)
  }

  /** Remove a file. */
  async unlink(path: string, sessionId?: string, signal?: AbortSignal): Promise<void> {
    await this.vfs('unlink', { path }, sessionId, signal)
  }

  /** Move a file. */
  async rename(src: string, dst: string, sessionId?: string, signal?: AbortSignal): Promise<void> {
    await this.vfs('rename', { src, dst }, sessionId, signal)
  }

  /**
   * The file calls as one session makes them, in the shape a workspace's
   * own `Files` answers with.
   *
   * @param sessionId the session to act as; the default when omitted.
   * @returns the session's file calls.
   */
  files(sessionId?: string): RemoteFiles {
    return {
      stat: (path) => this.stat(path, sessionId),
      read: (path, options = {}) =>
        this.read(path, {
          ...(options.offset !== undefined ? { offset: options.offset } : {}),
          ...(options.size !== undefined && options.size !== null ? { size: options.size } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        }),
      write: (path, data) =>
        this.write(
          path,
          typeof data === 'string' ? new TextEncoder().encode(data) : data,
          sessionId,
        ),
      unlink: (path) => this.unlink(path, sessionId),
      isDir: (path) => this.isDir(path, sessionId),
      readdir: (path) => this.readdir(path, sessionId),
      readlink: (path) => this.readlink(path, sessionId),
    }
  }

  /** A symlink's target, or null when the path is not a link. */
  async readlink(path: string, sessionId?: string, signal?: AbortSignal): Promise<string | null> {
    try {
      return (await this.vfs<{ target: string }>('readlink', { path }, sessionId, signal)).target
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code === 'EINVAL' || code === 'ENOENT') return null
      throw err
    }
  }
}
