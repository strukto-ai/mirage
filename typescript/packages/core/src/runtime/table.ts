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

import { MachineHandle } from '../machine/handle.ts'
import { buildMachine } from '../machine/registry.ts'
import { compareCodePoints } from '../utils/sort.ts'
import { Runtime } from './base.ts'
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
 * The default world when no machines are given: the shell alone, as
 * Python's, so an interpreter runs only where the config names one
 * (integ/runtime/routing/defaults.json pins it).
 */
export const DEFAULT_ENTRIES: readonly string[] = ['workspace']

// The runtimes @struktoai/mirage-node registers when it is imported.
const NODE_RUNTIMES: readonly string[] = ['local', 'sandlock']

/** Why a name a config may carry is not registered here, and where it lives. */
const RUNTIME_HINTS: Record<string, string> = {
  ...Object.fromEntries(
    NODE_RUNTIMES.map((name) => [
      name,
      "a host machine's programs run through @struktoai/mirage-node; import that package " +
        "to register them. Browser worlds run 'quickjs' and 'pyodide' in process and " +
        "'monty' on a worker",
    ]),
  ),
  wasi:
    "runtime 'wasi' is Python-only (a CPython WASI build); TypeScript runs " +
    "'quickjs' and 'pyodide' in process and 'monty' on a worker",
}

/**
 * The providers a `machines:` entry names for a runtime of Mirage's own
 * rather than a machine it reaches: in its process, in worker processes it
 * spawns, or as native programs on its host.
 */
export const IN_PROCESS = 'in_process'
export const WORKER = 'worker'
export const HOST = 'host'
const ENGINE_PROVIDERS: readonly string[] = [IN_PROCESS, WORKER, HOST]

// Where each builtin runtime runs, when that is not in process. Null
// prototype: names come from config.
const PLACED: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    monty: WORKER,
    local: HOST,
    sandlock: HOST,
    workspace: IN_PROCESS,
  },
)

/**
 * Say where a runtime runs on this host. A host package calls it when it
 * swaps a runtime's engine: Cloudflare runs Monty in its isolate, so there
 * monty is an `in_process` runtime, not a worker's.
 */
export function placeRuntime(name: string, provider: string): void {
  if (provider === IN_PROCESS) Reflect.deleteProperty(PLACED, name)
  else PLACED[name] = provider
}

/** What a `machines:` entry may be: a machine handle, a runtime, or the entry as config spells it. */
export type MachineSpec = MachineHandle | Runtime | Record<string, unknown>

/** A workspace's `machines`: the entries by name, or handles and runtimes named by their own `name`. */
export type MachineSpecs = Record<string, MachineSpec> | readonly (MachineHandle | Runtime)[]

// The names mirage ships: core's own, and the ones its packages register
// when they load, so `registerRuntime` can refuse to shadow one the way
// the VFS and CLI registries refuse a builtin name. A package's own
// registration is the first under its name; any later one shadows it.
const BUILTIN_RUNTIMES: ReadonlySet<string> = new Set([...Object.keys(NAMED), ...NODE_RUNTIMES])

/**
 * Register a runtime class under a config name. Host-side only, like
 * `registerVfs` and `registerCliSpec`: the embedding program calls it,
 * never a line the agent types. Once registered the name is a `runtime` an
 * `in_process` machine entry may name. Runtime packages use the same entry
 * point for their own runtimes (`local` and `sandlock` from
 * `@struktoai/mirage-node`). Mirrors `register_runtime` in
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

/** Construct a runtime by name, failing loud on unknown names, with a cross-language hint for Python-only names. */
export function buildRuntime(name: string, options: Record<string, unknown> = {}): Runtime {
  return new (runtimeClass(name))(options as RuntimeOptions<never>)
}

// The `machines:` entry each engine provider's runtime was built from, so
// a copy can build it again.
const BUILT_FROM = new WeakMap<Runtime, Record<string, unknown>>()

/** The `machines:` entry an engine provider's runtime was built from; undefined for a machine provider's runtime or one the host built. */
export function builtFrom(runtime: Runtime): Record<string, unknown> | undefined {
  return BUILT_FROM.get(runtime)
}

/**
 * The machine one `machines:` entry describes, and the runtime that runs
 * what it captures there. A machine provider (docker, ssh, ...) builds its
 * handle and the remote runtime that runs its `captures` through it. An
 * engine provider builds the runtime alone: `in_process` the one its
 * `runtime` names (none for the shell, which only `workspace` may be),
 * `worker` monty, `host` the host's own programs, confined by sandlock when a
 * `sandbox` block grants paths. The entry's other keys are the runtime's
 * config. Mirrors Python's `build_entry`.
 *
 * Throws:
 *   Error: `workspace` for anything but the shell, a runtime its provider
 *   does not run, or what `buildMachine` refuses.
 */
