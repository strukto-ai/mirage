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

import { CommandTimeoutError } from '../commands/errors.ts'
import type { Runtime } from '../runtime/base.ts'
import { EvalError } from '../runtime/errors.ts'
import { LanguageRuntime } from '../runtime/language.ts'
import type { Evaluator } from '../runtime/mixin.ts'
import type { MountResolver } from '../runtime/resolver.ts'
import type { ScriptSource } from '../runtime/routing/types.ts'
import { evalWithCtx, scriptEngine } from '../runtime/script.ts'
import type { BridgeDispatchFn, EvalValue } from '../runtime/types.ts'
import type { Policy } from './base.ts'
import {
  DEFAULT_ASK_REASON,
  DEFAULT_DENY_REASON,
  SCRIPT_EVAL_TIMEOUT_SECONDS,
} from './constants.ts'
import { SESSION_SCOPED, type SessionScoped } from './mixin.ts'
import {
  VALIDITY,
  type Action,
  type Ask,
  type CommandContext,
  type Deny,
  type OpsContext,
  type PolicyHook,
  type ProfileScript,
  type SessionContext,
  type SessionScriptsQuery,
} from './types.ts'

/** The admission hooks a policy program may define, as the Policy interface spells them. */
export type ScriptHook = 'preCommand' | 'preOps' | 'preSession'

/**
 * The admission hooks a policy program may define, JavaScript spelling
 * to python spelling. The output doors (postOps, postExecute) stay
 * coded: they answer with a Limit over a live result.
 */
export const HOOKS: Readonly<Record<ScriptHook, string>> = {
  preCommand: 'pre_command',
  preOps: 'pre_ops',
  preSession: 'pre_session',
}

const SCRIPT_HOOKS = Object.keys(HOOKS) as readonly ScriptHook[]

/**
 * What a profile's script is told about one command: the
 * `CommandContext` the coded hooks read, as plain data.
 *
 * The same facts on both hosts, JSON-shaped because the script runs
 * inside a sandboxed engine that a live object cannot cross into.
 * Paths are spelled as resolved virtual paths, so a script matches what
 * the command will actually touch, not what was typed; the raw words
 * are in `argv` for a script that wants them.
 */
export function scriptContext(
  profile: string,
  ctx: CommandContext,
  mounts: readonly string[],
): Record<string, EvalValue> {
  return {
    profile,
    command: {
      name: ctx.command,
      argv: [...ctx.argv],
      tokens: [...(ctx.tokens ?? [])],
      program: [...(ctx.program ?? [])],
      paths: ctx.paths.map((path) => path.virtual),
      operands: (ctx.operands ?? []).map((path) => path.virtual),
      tool: ctx.tool ?? true,
      walks: ctx.walks ?? false,
    },
    session: {
      id: ctx.sessionId ?? '',
      agent: ctx.agentId ?? '',
      cwd: ctx.cwd,
    },
    mounts: [...mounts],
  }
}

/**
 * What a profile's script is told about one VFS op: the `OpsContext`
 * the coded hooks read, as plain data.
 */
export function opsScriptContext(
  profile: string,
  ctx: OpsContext,
  mounts: readonly string[],
): Record<string, EvalValue> {
  return {
    profile,
    op: { name: ctx.op, path: ctx.path.virtual, write: ctx.write, prefix: ctx.prefix },
    session: { id: ctx.sessionId ?? '' },
    mounts: [...mounts],
  }
}

/**
 * What a profile's script is told about one session-state write: the
 * `SessionContext` the coded hooks read, as plain data.
 */
export function sessionScriptContext(
  profile: string,
  ctx: SessionContext,
  mounts: readonly string[],
): Record<string, EvalValue> {
  return {
    profile,
    write: { plane: ctx.plane, verb: ctx.verb, key: ctx.key, value: ctx.value },
    session: { id: ctx.sessionId },
    mounts: [...mounts],
  }
}

/**
 * The policy answer a policy's hook returns.
 *
 * The vocabulary is the coded hook's own, spelled as data: null or
 * `'allow'` is no opinion (the command runs unless another rule refuses
 * it, and can never override one that does), `'deny'` / `{deny: reason}`
 * refuses, and at `preCommand` alone `'ask'` / `{ask: reason}` takes the
 * line to the approval door, since the op and session doors cannot wait
 * on a host (`VALIDITY`). The bare strings carry the document's default
 * reasons, the same ones a rule stating no reason gets.
 *
 * Throws a plain Error whose message is a clause about "script", for
 * the caller to prefix with whose policy it is.
 */
