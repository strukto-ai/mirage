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

import { Runtime } from './base.ts'
import { isLineExecutor, type LineExecutor } from './mixin.ts'
import { QuickJsRuntime } from './js/quickjs.ts'
import { MontyRuntime } from './python/monty/index.ts'
import { PyodideRuntime } from './python/pyodide.ts'
import type { RuntimeOptions } from './types.ts'
import { compareCodePoints } from '../utils/sort.ts'

/**
 * The workspace's built-in command engine as a routing marker.
 *
 * By default it captures nothing and serves every command no other
 * runtime captures (cat, ls, echo, and anything unknown): it is the
 * catch-all. Passing explicit captures flips it into an ordinary
 * capturer: the workspace serves exactly those commands and anything
 * unclaimed exits 126. Required: every workspace world contains
 * exactly one, appended automatically when the runtimes list omits it;
 * pass your own instance to customize it.
 *
 * It is a pure routing marker, so it carries no capability mixin: a
 * line resolved to vfs runs on the workspace executor inline, the path
 * the line takes anyway, so there is no interpreter door (run) and no
 * delegate door (runLine) to implement.
 *
 * Constructed like every runtime (captures, config, script), with two
 * vfs readings: captures undefined (the default) keeps the catch-all
 * behavior, an empty array serves nothing (full lockdown); and the
 * config has no fields today, the slot exists for uniformity.
 */
export class VFSRuntime extends Runtime {
  readonly name = 'vfs'
  // A vfs-routed line runs on the workspace executor itself: it IS the
  // gate, so there is no door around it.
  override readonly reach = 'vfs'
  // Declaring captures (even empty) turns the catch-all off; the
  // dispatcher reads this bit, not the array's length.
  readonly restricted: boolean

  constructor(options: RuntimeOptions = {}) {
    super(options, [], [])
    this.restricted = options.captures !== undefined
  }
}

// One source of truth, preference order. The command -> runtime mapping
// is derived from each class's captures, never hand-maintained.
export const RUNTIMES = [PyodideRuntime, MontyRuntime, QuickJsRuntime] as const

// Null prototype: runtime names come from config, and a name like
// `constructor` must miss instead of resolving an `Object.prototype`
// member as a runtime class.
const NAMED: Record<string, new (options?: RuntimeOptions<never>) => Runtime> = Object.assign(
  Object.create(null) as Record<string, new (options?: RuntimeOptions<never>) => Runtime>,
  {
    pyodide: PyodideRuntime,
    monty: MontyRuntime,
    quickjs: QuickJsRuntime,
    vfs: VFSRuntime,
  },
)

/**
 * The python engine a default world registers, named rather than left
 * to a slot in DEFAULT_ENTRIES because it is the one entry the two
 * implementations disagree on: TypeScript registers pyodide, Python
 * registers monty (`DEFAULT_PYTHON` in `mirage/runtime/table.py`),
 * because `@pydantic/monty` cannot answer builtin `open()` calls yet
 * while `pydantic-monty` can. Both are sandboxed; neither reaches the
 * host. Pinned by integ/runtime/defaults.json, which reads the split
 * back out of a default world on each host.
 *
 * A name, not a class: `name` is an instance field, so `PyodideRuntime.name`
 * is the JS function name, not the registry key.
 */
export const DEFAULT_PYTHON = 'pyodide'

/**
 * The default world when no runtimes list is given: one python engine,
 * one js engine, and the builtin command engine. `local`/`wasi` are
 * Python-only.
 */
export const DEFAULT_ENTRIES: readonly string[] = [DEFAULT_PYTHON, 'quickjs', 'vfs']

/** Python-only runtime names a cross-language config may carry. */
const PYTHON_ONLY_HINTS: Record<string, string> = {
  wasi:
    "runtime 'wasi' is Python-only (a CPython WASI build); TypeScript " +
    "supports 'pyodide' (WASM CPython, default), 'monty' (sandboxed), " +
    "and 'quickjs' (sandboxed JavaScript)",
  local:
    "runtime 'local' (the host python3) lives in @struktoai/mirage-node; " +
    'import that package to register it. Browser worlds support ' +
    "'pyodide' (WASM CPython, default), 'monty' (sandboxed), and " +
    "'quickjs' (sandboxed JavaScript)",
  sandlock:
    "runtime 'sandlock' (the host python3 confined by Landlock and seccomp) " +
    "is Python-only and Linux-only; TypeScript supports 'smolvm' for a " +
    "hardware-isolated microVM, 'docker' for a container, 'pyodide' (WASM " +
    "CPython, default), 'monty' (sandboxed), and 'quickjs' (sandboxed " +
    'JavaScript)',
}

