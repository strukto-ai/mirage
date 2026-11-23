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

import { SPECS, parseCommand } from '../../../commands/spec/index.ts'
import { WordKind } from '../../../commands/spec/types.ts'
import { findLayout } from '../../../rs/find.ts'
import { isFsError } from '../../../errors/fs.ts'
import type { ByteSource } from '../../../io/types.ts'
import type { CommandWord } from '../../../policy/types.ts'
import type { RemoteRuntime } from '../../../runtime/machine/runtime.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { PathSpec } from '../../../types.ts'
import { unmarkGlobs } from '../../../utils/glob_walk.ts'
import { norm } from '../../../utils/path.ts'
import type { NamespaceReader } from '../../dispatcher/reader.ts'
import type { Argv } from '../../expand/argv.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import type { SessionState } from '../../session/session.ts'
import { FOLDER_FREE } from '../constants.ts'
import { Consumer, type ExternalTarget } from '../types.ts'
import {
  isPiped,
  machineHoldingAll,
  machineMount,
  machineMounts,
  mountMachines,
  onlyMachine,
} from './mounts.ts'

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
  if (isPiped(stdin)) return null
  const [paths, relative] = namedPaths(argv, session.cwd)
  const scopes: [string, boolean][] = paths.map((path) => [path, true])
  const cwd = norm(session.cwd)
  let runtime = await machineHoldingAll(
    scopes,
    session,
    registry,
    links,
    null,
    cwd === '/' ? null : cwd,
  )
  let runsFrom: string | null = null
  if (runtime === null && !relative && cwd !== '/' && FOLDER_FREE.has(argv.name)) {
    runtime = await machineHoldingAll(scopes, session, registry, links, null)
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
    const mounts = machineMounts(scoped, session, registry, links)
    if (mounts === null) continue
    let machines: string[] | null = null
    for (const [at, entry] of mounts.entries()) {
      const shown = mountMachines(entry, registry)
      // Only the run finds who holds a name several machines show.
      if (shown.length > 1 && at < scopes.length) {
        machines = []
        break
      }
      machines = machines === null ? shown : machines.filter((m) => shown.includes(m))
    }
    const runtime = onlyMachine(machines ?? [], registry)
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
  if (machineMount(registry, links, spec.virtual, false) === null) return null
  try {
    await dispatch('stat', spec)
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`${path}: not run on its machine: ${String(err)}`)
    return null
  }
  return machineHoldingAll([[spec.virtual, false]], session, registry, links, stdin)
}