export function scriptAction(value: EvalValue, hook: ScriptHook = 'preCommand'): Deny | Ask | null {
  const asks = VALIDITY[hook].has('ask')
  if (value === null || value === 'allow') return null
  if (value === 'deny') return { kind: 'deny', reason: DEFAULT_DENY_REASON }
  if (asks && value === 'ask') return { kind: 'ask', reason: DEFAULT_ASK_REASON }
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    const entries = Object.entries(value)
    if (entries.length === 1) {
      const first = entries[0]
      if (first !== undefined) {
        const [verb, reason] = first
        if (typeof reason === 'string' && reason !== '') {
          if (verb === 'deny') return { kind: 'deny', reason }
          if (asks && verb === 'ask') return { kind: 'ask', reason }
        }
      }
    }
  }
  if (asks) {
    throw new Error(
      `script must answer allow, deny or ask: null or 'allow', 'deny', 'ask', ` +
        `{deny: reason} or {ask: reason}; got ${JSON.stringify(value)}`,
    )
  }
  throw new Error(
    `script must answer allow or deny: null or 'allow', 'deny' or {deny: reason}; ` +
      `got ${JSON.stringify(value)}`,
  )
}

/**
 * The workspace's file doors, for the engine a profile policy runs on.
 *
 * A policy judges a line before it runs, and some judgments are about
 * what a file holds rather than what it is called. The engine is
 * attached with these exactly as `Runtimes` attaches an agent's, so
 * the policy's `open()` reads the mounts through the same door an
 * agent's program would, and a read from a policy clears the op door
 * like any other. The bridge is built for one `issuer`, the policy's
 * own token: every op it dispatches carries the token to the op door
 * (`OpsContext.issuer`), which is how the policy's `preOps` tells its
 * own read from anyone else's. The workspace supplies them; a bare
 * ScriptPolicy (outside a workspace) has none, and its programs see no
 * file.
 */
export interface ScriptWiring {
  bridge: (issuer: symbol) => BridgeDispatchFn
  resolver: MountResolver
}

/** A hook's name in the program's own language: `preOps` in JavaScript, `pre_ops` in python. */
export function hookName(script: ScriptSource, hook: ScriptHook): string {
  return script.language === 'js' ? hook : HOOKS[hook]
}

/**
 * The call that runs one of a policy's hooks, in its language's own
 * spelling.
 *
 * A policy program defines the hooks it answers at, the way a coded
 * Policy defines only the hooks it cares about: `pre_command(ctx)` in
 * python, `preCommand(ctx)` in JavaScript, returning the verdict. The
 * program is evaluated whole, with this call appended as its last
 * expression, so the definitions run and the call's return is what the
 * evaluator hands back.
 */
export function hookCall(script: ScriptSource, hook: ScriptHook): string {
  return `${hookName(script, hook)}(ctx)`
}

/**
 * The expression that lists which hooks a policy program defines.
 *
 * Appended to the program once, before its first judgment, so a hook
 * the program leaves out is silence at that door rather than a call
 * that fails, and the op door in particular is never charged an
 * evaluation for a program that only judges commands. Spelled per
 * language and in the engines' common subset: monty has neither
 * `globals()` nor `callable()`, so python asks each name and catches
 * the NameError; JavaScript asks `typeof`, behind a `;` that ends
 * whatever statement the program left open, since a bracket on the
 * next line would otherwise index its last value. A name the program
 * binds is a hook it defines, whatever it bound.
 */
export function hookProbe(script: ScriptSource): string {
  const names = SCRIPT_HOOKS.map((hook) => hookName(script, hook))
  if (script.language === 'js') {
    const pairs = names.map((name) => `['${name}', typeof ${name}]`).join(', ')
    return `;[${pairs}].filter((h) => h[1] !== 'undefined').map((h) => h[0])`
  }
  const arms = names
    .map(
      (name) =>
        `try:\n    ${name}\n    _mirage_hooks.append('${name}')\nexcept NameError:\n    pass\n`,
    )
    .join('')
  return `_mirage_hooks = []\n${arms}_mirage_hooks`
}

/**
 * The hooks `hookProbe` found, as the Policy interface spells them.
 * Throws a plain Error, a clause about "script", when the value is not
 * a list of the probe's names.
 */
