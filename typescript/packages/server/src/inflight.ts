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

import type { JsonValue } from '@struktoai/mirage-core/types'

/** The JSON-RPC messages a request body carries, one or a batch. */
export function rpcMessages(body: unknown): Record<string, unknown>[] {
  const items: unknown[] = Array.isArray(body) ? body : [body]
  return items.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  )
}

/**
 * Calls still running, so a cancel that arrives on another request
 * reaches them. A stateless endpoint answers each HTTP request on its
 * own, so a client's cancel (MCP's `notifications/cancelled`, RPC's
 * `$/cancelRequest`) comes in on a request of its own. Calls are keyed by
 * the workspace, the session and the request id the client chose; two
 * callers in one session that reuse an id each hold their own call under
 * it, and a cancel for the id stops both.
 */
export class InFlight {
  private readonly running = new Map<string, (() => void)[]>()

  static key(workspaceId: string, sessionId: string, requestId: JsonValue | undefined): string {
    return JSON.stringify([workspaceId, sessionId, requestId ?? null])
  }

  add(key: string, cancel: () => void): void {
    const calls = this.running.get(key)
    if (calls === undefined) this.running.set(key, [cancel])
    else calls.push(cancel)
  }

  /** Forget a call that settled, leaving any other under its key. */
  discard(key: string, cancel: () => void): void {
    const calls = (this.running.get(key) ?? []).filter((c) => c !== cancel)
    if (calls.length === 0) this.running.delete(key)
    else this.running.set(key, calls)
  }

  /** Stop every call running under a key; false when none runs. */
  cancel(key: string): boolean {
    const calls = this.running.get(key) ?? []
    this.running.delete(key)
    for (const cancel of calls) cancel()
    return calls.length > 0
  }
}
