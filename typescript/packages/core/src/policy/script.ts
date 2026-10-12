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

import { runWithTimeout } from '../commands/builtin/utils/limit.ts'
import { CommandTimeoutError } from '../errors/types.ts'
import { WorkspaceBinding } from '../runtime/binding.ts'
import { SCRIPT_EVAL_TIMEOUT } from '../runtime/constants.ts'
import type { LanguageRuntime } from '../runtime/language.ts'
import type { MountResolver } from '../runtime/resolver.ts'
import { scriptEngine } from '../runtime/script.ts'
import type { BridgeDispatchFn, EvalValue, RunResult } from '../runtime/types.ts'
import { PathSpec } from '../types.ts'
import { compareCodePoints } from '../utils/sort.ts'
import type { Policy } from './base.ts'
import {
  CTX_ENV,
  DEFAULT_ASK_REASON,
  DEFAULT_DENY_REASON,
  METHODS,
  PROGRAM_RUNTIMES,
} from './constants.ts'
import { SESSION_SCOPED, type SessionScoped } from './mixin.ts'
import {
  Answer,
  VALIDITY,
  type Action,
  type Ask,
  type CommandContext,
  type Deny,
  type PolicyHook,
  type ProfileScript,
  type Route,
  type RouteContext,
  type ScriptMethod,
  type SessionContext,
  type SessionScriptsQuery,
  type VfsContext,
} from './types.ts'

const DECODER = new TextDecoder()
const ENCODER = new TextEncoder()

// The live handles every context carries, which a program reads as data
// instead: the session as its cwd, env and profile, the namespace as the
// mounts it shows, the files through the program's own open().
const LIVE = new Set(['session', 'ns', 'vfs'])

/**
 * A value as a program reads it: JSON-shaped data, bytes as text, a path
 * as its virtual spelling, a record as its fields under the Python
 * names (the live handles left out). Mirrors the Python `_plain`.
 */
function plain(value: unknown): EvalValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value
  }
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Uint8Array) return DECODER.decode(value)
  if (value instanceof PathSpec) return value.virtual
  if (Array.isArray(value) || value instanceof Set) return [...value].map(plain)
  if (value instanceof Map) {
    return Object.fromEntries([...value].map(([key, item]) => [String(key), plain(item)]))
  }
  if (typeof value === 'object') {
    const own = value as { toDict?: () => unknown; toJSON?: () => unknown }
    if (typeof own.toDict === 'function') return plain(own.toDict())
    if (typeof own.toJSON === 'function') return plain(own.toJSON())
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) =>
            !LIVE.has(key) &&
            item !== undefined &&
            typeof item !== 'function' &&
            typeof item !== 'symbol',
        )
        // Under the field names the document and the Python host spell.
        .map(([key, item]) => [
          key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
          plain(item),
        ]),
    )
  }
  return null
}

/**
 * A policy context as a program reads it: every field a coded policy
 * reads, under the Python name, as plain data. The live handles become
 * data: the session its `cwd`, `env` and `profile`, the namespace the
 * `mounts` the session sees. The files are the program's own `open()`,
 * which reads as the session. Mirrors the Python `script_context`.
 */
export function scriptContext(
  ctx: CommandContext | RouteContext | VfsContext | SessionContext,
): Record<string, EvalValue> {
  const data = plain(ctx) as Record<string, EvalValue>
  const session = ctx.session
  if (session !== undefined) {
    data.cwd = session.cwd()
    data.env = { ...session.snapshot() }
    data.profile = session.profile() ?? ''
  } else {
    data.cwd ??= '/'
    data.env = {}
    data.profile = ''
  }
  data.mounts = [...(ctx.ns?.mounts?.visibleDescendants('/') ?? [])]
  return data
}

/**
 * The answer a policy program printed at one method.
 *
 * Nothing (or `null`) is no opinion. Anything else is one JSON answer
 * (`Answer`): `{"kind": "deny", "reason": ...}`, `{"kind": "ask",
 * "reason": ...}`, or at `preExecute` `{"kind": "route", "runtime": ...}`.
 * A deny or an ask without a reason carries the document's default one.
 * Throws a plain Error whose message is a clause about "script", for the
 * caller to prefix with whose policy it is. Mirrors the Python
 * `script_action`.
 */
export function scriptAction(output: Uint8Array, method: ScriptMethod): Deny | Ask | Route | null {
  const text = DECODER.decode(output).trim()
  if (text === '' || text === 'null') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const answer = Answer.safeParse(parsed)
  const name = METHODS[method]
  if (!answer.success) {
    throw new Error(
      `script must print a JSON answer at ${name}, ` + '{"kind": "deny" | "ask" | "route", ...}',
    )
  }
  const { kind, reason, runtime } = answer.data
  if (!VALIDITY[method].has(kind)) throw new Error(`script cannot answer ${kind} at ${name}`)
  if (kind === 'deny') return { kind, reason: reason ?? DEFAULT_DENY_REASON }
  if (kind === 'ask') return { kind, reason: reason ?? DEFAULT_ASK_REASON }
  return { kind, runtime: runtime ?? '' }
}