export function definedHooks(script: ScriptSource, value: EvalValue): ReadonlySet<ScriptHook> {
  const spelled = new Map(SCRIPT_HOOKS.map((hook) => [hookName(script, hook), hook] as const))
  if (Array.isArray(value)) {
    const hooks = value.map((name) => (typeof name === 'string' ? spelled.get(name) : undefined))
    if (hooks.every((hook): hook is ScriptHook => hook !== undefined)) return new Set(hooks)
  }
  throw new Error(`script hook probe answered ${JSON.stringify(value)}`)
}

/**
 * Each profile's policy, enforced at the admission gates.
 *
 * The scripted twin of `PermissionsPolicy`, registered right after it:
 * where that policy evaluates the document's declarative rules, this
 * one calls the profile's policy program with the same facts. A program
 * defines the hooks it answers at, the way a coded Policy defines only
 * the hooks it cares about: `preCommand` per command (`scriptContext`),
 * `preOps` per VFS op (`opsScriptContext`), `preSession` per env write
 * (`sessionScriptContext`). Which ones it defines is probed once per
 * program (`hookProbe`), so a hook it leaves out is silence at that
 * door and costs no evaluation, and a program defining none fails
 * closed at every door. It reads the session's policy through the
 * narrow `SessionScriptsQuery` by the session id the door put in the
 * context, so a session whose profile states no policy costs one lookup
 * and nothing else.
 *
 * The facts name the paths; the engine can open them. It is wired to
 * the workspace's files the way an agent's runtime is (`ScriptWiring`),
 * so a policy may read what an operand holds and answer for its
 * content, not only its name. A read from a policy clears the op door
 * like any other, except this policy's own `preOps`: the policy is the
 * one asking, and judging its own read would re-enter the evaluation
 * waiting on it. It knows its own read by `issuer`, a token only its
 * bridge stamps and that rides each op as an argument: a mark kept in
 * ambient context would be whatever op another task dispatched while
 * a read was in flight on a runtime with no task isolation.
 *
 * Every failure fails closed: a policy that threw, timed out, answered
 * with the wrong shape, defines no hook, or names an engine that cannot
 * be built refuses the command, op or write with a reason naming the
 * profile. Silence on failure would run exactly what the policy existed
 * to judge.
 *
 * Engines are built lazily on the first judgment that needs one, shared
 * per engine name, and closed by the workspace's own close.
 * Evaluations are serialized: the engines are workers, and two
 * concurrent evals on one would interleave.
 */
