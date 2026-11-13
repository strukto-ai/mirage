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

import { compareCodePoints } from '../utils/sort.ts'
import type { Runtime } from './base.ts'
import type { RuntimeOptions } from './config.ts'
import type { RouteDecision } from './types.ts'
import {
  EXTERNAL_COMMANDS,
  JS_GROUP,
  LANGUAGE_COMMANDS,
  PYTHON_GROUP,
  WHOLE_LINE,
} from './constants.ts'
import { QuickJsRuntime } from './js/quickjs/runtime.ts'
import { LanguageRuntime } from './language.ts'
import { isLineExecutor, isProcessExecutor, type LineExecutorMixin } from './mixin.ts'
import { RemoteRuntime } from './machine/runtime.ts'
import { MontyRuntime } from './python/monty/index.ts'
import { PyodideRuntime } from './python/pyodide/runtime.ts'
import { WorkspaceRuntime } from './workspace.ts'

// Null prototype: runtime names come from config, and a name like
// `constructor` must miss instead of resolving an `Object.prototype`
// member as a runtime class.
const NAMED: Record<
  string,
  (new (options?: RuntimeOptions<never>) => Runtime) & Pick<typeof Runtime, 'configFields'>
> = Object.assign(
  Object.create(null) as Record<
    string,
    (new (options?: RuntimeOptions<never>) => Runtime) & Pick<typeof Runtime, 'configFields'>
  >,
  {
    pyodide: PyodideRuntime,
    monty: MontyRuntime,
    quickjs: QuickJsRuntime,
    workspace: WorkspaceRuntime,
    remote: RemoteRuntime,
  },
)

/**
 * The default world when no runtimes list is given: the builtin command
 * engine alone, as Python's, so an interpreter runs only where the config
 * names one (integ/runtime/routing/defaults.json pins it).
 */
export const DEFAULT_ENTRIES: readonly string[] = ['workspace']

// The runtimes @struktoai/mirage-node registers when it is imported.
const NODE_RUNTIMES: readonly string[] = ['local', 'sandlock']

// The machine providers: names a runtimes entry may still carry from
// before machines had their own block.
const MACHINE_PROVIDERS: readonly string[] = [
  'apple_container',
  'daytona',
  'docker',
  'e2b',
  'kubernetes',
  'microsandbox',
  'smolvm',
  'ssh',
]

/** Why a name a config may carry is not registered here, and where it lives. */
const RUNTIME_HINTS: Record<string, string> = {
  ...Object.fromEntries(
    NODE_RUNTIMES.map((name) => [
      name,
      `runtime '${name}' lives in @struktoai/mirage-node; import that package to register ` +
        "it. Browser worlds support 'monty' (sandboxed), 'pyodide' (WASM CPython), and " +
        "'quickjs' (sandboxed JavaScript)",
    ]),
  ),
  wasi:
    "runtime 'wasi' is Python-only (a CPython WASI build); TypeScript " +
    "supports 'monty' (sandboxed), 'pyodide' (WASM CPython), " +
    "and 'quickjs' (sandboxed JavaScript)",
  sandlock:
    "runtime 'sandlock' lives in @struktoai/mirage-node; import that package " +
    'to register it. Sandlock requires Linux and `sandlock` on PATH.',
  ...Object.fromEntries(
    MACHINE_PROVIDERS.map((name) => [
      name,
      `'${name}' is a machine provider, not a runtime: declare the machine under ` +
        `machines: with provider: ${name}, and run its programs with the remote runtime`,
    ]),
  ),
}

// Every runtime is constructed the same way; config keys are checked
// inside each class (its config key list), so the entry level only
// knows the uniform options. Python gets this check for free
// (`**options` raises TypeError on an unknown kwarg); a TS object
// literal would silently swallow a typo key without it.
const ENTRY_KEYS: readonly string[] = ['captures', 'config']
// The one runtime that runs on a machine takes one more: its default.
const MACHINE_KEYS: readonly string[] = [...ENTRY_KEYS, 'machine']

// The names mirage ships: core's own, and the ones its packages register
// when they load, so `registerRuntime` can refuse to shadow one the way
// the VFS and CLI registries refuse a builtin name. A package's own
// registration is the first under its name; any later one shadows it.
const BUILTIN_RUNTIMES: ReadonlySet<string> = new Set([...Object.keys(NAMED), ...NODE_RUNTIMES])

/**
 * Register a runtime class under a config name. Host-side only, like
 * `registerVfs` and `registerCliSpec`: the embedding program
 * calls it, never a line the agent types. Once registered the name works
 * everywhere a builtin's does: a `runtimes:` entry in workspace config, a
 * string in `new Workspace(..., { runtimes })`, and `execute({ runtime })`.
 * Runtime packages use the same entry point for their own runtimes (`daytona`
 * from `@struktoai/mirage-node`). Mirrors `register_runtime` in
 * `mirage/runtime/table.py`: a core builtin cannot be shadowed, and
 * re-registering any other name replaces it.
 */
