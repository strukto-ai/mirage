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

import type { BridgeDispatchFn } from './python/mirage_bridge.ts'
import { ScriptSource, type RouteScript } from './route/types.ts'

/** One interpreter execution request, language-agnostic. */
export interface RunArgs {
  code: string
  args: string[]
  env: Record<string, string>
  stdin: Uint8Array | null
  /**
   * Interpreter-level switches parsed by the command's spec (e.g. js
   * module mode). Each runtime reads its own switches and ignores the
   * rest.
   */
  flags?: Record<string, unknown>
}

/** Outcome of one interpreter execution. */
export interface RunResult {
  stdout: Uint8Array
  /** Captured standard error, null when empty (mirrors Python). */
  stderr: Uint8Array | null
  exitCode: number
}

/**
 * The value contract of eval: never richer than JSON plus bytes, so
 * any evaluator (in-process or remote over a serialized transport)
 * can carry it, in either direction (inputs in, verdict out).
 */
export type EvalValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | EvalValue[]
  | { [key: string]: EvalValue }

/**
 * "incomplete" is console semantics: the source needs a continuation
 * line (session mode only). "exit" is an explicit exit() call.
 */
export type EvalStatus = 'complete' | 'incomplete' | 'exit'

/**
 * Outcome of one evaluation (mirrors Python's EvalResult).
 *
 * One-shot mode rejects with EvalError on any failure, so a returned
 * result is always a success. Session (console) mode is a transcript:
 * a failing snippet comes back as a result too (its traceback on
 * stderr, a nonzero exitCode), because a console reports errors and
 * keeps going.
 */
export interface EvalResult {
  /**
   * The program's last expression. In-process evaluators return it
   * directly; remote ones return what the transport could carry.
   * Session (console) mode may report null when the evaluator only
   * streams output.
   */
  value: EvalValue
  /** Output the program printed while running. */
  stdout: Uint8Array
  /** Captured standard error, null when empty. */
  stderr: Uint8Array | null
  /** 0 outside session mode; a console snippet's exit. */
  exitCode: number
  /** Console verdict; always "complete" outside session mode. */
  status: EvalStatus
}

/**
 * An evaluation that could not produce a value. The message carries
 * the evaluator's own diagnostics (a traceback, a transport failure,
 * a non-serializable result); `syntax` is true when the program
 * failed to parse, so callers can distinguish "bad script" from
 * "script raised".
 */
export class EvalError extends Error {
  readonly syntax: boolean

  constructor(message: string, options: { syntax?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {})
    this.name = 'EvalError'
    this.syntax = options.syntax ?? false
  }
}

/**
 * The evaluator capability: named inputs in, a value out (Python's
 * EvaluatorMixin). A Runtime that also implements this can evaluate
 * expressions, which is what the routing policy engine and the repl
 * consume; process-only runtimes never implement it and are never
 * asked to evaluate. The contract promises the shape, not value
 * fidelity: inputs and the returned value stay within EvalValue so
 * any transport can carry them, and errors surface as the
 * evaluator's own diagnostics wrapped in EvalError.
 */
export interface Evaluator {
  /**
   * Evaluate one program and return its last expression. `inputs`
   * bind as globals in the evaluator's own idiom; a `session` id
   * keeps state alive per id (console semantics), absent evaluates
   * one-shot.
   */
  eval(
    code: string,
    opts?: { inputs?: Record<string, EvalValue>; session?: string },
  ): Promise<EvalResult>
}

/** Whether this runtime carries the evaluator capability. */
export function isEvaluator(runtime: Runtime): runtime is Runtime & Evaluator {
  return typeof (runtime as Partial<Evaluator>).eval === 'function'
}

/** Constructor options every runtime accepts (a yaml entry's keys). */
export interface RuntimeOptions<C extends object = Record<string, unknown>> {
  /**
   * Commands this runtime claims, overriding the class default; ["*"]
   * claims every line for a runsLines runtime.
   */
  captures?: readonly string[]
  /**
   * The runtime's implementation knobs (a yaml entry's `config`
   * block), coerced against the runtime's own key list so a field the
   * runtime does not have fails loud.
   */
  config?: C
  /**
   * Per-line admission script for the routing ladder, answering "do I
   * want this line": a function taking a RouteContext, or a
   * config-borne ScriptSource. Absent = always willing. Policy, not
   * capability: it can only refuse lines the captures already allow.
   */
  script?: RouteScript
}

/**
 * A constructor's config option as the runtime's own config, mirroring
 * Python's RuntimeConfig.coerce: keys outside the runtime's list fail
 * loud (Python gets this from the dataclass raising TypeError; a TS
 * object spread would silently swallow a typo key without it).
 */
