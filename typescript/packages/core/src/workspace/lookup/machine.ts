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
import { WordKind } from '../../commands/spec/types.ts'
import { chosen, holders, newNameMachine } from '../../core/machine/place.ts'
import type { Holder } from '../../core/machine/types.ts'
import { folderOf } from '../../core/machine/utils.ts'
import { findLayout } from '../../rs/find.ts'
import { isFsError } from '../../errors/fs.ts'
import type { ByteSource } from '../../io/types.ts'
import type { CommandWord } from '../../policy/types.ts'
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
import type { PipeWriter } from '../frame.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { Namespace } from '../mount/namespace/namespace.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'
import { envSnapshot } from '../session/state.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { FOLDER_FREE, KEYWORDS } from './constants.ts'
import { lookupAll, programHead, programRuntime } from './lookup.ts'
import { Consumer, MachineAnswer, ProgramLookup, type ExternalTarget } from './types.ts'

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
 * The machine mount showing each path at its own path, in order; null when
 * there is no path, any path is elsewhere, or the session's rules restrict
 * one of those mounts. Mirrors Python's `_held_mounts`.
 *
 * @param scopes each absolute path, with whether the command may write it.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
function heldMounts(
  scopes: readonly (readonly [string, boolean])[],
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): MountEntry[] | null {
  const mounts: MountEntry[] = []
  for (const [path, writes] of scopes) {
    const entry = localMount(registry, links, path, writes)
    if (entry === null) return null
    mounts.push(entry)
  }
  if (scopes.length === 0 || ruled(session, registry, mounts)) return null
  return mounts
}

/**
 * The runtime that runs programs on the one machine named; null for none or
 * several. Mirrors Python's `_runtime_of`.
 *
 * @param machines the candidate machines.
 * @param registry the workspace's mounts and machines.
 */
function runtimeOf(machines: readonly string[], registry: MountRegistry): RemoteRuntime | null {
  if (machines.length !== 1) return null
  return (
    registry.runtimeEntries.find(
      (e): e is RemoteRuntime => e instanceof RemoteRuntime && e.defaultMachine === machines[0],
    ) ?? null
  )
}

/**
 * The machines a machine mount shows, by its config: the ones it names, else
 * every machine the workspace runs programs on. Mirrors Python's
 * `_shown_machines`.
 *
 * @param entry a machine mount.
 * @param registry the workspace's mounts and machines.
 */
function shownMachines(entry: MountEntry, registry: MountRegistry): string[] {
  const named = entry.vfs instanceof MachineVFS ? entry.vfs.config.machines : null
  if (named !== null && named !== undefined) return [...named]
  return [
    ...new Set(
      registry.runtimeEntries
        .filter((e): e is RemoteRuntime => e instanceof RemoteRuntime)
        .map((e) => e.defaultMachine),
    ),
  ].sort(compareCodePoints)
}

/**
 * The one machine holding every path, each its own at the same path on a
 * machine mount the session may use, and the folder it runs from; null when
 * any path is elsewhere, no one machine holds them all, or input is piped
 * into a machine that takes none. A name several machines hold is no one
 * machine's to answer for: Mirage shows it as one (`chosen`), so the command
 * stays with Mirage. The folder a command only runs from may be on several.
 * Mirrors Python's `_machine_holding`.
 *
 * @param scopes each absolute path, with whether the command may write it.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param stdin what is piped into it.
 * @param folder the folder it runs from, which the machine must hold too;
 *   null for one that runs from `/`.
 */
async function machineHolding(
  scopes: readonly (readonly [string, boolean])[],
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  stdin: ByteSource | null,
  folder: string | null = null,
): Promise<RemoteRuntime | null> {
  const stood: (readonly [string, boolean])[] = folder === null ? [] : [[folder, false]]
  const every = [...scopes, ...stood]
  const mounts = heldMounts(every, session, registry, links)
  if (mounts === null) return null
  if (await registry.policies.wantsFor('preVfs', session.sessionId)) return null
  let candidates: string[] | null = null
  for (const [at, [path]] of every.entries()) {
    const entry = mounts[at]
    if (entry === undefined || !(entry.vfs instanceof MachineVFS)) return null
    const held = (await holders(entry.vfs.accessor, onMount(entry, path))).map((one) => one.machine)
    if (held.length > 1 && at < scopes.length) return null
    candidates = candidates === null ? held : candidates.filter((m) => held.includes(m))
  }
  const runtime = runtimeOf(candidates ?? [], registry)
  if (runtime === null) return null
  if (piped(stdin) && !runtime.handle().takesInput) return null
  return runtime
}