export function buildEntry(name: string, spec: MachineSpec): [MachineHandle | null, Runtime] {
  let runtime: Runtime
  if (spec instanceof Runtime) {
    runtime = spec
  } else if (spec instanceof MachineHandle || !ENGINE_PROVIDERS.includes(spec.provider as string)) {
    const handle = buildMachine(name, spec)
    if (name === 'workspace') throw new Error(`'${name}' is the shell's machine name`)
    const captures = (handle.config as { captures?: readonly string[] }).captures
    return [handle, new RemoteRuntime(name, captures === undefined ? {} : { captures })]
  } else {
    const { provider, captures, sandbox, runtime: named, ...fields } = spec
    const cls = runtimeFor(
      name,
      provider as string,
      named as string | undefined,
      sandbox as Record<string, unknown> | undefined,
    )
    const config = { ...fields, ...(sandbox as Record<string, unknown> | undefined) }
    runtime = new cls({
      ...(captures === undefined ? {} : { captures: captures as string[] }),
      ...(Object.keys(config).length > 0 ? { config: config as never } : {}),
    })
    BUILT_FROM.set(runtime, { ...spec })
  }
  if ((name === 'workspace') !== runtime instanceof WorkspaceRuntime)
    throw new Error(`'${name}' is the shell's machine name`)
  runtime.name = name
  return [null, runtime]
}

function runtimeFor(
  name: string,
  provider: string,
  runtime: string | undefined,
  sandbox: Record<string, unknown> | undefined,
): (new (options?: RuntimeOptions<never>) => Runtime) & Pick<typeof Runtime, 'configFields'> {
  if (sandbox !== undefined && provider !== HOST)
    throw new Error(`machine '${name}': only a host takes a sandbox`)
  if (provider === HOST) {
    if (runtime !== undefined)
      throw new Error(`machine '${name}': a host runs its own programs, not a runtime`)
    return runtimeClass(sandbox !== undefined ? 'sandlock' : 'local')
  }
  if (provider === WORKER) {
    if (runtime !== undefined && runtime !== 'monty')
      throw new Error(`machine '${name}': a worker runs 'monty', not '${runtime}'`)
    if (PLACED.monty !== WORKER)
      throw new Error(`machine '${name}': monty runs in process here, not on a worker`)
    return runtimeClass('monty')
  }
  if (runtime === undefined) return WorkspaceRuntime
  const placed = PLACED[runtime]
  if (placed !== undefined)
    throw new Error(`machine '${name}': '${runtime}' runs on ${placed}, not ${IN_PROCESS}`)
  return runtimeClass(runtime)
}

/** Every runtime an `in_process` machine may name. */
export function inProcessRuntimes(): string[] {
  return knownRuntimes().filter((name) => !(name in PLACED) && name !== 'remote')
}

/**
 * The machine handles and the ordered runtimes `machines` describes, each
 * named for its machine. Mirrors Python's `split_machines`.
 */
export function splitMachines(
  machines: MachineSpecs | undefined,
): [Record<string, MachineHandle>, Runtime[]] {
  const items: [string, MachineSpec][] =
    machines === undefined
      ? []
      : Array.isArray(machines)
        ? (machines as readonly (MachineHandle | Runtime)[]).map((m) => [m.name, m])
        : Object.entries(machines as Record<string, MachineSpec>)
  // Null prototype: machine names come from config.
  const handles = Object.create(null) as Record<string, MachineHandle>
  const entries: Runtime[] = []
  for (const [name, spec] of items) {
    const [handle, runtime] = buildEntry(name, spec)
    if (handle !== null) handles[name] = handle
    entries.push(runtime)
  }
  return [handles, entries]
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
 * Resolve a machine a line names into a binding override map. Naming a
 * machine places a line's captured stages on it without touching
 * capability: only commands its entry captures rebind, everything else keeps
 * its normal binding. Throws for `workspace` and for no machine.
 */
export function machineBindingsFor(
  entries: readonly Runtime[],
  name: string,
): Record<string, Runtime> {
  if (name === 'workspace') {
    throw new Error(`'workspace' is the default executor, not a machine you can select`)
  }
  const entry = entries.find((e) => e.name === name)
  if (entry !== undefined) {
    // Null prototype: captures are arbitrary command names.
    const bindings: Record<string, Runtime> = Object.create(null) as Record<string, Runtime>
    for (const command of entry.captures) bindings[command] = entry
    return bindings
  }
  const known = entries
    .filter((e) => e.name !== 'workspace')
    .map((e) => `'${e.name}'`)
    .join(', ')
  throw new Error(`unknown machine: '${name}' (workspace machines: ${known})`)
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
          throw new Error(`machine '${entry.name}' does not run '${capture}'`)
        }
      }
    }
    if (seen.has(entry.name)) {
      throw new Error(`duplicate machine: '${entry.name}'`)
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
 * machine serves every command it captures over `bindings`; none leaves
 * each command where `bindings` put it. `bindings` are the static ones for
 * a line, the line's own for a command. Mirrors Python's `routed`.
 *
 * Throws:
 *   Error: no entry is the machine.
 */
export function routed(
  entries: readonly Runtime[],
  bindings: Readonly<Record<string, Runtime | null | undefined>>,
  machine: string | undefined,
): RouteDecision<Runtime> {
  // Null prototype: captures are arbitrary command names.
  const placed = Object.create(null) as Record<string, Runtime | null>
  if (machine === 'workspace') {
    for (const entry of entries) {
      for (const command of entry.captures) placed[command] = null
    }
    Object.assign(
      placed,
      bindCommands(entries.filter((entry) => !entry.captures.includes(WHOLE_LINE))),
    )
  } else {
    Object.assign(placed, bindings)
    if (machine !== undefined) Object.assign(placed, machineBindingsFor(entries, machine))
  }
  return { bindings: placed, fallback: catchAll(entries) }
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
