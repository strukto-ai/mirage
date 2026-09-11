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

import { materialize } from '../../../../io/types.ts'
import { ArithError, ExitSignal } from '../../../../shell/errors.ts'
import type { ByteSource } from '../../../../io/types.ts'
import type { FileStat } from '../../../../types.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import { CycleError, resolvePath, resolveSymlinks } from '../../../../utils/path.ts'
import { isoTimestamp } from '../../../../utils/dates.ts'
import { resolvePathStat } from '../links/index.ts'
import { toScope, scopePath } from '../scope.ts'
import { elementIsSet } from '../../../session/elements.ts'
import { FILE_PAIR_BINARY, FILE_UNARY, INT_COMPARATORS, UNSUPPORTED_UNARY } from './constants.ts'
import { CondError } from './types.ts'
import type { CondContext } from './types.ts'

/** Resolve a file operand to an addressable scope. */
function operandScope(ctx: CondContext, val: string | PathSpec): PathSpec {
  if (val instanceof PathSpec) return val
  let resolved = resolvePath(val, ctx.session.cwd)
  resolved = resolveSymlinks(resolved, ctx.namespace.symlinkTargets())
  return toScope(resolved)
}

/**
 * Resolve an operand to 'dir' / 'file' / null plus its stat. Symlinks are
 * followed first, then resolvePathStat answers what is there. That probe is
 * shared with find and tree's start point, so `test -d` and a traversal
 * cannot disagree about whether a path exists.
 */
async function pathKind(
  ctx: CondContext,
  val: string | PathSpec,
): Promise<['dir' | 'file' | 'char' | null, FileStat | null]> {
  let scope: PathSpec
  try {
    scope = operandScope(ctx, val)
  } catch (err) {
    // A link loop names nothing: stat fails with ELOOP and bash reads
    // that as absent (`[ loop -ef loop ]` and `[ -e loop ]` are false),
    // so a file test answers false rather than erroring.
    if (err instanceof CycleError) return [null, null]
    throw err
  }
  const stat = await resolvePathStat(ctx.dispatch, scope)
  if (stat === null) return [null, null]
  if (stat.type === FileType.DIRECTORY) return ['dir', stat]
  if (stat.type === FileType.CHAR_DEVICE) return ['char', stat]
  return ['file', stat]
}

export async function applyUnary(
  ctx: CondContext,
  op: string,
  val: string | PathSpec,
): Promise<boolean> {
  const text = scopePath(val)
  if (op === '-n') return text !== ''
  if (op === '-z') return text === ''
  if (op === '-v') {
    try {
      return await elementIsSet(ctx.session, text, ctx.view ?? null)
    } catch (err) {
      // bash aborts the line on `[[ -v a[1/0] ]]` with `1/0: division by
      // 0`, a test's grammar error being the only other thing that ends it.
      if (err instanceof ArithError) {
        throw new ExitSignal(1, new TextEncoder().encode(`bash: ${err.message}\n`), null, 1)
      }
      throw err
    }
  }
  if (op === '-L' || op === '-h') {
    const resolved = resolvePath(text, ctx.session.cwd)
    return ctx.namespace.isLink(resolved)
  }
  if (FILE_UNARY.has(op)) {
    if (!(val instanceof PathSpec) && text === '') return false
    const [kind, stat] = await pathKind(ctx, val)
    if (op === '-e') return kind !== null
    if (op === '-f') return kind === 'file'
    if (op === '-d') return kind === 'dir'
    if (op === '-c') return kind === 'char'
    if (op === '-s') {
      if (kind === 'dir') return true
      if (kind !== 'file' || stat === null) return false
      if (stat.size !== null) return stat.size > 0
      // API backends (dropbox, gdrive, box) stat freshly written empty
      // files as size-unknown; only a read can answer, and the
      // prefetch TTL cache keeps repeat tests cheap.
      const [data] = await ctx.dispatch('read', operandScope(ctx, val))
      return (await materialize(data as ByteSource | null)).length > 0
    }
    if (op === '-r' || op === '-w') {
      // Mirage has no per-user access model: whatever exists in a
      // mount is readable and writable through it.
      return kind !== null
    }
    if (op === '-x') {
      if (kind === 'dir') return true
      if (kind !== 'file' || stat === null) return false
      return stat.mode !== null && (stat.mode & 0o111) !== 0
    }
  }
  if (UNSUPPORTED_UNARY.has(op)) {
    throw new CondError(`${ctx.name}: ${op}: unsupported operator`)
  }
  throw new CondError(`${ctx.name}: ${op}: unary operator expected`)
}

function toInt(ctx: CondContext, text: string): bigint {
  const trimmed = text.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new CondError(`${ctx.name}: ${text}: integer expression expected`)
  }
  return BigInt(trimmed)
}

export async function applyBinary(
  ctx: CondContext,
  left: string | PathSpec,
  op: string,
  right: string | PathSpec,
): Promise<boolean> {
  const lt = scopePath(left)
  const rt = scopePath(right)
  if (op === '=' || op === '==') return lt === rt
  if (op === '!=') return lt !== rt
  const compare = INT_COMPARATORS.get(op)
  if (compare !== undefined) {
    return compare(toInt(ctx, lt), toInt(ctx, rt))
  }
  if (FILE_PAIR_BINARY.has(op)) return applyFilePair(ctx, op, left, right)
  throw new CondError(`${ctx.name}: ${op}: binary operator expected`)
}

/** Stat one file-pair operand, null when it names nothing. An empty word
 * names nothing, as it does for the unary file tests. */
async function pairStat(ctx: CondContext, val: string | PathSpec): Promise<FileStat | null> {
  if (!(val instanceof PathSpec) && scopePath(val) === '') return null
  const [, stat] = await pathKind(ctx, val)
  return stat
}

/**
 * Evaluate `-nt`, `-ot` and `-ef`, with bash's absence rules.
 *
 * `-nt` is true when the left file exists and either the right does not
 * or the left's mtime is strictly later; `-ot` is the mirror. Equal
 * mtimes, or one the backend does not report, make both false. `-ef` is
 * true when both exist and resolve, symlinks followed, to the same
 * virtual path: mirage has no device and inode pair, and a path names
 * exactly one entry across the mount table, so the resolved spelling is
 * the identity. Pinned against GNU bash 5.2.
 */
export async function applyFilePair(
  ctx: CondContext,
  op: string,
  left: string | PathSpec,
  right: string | PathSpec,
): Promise<boolean> {
  let lstat = await pairStat(ctx, left)
  let rstat = await pairStat(ctx, right)
  if (op === '-ef') {
    if (lstat === null || rstat === null) return false
    return (
      operandScope(ctx, left).virtual.replace(/\/+$/, '') ===
      operandScope(ctx, right).virtual.replace(/\/+$/, '')
    )
  }
  if (op === '-ot') [lstat, rstat] = [rstat, lstat]
  if (lstat === null) return false
  if (rstat === null) return true
  const lt = isoTimestamp(lstat.modified)
  const rt = isoTimestamp(rstat.modified)
  return lt !== null && rt !== null && lt > rt
}