/**
 * The machine a command Mirage runs itself is about
 * (`Caller.preferredMachine`): the one the line names, else the one whose
 * program writes the pipe it reads, else the one its folder is on; null when
 * nothing says, and in a workspace that runs programs on one machine, where
 * nothing is to choose. Mirrors Python's `preferred_machine`.
 *
 * A pipe's writer is placed once for the pipe, so a reader that moves
 * (`gen | (cd /srv; tee log)`) or runs many commands asks no more.
 *
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param routing the line's placement.
 * @param fedBy the program writing the pipe the command reads.
 * @param namespace the link table a writer's path is read through.
 * @param dispatch op dispatcher, which a writer's path is asked of.
 */
export async function preferredMachine(
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime> | undefined,
  fedBy: PipeWriter | null,
  namespace: Namespace,
  dispatch: DispatchFn,
): Promise<string | null> {
  if (routing === undefined || !severalMachines(registry)) return null
  if (routing.machine !== undefined) return routing.machine
  if (fedBy !== null && !fedBy.placed) {
    fedBy.machine = await writerMachine(fedBy, session, registry, routing, namespace, dispatch)
    fedBy.placed = true
  }
  if (fedBy !== null && fedBy.machine !== null) return fedBy.machine
  const shown = folderMachines(session.cwd, registry)
  const [only] = shown
  return shown.length === 1 && only !== undefined ? only : null
}

/**
 * The machine a pipe's writer runs on, placed as it runs, from the folder
 * its pipeline started in: by its words, through the wrappers Mirage runs
 * (`nice gen | tee log`), and one named by its path on the machine holding
 * that file (`nice /tmp/tool | tee log`). Null for a program Mirage runs
 * itself, and for one that would not start in that folder as far as the
 * mounts tell, which writes nothing: it starts where the folder is `/`, the
 * machine's own, or Mirage's mounts are served into the machine. Mirrors
 * Python's `_writer_machine`.
 *
 * A path is looked up only when no file policy speaks for the session: the
 * lookup asks the dispatcher before the reader is admitted, and a policy
 * judges a call inside the command that makes it.
 *
 * @param fedBy the pipe's writer.
 * @param session the session its reader runs in.
 * @param registry the workspace's mounts and machines.
 * @param routing the line's placement.
 * @param namespace the link table the path is read through.
 * @param dispatch op dispatcher, which the path is asked of.
 */
async function writerMachine(
  fedBy: PipeWriter,
  session: SessionState,
  registry: MountRegistry,
  routing: RouteDecision<Runtime>,
  namespace: Namespace,
  dispatch: DispatchFn,
): Promise<string | null> {
  const head = programHead(registry, fedBy.words, session, routing)
  let runtime: Runtime | null | undefined = null
  if (head.includes('/') && !(await registry.policies.wantsFor('preVfs', session.sessionId)))
    runtime = await programMachine(
      PathSpec.fromStrPath(head, undefined, fedBy.cwd).virtual,
      session,
      registry,
      namespace.sessionLinks(session),
      dispatch,
      null,
    )
  runtime ??= programRuntime(registry, fedBy.words, session, routing)
  if (!(runtime instanceof RemoteRuntime)) return null
  const name = runtime.defaultMachine
  if (norm(fedBy.cwd) === '/' || runtime.handle().config.mountType !== undefined) return name
  return folderMachines(fedBy.cwd, registry).includes(name) ? name : null
}

/**
 * The machines whose own files a folder is, by the mount showing it
 * (`/srv/gpu` over the gpu machine, `/tmp` over every machine); none for a
 * folder in a store. Mirrors Python's `_folder_machines`.
 *
 * @param folder the folder, an absolute virtual path.
 * @param registry the workspace's mounts and machines.
 */
function folderMachines(folder: string, registry: MountRegistry): string[] {
  const entry = registry.tryMountFor(folder)
  if (entry === null || !(entry.vfs instanceof MachineVFS)) return []
  return shownMachines(entry, registry)
}

/**
 * Whether the workspace runs programs on more than one machine, the only
 * case where which machine a command runs on decides where a new file
 * lands. Mirrors Python's `several_machines`.
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
 * The paths a command takes as operands, the files it works on, and not as an
 * option's value: `grep -r -f /tmp/p` takes none, so it searches its folder.
 * Every path for a command without a spec. Mirrors Python's `_path_operands`.
 *
 * @param argv the command.
 * @param cwd the directory a relative path resolves against.
 */
