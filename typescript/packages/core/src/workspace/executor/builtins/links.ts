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

import { resolvePath } from '../../../utils/path.ts'
import { IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec, wordText } from '../../../types.ts'
import { CycleError } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { DispatchFn } from '../cross_mount.ts'
import type { Namespace } from '../../mount/namespace.ts'
import type { Session } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'
import type { Result } from './scope.ts'

// Commands whose path operands name the link itself (lstat semantics):
// rm/mv mutate the link entry, ln/readlink inspect it, rmdir must not
// descend through it. Everything else follows links before dispatch,
// mirroring open(2).

function abs(arg: string | PathSpec, cwd: string): string {
  if (arg instanceof PathSpec) return arg.virtual
  return resolvePath(arg, cwd)
}

function allKnown(chars: string, known: string): boolean {
  for (const c of chars) if (!known.includes(c)) return false
  return true
}

function splitFlags(
  args: (string | PathSpec)[],
  known: string,
): [Set<string>, (string | PathSpec)[]] {
  const flags = new Set<string>()
  const operands: (string | PathSpec)[] = []
  let parsing = true
  for (const arg of args) {
    const s = arg instanceof PathSpec ? arg.virtual : arg
    if (parsing && s === '--') {
      parsing = false
      continue
    }
    if (parsing && s !== '-' && s.length >= 2 && s.startsWith('-') && allKnown(s.slice(1), known)) {
      for (const c of s.slice(1)) flags.add(c)
      continue
    }
    parsing = false
    operands.push(arg)
  }
  return [flags, operands]
}

export function linkFlags(args: (string | PathSpec)[], known: string): Set<string> {
  return splitFlags(args, known)[0]
}

function errorResult(command: string, message: string): Result {
  const err = new TextEncoder().encode(message)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command, exitCode: 1, stderr: err }),
  ]
}

export function handleLn(
  namespace: Namespace,
  session: Session,
  args: (string | PathSpec)[],
): Result {
  const [flags, operands] = splitFlags(args, 'sfnv')
  const targetArg = operands[0]
  const linkArg = operands[1]
  if (targetArg === undefined || linkArg === undefined) {
    return errorResult('ln', 'ln: missing file operand\n')
  }
  // GNU: with more than two operands the last must be a directory;
  // namespace links never name directories, so this is always an error
  // (an expanded multi-match glob source lands here).
  if (operands.length > 2) {
    const last = operands[operands.length - 1]
    return errorResult('ln', `ln: target '${wordText(last ?? '')}' is not a directory\n`)
  }
  const linkAbs = abs(linkArg, session.cwd)
  const targetTyped = wordText(targetArg)
  const exists = namespace.isLink(linkAbs) && !flags.has('f')
  if (namespace.isMountRoot(linkAbs) || exists) {
    return errorResult(
      'ln',
      `ln: failed to create symbolic link '${wordText(linkArg)}': File exists\n`,
    )
  }
  namespace.symlink(linkAbs, targetTyped, Date.now() / 1000)
  let out: Uint8Array | null = null
  if (flags.has('v')) {
    out = new TextEncoder().encode(`'${wordText(linkArg)}' -> '${targetTyped}'\n`)
  }
  return [out, new IOResult(), new ExecutionNode({ command: 'ln', exitCode: 0 })]
}

// Rewrite path operands through the symlink table (open(2) semantics).
// A rewritten spec keeps the user-typed form in `rawPath` so error messages
// still name the operand as typed; the mount re-stamps `resourcePath` at
// dispatch. Throws CycleError (carrying the typed operand) on ELOOP.
export function followPaths(
  namespace: Namespace,
  items: (string | PathSpec)[],
): (string | PathSpec)[] {
  const out: (string | PathSpec)[] = []
  for (const item of items) {
    if (!(item instanceof PathSpec)) {
      out.push(item)
      continue
    }
    let virtual: string
    try {
      virtual = namespace.follow(item.virtual)
    } catch (err) {
      if (err instanceof CycleError) throw new CycleError(item.rawPath)
      throw err
    }
    if (virtual === item.virtual) {
      out.push(item)
      continue
    }
    out.push(
      new PathSpec({
        virtual,
        directory: virtual.slice(0, virtual.lastIndexOf('/') + 1) || '/',
        resourcePath: '',
        pattern: item.pattern,
        resolved: item.resolved,
        rawPath: item.rawPath,
      }),
    )
  }
  return out
}