function coerceRuntimeConfig<C extends object>(
  value: C | undefined,
  keys: readonly string[],
  label = 'runtime',
): C {
  const config = value ?? ({} as C)
  for (const key of Object.keys(config)) {
    if (!keys.includes(key)) {
      const known =
        keys.length > 0 ? `expected: ${keys.map((k) => `'${k}'`).join(', ')}` : 'none allowed'
      throw new Error(`unknown ${label} config key '${key}' (${known})`)
    }
  }
  return { ...config }
}

/**
 * An interpreter a workspace command can execute code on.
 *
 * A runtime is to its commands what the regex engine is to grep: the
 * machinery inside a handler, invisible to the dispatcher. Each runtime
 * declares the command names it captures; a command binds to the first
 * runtime in the workspace's ordered list that captures it.
 * Implementations own their interpreter lifecycle (lazy boot, reuse
 * across runs, teardown in close). Every runtime is constructed the
 * same way (captures, config, script); each subclass hands the base
 * its class-default captures and its config key list, so a config
 * field the runtime does not have fails loud (config_cls in Python).
 */
export abstract class Runtime {
  abstract readonly name: string
  readonly captures: readonly string[]
  /**
   * A runtime that runs whole lines sets this true and overrides
   * runLine. Interpreter runtimes leave it false: they are the engine
   * inside one command (python3, node), never the line.
   */
  readonly runsLines: boolean = false
  /** The runtime's coerced implementation knobs. */
  config: object
  script?: RouteScript

  constructor(
    options: RuntimeOptions<object> = {},
    defaultCaptures: readonly string[] = [],
    configKeys: readonly string[] = [],
  ) {
    if (typeof options.script === 'string') throw scriptStringError()
    this.captures =
      options.captures !== undefined ? options.captures.slice() : defaultCaptures.slice()
    this.config = coerceRuntimeConfig(options.config, configKeys)
    if (typeof options.script === 'function' || options.script instanceof ScriptSource) {
      this.script = options.script
    }
  }

  /**
   * Late-wire workspace I/O into a user-constructed instance. The
   * workspace attaches its dispatch bridge at construction; runtimes
   * that never touch workspace files keep the default no-op.
   */
  attach(_dispatch: BridgeDispatchFn, _listMounts: () => string[]): void {
    // runtimes that never touch workspace files keep the no-op
  }

  abstract run(args: RunArgs): Promise<RunResult>

  /**
   * Execute one raw command line wholesale. Only runtimes with
   * runsLines override this: the runtime owns the entire line
   * (pipes, redirects, its own cat), the workspace shell never
   * splits it. A line lands here when this runtime captures one of
   * the line's commands or "*".
   */
  runLine(
    _line: string,
    _stdin: Uint8Array | null,
    _env: Record<string, string>,
    _cwd: string,
  ): Promise<RunResult> {
    return Promise.reject(new Error(`runtime '${this.name}' runs single commands, not whole lines`))
  }

  /** Release interpreter resources. Default: nothing held. */
  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** A workspace runtimes-list entry: an instance or a name shorthand. */
export type RuntimeEntry = Runtime | string

/** The code API takes functions; script source belongs to config. */
export function scriptStringError(kind = 'a script'): Error {
  return new Error(
    `${kind} in code must be a function taking the RouteContext; config ` +
      `scripts reference a .py file (script:/route: in the workspace yaml)`,
  )
}

/**
 * The workspace's built-in command engine as a runtime.
 *
 * By default it captures nothing and serves every command no other
 * runtime captures (cat, ls, echo, and anything unknown): it is the
 * catch-all. Passing explicit captures flips it into an ordinary
 * capturer: the workspace serves exactly those commands and anything
 * unclaimed exits 126. Required: every workspace world contains
 * exactly one, appended automatically when the runtimes list omits it;
 * pass your own instance to customize it. Its runLine is the workspace
 * executor itself, wired in at construction; run() stays unimplemented
 * because vfs has no single-command interpreter.
 *
 * Constructed like every runtime (captures, config, script), with two
 * vfs readings: captures undefined (the default) keeps the catch-all
 * behavior, an empty array serves nothing (full lockdown); and the
 * config has no fields today, the slot exists for uniformity.
 */
export class VfsRuntime extends Runtime {
  readonly name = 'vfs'
  // Declaring captures (even empty) turns the catch-all off; the
  // dispatcher reads this bit, not the array's length.
  readonly restricted: boolean
  override readonly runsLines = true
  private executeLine:
    | ((
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ) => Promise<RunResult>)
    | null = null

  constructor(options: RuntimeOptions = {}) {
    super(options, [], [])
    this.restricted = options.captures !== undefined
  }