export function registerRuntime(
  name: string,
  cls: (new (options?: RuntimeOptions<never>) => Runtime) & Pick<typeof Runtime, 'configFields'>,
): void {
  if (BUILTIN_RUNTIMES.has(name) && NAMED[name] !== undefined) {
    throw new Error(`cannot register '${name}': shadows a builtin`)
  }
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
    if (key === 'machine' && name !== 'remote' && name in NAMED)
      throw new Error(
        `runtime '${name}' runs on the workspace's machine; a machine takes the remote runtime`,
      )
    if (!(name === 'remote' ? MACHINE_KEYS : ENTRY_KEYS).includes(key)) {
      const knownKeys = ENTRY_KEYS.map((k) => `'${k}'`).join(', ')
      throw new Error(`unknown ${name} runtime option '${key}' (expected: ${knownKeys})`)
    }
  }
}

/**
 * Construct a runtime by name, failing loud on unknown names (with a
 * cross-language hint for Python-only names) and on unknown options.
 */
// The name each runtime built with no options came from, so a copy can build it again.
const BUILT_FROM = new WeakMap<Runtime, string>()

export function buildRuntime(name: string, options: Record<string, unknown> = {}): Runtime {
  const cls = runtimeClass(name)
  checkRuntimeOptions(name, options)
  const runtime = new cls(options as RuntimeOptions<never>)
  if (Object.keys(options).length === 0) BUILT_FROM.set(runtime, name)
  return runtime
}

/** The registry name a runtime was built from with no options; undefined for one built with options or by the host. */
export function builtFrom(runtime: Runtime): string | undefined {
  return BUILT_FROM.get(runtime)
}

/**
 * The runtime class a name resolves to. Mirrors Python's `runtime_class`.
 *
 * Throws:
 *   Error: unknown name, with a hint for one another package registers.
 */
export function runtimeClass(
  name: string,
): (new (options?: RuntimeOptions<never>) => Runtime) & Pick<typeof Runtime, 'configFields'> {
  const cls = NAMED[name]
  if (cls === undefined) {
    const hint = RUNTIME_HINTS[name]
    if (hint !== undefined) throw new Error(hint)
    const known = knownRuntimes()
      .map((n) => `'${n}'`)
      .join(', ')
    throw new Error(`unknown runtime: '${name}' (expected one of ${known})`)
  }
  return cls
}

/**
 * Resolve an explicit runtime name into a binding override map.
 *
 * Naming a runtime places a line's captured stages on it without
 * touching capability: only commands the runtime captures rebind,
 * everything else keeps its normal binding. The name is an entry's, or the
 * part before its colon (`remote` for `remote:gpu`) while the workspace has
 * one such entry; throws for `workspace`, no entry or several.
 */
export function runtimeBindingsFor(
  entries: readonly Runtime[],
  name: string,
): Record<string, Runtime> {
  if (name === 'workspace') {
    throw new Error(`'workspace' is the default executor, not a runtime you can select`)
  }
  const exact = entries.filter((e) => e.name === name)
  const found = exact.length > 0 ? exact : entries.filter((e) => e.name.split(':', 1)[0] === name)
  const [entry] = found
  if (found.length === 1 && entry !== undefined) {
    // Null prototype: captures are arbitrary command names.
    const bindings: Record<string, Runtime> = Object.create(null) as Record<string, Runtime>
    for (const command of entry.captures) bindings[command] = entry
    return bindings
  }
  const known = entries.map((e) => `'${e.name}'`).join(', ')
  throw new Error(
    `${found.length > 0 ? 'ambiguous' : 'unknown'} runtime: '${name}' (workspace runtimes: ${known})`,
  )
}

/**
 * Resolve the ordered world into a command -> runtime binding map.
 *
 * A command binds to the FIRST entry that captures it; a default workspace
 * runtime captures nothing, so only a workspace entry with declared captures
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
    for (const capture of entry.captures) {
      if (
        capture !== EXTERNAL_COMMANDS &&
        capture !== WHOLE_LINE &&
        (capture === '*' || capture.startsWith('@'))
      ) {
        throw new Error(
          `'${capture}' is not a program or a group; the groups are '${EXTERNAL_COMMANDS}', '${WHOLE_LINE}', '${PYTHON_GROUP}' and '${JS_GROUP}'`,
        )
      }
    }
    if (entry.captures.includes(WHOLE_LINE) && !isLineExecutor(entry))
      throw new Error(`${WHOLE_LINE} requires shell execution`)
    if (
      entry.captures.includes(EXTERNAL_COMMANDS) &&
      !isLineExecutor(entry) &&
      !isProcessExecutor(entry)
    ) {
      throw new Error('@external requires process or shell execution')
    }
    if (entry instanceof LanguageRuntime && !isLineExecutor(entry) && !isProcessExecutor(entry)) {
      const runs = LANGUAGE_COMMANDS[entry.language]
      for (const capture of entry.captures) {
        if (!runs.includes(capture)) {
          throw new Error(`runtime '${entry.name}' does not run '${capture}'`)
        }
      }
    }
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
 * Each capture an earlier entry already takes, as [capture, winner,
 * shadowed], in list order. Mirrors Python's `shadowed_captures`.
 *
 * @param entries runtime instances in precedence order.
 */