function pathOperands(argv: Argv, cwd: string): PathSpec[] {
  const spec = SPECS[argv.name]
  if (spec === undefined) {
    return argv.operands.filter((w): w is PathSpec => w instanceof PathSpec)
  }
  const roles = parseCommand(spec, [...argv.args], cwd, argv.name).wordRoles
  return argv.operands.filter(
    (w, i): w is PathSpec => roles[i] === WordKind.OPERAND && w instanceof PathSpec,
  )
}

/**
 * The paths a `find -exec` command names, which the machine must hold as
 * well, since the classifier keeps its words as text: an absolute word, or
 * one that climbs with `..`. A word that is no path at all keeps the command
 * in Mirage, which is always right. Mirrors Python's `_child_paths`.
 *
 * @param name the command's name.
 * @param words its words after the name.
 * @param cwd the directory a relative word resolves against.
 */
function childPaths(name: string, words: readonly string[], cwd: string): string[] {
  if (name !== 'find') return []
  return findLayout(words).spans.flatMap(([start, end]) =>
    words
      .slice(start + 1, end)
      .filter((word) => word.startsWith('/') || word.split('/').includes('..'))
      .map((word) => norm(word.startsWith('/') ? word : `${cwd}/${word}`)),
  )
}

/**
 * Every path a command names, absolute, with whether any of them depends on
 * the folder it runs from: an operand typed relative, an option's path the
 * folder changes, or no path operand at all (`ls` and `grep -r -f /tmp/p`
 * read the folder). Mirrors Python's `_named_paths`.
 *
 * @param argv the command.
 * @param cwd the session's folder.
 */
function namedPaths(argv: Argv, cwd: string): [string[], boolean] {
  const named = argv.operands.filter((w): w is PathSpec => w instanceof PathSpec)
  const options = optionPaths(argv, cwd)
  const children = childPaths(argv.name, argv.args, cwd)
  const paths = named.map((w) => unmarkGlobs(w.virtual))
  const relative =
    pathOperands(argv, cwd).length === 0 ||
    named.some((w) => !w.rawPath.startsWith('/')) ||
    options.join('\0') !== optionPaths(argv, '/').join('\0')
  return [[...paths, ...options, ...children], relative]
}