// Unlink and drop `rm` operands that are symlinks. GNU rm removes the link
// itself and never follows it; a dangling link removes fine.
export function stripLinkOperands(
  namespace: Namespace,
  items: (string | PathSpec)[],
): [(string | PathSpec)[], number] {
  let removed = 0
  const kept: (string | PathSpec)[] = []
  for (const item of items) {
    if (item instanceof PathSpec && namespace.isLink(item.virtual)) {
      namespace.unlink(item.virtual)
      removed += 1
      continue
    }
    kept.push(item)
  }
  return [kept, removed]
}

async function statOrNull(dispatch: DispatchFn, path: PathSpec): Promise<FileStat | null> {
  // A missing destination is an expected mv case (plain rename), not an
  // error to surface.
  try {
    const [stat] = await dispatch('stat', path)
    return stat instanceof FileStat ? stat : null
  } catch {
    return null
  }
}

export interface PreparedMv {
  items: (string | PathSpec)[]
  postUnlink: string | null
  postRename: [string, string] | null
  early: Result | null
}

// Adjust a two-operand `mv` for node-meta operands. A link source renames
// the link entry itself. A destination that is (a link to) a directory
// receives the move inside it (rename(2) preceded by mv's dst stat); any
// other destination is replaced, so its node entry, link or overlay attrs
// alike, drops once the backend move succeeds. A plain source that carries
// overlay attributes has its meta travel with the file once the backend
// move succeeds.
export async function prepareMv(
  namespace: Namespace,
  dispatch: DispatchFn,
  items: (string | PathSpec)[],
): Promise<PreparedMv> {
  const paths = items.filter((p): p is PathSpec => p instanceof PathSpec)
  const src = paths[0]
  const dst = paths[1]
  if (paths.length !== 2 || src === undefined || dst === undefined) {
    return { items, postUnlink: null, postRename: null, early: null }
  }

  // Where the move lands: inside a directory destination (followed, so
  // node-meta keys line up with the followed paths stat merges on), else
  // the destination itself, replaced like rename(2).
  const followed = namespace.follow(dst.virtual)
  const stat = await statOrNull(dispatch, PathSpec.fromStrPath(followed))
  const intoDir = stat !== null && stat.type === FileType.DIRECTORY
  let targetDst = dst.virtual
  if (intoDir) {
    const name = src.virtual.slice(src.virtual.lastIndexOf('/') + 1)
    targetDst = rstripSlash(followed) + '/' + name
  }

  if (namespace.isLink(src.virtual)) {
    namespace.unlink(targetDst)
    namespace.rename(src.virtual, targetDst)
    const early: Result = [null, new IOResult(), new ExecutionNode({ command: 'mv', exitCode: 0 })]
    return { items, postUnlink: null, postRename: null, early }
  }

  let postRename: [string, string] | null = null
  if (namespace.metaFor(src.virtual) !== null) {
    postRename = [src.virtual, targetDst]
  }

  const rewritten = intoDir && namespace.isLink(dst.virtual) ? followPaths(namespace, items) : items
  return { items: rewritten, postUnlink: targetDst, postRename, early: null }
}

export function handleReadlink(
  namespace: Namespace,
  session: Session,
  args: (string | PathSpec)[],
): Result {
  const [flags, operands] = splitFlags(args, 'fenm')
  if (operands.length === 0) {
    return errorResult('readlink', 'readlink: missing operand\n')
  }
  const lines: string[] = []
  let exitCode = 0
  for (const op of operands) {
    const target = namespace.readlink(abs(op, session.cwd))
    if (target === null) {
      exitCode = 1
      continue
    }
    lines.push(target)
  }
  if (lines.length === 0) {
    return [null, new IOResult({ exitCode }), new ExecutionNode({ command: 'readlink', exitCode })]
  }
  const text = flags.has('n') ? lines.join('') : lines.map((l) => l + '\n').join('')
  return [
    new TextEncoder().encode(text),
    new IOResult({ exitCode }),
    new ExecutionNode({ command: 'readlink', exitCode }),
  ]
}
