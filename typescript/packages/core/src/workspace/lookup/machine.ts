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

import { splitLines } from '../../commands/builtin/utils/lines.ts'
import { SPECS, parseCommand } from '../../commands/spec/index.ts'
import { holders } from '../../core/machine/place.ts'
import { findLayout } from '../../rs/find.ts'
import { isFsError } from '../../errors/fs.ts'
import type { ByteSource } from '../../io/types.ts'
import { restrictedMountsFor } from '../../runtime/binding.ts'
import { EXTERNAL_COMMANDS } from '../../runtime/constants.ts'
import { RemoteRuntime } from '../../runtime/machine/runtime.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { DispatchFn, RouteDecision } from '../../runtime/types.ts'
import { decodeText } from '../../shell/bytes.ts'
import { BIN_PREFIX } from '../../shell/constants.ts'
import { shellJoin } from '../../shell/join.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { unmarkGlobs } from '../../utils/glob_walk.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import { CycleError, norm, parent, resolvePath } from '../../utils/path.ts'
import { shellQuote } from '../../utils/quote.ts'
import { BinViewVFS } from '../../vfs/bin/bin.ts'
import { MachineVFS } from '../../vfs/machine/machine.ts'
import type { NamespaceReader } from '../dispatcher/reader.ts'
import type { Argv } from '../expand/argv.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import { envSnapshot } from '../session/state.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { KEYWORDS } from './constants.ts'
import { lookupAll } from './lookup.ts'
import { Consumer, MachineAnswer, ProgramLookup } from './types.ts'

/**
 * The machine mount showing `path` at the same path on its machines, with no
 * other mount and no link of Mirage's own under the path; null for any other
 * path, for one a write may not reach, and for one that walks through a link
 * of Mirage's own, which the machine does not have. A name the `/usr/bin`
 * view leaves to the mount beneath it is read from that mount, so
 * `/usr/bin/python3` is the machine's own file where the machine's disk lies
 * under the view.
 */
function localMount(
  registry: MountRegistry,
  links: NamespaceReader,
  path: string,
  writes: boolean,
): MountEntry | null {
  try {
    if (
      norm(links.follow(norm(path))) !== norm(path) ||
      links.linkStatsBelow(norm(path)).length > 0
    )
      return null
  } catch (err) {
    if (!(err instanceof CycleError)) throw err
    console.debug(`${path}: a link loop keeps it here: ${String(err)}`)
    return null
  }
  let entry = registry.tryMountFor(path)
  if (
    entry !== null &&
    !writes &&
    entry.vfs instanceof BinViewVFS &&
    entry.vfs.leaves(mountKey(path, entry.prefix))
  )
    entry = registry.mountBeneath(entry, path)
  if (entry === null || !(entry.vfs instanceof MachineVFS)) return null
  if (norm(entry.vfs.config.root ?? '/') !== norm(entry.prefix)) return null
  if (writes && entry.mode === MountMode.READ) return null
  const below = `${rstripSlash(norm(path))}/`
  if (registry.allMounts().some((m) => m !== entry && norm(m.prefix).startsWith(below))) return null
  return entry
}

/**
 * Whether anything is piped in: the empty input `xargs` gives a command, as
 * GNU's gives it `/dev/null`, is none. Mirrors Python's `_piped`.
 */
function piped(stdin: ByteSource | null): boolean {
  return stdin !== null && !(stdin instanceof Uint8Array && stdin.byteLength === 0)
}

function ruled(session: SessionState, registry: MountRegistry, entries: MountEntry[]): boolean {
  const prefixes = registry.allMounts().map((m) => m.prefix)
  const restricted = new Set(restrictedMountsFor(session, prefixes).map((p) => norm(p)))
  return entries.some((e) => restricted.has(norm(e.prefix)))
}

/**
 * The one machine holding every path, each its own at the same path on a
 * machine mount the session may use; null when any path is elsewhere, no one
 * machine holds them all, or input is piped into a machine that takes none.
 * Mirrors Python's `_machine_holding`.
 *
 * @param scopes each absolute path, with whether the command may write it.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param stdin what is piped into it.
 */
