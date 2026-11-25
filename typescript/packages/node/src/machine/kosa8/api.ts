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

import {
  API_KEY_ENV,
  API_URL_ENV,
  DEFAULT_API_URL,
  REQUEST_TIMEOUT_SECONDS,
  STREAM_QUIET_SECONDS,
} from './constants.ts'

/** A refusal kosa8 Cloud answered with: its HTTP status and kosa8's error code. */
export class Kosa8ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${message} (${String(status)} ${code})`)
    this.name = 'Kosa8ApiError'
  }
}

/** An exec's stream that ended or broke before the command's exit came. */
export class Kosa8StreamCut extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'Kosa8StreamCut'
  }
}

/** One piece of a streamed exec: output, or the command's exit. */
export interface ExecFrame {
  /** `stdout` or `stderr` for output. */
  stream?: 'stdout' | 'stderr'
  /** The output's bytes. */
  data?: Uint8Array
  /** The exit status, on the last frame. */
  exitCode?: number
}

/** The frame one NDJSON line holds; null for a heartbeat. Mirrors Python's `parse_frame`. */
export function parseFrame(line: string): ExecFrame | null {
  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    raw = parsed as Record<string, unknown>
  } catch (error) {
    throw new Kosa8StreamCut(`kosa8 sent a frame it cannot read: ${String(error)}`, {
      cause: error,
    })
  }
  if (raw.done === true) {
    const code = raw.exit
    if (typeof code !== 'number' || !Number.isInteger(code))
      throw new Kosa8StreamCut(
        typeof raw.error === 'string' && raw.error !== ''
          ? raw.error
          : 'the command ended without an exit',
      )
    return { exitCode: code }
  }
  if (typeof raw.data !== 'string') return null
  const text = raw.data
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
    throw new Kosa8StreamCut(`kosa8 sent a frame it cannot read: not base64: ${text.slice(0, 40)}`)
  const bytes = atob(text)
  const data = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) data[i] = bytes.charCodeAt(i)
  return { stream: raw.stream === 'stderr' ? 'stderr' : 'stdout', data }
}

/** The part of kosa8 Cloud's REST API a machine uses, over fetch. */
export class Kosa8Api {
  private readonly base: string
  private readonly headers: Record<string, string>

  /**
   * @param apiKey the API key; unset reads KOSA8_API_KEY.
   * @param apiUrl the API's address; unset reads KOSA8_CLOUD_URL, then `DEFAULT_API_URL`.
   * @param fetcher the fetch to call, for tests; the global one unset.
   */
  constructor(
    apiKey: string | undefined,
    apiUrl: string | undefined,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    const env =
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
    const key = (apiKey ?? env[API_KEY_ENV] ?? '').trim()
    if (key === '') throw new Error(`kosa8: no API key; set ${API_KEY_ENV} or the machine's apiKey`)
    const url = apiUrl ?? env[API_URL_ENV]
    this.base = (url !== undefined && url !== '' ? url : DEFAULT_API_URL).replace(/\/+$/, '')
    this.headers = { Authorization: `Bearer ${key}`, 'User-Agent': 'mirage-kosa8' }
  }

  private static path(sandboxId: string, suffix = ''): string {
    return `/v1/sandboxes/${encodeURIComponent(sandboxId)}${suffix}`
  }

  private static async refusal(response: Response): Promise<Kosa8ApiError> {
    const text = await response.text()
    let data: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed !== null && typeof parsed === 'object') data = parsed as Record<string, unknown>
    } catch {
      data = {}
    }
    const word = (value: unknown): string | null =>
      typeof value === 'string' && value !== '' ? value : null
    return new Kosa8ApiError(
      response.status,
      word(data.code) ?? word(data.error) ?? 'error',
      word(data.message) ?? text.slice(0, 300),
    )
  }

  private async send(
    method: string,
    path: string,
    init: { body?: RequestInit['body']; json?: unknown; query?: Record<string, string> } = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = new URL(this.base + path)
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)
    const headers: Record<string, string> = { ...this.headers }
    let body = init.body
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.json)
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/octet-stream'
    }
    const response = await this.fetcher(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
    } as RequestInit)
    if (!response.ok) throw await Kosa8Api.refusal(response)
    return response
  }

  private async call(
    method: string,
    path: string,
    json?: unknown,
    query?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.send(method, path, {
      ...(json !== undefined ? { json } : {}),
      ...(query !== undefined ? { query } : {}),
    })
    const text = await response.text()
    if (text === '') return {}
    const data = JSON.parse(text) as unknown
    return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  }

  /** Start a sandbox and return it once kosa8 has it. */
  async create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return ((await this.call('POST', '/v1/sandboxes', body)).sandbox ?? {}) as Record<
      string,
      unknown
    >
  }

  /** The sandbox as kosa8 sees it. */
  async get(sandboxId: string): Promise<Record<string, unknown>> {
    return ((await this.call('GET', Kosa8Api.path(sandboxId))).sandbox ?? {}) as Record<
      string,
      unknown
    >
  }

  /** Delete the sandbox. */
  async delete(sandboxId: string): Promise<void> {
    await this.call('DELETE', Kosa8Api.path(sandboxId))
  }

  /** Put the sandbox to sleep, its memory and disk kept; the next exec wakes it. */
  async sleep(sandboxId: string): Promise<void> {
    await this.call('POST', Kosa8Api.path(sandboxId, '/sleep'))
  }

  /** Replace the sandbox's network policy, applied at once. */
  async setEgress(sandboxId: string, policy: unknown): Promise<void> {
    await this.call('PUT', Kosa8Api.path(sandboxId, '/egress'), policy)
  }

  /** Write a file in the sandbox from a stream of bytes. */
  async upload(sandboxId: string, path: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    const iterator = content[Symbol.asyncIterator]()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next()
          if (next.done === true) controller.close()
          else controller.enqueue(next.value)
        } catch (error) {
          controller.error(error)
        }
      },
      async cancel() {
        await iterator.return?.()
      },
    })
    const response = await this.send(
      'PUT',
      Kosa8Api.path(sandboxId, '/files/raw'),
      { body, query: { path } },
      AbortSignal.timeout(24 * 3600 * 1000),
    )
    await response.body?.cancel()
  }

  /** Remove a file in the sandbox; one already gone is no error. */
  async remove(sandboxId: string, path: string): Promise<void> {
    try {
      await this.call('DELETE', Kosa8Api.path(sandboxId, '/files'), undefined, { path })
    } catch (error) {
      if (!(error instanceof Kosa8ApiError) || error.status !== 404) throw error
    }
  }

  /**
   * Run argv in the sandbox, its frames yielded as the command writes; the
   * last carries its exit. Ending the iteration, or `signal`, ends the
   * stream but not the command, which kosa8 keeps running.
   *
   * Throws:
   *   Kosa8ApiError: kosa8 refused the exec.
   *   Kosa8StreamCut: the stream ended before the exit.
   */
  async *exec(
    sandboxId: string,
    argv: readonly string[],
    env: readonly string[],
    signal?: AbortSignal,
  ): AsyncGenerator<ExecFrame, void, undefined> {
    const controller = new AbortController()
    // The stream being read, cancelled with the request: a fetch need not
    // end a body it already answered with once its signal aborts.
    const reading: { reader: ReadableStreamDefaultReader<Uint8Array> | null } = { reader: null }
    const cut = (reason: unknown): void => {
      controller.abort(reason)
      reading.reader?.cancel(reason).catch(() => undefined)
    }
    const quiet = { timer: null as ReturnType<typeof setTimeout> | null }
    const hush = (): void => {
      if (quiet.timer !== null) clearTimeout(quiet.timer)
      quiet.timer = setTimeout(() => {
        cut(new Kosa8StreamCut('kosa8 sent nothing for too long'))
      }, STREAM_QUIET_SECONDS * 1000)
    }
    const stop = (): void => {
      cut(signal?.reason)
    }
    signal?.addEventListener('abort', stop, { once: true })
    const body: Record<string, unknown> = { cmd: [...argv], stream: true }
    if (env.length > 0) body.env = [...env]
    hush()
    try {
      const response = await this.send(
        'POST',
        Kosa8Api.path(sandboxId, '/exec'),
        { json: body },
        controller.signal,
      )
      if (response.body === null) throw new Kosa8StreamCut('kosa8 answered the exec with no stream')
      const reader = response.body.getReader()
      reading.reader = reader
      if (controller.signal.aborted) cut(controller.signal.reason)
      const decoder = new TextDecoder()
      let held = ''
      try {
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>
          try {
            chunk = await reader.read()
          } catch (error) {
            if (signal?.aborted === true) throw error
            throw new Kosa8StreamCut(`the exec stream broke: ${String(error)}`, { cause: error })
          }
          hush()
          if (chunk.done) break
          held += decoder.decode(chunk.value as Uint8Array, { stream: true })
          let end: number
          while ((end = held.indexOf('\n')) >= 0) {
            const line = held.slice(0, end)
            held = held.slice(end + 1)
            if (line.trim() === '') continue
            const frame = parseFrame(line)
            if (frame === null) continue
            yield frame
            if (frame.exitCode !== undefined) return
          }
        }
        if (held.trim() !== '') {
          const frame = parseFrame(held)
          if (frame !== null) {
            yield frame
            if (frame.exitCode !== undefined) return
          }
        }
      } finally {
        controller.abort()
        reader.releaseLock()
      }
      throw new Kosa8StreamCut('the exec stream ended before the command exited')
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new Kosa8StreamCut('kosa8 sent nothing for too long', { cause: error })
      if (!(signal?.aborted ?? false) && controller.signal.reason instanceof Kosa8StreamCut)
        throw controller.signal.reason
      throw error
    } finally {
      if (quiet.timer !== null) clearTimeout(quiet.timer)
      signal?.removeEventListener('abort', stop)
    }
  }
}