/**
 * The workspace's file calls, for the runtime a profile's programs run on.
 *
 * Some judgments are about what a file holds rather than what it is
 * called. The runtime is attached with these exactly as `Runtimes`
 * attaches an agent's, so a program's `open()` reads the mounts through
 * the same entry point an agent's program would, and a read from a policy
 * clears the dispatcher like any other. The bridge is built for one
 * `issuer`, the policy's own token: every op it dispatches carries the
 * token to the dispatcher (`VfsContext.issuer`), which is how the
 * policy's `preVfs` tells its own read from anyone else's. The workspace
 * supplies them; a bare ScriptPolicy (outside a workspace) has none, and
 * its programs see no file.
 */
export interface ScriptWiring {
  bridge: (issuer: symbol) => BridgeDispatchFn
  resolver: MountResolver
}

/**
 * Each profile's policy programs, run at the `pre` methods.
 *
 * The scripted twin of `PermissionsPolicy`, registered right after it:
 * where that policy evaluates the document's declarative rules, this one
 * runs the profile's programs. A profile names, per method, a list of
 * programs and the runtime each runs on; they are asked in order, the
 * first deny wins, then the first ask, and every route must agree. A
 * method with no program is silence and costs nothing. It reads the
 * session's programs through the narrow `SessionScriptsQuery` by the
 * session id the entry point put in the context.
 *
 * A program runs as any program does on its runtime: never edited, with
 * the context as JSON (`scriptContext`) in `CTX_ENV` and on stdin, the
 * session's cwd and environment, and its answer printed on stdout
 * (`scriptAction`). Every failure fails closed: a program that exits
 * non-zero, runs past the timeout, prints something else, or names a
 * runtime that cannot be built refuses the action with a reason naming
 * the profile, and is logged.
 *
 * The runtime is the policy's own, built from the name and settings the
 * profile gives, shared across sessions and never the agent's. It is
 * wired to the workspace's files the way an agent's runtime is
 * (`ScriptWiring`), so a program reads what an operand holds as the
 * session reads it. A read from a program clears the dispatcher like any
 * other, except this policy's own `preVfs`: the policy is the one
 * asking, and judging its own read would re-enter the run waiting on it.
 * It knows its own read by `issuer`, a token only its bridge stamps and
 * that rides each op as an argument: a mark kept in ambient context would
 * be whatever op another task dispatched while a read was in flight on a
 * runtime with no task isolation. Runs are serialized. Mirrors the Python
 * `ScriptPolicy`.
 */
export class ScriptPolicy implements Policy, SessionScoped {
  readonly [SESSION_SCOPED] = true as const
  private readonly sessions: SessionScriptsQuery
  private readonly wiring: ScriptWiring | null
  private readonly engines = new Map<string, LanguageRuntime>()
  // The mark on every op this policy's own runtimes dispatch, and nothing
  // else's: unexported, so only the bridge built for it can stamp it.
  private readonly issuer = Symbol('policy read')
  private queue: Promise<unknown> = Promise.resolve()

  constructor(sessions: SessionScriptsQuery, wiring: ScriptWiring | null = null) {
    this.sessions = sessions
    this.wiring = wiring
  }

  async preExecute(ctx: RouteContext): Promise<Action | null> {
    return this.judge('preExecute', ctx)
  }

  async preCommand(ctx: CommandContext): Promise<Action | null> {
    return this.judge('preCommand', ctx)
  }

  async preVfs(ctx: VfsContext): Promise<Action | null> {
    if (ctx.issuer === this.issuer) return null
    return this.judge('preVfs', ctx)
  }

  async preSession(ctx: SessionContext): Promise<Action | null> {
    return this.judge('preSession', ctx)
  }

  /** Whether this session's profile names a program at `hook`. */
  wantsFor(hook: PolicyHook, sessionId: string): Promise<boolean> {
    const programs = hook in METHODS ? this.sessions.scriptsOf(sessionId)[hook as ScriptMethod] : []
    return Promise.resolve((programs?.length ?? 0) > 0)
  }

  /** Close every runtime a program ran on. */
  async close(): Promise<void> {
    const engines = [...this.engines.values()]
    this.engines.clear()
    for (const engine of engines) await engine.close()
  }