async function machineHolding(
  scopes: readonly (readonly [string, boolean])[],
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  stdin: ByteSource | null,
): Promise<RemoteRuntime | null> {
  const mounts: MountEntry[] = []
  for (const [path, writes] of scopes) {
    const entry = localMount(registry, links, path, writes)
    if (entry === null) return null
    mounts.push(entry)
  }
  if (scopes.length === 0 || ruled(session, registry, mounts)) return null
  if (await registry.policies.wantsFor('preVfs', session.sessionId)) return null
  let candidates: string[] | null = null
  for (const [at, [path]] of scopes.entries()) {
    const entry = mounts[at]
    if (entry === undefined || !(entry.vfs instanceof MachineVFS)) return null
    const held = await holders(
      entry.vfs.accessor,
      PathSpec.fromStrPath(path, mountKey(path, entry.prefix)),
    )
    candidates = candidates === null ? held : candidates.filter((m) => held.includes(m))
  }
  if (candidates?.length !== 1) return null
  const only = candidates
  const runtime = registry.runtimeEntries.find(
    (e): e is RemoteRuntime => e instanceof RemoteRuntime && only.includes(e.defaultMachine),
  )
  if (runtime === undefined) return null
  if (piped(stdin) && !runtime.handle().takesInput) return null
  return runtime
}

/**
 * Whether the workspace runs programs on more than one machine, the only case
 * where which machine a command runs on decides where a new file lands.
 * Mirrors Python's `several_machines`.
 *
 * @param registry the workspace's mounts and machines.
 */
export function severalMachines(registry: MountRegistry): boolean {
  const machines = new Set(
    registry.runtimeEntries
      .filter((e): e is RemoteRuntime => e instanceof RemoteRuntime)
      .map((e) => e.defaultMachine),
  )
  return machines.size > 1
}

/**
 * The paths a command's options name (`grep -f /data/patterns`), which the
 * machine must hold as well as its operands; none for a command without a
 * spec. Mirrors Python's `_option_paths`.
 *
 * @param argv the command.
 * @param cwd the directory a relative path resolves against.
 */
function optionPaths(argv: Argv, cwd: string): string[] {
  const spec = SPECS[argv.name]
  if (spec === undefined) return []
  return parseCommand(spec, [...argv.args], cwd, argv.name).pathFlagValues.filter((p) => p !== '-')
}

/**
 * The paths a `find -exec` command names, which the machine must hold as
 * well, since the classifier keeps its words as text: an absolute word, or
 * one that climbs with `..`. A word that is no path at all keeps the command
 * in Mirage, which is always right. Mirrors Python's `_child_paths`.
 *
 * @param argv the command.
 * @param cwd the directory a relative word resolves against.
 */
function childPaths(argv: Argv, cwd: string): string[] {
  if (argv.name !== 'find') return []
  const words = [...argv.args]
  return findLayout(words).spans.flatMap(([start, end]) =>
    words
      .slice(start + 1, end)
      .filter((word) => word.startsWith('/') || word.split('/').includes('..'))
      .map((word) => norm(word.startsWith('/') ? word : `${cwd}/${word}`)),
  )
}

/**
 * The machine a mount command runs on whole, when every path it names is one
 * machine's own at the same path: `grep -rn x /testbed` is one exec there,
 * with the machine's own output, where Mirage's implementation would read
 * each file through an exec of its own.
 *
 * Mirage keeps the command when anything is piped into it, since its own
 * command leaves input it does not read for the next one (`... | while read
 * f; do grep x "$f"; done`) where a machine would drain it; when a path is
 * anywhere else (another mount, a machine mount at another root, a mount
 * nested under it); when no one machine holds every path (a new name, or a
 * name on several machines, which Mirage places by its own rules); when the
 * session's rules restrict its mount, a coded file policy speaks for the
 * session, or the mount is read-only; when the cwd
 * is not on the machine; when a path, an option's or a `find -exec`
 * command's included, walks through a link of Mirage's own; or
 * when the machine lacks the program. A command
 * naming no path runs there from a cwd on the machine (`ls`, `find`).
 * Mirrors Python's `operand_machine`.
 *
 * @param argv the command.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param stdin what is piped into it.
 */
export async function operandMachine(
  argv: Argv,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  stdin: ByteSource | null,
): Promise<RemoteRuntime | null> {
  if (piped(stdin)) return null
  const paths = argv.operands.flatMap((w) =>
    w instanceof PathSpec ? [unmarkGlobs(w.virtual)] : [],
  )
  const cwd = norm(session.cwd)
  paths.push(...optionPaths(argv, session.cwd))
  paths.push(...childPaths(argv, session.cwd))
  const scopes: [string, boolean][] = paths.map((path) => [path, true])
  if (cwd !== '/') scopes.push([cwd, false])
  const runtime = await machineHolding(scopes, session, registry, links, null)
  if (runtime === null || !(await runtime.handle().hasProgram(argv.name))) return null
  return runtime
}

