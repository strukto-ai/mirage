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
 * An interpreter a workspace command can execute code on.
 *
 * A runtime is to its commands what the regex engine is to grep: the
 * machinery inside a handler, invisible to the dispatcher. Each runtime
 * declares the command names it captures; a command binds to the first
 * runtime in the workspace's ordered list that captures it.
 */
export interface Runtime {
  readonly name: string
  readonly captures: readonly string[]
  /**
   * Per-line admission script for the routing ladder, answering "do I
   * want this line": a function taking a RouteContext, or a
   * config-borne ScriptSource. Absent = always willing. Policy, not
   * capability: it can only refuse lines the captures already allow.
   */
  script?: RouteScript
  /**
   * A runtime that runs whole lines sets this true and implements
   * runLine. Interpreter runtimes leave it unset: they are the engine
   * inside one command (python3, node), never the line.
   */
  readonly runsLines?: boolean
  /**
   * Late-wire workspace I/O into a user-constructed instance. The
   * workspace attaches its dispatch bridge at construction; runtimes
   * that never touch workspace files keep this a no-op.
   */
  attach(dispatch: BridgeDispatchFn, listMounts: () => string[]): void
  run(args: RunArgs): Promise<RunResult>
  /**
   * Execute one raw command line wholesale. Only runtimes with
   * runsLines implement this: the runtime owns the entire line
   * (pipes, redirects, its own cat), the workspace shell never
   * splits it. A line lands here when this runtime captures one of
   * the line's commands or "*".
   */
  runLine?(
    line: string,
    stdin: Uint8Array | null,
    env: Record<string, string>,
    cwd: string,
  ): Promise<RunResult>
  close(): Promise<void>
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
 */
export class VfsRuntime implements Runtime {
  readonly name = 'vfs'
  readonly captures: readonly string[] = []
  // Declaring captures (even empty) turns the catch-all off; the
  // dispatcher reads this bit, not the array's length.
  readonly restricted: boolean = false
  readonly runsLines = true
  script?: RouteScript
  private executeLine:
    | ((
        line: string,
        stdin: Uint8Array | null,
        env: Record<string, string>,
        cwd: string,
      ) => Promise<RunResult>)
    | null = null

  // The record form exists for the shared buildRuntime path, which
  // hands every runtime its options object ({script?, captures?}).
  constructor(options?: RouteScript | Record<string, unknown>) {
    if (typeof options === 'function' || options instanceof ScriptSource) {
      this.script = options
      return
    }
    if (options === undefined) return
    if (typeof options === 'string') throw scriptStringError()
    const script = options.script
    if (typeof script === 'string') throw scriptStringError()
    if (typeof script === 'function' || script instanceof ScriptSource) {
      this.script = script as RouteScript
    }
    if (Array.isArray(options.captures)) {
      this.captures = (options.captures as string[]).slice()
      this.restricted = true
    }
  }

  attach(): void {
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

  runLine(
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

  close(): Promise<void> {
    return Promise.resolve()
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
