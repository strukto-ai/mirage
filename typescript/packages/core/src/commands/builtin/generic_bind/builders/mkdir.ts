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

import { formatOptionalRecords } from '../../utils/output.ts'
import { operandsIo } from '../../utils/operands.ts'
import { posixPhrase } from '../../../../errors/posix.ts'
import { errorVirtualPath, fsStrerror, isFsError } from '../../../../errors/fs.ts'
import { operandSpelling } from '../../../../errors/render.ts'
import { DEFAULT_DIR_MODE, parseChmod } from '../../../../utils/mode.ts'
import { DEFAULT_UMASK, sessionUmask, walkProbeFor } from '../../../../context/session_context.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { mkdirLinkRefusal } from '../../utils/slash_links.ts'
import {
  descendantPath,
  dispatchStat,
  entryKind,
  linkFollow,
  nearestAncestor,
} from '../../utils/paths.ts'
import type { LinkView } from '../../../../view/types.ts'
import { FileType, PathSpec, type WalkProbe } from '../../../../types.ts'
import { CycleError, norm, parent, walkNodes } from '../../../../utils/path.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles } from '../files.ts'
import { missingOperandError } from '../../../spec/usage.ts'
import { linksOf, mountRoot } from '../../utils/links.ts'

/**
 * Make one name of a walk a directory, or say why it is not one.
 *
 * Judged the way GNU's walk into the name is, before anything is made: a
 * directory, or a link to one, is passed through; a plain file, or a link to
 * one, is ENOTDIR; a dangling link is EEXIST, and a looping one ELOOP. Only
 * a missing name is made,
 * where its links lead, so no store is asked to make a directory over a file
 * or under a link it cannot see. Outside a workspace command there is no stat
 * to judge with, and the store's own mkdir answers. Mirrors Python's
 * _enter_node.
 */
async function enterNode(
  mkdir: (path: PathSpec, parents?: boolean) => Promise<void>,
  path: PathSpec,
  node: string,
  root: string,
  links: LinkView | null,
  probe: WalkProbe | null,
): Promise<string | null> {
  if (links !== null && links.statAt(node) !== null) {
    try {
      links.resolve(node)
    } catch (err) {
      if (!(err instanceof CycleError)) throw err
      return posixPhrase('ELOOP')
    }
    const target = await links.targetStat(node)
    if (target === null) return posixPhrase('EEXIST')
    return target.type === FileType.DIRECTORY ? null : posixPhrase('ENOTDIR')
  }
  if (probe !== null) {
    const { exists, isDir } = await entryKind(probe.stat, PathSpec.fromStrPath(node))
    if (exists) return isDir ? null : posixPhrase('ENOTDIR')
  }
  const real = links !== null ? links.resolve(node) : node
  if (real.startsWith(`${root}/`)) await mkdir(descendantPath(path, real), true)
  return null
}

/**
 * Make every name an operand's walk enters, GNU `mkdir -p` style.
 *
 * The backend's `parents` makes the ancestors of the simplified path, which
 * skips a name the walk passes through on its way to a `..`: GNU creates
 * `nope` for `mkdir -p nope/../m`. The operand itself is left to the caller;
 * a name in the way is quoted as the operand spells it. Null when every name
 * is made. Mirrors Python's _make_walked.
 */
async function makeWalked(
  mkdir: (path: PathSpec, parents?: boolean) => Promise<void>,
  path: PathSpec,
  dotted: string,
  root: string,
  links: LinkView | null,
  probe: WalkProbe | null,
): Promise<string | null> {
  const follow = links === null ? null : (virtual: string) => links.resolve(virtual)
  for (const [node, spelled] of walkNodes(dotted, path.rawPath, follow)) {
    let why: string | null
    try {
      why = await enterNode(mkdir, path, node, root, links, probe)
    } catch (err) {
      if (!isFsError(err)) throw err
      why =
        (err as { code?: string }).code === 'EEXIST'
          ? posixPhrase('ENOTDIR')
          : String(fsStrerror(err))
    }
    if (why !== null) return `mkdir: cannot create directory '${spelled}': ${why}`
  }
  return null
}

/**
 * Make one mkdir operand, or the line GNU reports when it cannot.
 *
 * One unusable operand is not an aborted command: GNU reports it and still
 * makes the remaining directories. The error names the path to quote:
 * usually the operand, but `mkdir -p` blames the component of the chain it
 * tripped on. Every mkdir makes its operands here, a keyed store's override
 * included, so they report alike. Mirrors Python's make_directory.
 */