/**
 * The machine a program named by its path runs on, when the file is one
 * machine's own at that path: the `venv/bin/python` a machine's `python -m
 * venv` made in /tmp runs there, as bash runs it, where Mirage would read the
 * binary and refuse it. The path is asked of the dispatcher first, so a
 * hidden or refused path stays with Mirage, which words the refusal. Mirrors
 * Python's `program_machine`.
 *
 * @param path the head word, as typed.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param dispatch op dispatcher, which applies the session's hides and
 *   policies to the path.
 * @param stdin what is piped into it.
 */
export async function programMachine(
  path: string,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  dispatch: DispatchFn,
  stdin: ByteSource | null,
): Promise<RemoteRuntime | null> {
  const spec = PathSpec.fromStrPath(path, undefined, session.cwd)
  if (localMount(registry, links, spec.virtual, false) === null) return null
  try {
    await dispatch('stat', spec)
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`${path}: not run on its machine: ${String(err)}`)
    return null
  }
  return machineHolding([[spec.virtual, false]], session, registry, links, stdin)
}

/**
 * The machine an `ln` runs on whole, when every link lands in a folder one
 * machine holds at its own path and points at that machine's own files: the
 * machine makes the link, so its programs follow it, where Mirage's link
 * table holds links only Mirage sees.
 *
 * A symbolic link's target counts when it resolves onto a machine mount at
 * its own path, there or not, since a dangling link is a link all the same;
 * a hard link's source must be one the machine holds. Mirrors Python's
 * `link_machine`.
 *
 * @param made each link's absolute path and its target, resolved as the
 *   link will resolve it.
 * @param symbolic whether the links are symbolic.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
export async function linkMachine(
  made: readonly (readonly [string, string])[],
  symbolic: boolean,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): Promise<RemoteRuntime | null> {
  if (made.length === 0) return null
  if (symbolic && made.some(([, target]) => localMount(registry, links, target, false) === null))
    return null
  const scopes = new Map<string, readonly [string, boolean]>()
  const scope = (path: string, writes: boolean): void => {
    scopes.set(JSON.stringify([path, writes]), [path, writes])
  }
  for (const [link] of made) scope(parent(link), true)
  if (!symbolic) for (const [, target] of made) scope(target, false)
  const runtime = await machineHolding([...scopes.values()], session, registry, links, null)
  if (runtime === null || !(await runtime.handle().hasProgram('ln'))) return null
  return runtime
}

/**
 * The machine a lookup of `name` asks: the one that would run it as a
 * program on this line; null when Mirage answers for it, or no machine would
 * run it.
 *
 * Mirage answers a name it holds in any layer: a builtin, a namespace
 * command, a CLI, a mount command, and a function unless the lookup looks
 * past functions to the file a run would exec (`which`, `type -P`,
 * `type -a`). Any other name is the machine's that takes it by name, else
 * the one taking `@external`, as the line's placement binds them
 * (`ProgramLookup` has the whole rule). Mirrors Python's `lookup_machine`.
 *
 * @param name the name looked up.
 * @param session the session it is looked up in.
 * @param registry the workspace's mounts and machines.
 * @param routing the line's placement; undefined for the workspace's own
 *   bindings.
 * @param pastFunctions the lookup finds the program a function of the same
 *   name shadows.
 */
export function lookupMachine(
  name: string,
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
  pastFunctions: boolean,
): RemoteRuntime | null {
  if (name.includes('/') || KEYWORDS.has(name)) return null
  for (const consumer of lookupAll(name, session, registry, routing)) {
    if (consumer === Consumer.FUNCTION && pastFunctions) continue
    if (consumer !== Consumer.EXTERNAL) return null
  }
  const bindings: Readonly<Record<string, Runtime | null | undefined>> =
    routing?.bindings ?? registry.runtimeBindings
  const runtime = Object.hasOwn(bindings, name) ? bindings[name] : bindings[EXTERNAL_COMMANDS]
  return runtime instanceof RemoteRuntime ? runtime : null
}

/**
 * The program a `/usr/bin/NAME` path runs by name, for a path no file of
 * Mirage's or of a machine Mirage shows is at: NAME, where a machine runs it
 * on this line (`lookupMachine`), since a lookup prints that path for a
 * program whose own file Mirage does not show; null for any other path.
 * Mirrors Python's `bin_program`.
 *
 * @param path the head word, as typed.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param routing the line's placement.
 */
