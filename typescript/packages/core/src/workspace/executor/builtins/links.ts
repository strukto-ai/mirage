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

import { resolvePath } from '../../../commands/spec/parser.ts'
import { IOResult } from '../../../io/types.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
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
export const NO_FOLLOW_COMMANDS = new Set(['rm', 'mv', 'ln', 'readlink', 'rmdir'])

function typed(arg: string | PathSpec): string {
  if (arg instanceof PathSpec) return arg.rawPath ?? arg.virtual
  return arg
}

function abs(arg: string | PathSpec, cwd: string): string {
  if (arg instanceof PathSpec) return arg.virtual
  return resolvePath(cwd, arg)
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
  const linkAbs = abs(linkArg, session.cwd)
  const targetTyped = typed(targetArg)
  const exists = namespace.isLink(linkAbs) && !flags.has('f')
  if (namespace.isMountRoot(linkAbs) || exists) {
    return errorResult(
      'ln',
      `ln: failed to create symbolic link '${typed(linkArg)}': File exists\n`,
    )
  }
  namespace.symlink(linkAbs, targetTyped, Date.now() / 1000)
  let out: Uint8Array | null = null
  if (flags.has('v')) {
    out = new TextEncoder().encode(`'${typed(linkArg)}' -> '${targetTyped}'\n`)
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
      if (err instanceof CycleError) throw new CycleError(item.rawPath ?? item.virtual)
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
        rawPath: item.rawPath ?? item.virtual,
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
  early: Result | null
}

// Adjust a two-operand `mv` for symlink operands. A link source renames the
// link entry itself (into a destination directory when one exists). A link
// destination whose target is a directory is followed (mv moves into it);
// any other link destination is replaced, so its entry must drop once the
// backend move succeeds.
export async function prepareMv(
  namespace: Namespace,
  dispatch: DispatchFn,
  items: (string | PathSpec)[],
): Promise<PreparedMv> {
  const paths = items.filter((p): p is PathSpec => p instanceof PathSpec)
  const src = paths[0]
  const dst = paths[1]
  if (paths.length !== 2 || src === undefined || dst === undefined) {
    return { items, postUnlink: null, early: null }
  }

  if (namespace.isLink(src.virtual)) {
    let targetDst = dst.virtual
    const stat = await statOrNull(dispatch, dst)
    if (stat !== null && stat.type === FileType.DIRECTORY) {
      const name = src.virtual.slice(src.virtual.lastIndexOf('/') + 1)
      targetDst = rstripSlash(dst.virtual) + '/' + name
    }
    namespace.unlink(targetDst)
    namespace.rename(src.virtual, targetDst)
    const early: Result = [null, new IOResult(), new ExecutionNode({ command: 'mv', exitCode: 0 })]
    return { items, postUnlink: null, early }
  }

  if (namespace.isLink(dst.virtual)) {
    const followed = namespace.follow(dst.virtual)
    const stat = await statOrNull(dispatch, PathSpec.fromStrPath(followed))
    if (stat !== null && stat.type === FileType.DIRECTORY) {
      return { items: followPaths(namespace, items), postUnlink: null, early: null }
    }
    return { items, postUnlink: dst.virtual, early: null }
  }

  return { items, postUnlink: null, early: null }
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