// Every runtime is constructed the same way; config keys are checked
// inside each class (its config key list), so the entry level only
// knows the uniform options. Python gets this check for free
// (`**options` raises TypeError on an unknown kwarg); a TS object
// literal would silently swallow a typo key without it.
const ENTRY_KEYS: readonly string[] = ['captures', 'config', 'script']

// The names core ships, frozen before any package or host registers its
// own, so `registerRuntime` can refuse to shadow one the way the resource
// and CLI registries refuse a builtin name.
const BUILTIN_RUNTIMES: ReadonlySet<string> = new Set(Object.keys(NAMED))

/**
 * Register a runtime class under a config name. Host-side only, like
 * `registerResourceFactory` and `registerCliSpec`: the embedding program
 * calls it, never a line the agent types. Once registered the name works
 * everywhere a builtin's does: a `runtimes:` entry in workspace config, a
 * string in `new Workspace(..., { runtimes })`, and `execute({ runtime })`.
 * Runtime packages use the same door for their own runtimes (`daytona`
 * from `@struktoai/mirage-node`). Mirrors `register_runtime` in
 * `mirage/runtime/table.py`: a core builtin cannot be shadowed, and
 * re-registering any other name replaces it.
 */
export function registerRuntime(
  name: string,
  cls: new (options?: RuntimeOptions<never>) => Runtime,
): void {
  if (BUILTIN_RUNTIMES.has(name)) throw new Error(`cannot register '${name}': shadows a builtin`)
  NAMED[name] = cls
}

/** Every name `buildRuntime` can resolve, builtin and registered. */
export function knownRuntimes(): string[] {
  return Object.keys(NAMED).sort(compareCodePoints)
}

/**
 * Refuse an entry key no runtime takes, naming the entry. Every runtime
 * is constructed the same way, so this is one check for a builtin, a
 * registered name and a `source:Class` reference alike: `buildRuntime`
 * runs it for the names it resolves, and the config loader runs it for
 * a reference, whose class it constructs itself.
 */
export function checkRuntimeOptions(name: string, options: Record<string, unknown>): void {
  for (const key of Object.keys(options)) {
    if (!ENTRY_KEYS.includes(key)) {
      const knownKeys = ENTRY_KEYS.map((k) => `'${k}'`).join(', ')
      throw new Error(`unknown ${name} runtime option '${key}' (expected: ${knownKeys})`)
    }
  }
}

/**
 * Construct a runtime by name, failing loud on unknown names (with a
 * cross-language hint for Python-only names) and on unknown options.
 */
export function buildRuntime(name: string, options: Record<string, unknown> = {}): Runtime {
  const cls = NAMED[name]
  if (cls === undefined) {
    const hint = PYTHON_ONLY_HINTS[name]
    if (hint !== undefined) throw new Error(hint)
    const known = Object.keys(NAMED)
      .map((n) => `'${n}'`)
      .join(', ')
    throw new Error(`unknown runtime: '${name}' (expected one of ${known})`)
  }
  checkRuntimeOptions(name, options)
  return new cls(options as RuntimeOptions<never>)
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
      // Null prototype: captures are arbitrary command names.
      const bindings: Record<string, Runtime> = Object.create(null) as Record<string, Runtime>
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
  // Null prototype: captures are arbitrary command names, so a capture
  // like `toString` must bind instead of reading as already-present.
  const bindings: Record<string, Runtime> = Object.create(null) as Record<string, Runtime>
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
 * A runtime carrying LineExecutor takes the raw line when it captures
 * one of the line's commands; a "*" capture claims any line. A
 * specific capture beats "*". The vfs runtime never matches here
 * because it carries no capability: the workspace executor IS the
 * path a vfs-resolved line takes anyway, so there is no delegate.
 */
export function wholeLineRuntime(
  bindings: Record<string, Runtime | null>,
  commands: readonly string[],
): (Runtime & LineExecutor) | null {
  for (const command of commands) {
    const runtime = Object.hasOwn(bindings, command) ? bindings[command] : null
    if (runtime != null && isLineExecutor(runtime)) return runtime
  }
  const star = Object.hasOwn(bindings, '*') ? bindings['*'] : null
  if (star != null && isLineExecutor(star)) return star
  return null
}

/**
 * The runtime that serves commands no entry captures, if any.
 *
 * That is the world's VFSRuntime, unless it declares captures (then it
 * is an ordinary capturer and nothing is catch-all) or it is not among
 * the given entries (refused the line / omitted).
 */
export function catchAll(entries: readonly Runtime[]): Runtime | null {
  for (const entry of entries) {
    if (entry instanceof VFSRuntime && !entry.restricted) return entry
  }
  return null
}