  override attach(): void {
    // the workspace executor serves vfs commands; nothing to wire
  }

  run(): Promise<never> {
    return Promise.reject(
      new Error(
        'the vfs runtime runs whole lines through the workspace executor; ' +
          'it has no single-command interpreter',
      ),
    )
  }

  /** Wire the workspace executor in as this runtime's runLine. */
  bindLineExecutor(
    execute: (
      line: string,
      stdin: Uint8Array | null,
      env: Record<string, string>,
      cwd: string,
    ) => Promise<RunResult>,
  ): void {
    this.executeLine = execute
  }

  override runLine(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult> {
    if (this.executeLine === null) {
      return Promise.reject(new Error('the vfs runtime is not attached to a workspace'))
    }
    return this.executeLine(line, stdin, env, cwd)
  }
}

/**
 * The default world when no runtimes list is given: today's behavior
 * exactly. Pyodide stays the TypeScript python default until
 * `@pydantic/monty` can answer builtin `open()` calls; `local`/`wasi`
 * are Python-only.
 */
export const DEFAULT_ENTRIES: readonly string[] = ['pyodide', 'quickjs', 'vfs']

/** Python-only runtime names a cross-language config may carry. */
export const PYTHON_ONLY_HINTS: Record<string, string> = {
  wasi:
    "runtime 'wasi' is Python-only (a CPython WASI build); TypeScript " +
    "supports 'pyodide' (WASM CPython, default), 'monty' (sandboxed), " +
    "and 'quickjs' (sandboxed JavaScript)",
  local:
    "runtime 'local' is Python-only (the host CPython); TypeScript " +
    "supports 'pyodide' (WASM CPython, default), 'monty' (sandboxed), " +
    "and 'quickjs' (sandboxed JavaScript)",
}

/**
 * Resolve an explicit runtime name into a binding override map.
 *
 * Naming a runtime places a line's captured stages on it without
 * touching capability: only commands the runtime captures rebind,
 * everything else keeps its normal binding.
 */
export function runtimeBindingsFor(
  entries: readonly Runtime[],
  name: string,
): Record<string, Runtime> {
  if (name === 'vfs') {
    throw new Error(`'vfs' is the default executor, not a runtime you can select`)
  }
  for (const entry of entries) {
    if (entry.name === name) {
      const bindings: Record<string, Runtime> = {}
      for (const command of entry.captures) bindings[command] = entry
      return bindings
    }
  }
  const known = entries.map((e) => `'${e.name}'`).join(', ')
  throw new Error(`unknown runtime: '${name}' (workspace runtimes: ${known})`)
}

/**
 * Resolve the ordered world into a command -> runtime binding map.
 *
 * A command binds to the FIRST entry that captures it; a default vfs
 * runtime captures nothing, so only a vfs with declared captures
 * appears in the map. Duplicate names are rejected: a second entry
 * under the same name could never bind anything and always signals a
 * config mistake.
 */
export function bindCommands(entries: readonly Runtime[]): Record<string, Runtime> {
  const bindings: Record<string, Runtime> = {}
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(`duplicate runtime entry: '${entry.name}'`)
    }
    seen.add(entry.name)
    for (const command of entry.captures) {
      if (!(command in bindings)) bindings[command] = entry
    }
  }
  return bindings
}

/**
 * The runtime that runs this entire line, if any.
 *
 * A runtime with runsLines takes the raw line when it captures one of
 * the line's commands; a "*" capture claims any line. A specific
 * capture beats "*". The vfs runtime never matches here: the
 * workspace executor IS its runLine, the path the line takes anyway
 * when nothing else claims it.
 */
export function wholeLineRuntime(
  bindings: Record<string, Runtime | null>,
  commands: readonly string[],
): Runtime | null {
  for (const command of commands) {
    const runtime = Object.hasOwn(bindings, command) ? bindings[command] : null
    if (runtime?.runsLines === true) {
      if (!(runtime instanceof VfsRuntime)) return runtime
    }
  }
  const star = Object.hasOwn(bindings, '*') ? bindings['*'] : null
  if (star?.runsLines === true) {
    if (!(star instanceof VfsRuntime)) return star
  }
  return null
}

/**
 * The runtime that serves commands no entry captures, if any.
 *
 * That is the world's VfsRuntime, unless it declares captures (then it
 * is an ordinary capturer and nothing is catch-all) or it is not among
 * the given entries (refused the line / omitted).
 */
export function catchAll(entries: readonly Runtime[]): Runtime | null {
  for (const entry of entries) {
    if (entry instanceof VfsRuntime && !entry.restricted) return entry
  }
  return null
}
