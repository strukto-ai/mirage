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

import type { Runtime } from '../base.ts'
import type { EvalValue, RuntimeLanguage } from '../types.ts'

/** One command of the line being routed, distilled from the parse. */
export interface ParsedCommand {
  command: string
  words: readonly string[]
  builtin: boolean
  paths: readonly string[]
  /**
   * The installed CLI whose head word `command` is, null otherwise.
   * Lets a policy steer an installed name between the virtual CLI and
   * a runtime capturing the same word.
   */
  cli: string | null
}

/**
 * What a policy may consult about the line, parse-before-policy. `command` /
 * `builtin` name the stage addressed to the consulted party: an entry
 * script sees its runtime's first captured stage (see ctxForRuntime),
 * the global policy sees the line's first command.
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
 * The global policy script sees the same context with
 * `ctx.command === 'cat'`, the line's first stage. A monty-source
 * script gets this as the `ctx` dict (snake_case `session_id` /
 * `agent_id`, matching Python), with `ctx['runtime']` naming the
 * runtime being asked.
 */
export interface RouteContext {
  line: string
  commands: readonly ParsedCommand[]
  command: string
  builtin: boolean
  cwd: string
  env: Record<string, string>
  sessionId: string
  agentId: string
  mounts: readonly string[]
}

/**
 * The ctx payload as any evaluator's script sees it.
 *
 * This is the policy context WIRE SCHEMA, a public contract:
 * JSON-shaped (strings, bools, lists, dicts), snake_case keys,
 * identical in both languages, so a script in any evaluator's
 * language (and any transport, in-process or remote) receives the
 * same structure. Keys: line, commands (command/words/builtin/paths/
 * cli per stage), command, builtin, cwd, env, session_id, agent_id,
 * mounts, plus runtime (name/captures) for per-runtime scripts.
 * routeContextFromPayload is the inverse, so a payload can be stored
 * as JSON and replayed.
 */
export function routeContextPayload(
  ctx: RouteContext,
  runtime?: Runtime,
): Record<string, EvalValue> {
  const payload: Record<string, EvalValue> = {
    line: ctx.line,
    commands: ctx.commands.map((c) => ({
      command: c.command,
      words: [...c.words],
      builtin: c.builtin,
      paths: [...c.paths],
      cli: c.cli,
    })),
    command: ctx.command,
    builtin: ctx.builtin,
    cwd: ctx.cwd,
    env: { ...ctx.env },
    session_id: ctx.sessionId,
    agent_id: ctx.agentId,
    mounts: [...ctx.mounts],
  }
  if (runtime !== undefined) {
    payload.runtime = { name: runtime.name, captures: [...runtime.captures] }
  }
  return payload
}

/**
 * Rebuild a context from its wire-schema payload: the inverse of
 * routeContextPayload for the context's own fields (the payload's
 * `runtime` block is per-consultation decoration and is ignored), so
 * a stored JSON payload replays through scripts and routes in tests
 * or debugging.
 */
export function routeContextFromPayload(payload: Record<string, unknown>): RouteContext {
  const commands = (payload.commands as Record<string, unknown>[]).map((c) => ({
    command: String(c.command),
    words: (c.words as string[]).slice(),
    builtin: Boolean(c.builtin),
    paths: (c.paths as string[]).slice(),
    cli: typeof c.cli === 'string' ? c.cli : null,
  }))
  return {
    line: String(payload.line),
    commands,
    command: String(payload.command),
    builtin: Boolean(payload.builtin),
    cwd: String(payload.cwd),
    env: { ...(payload.env as Record<string, string>) },
    sessionId: String(payload.session_id),
    agentId: String(payload.agent_id),
    mounts: (payload.mounts as string[]).slice(),
  }
}

/**
 * Script source arriving from a workspace config, not from code.
 *
 * The programmatic API takes functions; a yaml `script:`/`policy:`
 * value references a `.py` file whose content is embedded here at
 * load. The source sees ctx as a dict and its LAST EXPRESSION is the
 * verdict. It runs on the policy engine (monty today; a sandbox
 * runtime is a candidate door later).
 */
export class ScriptSource {
  /**
   * `language` names the script's language ("python" or "js"), stamped
   * from the file extension at config load; the programmatic default
   * is "python". The policy engine prefers a matching evaluator.
   *
   * `module` says the source is an ES module (a `.mjs` file), so a js
   * engine must run it in module mode or `import` and top-level
   * `await` fail. It is stamped from the extension at load beside
   * `language`, since the path is gone once the source is embedded.
   * Inert for policy scripts: a module has no completion value, and
   * their contract is the last expression.
   */
  constructor(
    readonly source: string,
    readonly language: RuntimeLanguage = 'python',
    readonly module = false,
  ) {}
}

/**
 * A per-runtime willingness script, answering "do I want this line?".
 * In code: a function (sync or async) on the RouteContext returning a
 * truthy verdict. From config: a `.py` file reference, loaded as
 * ScriptSource (its last expression is the verdict).
 *
 * ```
 * new VFSRuntime({ script: (ctx) => ctx.builtin && !ctx.line.includes('/secret') })
 *
 * // workspace yaml: guard.py next to the config file
 * // runtimes:
 * //   - name: vfs
 * //     script: guard.py
 * ```
 */
export type RouteScript = ((ctx: RouteContext) => boolean | Promise<boolean>) | ScriptSource

/** The affirmative arm: this runtime serves the line. Wire form: `{runtime: name}`. */
export class RouteResult {
  constructor(readonly runtime: string) {}
}

/**
 * The negative arm: refuse the line before anything runs. The line
 * exits 126 with `<command>: Permission denied`, the reason on the result's `refusal` record, on stderr.
 * Wire form: `{deny: reason}`.
 */
export class DenyResult {
  constructor(readonly reason: string) {}
}

/**
 * The typed spelling of a policy verdict, one class per arm.
 *
 * Code policies return an arm instance (or the plain-shape sugar in
 * RouteVerdict); config scripts return the wire dict, since class
 * instances cannot cross the evaluator sandbox. Each arm serializes
 * to one wire key, and future powers grow as fields on the arm they
 * ride (attachments on RouteResult, kubernetes-admission style).
 * Mirrors the python RouteOutcome base class.
 */
type RouteOutcome = RouteResult | DenyResult

/**
 * What the global policy may answer: a RouteOutcome arm, a runtime
 * name, null to pass, or the verdict object (the wire spelling of the
 * arms, the only form a config script can return). Object keys are
 * mutually exclusive: `{runtime: name}` places the line, `{deny:
 * reason}` refuses it. New powers grow as arm fields and wire keys,
 * never as new return types. Mirrors the python RouteVerdict.
 */
type RouteVerdict = RouteOutcome | string | null | { runtime?: string; deny?: string }

/**
 * The global policy, answering "who takes this line?". In code: a
 * function (sync or async) on the RouteContext returning a
 * RouteVerdict. From config: a `.py` file reference, loaded as
 * ScriptSource (its last expression is the verdict).
 *
 * ```
 * policy: (ctx) => (ctx.command === 'python3' ? 'monty' : null)
 *
 * // workspace yaml: policy.py next to the config file
 * // policy: policy.py
 * ```
 */
export type RoutePolicy =
  | ((ctx: RouteContext) => RouteVerdict | Promise<RouteVerdict>)
  | ScriptSource

/**
 * The one-line placement decision the dispatcher consults.
 *
 * Both fields hold runtimes: the decision IS "which runtime runs which
 * command". The vfs runtime is a legal value in either; a command
 * placed on it is served by the workspace executor itself.
 */
export interface RouteDecision {
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
