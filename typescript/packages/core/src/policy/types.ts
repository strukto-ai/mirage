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

import type { Limit, PathSpec, Producer } from '../types.ts'
import type { EvalValue } from '../workspace/executor/runtime_types.ts'

/**
 * The one registry question policy hooks may ask. MountRegistry
 * satisfies this structurally; the narrow interface keeps this package
 * a leaf (no workspace imports), so the registry can host a Policies
 * instance without a cycle. Mirrors the Python MountRootQuery.
 */
export interface MountRootQuery {
  isMountRoot(path: string): boolean
}

/**
 * What ExecuteContext needs to know about a runtime. Runtime satisfies
 * this structurally; the narrow interface keeps this package a leaf
 * (no executor imports). Mirrors the Python RuntimeIdentity.
 */
export interface RuntimeIdentity {
  readonly name: string
  readonly captures: readonly string[]
}

/**
 * Refuse the command with a message on stderr. `kind` is the wire
 * discriminant shared with Python; `exitCode` 1 (the GNU spelling of
 * an operand-level refusal) when omitted.
 */
export interface Deny {
  kind: 'deny'
  /** Full stderr text, newline-terminated. */
  message: string
  exitCode?: number
}

/**
 * Place the line on a named runtime, the affirmative routing arm.
 * Only legal from `preExecute`. The first Route wins (placement is an
 * affirmative choice, never a refusal); an unknown runtime name is a
 * PolicyError at the router, mirroring the `runtime` argument.
 */
export interface Route {
  kind: 'route'
  /** Name of the entry that serves every command it captures on this line. */
  runtime: string
}

/**
 * The closed vocabulary of policy answers: a hook returns an Action to
 * state an opinion or null to stay silent. Deny refuses (first opinion
 * wins); Limit bounds (every opinion merges to the tightest,
 * Limit.aggr); Route places the line on a runtime (first Route wins).
 * Each hook accepts a fixed set of kinds (VALIDITY), enforced at the
 * seam.
 */
export type Action = Deny | Limit | Route

/**
 * A declarative guard: refuse matching commands on matching paths.
 * The YAML `guards:` block and `Workspace({guards: [...]})` accept
 * this shape; `Policies.add` compiles it to a SpecPolicy. Patterns
 * match the absolute virtual path with `*` (any run, including `/`)
 * and `?` (any one character). Empty `commands` means every command;
 * empty `paths` refuses the command regardless of its operands.
 */
export interface GuardSpec {
  reason: string
  commands?: readonly string[]
  paths?: readonly string[]
}

/** Facts about one classified command, as preCommand hooks see it. */
export interface CommandContext {
  command: string
  paths: readonly PathSpec[]
  /** Raw argv after the command name; hooks fire before flag parsing. */
  argv: readonly string[]
  cwd: string
  registry: MountRootQuery
}

/** Facts about one VFS op, as preOps hooks see it. Fires at the op
 * door (the dispatcher every access routes through, FUSE included),
 * before any backend or cache I/O. */
export interface OpsContext {
  op: string
  path: PathSpec
  write: boolean
  prefix: string
}

/** One completed VFS op, as postOps hooks see it; a Deny suppresses
 * the result. */
export interface OpsResultContext {
  op: string
  path: PathSpec
  write: boolean
  prefix: string
  result: unknown
}

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
 * One typed line about to execute, as preExecute hooks see it,
 * parse-before-dispatch. `command` / `builtin` name the stage
 * addressed to the consulted party: an entry script sees its runtime's
 * first captured stage (see ctxForRuntime), a hook sees the line's
 * first command.
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
 * A config script gets this as the `ctx` dict (snake_case
 * `session_id` / `agent_id`, matching Python), with `ctx['runtime']`
 * naming the runtime being asked.
 */
export interface ExecuteContext {
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
 * The context as one runtime's script sees it: command/builtin become
 * the first stage the runtime captures, so `ctx.command === 'python3'`
 * means what it reads as even on `cat x | python3`. A runtime with no
 * captured stage on the line (including the catch-all vfs) keeps the
 * line's first stage. Mirrors the Python ExecuteContext.for_runtime.
 */
export function ctxForRuntime(ctx: ExecuteContext, runtime: RuntimeIdentity): ExecuteContext {
  for (const parsed of ctx.commands) {
    if (runtime.captures.includes(parsed.command)) {
      return { ...ctx, command: parsed.command, builtin: parsed.builtin }
    }
  }
  return ctx
}

/**
 * The ctx payload as any evaluator's script sees it.
 *
 * This is the execute context WIRE SCHEMA, a public contract:
 * JSON-shaped (strings, bools, lists, dicts), snake_case keys,
 * identical in both languages, so a script in any evaluator's
 * language (and any transport, in-process or remote) receives the
 * same structure. Keys: line, commands (command/words/builtin/paths/
 * cli per stage), command, builtin, cwd, env, session_id, agent_id,
 * mounts, plus runtime (name/captures) for per-runtime scripts.
 * executeContextFromPayload is the inverse, so a payload can be
 * stored as JSON and replayed.
 */
export function executeContextPayload(
  ctx: ExecuteContext,
  runtime?: RuntimeIdentity,
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
 * executeContextPayload for the context's own fields (the payload's
 * `runtime` block is per-consultation decoration and is ignored), so
 * a stored JSON payload replays through scripts and routes in tests
 * or debugging.
 */
export function executeContextFromPayload(payload: Record<string, unknown>): ExecuteContext {
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
 * One finished execute() line, as postExecute hooks see it. Fires at
 * the workspace boundary before the line's output stream is
 * finalized, so a Limit returned here bounds what the caller sees.
 * `producer` is the provenance of the surviving stream (the rightmost
 * command, per shell semantics), with an empty command when no
 * dispatch site stamped one.
 */
export interface ExecuteResultContext {
  producer: Producer
  exitCode: number
}

export const VALIDITY: Readonly<
  Record<'preCommand' | 'preExecute' | 'preOps' | 'postOps' | 'postExecute', ReadonlySet<string>>
> = {
  preCommand: new Set(['deny']),
  preExecute: new Set(['deny', 'route']),
  preOps: new Set(['deny']),
  postOps: new Set(['deny', 'limit']),
  postExecute: new Set(['limit']),
}