export function binProgram(
  path: string,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  routing: RouteDecision<Runtime> | undefined,
): string | null {
  let target: string
  try {
    target = links.follow(resolvePath(path, session.cwd))
  } catch (err) {
    if (!(err instanceof CycleError)) throw err
    console.debug(`${path}: a link loop names no program`)
    return null
  }
  const entry = registry.tryMountFor(target)
  if (entry === null || !(entry.vfs instanceof BinViewVFS)) return null
  const name = mountKey(target, entry.prefix).replace(/^\/+|\/+$/g, '')
  if (name === '' || name.includes('/')) return null
  if (lookupMachine(name, session, registry, routing, true) === null) return null
  return name
}

/**
 * The line a machine runs for a lookup: the command the agent typed, on this
 * one name, after `--` where it starts with a dash, so the machine reads it
 * as the name it is. `type` and `command` are bash's builtins, so they run
 * in the machine's bash, its `sh` where it has none.
 *
 * @param command `which`, `type` or `command`.
 * @param letters the options the agent gave it.
 * @param name the name looked up.
 */
function lookupLine(command: string, letters: string, name: string): string {
  const line = shellJoin([
    command,
    ...(letters !== '' ? [`-${letters}`] : []),
    ...(name.startsWith('-') ? ['--'] : []),
    name,
  ])
  if (command === 'which') return line
  const quoted = shellQuote(line)
  return `if [ -x /bin/bash ]; then exec /bin/bash -c ${quoted}; fi; exec /bin/sh -c ${quoted}`
}

/**
 * The path a line of a machine's answer names, null for none: a PATH answer
 * is the path, a KIND one names it after `NAME is`.
 *
 * @param line one line of the answer.
 * @param name the name looked up.
 * @param kind what the lookup asks.
 */
function pathIn(line: string, name: string, kind: ProgramLookup): string | null {
  if (kind === ProgramLookup.PATH) return line.startsWith('/') ? line : null
  const lead = `${name} is `
  if (kind === ProgramLookup.KIND && line.startsWith(`${lead}/`)) return line.slice(lead.length)
  return null
}

/**
 * What `runtime`'s machine answers the lookup of one name, in the
 * environment a program run there gets, each path it prints kept only where
 * Mirage shows that same path as the machine's own file, the name's
 * `/usr/bin` file otherwise.
 *
 * @param command `which`, `type` or `command`.
 * @param letters the options the agent gave it.
 * @param name the name looked up.
 * @param kind what the lookup asks.
 * @param runtime the machine that runs the name.
 * @param session the session it is looked up in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
async function answer(
  command: string,
  letters: string,
  name: string,
  kind: ProgramLookup,
  runtime: RemoteRuntime,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): Promise<MachineAnswer> {
  const done = await runtime
    .handle()
    .lookUp(lookupLine(command, letters, name), envSnapshot(session))
  const lines: string[] = []
  for (const said of splitLines(decodeText(done.stdout))) {
    let line = said
    const path = pathIn(line, name, kind)
    if (path !== null) {
      const held = await machineHolding([[path, false]], session, registry, links, null)
      if (held?.defaultMachine !== runtime.defaultMachine)
        line = `${line.slice(0, line.length - path.length)}${BIN_PREFIX}/${name}`
    }
    if (!lines.includes(line)) lines.push(line)
  }
  return new MachineAnswer(done.exitCode === 0, lines)
}

/**
 * What the machine that runs each name answered the lookup the agent typed,
 * for each name a machine runs (`lookupMachine`); a name Mirage answers for,
 * or none runs, has no entry. Every machine is asked at once. Mirrors
 * Python's `machine_answers`.
 *
 * @param command `which`, `type` or `command`.
 * @param letters the options the agent gave it.
 * @param names the names looked up.
 * @param kind what the lookup asks, by its `PROGRAM_LOOKUPS` row.
 * @param pastFunctions the lookup finds the program a function of the same
 *   name shadows.
 * @param session the session they are looked up in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param routing the line's placement.
 */
export async function machineAnswers(
  command: string,
  letters: string,
  names: readonly string[],
  kind: ProgramLookup,
  pastFunctions: boolean,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  routing: RouteDecision<Runtime> | undefined,
): Promise<Map<string, MachineAnswer>> {
  const asked = new Map<string, RemoteRuntime>()
  for (const name of new Set(names)) {
    const runtime = lookupMachine(name, session, registry, routing, pastFunctions)
    if (runtime !== null) asked.set(name, runtime)
  }
  const found = await Promise.all(
    [...asked].map(
      async ([name, runtime]) =>
        [
          name,
          await answer(command, letters, name, kind, runtime, session, registry, links),
        ] as const,
    ),
  )
  return new Map(found)
}
