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

import { holders } from '../../core/machine/place.ts'
import { isFsError } from '../../errors/fs.ts'
import type { ByteSource } from '../../io/types.ts'
import { restrictedMountsFor } from '../../runtime/binding.ts'
import { RemoteRuntime } from '../../runtime/machine/runtime.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { unmarkGlobs } from '../../utils/glob_walk.ts'
import { CycleError, norm, parent } from '../../utils/path.ts'
import { MachineVFS } from '../../vfs/machine/machine.ts'
import type { NamespaceReader } from '../dispatcher/reader.ts'
import type { Argv } from '../expand/argv.ts'
import type { MountEntry } from '../mount/mount.ts'
import type { MountRegistry } from '../mount/registry.ts'
import type { SessionState } from '../session/session.ts'

/**
 * The machine mount showing `path` at the same path on its machines, with no
 * other mount and no link of Mirage's own under the path; null for any other
 * path, for one a write may not reach, and for one that walks through a link
 * of Mirage's own, which the machine does not have.
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
  const entry = registry.tryMountFor(path)
  if (entry === null || !(entry.vfs instanceof MachineVFS)) return null
  if (norm(entry.vfs.config.root ?? '/') !== norm(entry.prefix)) return null
  if (writes && entry.mode === MountMode.READ) return null
  const below = `${norm(path).replace(/\/+$/, '')}/`
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
  let candidates: string[] | null = null
  for (const [at, [path]] of scopes.entries()) {
    const vfs = mounts[at]?.vfs
    if (!(vfs instanceof MachineVFS)) return null
    const [, spec] = registry.resolve(path)
    const held = await holders(vfs.accessor, spec)
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
 * session's rules restrict its mount or the mount is read-only; when the cwd
 * is not on the machine; when a path walks through a link of Mirage's own; or
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