/**
 * The machine a mount command runs on whole, when every path it names is one
 * machine's own at the same path: `grep -rn x /testbed` is one exec there,
 * with the machine's own output, where Mirage's implementation would read
 * each file through an exec of its own. Its output is then the machine's in
 * every detail, its links and its `/proc` included.
 *
 * It runs from the session's folder when that folder is on the same machine.
 * A command that touches nothing but the paths it names (`FOLDER_FREE`),
 * every one absolute, runs there from `/` otherwise, since nothing it does
 * depends on the folder (`ls /proc/self/fd` from a Mirage store); any other
 * needs the folder on the machine.
 *
 * Mirage keeps the command when anything is piped into it, since its own
 * command leaves input it does not read for the next one (`... | while read
 * f; do grep x "$f"; done`) where a machine would drain it; when a path is
 * anywhere else (another mount, a machine mount at another root, a mount
 * nested under it); when no one machine holds every path (a new name, or a
 * name on several machines, which Mirage places by its own rules); when the
 * session's rules restrict its mount, a coded file policy speaks for the
 * session, or the mount is read-only; when a path, an option's or a `find
 * -exec` command's included, walks through a link of Mirage's own; or when
 * the machine lacks the program. `statedMachine` is the same rule as far as a
 * command's words tell it. Mirrors Python's `operand_machine`.
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
): Promise<ExternalTarget | null> {
  if (piped(stdin)) return null
  const [paths, relative] = namedPaths(argv, session.cwd)
  const scopes: [string, boolean][] = paths.map((path) => [path, true])
  const cwd = norm(session.cwd)
  let runtime = await machineHolding(
    scopes,
    session,
    registry,
    links,
    null,
    cwd === '/' ? null : cwd,
  )
  let runsFrom: string | null = null
  if (runtime === null && !relative && cwd !== '/' && FOLDER_FREE.has(argv.name)) {
    runtime = await machineHolding(scopes, session, registry, links, null)
    runsFrom = '/'
  }
  if (runtime === null || !(await runtime.handle().hasProgram(argv.name))) return null
  return { kind: Consumer.EXTERNAL, runtime, cwd: runsFrom }
}

/**
 * The machine a mount command runs on whole as far as its words tell, without
 * asking anything (`explain`): `operandMachine`'s rule over the paths its
 * operands, options and `find -exec` command name, where each mount shows
 * one machine, for a
 * session no coded file policy speaks for (the caller asks, `wantsFor`). What
 * only a machine or the run can tell is left to the run, which keeps the
 * command in Mirage: which of several machines a mount shows holds a name,
 * whether the machine has the program, and input piped in. Mirrors Python's
 * `stated_machine`.
 *
 * @param words the command's words, as judged.
 * @param cwd the session's folder.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
export function statedMachine(
  words: readonly CommandWord[],
  cwd: string,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): RemoteRuntime | null {
  const named = words.flatMap((w) =>
    w.path !== null &&
    (w.kind === WordKind.OPERAND || w.kind === WordKind.VALUE || w.kind === WordKind.OPTION)
      ? [w.path]
      : [],
  )
  const name = words.find((w) => w.kind === WordKind.NAME)?.text ?? ''
  const args = words
    .filter((w) => w.kind !== WordKind.NAME && w.kind !== WordKind.REDIRECT)
    .map((w) => w.text)
  const children = childPaths(name, args, cwd)
  const relative =
    !words.some((w) => w.kind === WordKind.OPERAND && w.path !== null) ||
    named.some((p) => !p.rawPath.startsWith('/'))
  const scopes: [string, boolean][] = [
    ...named.map((p): [string, boolean] => [unmarkGlobs(p.virtual), true]),
    ...children.map((c): [string, boolean] => [c, true]),
  ]
  const here = norm(cwd)
  const tries: [string, boolean][][] = here === '/' ? [scopes] : [[...scopes, [here, false]]]
  if (!relative && here !== '/' && FOLDER_FREE.has(name)) tries.push(scopes)
  for (const scoped of tries) {
    const mounts = heldMounts(scoped, session, registry, links)
    if (mounts === null) continue
    let machines: string[] | null = null
    for (const [at, entry] of mounts.entries()) {
      const shown = shownMachines(entry, registry)
      // Only the run finds who holds a name several machines show.
      if (shown.length > 1 && at < scopes.length) {
        machines = []
        break
      }
      machines = machines === null ? shown : machines.filter((m) => shown.includes(m))
    }
    const runtime = runtimeOf(machines ?? [], registry)
    if (runtime !== null) return runtime
  }
  return null
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
 * The machine an `ln` runs on whole, when one machine can make every link
 * (`linkRuntime`): the machine makes the link, so its programs follow it,
 * where Mirage's link table holds links only Mirage sees.
 *
 * It runs from the session's folder when the machine holds that folder.
 * From any other folder it runs from `/` when every path it names is
 * absolute, and stays with Mirage otherwise, since the machine could not
 * resolve a relative name. Mirrors Python's `link_machine`.
 *
 * @param made each link's absolute path and its target, resolved as the
 *   link will resolve it.
 * @param symbolic whether the links are symbolic.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 * @param absolute whether every path the command names, that the folder it
 *   runs from could change, is typed absolute.
 */
export async function linkMachine(
  made: readonly (readonly [string, string])[],
  symbolic: boolean,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
  absolute: boolean,
): Promise<ExternalTarget | null> {
  if (made.length === 0) return null
  const runtime = await linkRuntime(made, symbolic, session, registry, links)
  if (runtime === null || !(await runtime.handle().hasProgram('ln'))) return null
  const cwd = norm(session.cwd)
  if (cwd === '/' || (await holdsFolder(runtime, cwd, session, registry, links)))
    return { kind: Consumer.EXTERNAL, runtime }
  return absolute ? { kind: Consumer.EXTERNAL, runtime, cwd: '/' } : null
}

/**
 * A virtual path as its mount addresses it, the mount's own root included.
 * Mirrors Python's `_on_mount`.
 *
 * @param entry the mount showing the path.
 * @param path an absolute virtual path on it.
 */
function onMount(entry: MountEntry, path: string): PathSpec {
  return PathSpec.fromStrPath(path, mountKey(path, rstripSlash(entry.prefix)))
}

/**
 * Whether a machine holds a folder at its own path, so a program there can
 * run from it. Mirrors Python's `_holds_folder`.
 *
 * @param runtime the machine's runtime.
 * @param folder the folder, an absolute virtual path.
 * @param session the session.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
async function holdsFolder(
  runtime: RemoteRuntime,
  folder: string,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): Promise<boolean> {
  const mounts = heldMounts([[folder, false]], session, registry, links)
  const entry = mounts?.[0]
  if (entry === undefined || !(entry.vfs instanceof MachineVFS)) return false
  const held = await holders(entry.vfs.accessor, onMount(entry, folder))
  return held.some((one) => one.machine === runtime.defaultMachine && folderThere(one))
}

/**
 * Whether a machine holds a folder at a name as far as is known: a mount on
 * one machine asks nothing, so its machine answers for itself. Mirrors
 * Python's `_folder_there`.
 *
 * @param one the machine and what it reports for the name.
 */
