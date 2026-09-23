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

import type { Workspace } from './workspace/workspace.ts'

/**
 * A {@link Workspace} wrapper that owns its lifecycle and provides a
 * canonical handle for callers that want a single owner per workspace.
 *
 * In Python this class pins the workspace to its own asyncio event
 * loop in a background thread, isolating it from the caller's loop.
 * Node.js has a single event loop per thread, so there's no
 * cross-loop handoff to perform; TS `call()` simply awaits the
 * supplied promise on the current loop. Callers who need true OS-
 * thread isolation should place the workspace inside a Worker and
 * communicate via message-passing.
 *
 * What this class DOES provide in TS:
 * - A clear owner: the runner is responsible for closing the workspace.
 * - Lifecycle guardrails: `call()` rejects after `stop()`.
 * - API parity with Python for code that ports over verbatim.
 *
 * @example
 * ```ts
 * const runner = new WorkspaceRunner(new Workspace({ '/': ram }))
 * try {
 *   const result = await runner.call(runner.ws.shell('ls /'))
 * } finally {
 *   await runner.stop()
 * }
 * ```
 */
export class WorkspaceRunner {
  readonly ws: Workspace
  private stopped = false
  private stopping: Promise<void> | null = null

  constructor(ws: Workspace) {
    this.ws = ws
  }

  /**
   * Await a workspace-produced promise.
   *
   * Rejects if the runner has been stopped. Does not block — Node's
   * single event loop interleaves this call with other work as usual.
   *
   * @param p a promise produced from the workspace API (e.g.
   *   `runner.ws.shell('ls /')`).
   */
  async call<T>(p: Promise<T>): Promise<T> {
    if (this.stopped) throw new Error('WorkspaceRunner is stopped')
    return p
  }

  /**
   * Close the workspace and mark the runner as stopped. Idempotent;
   * concurrent calls are deduplicated.
   */
  async stop(): Promise<void> {
    if (this.stopped) return this.stopping ?? Promise.resolve()
    this.stopped = true
    this.stopping = this.ws.close()
    await this.stopping
  }
}
