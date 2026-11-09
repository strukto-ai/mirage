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

import { LINE_STOP_SIGNAL } from '@struktoai/mirage-core/execution/constants'
import { newLineId } from '@struktoai/mirage-core/execution/context'
import { LineHandle } from '@struktoai/mirage-core/execution/line/handle'
import type { LineId } from '@struktoai/mirage-core/execution/types'
import type { BytePipe } from '@struktoai/mirage-core/io/pipe'
import type { JsonValue } from '@struktoai/mirage-core/types'

/**
 * One request that runs a line: the line's handle, the work running it,
 * and what the request answers once it settles: its result, or the error
 * that failed it.
 *
 * The line's record says how the line went (`LineHandle`); a request whose
 * line ended may still fail after, should its answer not be made. Mirrors
 * Python's `LineRequest`.
 */
export class LineRequest {
  result: JsonValue = null
  error: string | null = null
  cancelRequested = false
  settled = false
  readonly controller = new AbortController()
  completion: Promise<void> = Promise.resolve()
  stdin: BytePipe | undefined

  constructor(
    readonly line: LineHandle,
    readonly workspaceId: string,
  ) {}

  get id(): LineId {
    return this.line.id
  }
}

/**
 * The server's requests that run a line, each by its line's id, until its
 * caller has its answer.
 *
 * A line runs only after its session admits it. Cancel stops the work at
 * once; the line ends as stopped by an interrupt after the work and its
 * cleanup settle, unless it ended first. A request is held until `wait`
 * hands it to its caller, or its workspace goes. Mirrors Python's
 * `RequestTable`.
 */
export class RequestTable {
  /**
   * Set once the server starts shutting down: every door that submits a
   * line refuses a new one.
   */
  draining = false
  private held = new Map<string, LineRequest>()
  private closed = false
  private closing: Promise<void> | undefined

  /** The requests held, as of now. */
  requests(): LineRequest[] {
    return [...this.held.values()]
  }

  /** A request still held, or undefined. */
  get(id: LineId): LineRequest | undefined {
    return this.held.get(id.value)
  }

  /** Forget requests after their workspace's runner has stopped. */
  discardWorkspace(workspaceId: string): void {
    for (const [id, request] of this.held) {
      if (request.workspaceId === workspaceId) this.held.delete(id)
    }
  }

  private started(id: LineId): Promise<void> {
    if (this.held.get(id.value)?.cancelRequested === true) {
      return Promise.reject(new DOMException('request canceled', 'AbortError'))
    }
    return Promise.resolve()
  }

  /** Start a request's line; `factory` runs it and makes the request's answer. */
  submit(
    workspaceId: string,
    command: string,
    factory: (signal: AbortSignal, line: LineHandle) => Promise<JsonValue>,
    sessionId: string,
  ): LineRequest {
    if (this.closed) throw new Error('request table is closed')
    const id = newLineId()
    const request = new LineRequest(
      new LineHandle(id, sessionId, command, () => this.started(id)),
      workspaceId,
    )
    this.held.set(id.value, request)
    request.completion = this.run(request, factory)
    return request
  }

  private async run(
    request: LineRequest,
    factory: (signal: AbortSignal, line: LineHandle) => Promise<JsonValue>,
  ): Promise<void> {
    const line = request.line
    try {
      request.controller.signal.throwIfAborted()
      request.result = await factory(request.controller.signal, line)
    } catch (err) {
      // The request's own cancel aborts its controller; the workspace's (a
      // session or workspace cancel) rejects the line with the abort error.
      if (err instanceof DOMException && err.name === 'AbortError') {
        line.stop(LINE_STOP_SIGNAL)
      } else {
        request.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }
    }
    if (request.cancelRequested) line.stop(LINE_STOP_SIGNAL)
    const stopped = line.record.state === 'stopping' || line.record.signal !== null
    if (stopped) request.result = null
    line.end(stopped ? 128 + LINE_STOP_SIGNAL : null, request.error)
    request.settled = true
  }

  /** A request once it settles, which the table then lets go. */
  async wait(id: LineId): Promise<LineRequest> {
    const request = this.held.get(id.value)
    if (request === undefined) throw new Error(`request not found: ${id.value}`)
    await request.completion
    this.held.delete(id.value)
    return request
  }

  /**
   * Wait for a request on behalf of the caller that made it. A caller that
   * aborts cancels the request, and the wait still lasts until its cleanup
   * settles, so the work never outlives the request that started it.
   */
  async join(id: LineId, signal?: AbortSignal): Promise<LineRequest> {
    const cancel = (): void => {
      this.cancel(id)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted === true) cancel()
    try {
      return await this.wait(id)
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  /**
   * Stop a request's work and mark its line stopping. Answers whether this
   * call cancelled the request; false for one already settled, or settled
   * and let go.
   */
  cancel(id: LineId): boolean {
    const request = this.held.get(id.value)
    if (request === undefined || request.settled || request.cancelRequested) return false
    request.cancelRequested = true
    request.line.stop(LINE_STOP_SIGNAL)
    request.controller.abort()
    return true
  }

  /** Wait for a request's work and cleanup to settle. */
  async drain(id: LineId): Promise<void> {
    await this.held.get(id.value)?.completion
  }

  close(): Promise<void> {
    this.closed = true
    return (this.closing ??= this.finishClose())
  }

  private async finishClose(): Promise<void> {
    const requests = [...this.held.values()]
    for (const request of requests) this.cancel(request.id)
    await Promise.all(requests.map((request) => request.completion))
  }
}