export class ScriptPolicy implements Policy, SessionScoped {
  readonly [SESSION_SCOPED] = true as const
  private readonly sessions: SessionScriptsQuery
  private readonly mounts: () => readonly string[]
  private readonly wiring: ScriptWiring | null
  private readonly engines = new Map<string, Runtime & Evaluator>()
  private readonly defined = new Map<string, ReadonlySet<ScriptHook>>()
  // The mark on every op this policy's own engines dispatch, and
  // nothing else's: unexported, so only the bridge built for it can
  // stamp it.
  private readonly issuer = Symbol('policy read')
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    sessions: SessionScriptsQuery,
    mounts: () => readonly string[],
    wiring: ScriptWiring | null = null,
  ) {
    this.sessions = sessions
    this.mounts = mounts
    this.wiring = wiring
  }

  async preCommand(ctx: CommandContext): Promise<Action | null> {
    return this.judge('preCommand', ctx.sessionId ?? '', (entry) =>
      scriptContext(entry.profile, ctx, this.mounts()),
    )
  }

  async preOps(ctx: OpsContext): Promise<Action | null> {
    if (ctx.issuer === this.issuer) return null
    return this.judge('preOps', ctx.sessionId ?? '', (entry) =>
      opsScriptContext(entry.profile, ctx, this.mounts()),
    )
  }

  async preSession(ctx: SessionContext): Promise<Action | null> {
    return this.judge('preSession', ctx.sessionId, (entry) =>
      sessionScriptContext(entry.profile, ctx, this.mounts()),
    )
  }

  /**
   * Whether this session's policy speaks at `hook`: it has a program,
   * and the program defines the hook, or defines none and so refuses at
   * every door. A probe that fails answers true for the same reason:
   * the door will refuse.
   */
  async wantsFor(hook: PolicyHook, sessionId: string): Promise<boolean> {
    const entry = this.sessions.scriptOf(sessionId)
    if (entry === null || !(hook in HOOKS)) return false
    let defined: ReadonlySet<ScriptHook>
    try {
      defined = await this.hooksOf(entry)
    } catch {
      // The door reports the failure itself, as a refusal naming the
      // profile; here the answer is only that it will speak.
      return true
    }
    return defined.size === 0 || defined.has(hook as ScriptHook)
  }

  /** Close every engine a script was evaluated on. */
  async close(): Promise<void> {
    const engines = [...this.engines.values()]
    this.engines.clear()
    for (const engine of engines) await engine.close()
  }

  /** One hook of the session's policy, with the door's facts as `ctx`. */
  private async judge(
    hook: ScriptHook,
    sessionId: string,
    facts: (entry: ProfileScript) => Record<string, EvalValue>,
  ): Promise<Action | null> {
    const entry = this.sessions.scriptOf(sessionId)
    if (entry === null) return null
    let value: EvalValue
    try {
      const defined = await this.hooksOf(entry)
      if (defined.size === 0) {
        const names = SCRIPT_HOOKS.map((name) => hookName(entry.script, name))
        return failed(
          entry,
          `defines no hook: ${names.slice(0, -1).join(', ')} or ${names[names.length - 1] ?? ''}`,
        )
      }
      if (!defined.has(hook)) return null
      value = await this.evaluate(entry, hookCall(entry.script, hook), facts(entry))
    } catch (err) {
      if (err instanceof CommandTimeoutError) {
        return failed(entry, `timed out after ${String(SCRIPT_EVAL_TIMEOUT_SECONDS)}s`)
      }
      if (err instanceof EvalError) {
        return failed(entry, `${err.syntax ? 'syntax error' : 'failed'}: ${err.message}`)
      }
      // scriptEngine's refusal (the engine cannot be built) or the
      // probe's (the program answered it with something else) is a
      // clause about "script"; the profile's word for it is policy.
      return failed(entry, clause(err))
    }
    try {
      return scriptAction(value, hook)
    } catch (err) {
      return failed(entry, clause(err))
    }
  }

  /**
   * The hooks one profile's program defines, probed on its first
   * judgment and remembered by runtime, program text and language.
   * A runtime change must probe again, including its validation;
   * a cached absent hook must never bypass a broken new engine.
   */
  private async hooksOf(entry: ProfileScript): Promise<ReadonlySet<ScriptHook>> {
    const key = JSON.stringify([entry.runtime, entry.script.language, entry.script.source])
    let defined = this.defined.get(key)
    if (defined === undefined) {
      defined = definedHooks(entry.script, await this.evaluate(entry, hookProbe(entry.script), {}))
      this.defined.set(key, defined)
    }
    return defined
  }

  /** The program whole, then `tail` as its last expression, on the profile's engine, serialized. */
  private async evaluate(
    entry: ProfileScript,
    tail: string,
    ctx: Record<string, EvalValue>,
  ): Promise<EvalValue> {
    const run = this.queue.then(async () => {
      let engine = this.engines.get(entry.runtime)
      if (engine === undefined) {
        engine = scriptEngine(entry.script, entry.runtime)
        // Attached before the first eval, as `Runtimes` attaches an
        // agent's engine: the script's `open()` then reads the mounts
        // through the same door, and an unattached engine sees no file.
        // The bridge is built for this policy's token, so every op the
        // engine dispatches reaches `preOps` above as the policy's own.
        if (this.wiring !== null && engine instanceof LanguageRuntime) {
          engine.attach(this.wiring.bridge(this.issuer), this.wiring.resolver)
        }
        this.engines.set(entry.runtime, engine)
      }
      return evalWithCtx(
        `${entry.script.source}\n\n${tail}\n`,
        ctx,
        engine,
        SCRIPT_EVAL_TIMEOUT_SECONDS,
        `profile '${entry.profile}' policy`,
      )
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}

/** The fail-closed refusal: one wording however the policy broke. */
function failed(entry: ProfileScript, detail: string): Deny {
  return { kind: 'deny', reason: `profile '${entry.profile}' policy ${detail}` }
}

/**
 * An error's message as the clause after "policy": the engine door and
 * the answer reader both speak of "script", which is the program's
 * generic name, and the profile's word for its program is policy.
 */
function clause(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^script /, '')
}