export function shadowedCaptures(entries: readonly Runtime[]): [string, string, string][] {
  const winners = new Map<string, string>()
  const shadowed: [string, string, string][] = []
  for (const entry of entries) {
    for (const capture of new Set(entry.captures)) {
      const winner = winners.get(capture)
      if (winner !== undefined) shadowed.push([capture, winner, entry.name])
      else winners.set(capture, entry.name)
    }
  }
  return shadowed
}

/**
 * The runtime that runs this entire line, if any.
 *
 * Only an explicit WHOLE_LINE capture claims a whole line. Named captures
 * and EXTERNAL_COMMANDS execute individual commands. The workspace runtime never matches here
 * because it carries no capability: the workspace executor IS the
 * path a workspace-resolved line takes anyway, so there is no delegate.
 */
export function wholeLineRuntime(
  bindings: Readonly<Record<string, Runtime | null | undefined>>,
): (Runtime & LineExecutorMixin) | null {
  const whole = Object.hasOwn(bindings, WHOLE_LINE) ? bindings[WHOLE_LINE] : null
  if (whole != null && isLineExecutor(whole)) return whole
  return null
}

/**
 * Whether a runtime is a sandbox: a line executor on another machine.
 * Mirrors Python's `is_sandbox`.
 *
 * @param entry the runtime, null or undefined for none.
 */
export function isSandbox(entry: Runtime | null | undefined): entry is Runtime & LineExecutorMixin {
  return entry != null && isLineExecutor(entry) && entry.reach === 'remote'
}

/**
 * The decision a policy's route places a line or a command on.
 *
 * `workspace` keeps it in Mirage: no line executor (an `@line` capture)
 * takes it, and each command stays on its first other capturer. Any other
 * runtime serves every command it captures over `bindings`; none leaves
 * each command where `bindings` put it. `bindings` are the static ones for
 * a line, the line's own for a command. `inherited` is the machine of the
 * placement the route overlays, kept when the route names none. Mirrors
 * Python's `routed`.
 *
 * Throws:
 *   Error: no entry has the runtime's name, or no runtime it places takes
 *   the machine (`checkRouteMachine`).
 */
export function routed(
  entries: readonly Runtime[],
  bindings: Readonly<Record<string, Runtime | null | undefined>>,
  runtime: string | undefined,
  machine: string | undefined,
  inherited?: string,
): RouteDecision<Runtime> {
  checkRouteMachine(entries, runtime, machine)
  // Null prototype: captures are arbitrary command names.
  const placed = Object.create(null) as Record<string, Runtime | null>
  if (runtime === 'workspace') {
    for (const entry of entries) {
      for (const command of entry.captures) placed[command] = null
    }
    Object.assign(
      placed,
      bindCommands(entries.filter((entry) => !entry.captures.includes(WHOLE_LINE))),
    )
  } else {
    Object.assign(placed, bindings)
    if (runtime !== undefined) Object.assign(placed, runtimeBindingsFor(entries, runtime))
  }
  const on = machine ?? inherited
  return {
    bindings: placed,
    fallback: catchAll(entries),
    ...(on !== undefined ? { machine: on } : {}),
  }
}

/**
 * Refuse a placement whose machine no runtime it places would run on: only
 * the remote runtime runs on a machine a line names, so a named runtime has
 * to be one, and a placement naming no runtime needs one among the entries.
 * Mirrors Python's `check_route_machine`.
 *
 * Throws:
 *   Error: the named runtime runs on its own machine, or no entry is a
 *   remote runtime.
 */
export function checkRouteMachine(
  entries: readonly Runtime[],
  runtime: string | undefined,
  machine: string | undefined,
): void {
  if (machine === undefined) return
  if (runtime === undefined || runtime === 'workspace') {
    if (!entries.some((e) => e instanceof RemoteRuntime)) {
      throw new Error(`machine '${machine}' takes the remote runtime, and the workspace has none`)
    }
    return
  }
  for (const entry of entries) {
    if (entry.name === runtime && !(entry instanceof RemoteRuntime)) {
      throw new Error(
        `runtime '${runtime}' runs on the workspace's machine; ` +
          `machine '${machine}' takes the remote runtime`,
      )
    }
  }
}

/**
 * The runtime that serves commands no entry captures, if any.
 *
 * That is the world's WorkspaceRuntime, unless it declares captures (then it
 * is an ordinary capturer and nothing is catch-all) or it is not among
 * the given entries.
 */
export function catchAll(entries: readonly Runtime[]): Runtime | null {
  for (const entry of entries) {
    if (entry instanceof WorkspaceRuntime && !entry.restricted) return entry
  }
  return null
}
