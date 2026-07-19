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

/**
 * Script source arriving from a workspace config, not from code.
 *
 * The programmatic API takes functions; a yaml `script:`/`route:`
 * value references a `.py` file whose content is embedded here at
 * load. The source sees ctx as a dict and its LAST EXPRESSION is the
 * verdict. It runs on the routing interpreter (monty today; a sandbox
 * runtime is a candidate door later).
 */
export class ScriptSource {
  constructor(readonly source: string) {}
}

/**
 * A per-runtime willingness script, answering "do I want this line?".
 * In code: a function (sync or async) on the RouteContext returning a
 * truthy verdict. From config: a `.py` file reference, loaded as
 * ScriptSource (its last expression is the verdict).
 *
 * ```
 * new VfsRuntime((ctx) => ctx.builtin && !ctx.line.includes('/secret'))
 *
 * // workspace yaml: guard.py next to the config file
 * // runtimes:
 * //   - name: vfs
 * //     script: guard.py
 * ```
 */
export type RouteScript = ((ctx: RouteContext) => boolean | Promise<boolean>) | ScriptSource

/**
 * The global route, answering "who takes this line?". In code: a
 * function (sync or async) on the RouteContext returning a runtime
 * name, or null to pass down the ladder. From config: a `.py` file
 * reference, loaded as ScriptSource (its last expression is that name
 * or None).
 *
 * ```
 * route: (ctx) => (ctx.command === 'python3' ? 'monty' : null)
 *
 * // workspace yaml: route.py next to the config file
 * // route: route.py
 * ```
 */
export type RouteFn = ((ctx: RouteContext) => string | null | Promise<string | null>) | ScriptSource

/**
 * The one-line placement decision the dispatcher consults.
 *
 * Both fields hold runtimes: the decision IS "which runtime runs which
 * command". The vfs runtime is a legal value in either; a command
 * placed on it is served by the workspace executor itself.
 */
export interface RoutingDecision {
  /**
   * Every command some entry captures, resolved for this line: the
   * runtime it runs on, or null when its capturers all refused
   * (admission failure, exit 126, never a silent fallback to the
   * workspace).
   */
  bindings: Record<string, Runtime | null>
  /**
   * Where commands no entry captures run: the catch-all vfs runtime,
   * or null when the vfs runtime refused the line or declares
   * captures; unbound commands then exit 126.
   */
  fallback: Runtime | null
}
