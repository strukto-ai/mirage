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

import type { Runtime } from '../runtime.ts'

/** Parse facts for one command of the line being routed. */
export interface CommandFacts {
  command: string
  words: readonly string[]
  builtin: boolean
  paths: readonly string[]
}

/**
 * Facts about the line being routed, parse-before-route. `command` /
 * `builtin` name the stage addressed to the consulted party: an entry
 * script sees its runtime's first captured stage (see ctxForRuntime),
 * the global route sees the line's first command.
 *
 * For `cat /data/logs.txt | python3 process.py` typed in `/data`, the
 * python runtime's script (it captures `python3`) is consulted with:
 *
 * ```
 * ctx.line     === 'cat /data/logs.txt | python3 process.py'
 * ctx.commands === [
 *   { command: 'cat', words: ['cat', '/data/logs.txt'],
 *     builtin: true, paths: ['/data/logs.txt'] },
 *   { command: 'python3', words: ['python3', 'process.py'],
 *     builtin: true, paths: [] },
 * ]
 * ctx.command  === 'python3' // the runtime's first captured stage
 * ctx.builtin  === true
 * ctx.cwd      === '/data'
 * ```
 *
 * The global route script sees the same context with
 * `ctx.command === 'cat'`, the line's first stage. A monty-source
 * script gets this as the `ctx` dict (snake_case `session_id` /
 * `agent_id`, matching Python), with `ctx['runtime']` naming the
 * runtime being asked.
 */
export interface RouteContext {
  line: string
  commands: readonly CommandFacts[]
  command: string
  builtin: boolean
  cwd: string
  env: Record<string, string>
  sessionId: string
  agentId: string
  mounts: readonly string[]
}

export type RouteScript = ((ctx: RouteContext) => boolean | Promise<boolean>) | string
export type RouteFn = ((ctx: RouteContext) => string | null | Promise<string | null>) | string

/** The one-line placement decision the dispatcher consults. */
export interface RoutingDecision {
  /** Command -> runtime for this line. */
  bindings: Record<string, Runtime>
  /**
   * Whether unbound commands may run on the vfs executor; false turns
   * them into admission failures.
   */
  vfsAllowed: boolean
  /**
   * Commands captured by some entry; an unbound captured command is an
   * admission failure (its capturers all refused), never a silent
   * fallback.
   */
  captured: ReadonlySet<string>
}