  /** Every program the session's profile names at one method. */
  private async judge(
    method: ScriptMethod,
    ctx: CommandContext | RouteContext | VfsContext | SessionContext,
  ): Promise<Action | null> {
    const programs = this.sessions.scriptsOf(ctx.sessionId ?? '')[method] ?? []
    if (programs.length === 0) return null
    const payload = JSON.stringify(scriptContext(ctx))
    const cwd = await this.cwd(ctx)
    const env = { ...(ctx.session?.snapshot() ?? {}) }
    let asked: Ask | null = null
    let routed: Route | null = null
    for (const entry of programs) {
      const answer = await this.run(entry, method, payload, cwd, env)
      if (answer === null) continue
      if (answer.kind === 'deny') return answer
      if (answer.kind === 'ask') asked ??= answer
      if (answer.kind === 'route') {
        if (routed !== null && routed.runtime !== answer.runtime) {
          return failed(entry, `places the line on '${routed.runtime}' and '${answer.runtime}'`)
        }
        routed ??= answer
      }
    }
    return asked ?? routed
  }

  /**
   * The directory a program starts in: the session's, or `/` once the
   * session's has gone, since a runtime that enters it first cannot start
   * in a directory that is not there.
   */
  private async cwd(
    ctx: CommandContext | RouteContext | VfsContext | SessionContext,
  ): Promise<string> {
    const cwd = ctx.session?.cwd() ?? '/'
    if (cwd !== '/' && ctx.vfs !== undefined && !(await ctx.vfs.exists(cwd))) return '/'
    return cwd
  }

  /** One program at one method, failing closed. */
  private async run(
    entry: ProfileScript,
    method: ScriptMethod,
    payload: string,
    cwd: string,
    env: Record<string, string>,
  ): Promise<Deny | Ask | Route | null> {
    let result: RunResult
    try {
      result = await this.serialized(async () => {
        const engine = this.engine(entry)
        return runWithTimeout(
          engine.execute({
            kind: 'code',
            language: entry.script.language,
            code: entry.script.source,
            args: [],
            cwd: PathSpec.fromStrPath(cwd),
            env: { ...env, [CTX_ENV]: payload },
            stdin: ENCODER.encode(payload),
          }),
          SCRIPT_EVAL_TIMEOUT.seconds,
          `profile '${entry.profile}' policy`,
        )
      })
    } catch (err) {
      if (err instanceof CommandTimeoutError) {
        return failed(entry, `timed out after ${String(SCRIPT_EVAL_TIMEOUT.seconds)}s`)
      }
      // scriptEngine's refusal: the runtime cannot be built here.
      return failed(entry, clause(err))
    }
    if (result.exitCode !== 0) {
      const stderr = DECODER.decode(result.stderr ?? new Uint8Array())
      return failed(entry, `exited ${String(result.exitCode)}`, stderr.slice(-2000))
    }
    try {
      return scriptAction(result.stdout, method)
    } catch (err) {
      return failed(entry, clause(err))
    }
  }

  /**
   * The policy's own runtime for one program, built on first use and
   * shared by every program naming the same runtime and settings. Throws
   * a clause about "script" when the runtime is not one a policy program
   * runs on, or cannot be built here.
   */
  private engine(entry: ProfileScript): LanguageRuntime {
    if (!PROGRAM_RUNTIMES.has(entry.runtime)) {
      throw new Error(
        `script names runtime '${entry.runtime}'; a policy program runs on ` +
          [...PROGRAM_RUNTIMES].sort(compareCodePoints).join(' or '),
      )
    }
    const settings = Object.entries(entry.config).sort(([a], [b]) => compareCodePoints(a, b))
    const key = JSON.stringify([entry.runtime, settings])
    let engine = this.engines.get(key)
    if (engine === undefined) {
      engine = scriptEngine(entry.script, entry.runtime, entry.config)
      // Keep policy-origin attribution on the binding's dispatch.
      if (this.wiring !== null) {
        engine.bind(new WorkspaceBinding(this.wiring.bridge(this.issuer), this.wiring.resolver))
      }
      this.engines.set(key, engine)
    }
    return engine
  }

  /** `work` after every run before it: the runtimes are workers, and two runs on one would interleave. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => undefined)
    return run
  }
}

/** The fail-closed refusal: one wording however the program broke, logged with its stderr. */
function failed(entry: ProfileScript, detail: string, stderr = ''): Deny {
  const reason = `profile '${entry.profile}' policy ${detail}`
  console.error(stderr === '' ? reason : `${reason}\n${stderr}`)
  return { kind: 'deny', reason }
}

/**
 * An error's message as the clause after "policy": the runtime builder
 * and the answer reader both speak of "script", which is the program's
 * generic name, and the profile's word for its program is policy.
 */
function clause(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^script /, '')
}