function folderThere(one: Holder): boolean {
  return one.folder || one.entry === null
}

/**
 * The one machine that makes every link, when one can. A link is made on
 * the machine holding its target, the copy shown of it (`chosen`), so the
 * link leads where Mirage reads the target; a symbolic link to a name no
 * machine holds is a new name like any other (`newNameMachine`). That
 * machine must hold the link's folder, whose copy shown is a folder, and no
 * other machine may hold the link's name, which Mirage's own `ln` then
 * answers for.
 *
 * Null when a path is off a machine mount, the session's rules or a coded
 * file policy speak for the mount, a hard link's target is missing, or the
 * links land on different machines: the links are then Mirage's own.
 * Mirrors Python's `_link_runtime`.
 *
 * @param made each link's absolute path and its target, resolved as the
 *   link will resolve it.
 * @param symbolic whether the links are symbolic.
 * @param session the session it runs in.
 * @param registry the workspace's mounts and machines.
 * @param links the session's link table.
 */
async function linkRuntime(
  made: readonly (readonly [string, string])[],
  symbolic: boolean,
  session: SessionState,
  registry: MountRegistry,
  links: NamespaceReader,
): Promise<RemoteRuntime | null> {
  const scopes: [string, boolean][] = [
    ...made.map(([link]): [string, boolean] => [parent(link), true]),
    ...made.map(([, target]): [string, boolean] => [target, false]),
  ]
  const mounts = heldMounts(scopes, session, registry, links)
  if (mounts === null || (await registry.policies.wantsFor('preVfs', session.sessionId)))
    return null
  const machines = new Set<string>()
  for (const [at, [link, target]] of made.entries()) {
    const folder = mounts[at]
    const aimed = mounts[made.length + at]
    if (folder === undefined || !(folder.vfs instanceof MachineVFS)) return null
    if (aimed === undefined || !(aimed.vfs instanceof MachineVFS)) return null
    const spec = onMount(folder, link)
    const held = await holders(aimed.vfs.accessor, onMount(aimed, target))
    let machine: string
    if (held.length > 0) {
      machine = chosen(aimed.vfs.accessor, held).machine
    } else if (symbolic) {
      try {
        machine = await newNameMachine(folder.vfs.accessor, spec)
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOTDIR') throw error
        console.debug(`${link}: its folder is a file:`, error)
        return null
      }
    } else {
      return null
    }
    const above = await holders(folder.vfs.accessor, folderOf(spec))
    if (above.length === 0 || !folderThere(chosen(folder.vfs.accessor, above))) return null
    if (!above.some((one) => one.machine === machine && folderThere(one))) return null
    if (
      above.length > 1 &&
      (await holders(folder.vfs.accessor, spec)).some((one) => one.machine !== machine)
    )
      return null
    machines.add(machine)
  }
  return runtimeOf([...machines].sort(compareCodePoints), registry)
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
 * (`ProgramLookup` has the whole rule), unless that machine refuses the
 * session's runs (`refusesSession`). Mirrors Python's `lookup_machine`.
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
  if (!(runtime instanceof RemoteRuntime) || runtime.refusesSession()) return null
  return runtime
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
  const name = stripSlash(mountKey(target, entry.prefix))
  if (name === '' || name.includes('/')) return null
  if (lookupMachine(name, session, registry, routing, true) === null) return null
  return name
}

/**
 * The line a machine runs for a lookup: the command the agent typed, on this
 * one name, after `--` where it starts with a dash, so the machine reads it
 * as the name it is. `type` and `command` are bash's builtins, so they run
 * in the machine's bash, its `sh` where it has none; dash's `type` takes no
 * options, so there it gets the name bare.
 *
 * @param command `which`, `type` or `command`.
 * @param letters the options the agent gave it.
 * @param name the name looked up.
 */
function lookupLine(command: string, letters: string, name: string): string {
  const words = [command, ...(letters !== '' ? [`-${letters}`] : [])]
  const line = shellJoin([...words, ...(name.startsWith('-') ? ['--'] : []), name])
  if (command === 'which') return line
  const plain = command === 'type' ? shellJoin([...words, name]) : line
  return `if [ -x /bin/bash ]; then exec /bin/bash -c ${shellQuote(line)}; fi; exec /bin/sh -c ${shellQuote(plain)}`
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
