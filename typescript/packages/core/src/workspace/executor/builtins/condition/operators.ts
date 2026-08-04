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
import type { ByteSource } from '../../../../io/types.ts'
import type { FileStat } from '../../../../types.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import { resolvePath, resolveSymlinks } from '../../../../utils/path.ts'
import { resolvePathStat } from '../links.ts'
import { toScope, scopePath } from '../scope.ts'
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
): Promise<['dir' | 'file' | null, FileStat | null]> {
  const stat = await resolvePathStat(ctx.dispatch, operandScope(ctx, val))
  if (stat === null) return [null, null]
  if (stat.type === FileType.DIRECTORY) return ['dir', stat]
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

export function applyBinary(
  ctx: CondContext,
  left: string | PathSpec,
  op: string,
  right: string | PathSpec,
): boolean {
  const lt = scopePath(left)
  const rt = scopePath(right)
  if (op === '=' || op === '==') return lt === rt
  if (op === '!=') return lt !== rt
  const compare = INT_COMPARATORS.get(op)
  if (compare !== undefined) {
    return compare(toInt(ctx, lt), toInt(ctx, rt))
  }
  if (FILE_PAIR_BINARY.has(op)) {
    throw new CondError(`${ctx.name}: ${op}: unsupported operator`)
  }
  throw new CondError(`${ctx.name}: ${op}: binary operator expected`)
}
