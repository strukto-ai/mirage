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
import type { RouteScript } from './route/index.ts'

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
   * Per-line admission script for the routing ladder: a callable
   * taking a RouteContext (or monty source whose last expression is
   * the verdict) answering "do I want this line". Absent = always
   * willing. Policy, not capability: it can only refuse lines the
   * captures already allow.
   */
  script?: RouteScript
  /**
   * Late-wire workspace I/O into a user-constructed instance. The
   * workspace attaches its dispatch bridge at construction; runtimes
   * that never touch workspace files keep this a no-op.
   */
  attach(dispatch: BridgeDispatchFn, listMounts: () => string[]): void
  run(args: RunArgs): Promise<RunResult>
  close(): Promise<void>
}

/** A workspace runtimes-list entry: an instance or a name shorthand. */
export type RuntimeEntry = Runtime | string

export const VFS_ENTRY = 'vfs'

/**
 * The vfs executor as an ordinary, scriptable entry.
 *
 * The plain "vfs" string is the unconditional form; this class exists
 * so the vfs rung can carry a route script like any other entry (e.g.
 * refuse oversized lines). It captures nothing and never runs: the
 * workspace executor itself serves the commands it admits.
 */
export class VfsEntry implements Runtime {
  readonly name = VFS_ENTRY
  readonly captures: readonly string[] = []
  script?: RouteScript

  constructor(script?: RouteScript) {
    if (script !== undefined) this.script = script
  }

  attach(): void {
    // the workspace executor serves vfs commands; nothing to wire
  }

  run(): Promise<never> {
    return Promise.reject(
      new Error('the vfs entry is an ordering marker; the workspace executor runs its commands'),
    )
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
export const DEFAULT_ENTRIES: readonly string[] = ['pyodide', 'quickjs', VFS_ENTRY]

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
 * Resolve a per-line pin name into a binding override map.
 *
 * A pin places a line's captured stages on the named runtime without
 * touching capability: only commands the runtime captures rebind,
 * everything else keeps its normal binding.
 */
export function pinBindings(
  entries: readonly RuntimeEntry[],
  name: string,
): Record<string, Runtime> {
  if (name === VFS_ENTRY) {
    throw new Error(`'${VFS_ENTRY}' is the default executor, not a pinnable runtime`)
  }
  for (const entry of entries) {
    if (typeof entry !== 'string' && entry.name === name) {
      const bindings: Record<string, Runtime> = {}
      for (const command of entry.captures) bindings[command] = entry
      return bindings
    }
  }
  const known = entries.map((e) => `'${typeof e === 'string' ? e : e.name}'`).join(', ')
  throw new Error(`unknown runtime pin: '${name}' (workspace runtimes: ${known})`)
}

/**
 * Resolve the ordered world into a command -> runtime binding map.
 *
 * A command binds to the FIRST entry that captures it; the vfs entry is
 * an ordering marker with no interpreter captures. Duplicate names are
 * rejected: a second entry under the same name could never bind
 * anything and always signals a config mistake.
 */
export function bindCommands(entries: readonly RuntimeEntry[]): Record<string, Runtime> {
  const bindings: Record<string, Runtime> = {}
  const seen = new Set<string>()
  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name
    if (seen.has(entryName)) {
      throw new Error(`duplicate runtime entry: '${entryName}'`)
    }
    seen.add(entryName)
    if (typeof entry === 'string') continue
    for (const command of entry.captures) {
      if (!(command in bindings)) bindings[command] = entry
    }
  }
  return bindings
}