// The names a verbose mkdir reports for `path`, top-down, as GNU spells them.
// One backend mkdir makes a `-p` chain without saying which names it made, so
// the chain is probed before the create: every name below the nearest
// existing ancestor, or none when `path` already exists. A dotted operand is
// walked as typed, the way `-p` enters it, so `nope/../m` reports `nope` too,
// each name spelled by the prefix of the operand that reaches it. Outside a
// workspace there is nothing to probe with, and the operand alone is
// reported. Mirrors Python's created_names.
export async function createdNames(
  path: PathSpec,
  parents: boolean,
  links: LinkView | null = null,
  probe: WalkProbe | null = walkProbeFor(path.virtual),
): Promise<string[]> {
  if (!parents || probe === null) return [operandSpelling(path.virtual, path)]
  const named = PathSpec.fromStrPath(path.virtual)
  const names: string[] = []
  if (path.dotted !== null) {
    const follow = links === null ? null : (virtual: string) => links.resolve(virtual)
    const made = new Set<string>()
    for (const [node, spelled] of walkNodes(path.dotted, path.rawPath, follow)) {
      if (made.has(node) || (await entryKind(probe.stat, PathSpec.fromStrPath(node))).exists) {
        continue
      }
      made.add(node)
      names.push(spelled)
    }
    if (made.has(norm(path.virtual)) || (await entryKind(probe.stat, named)).exists) return names
    return [...names, operandSpelling(path.virtual, path)]
  }
  if ((await entryKind(probe.stat, named)).exists) return []
  const [top] = await nearestAncestor(probe.stat, named)
  let node = norm(path.virtual)
  while (node !== top && node !== '/') {
    names.push(operandSpelling(node, path))
    node = parent(node)
  }
  return names.reverse()
}

// GNU's `mkdir -v` lines. Mirrors Python's created_lines.
export function createdLines(names: string[]): string[] {
  return names.map((name) => `mkdir: created directory '${name}'`)
}

export async function makeDirectory(
  mkdir: (path: PathSpec, parents?: boolean) => Promise<void>,
  path: PathSpec,
  parents: boolean,
  root: string,
  links: LinkView | null = null,
  probe: WalkProbe | null = walkProbeFor(path.virtual),
): Promise<string | null> {
  let target = path
  // -p enters the names in front of the operand one at a time, so a dot
  // among them, or a link loop the walk refused the operand for, is met at
  // that name and GNU quotes it rather than the operand.
  if (parents && (path.dotted !== null || path.walkError === 'ELOOP')) {
    const failed = await makeWalked(mkdir, path, path.dotted ?? path.virtual, root, links, probe)
    if (failed !== null) return failed
    // The walk has entered every name the spelling passes through, so the
    // operand is made by its resolved path alone: walking it again would ask
    // a store that shows no empty directory (hf) for one the walk just made.
    target = new PathSpec({
      virtual: path.virtual,
      directory: path.directory,
      vfsPath: path.vfsPath,
      pattern: path.pattern,
      resolved: path.resolved,
      rawPath: path.rawPath,
      walkError: path.walkError,
    })
  }
  try {
    await mkdir(target, parents)
  } catch (err) {
    if (!isFsError(err)) throw err
    const named = operandSpelling(errorVirtualPath(err), path)
    return `mkdir: cannot create directory '${named}': ${String(fsStrerror(err))}`
  }
  return null
}

const mkdir: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const fl = new FlagView(ctx.flags, specOf('mkdir'))
  const parents = fl.asBool('parents')
  const verbose = fl.asBool('verbose')
  const modeText = fl.asStr('mode') ?? null
  if (paths.length === 0) throw missingOperandError('mkdir', null)
  let mode: number | null = null
  if (modeText !== null) {
    // Symbolic clauses build on what mirage renders for a new
    // directory; `-m` is applied after the create, so the session's
    // umask does not reach it, which is GNU's rule too.
    mode = parseChmod(modeText, DEFAULT_DIR_MODE)
    if (mode === null) throw new Error(`mkdir: invalid mode '${modeText}'`)
  } else {
    // A new directory is 0777 masked by the session's umask. Only a
    // mask away from bash's default costs a setattr, since 755 is what
    // every backend already renders for a fresh directory; parents
    // made by `-p` keep that default. A backend without permission
    // bits keeps the mode in the attribute overlay, as it keeps a chmod.
    const umask = sessionUmask(ctx.session?.access())
    if (umask !== DEFAULT_UMASK) mode = 0o777 & ~umask
  }
  const resolved = await files.resolveGlob(paths)
  const lines: string[] = []
  const errors: string[] = []
  const links = linksOf(ctx) ?? null
  const probe: WalkProbe | null =
    ctx.vfs === undefined
      ? null
      : { stat: dispatchStat(ctx.vfs.dispatch), follow: linkFollow(links) }
  for (const p of resolved) {
    const collision = await mkdirLinkRefusal(p, links, { parents })
    if (collision.taken) {
      if (collision.message !== null) errors.push(collision.message)
      continue
    }
    const names = verbose ? await createdNames(p, parents, links, probe) : []
    const failed = await makeDirectory(files.mkdir, p, parents, mountRoot(ctx), links, probe)
    if (failed !== null) {
      errors.push(failed)
      continue
    }
    // -m applies to the named directory only; any parents made by -p keep
    // the default mode (GNU).
    if (mode !== null) await files.setAttrs(p, { mode })
    lines.push(...createdLines(names))
  }
  return [formatOptionalRecords(lines), operandsIo(errors.map((line) => `${line}\n`).join(''))]
}

export const BUILDER: GenericCommand = {
  name: 'mkdir',
  write: true,
  fn: mkdir,
}
