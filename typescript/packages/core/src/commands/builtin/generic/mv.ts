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

import { rekey } from '../../../utils/key_prefix.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec, type MoveStrategy, type PrimitiveMove, type StatFn } from '../../../types.ts'
import {
  backendKeyDefault,
  copyTargets,
  isDirectory,
  pathExists,
  type BackendKeyFn,
} from '../utils/copy.ts'
import { fsStrerror, isFsError } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { copyEntries, cpWalk } from './cp.ts'

const ENC = new TextEncoder()

function isPrimitiveMove(strategy: MoveStrategy): strategy is PrimitiveMove {
  return 'readBytes' in strategy
}

// Remove copied source entries children first, GNU rm style. A failed
// removal is reported per entry ('mv: cannot remove ...') and the remaining
// entries are still attempted; directories with a failed descendant are
// skipped silently like GNU, which never reports the not-empty ancestors of
// a file it could not remove. Returns whether the source changed at all and
// whether it is fully gone.
// Confirm a failed removal actually left something behind. On dirless
// object stores a directory vanishes with its last child, so a failed
// rmdir of a path that no longer exists (or that no longer lists any
// children — an existing empty directory is impossible there) is a
// completed removal, not an error. The listing check covers index
// backends whose per-entry stat can lag a just-unlinked child within a
// command.
async function entryGone(
  strategy: PrimitiveMove,
  stat: StatFn,
  spec: PathSpec,
  isDir: boolean,
): Promise<boolean> {
  if (!(await pathExists(stat, spec))) return true
  if (!isDir) return false
  let children: string[]
  try {
    children = await strategy.readdir(spec)
  } catch (err) {
    if (!isFsError(err)) throw err
    return true
  }
  return children.length === 0
}

async function removeEntries(
  strategy: PrimitiveMove,
  stat: StatFn,
  src: PathSpec,
  entries: { path: string; isDir: boolean }[],
  errors: string[],
): Promise<{ removedAny: boolean; removedAll: boolean }> {
  const failed: string[] = []
  let removedAny = false
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const node = entries[i]
    if (node === undefined) continue
    const base = rstripSlash(node.path)
    if (node.isDir && failed.some((f) => f.startsWith(base + '/'))) {
      failed.push(base)
      continue
    }
    const spec = PathSpec.fromStrPath(node.path, rekey(src.virtual, src.resourcePath, node.path))
    try {
      if (node.isDir) await strategy.rmdir(spec)
      else await strategy.unlink(spec)
    } catch (err) {
      if (!isFsError(err)) throw err
      if (await entryGone(strategy, stat, spec, node.isDir)) {
        removedAny = true
        continue
      }
      errors.push(`mv: cannot remove '${node.path}': ${String(fsStrerror(err))}`)
      failed.push(base)
      continue
    }
    removedAny = true
  }
  return { removedAny, removedAll: failed.length === 0 }
}

// Move sources to a destination, fanning out into a directory. NativeMove
// uses an atomic backend rename. PrimitiveMove handles cross-mount moves by
// copying the tree (parents first, via cpWalk plus mkdir/write) and then
// removing the source children first. Failures follow GNU mv on a
// cross-device move: a copy failure keeps the whole source and skips
// removal, a removal failure (e.g. a source mount with no unlink) reports
// 'cannot remove' and leaves the copied destination in place; either way
// the remaining sources still move.
export async function mvGeneric(
  paths: PathSpec[],
  stat: StatFn,
  strategy: MoveStrategy,
  noClobber: boolean,
  verbose: boolean,
  index?: IndexCacheStore,
  backendKey?: BackendKeyFn,
): Promise<[ByteSource | null, IOResult]> {
  const keyOf = backendKey ?? backendKeyDefault
  const sources = paths.slice(0, -1)
  const dst = paths[paths.length - 1]
  if (dst === undefined) return [null, new IOResult()]
  const dstIsDir = await isDirectory(stat, dst, index)
  const writes: Record<string, ByteSource> = {}
  const lines: string[] = []
  const errors: string[] = []
  for (const [src, target] of copyTargets(sources, dst, dstIsDir)) {
    if (!(await pathExists(stat, src))) {
      errors.push(`mv: cannot stat '${src.virtual}': No such file or directory`)
      continue
    }
    if (keyOf(src) === keyOf(target)) {
      errors.push(`mv: '${src.virtual}' and '${target.virtual}' are the same file`)
      continue
    }
    if (keyOf(target).startsWith(keyOf(src) + '/')) {
      errors.push(
        `mv: cannot move '${src.virtual}' to a subdirectory of itself, '${target.virtual}'`,
      )
      continue
    }
    if (noClobber && (await pathExists(stat, target))) continue
    if (isPrimitiveMove(strategy)) {
      const entries = await cpWalk(strategy.readdir, stat, src, index)
      const { copiedAll, wroteAny } = await copyEntries(
        'mv',
        strategy,
        stat,
        src,
        target,
        entries,
        errors,
        index,
      )
      if (wroteAny) writes[target.mountPath] = new Uint8Array()
      // GNU keeps the whole source tree when any copy failed; the
      // destination keeps the entries that landed.
      if (!copiedAll) continue
      const { removedAny, removedAll } = await removeEntries(strategy, stat, src, entries, errors)
      if (removedAny) writes[src.mountPath] = new Uint8Array()
      // GNU leaves the copied destination in place and reports the source
      // entries it could not remove.
      if (!removedAll) continue
    } else {
      await strategy.rename(src, target)
      writes[src.mountPath] = new Uint8Array()
      writes[target.mountPath] = new Uint8Array()
    }
    if (verbose) lines.push(`renamed '${src.virtual}' -> '${target.virtual}'`)
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [output, new IOResult({ writes, stderr, exitCode: errors.length > 0 ? 1 : 0 })]
}
