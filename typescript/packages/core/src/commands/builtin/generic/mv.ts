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
import {
  PathSpec,
  type MoveStrategy,
  type NativeMove,
  type PrimitiveMove,
  type ReaddirFn,
  type StatFn,
} from '../../../types.ts'
import { UsageError } from '../../errors.ts'
import { DEFAULT_BACKUP_SUFFIX, backupControl, siblingPath } from '../utils/backup.ts'
import {
  backendKeyDefault,
  copyTargets,
  isDirectory,
  pathExists,
  type BackendKeyFn,
} from '../utils/copy.ts'
import { fsStrerror, isFsError } from '../../../utils/errors.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import {
  backupDisplaces,
  backupRaw,
  copyEntries,
  cpWalk,
  entryKind,
  firstStr,
  makeBackup,
  overwriteGate,
  overwriteTypeError,
  splitOperands,
  targetDirError,
  targetFlags,
  updateMode,
  wrapTargetDir,
  type Flags,
  type TransferPolicy,
} from './cp.ts'

const ENC = new TextEncoder()

// Bound on the --exchange staging-name probe.
const HOLDING_ATTEMPTS = 100

export interface MvFlags {
  noClobber: boolean
  verbose: boolean
  update: string | null
  backup: string | null
  suffix: string
  targetDir: PathSpec | string | null
  noTargetDir: boolean
  exchange: boolean
  noCopy: boolean
}

export function mvFlags(init: Partial<MvFlags> = {}): MvFlags {
  return {
    noClobber: init.noClobber ?? false,
    verbose: init.verbose ?? false,
    update: init.update ?? null,
    backup: init.backup ?? null,
    suffix: init.suffix ?? DEFAULT_BACKUP_SUFFIX,
    targetDir: init.targetDir ?? null,
    noTargetDir: init.noTargetDir ?? false,
    exchange: init.exchange ?? false,
    noCopy: init.noCopy ?? false,
  }
}

function isPrimitiveMove(strategy: MoveStrategy): strategy is PrimitiveMove {
  return 'readBytes' in strategy
}

// Parse the mv flag bag once into a frozen struct. -f/-i are accepted
// no-ops (non-interactive control plane: overwrite always proceeds unless
// -n/--update say otherwise), and --strip-trailing-slashes is a no-op
// because PathSpec already normalizes trailing slashes.
export function parseMvFlags(flags: Flags): MvFlags {
  const update = updateMode('mv', flags)
  const suffix = firstStr(flags.S, flags.suffix)
  const control = backupControl('mv', backupRaw(flags), suffix)
  const noClobber = flags.n === true || flags.no_clobber === true
  const exchange = flags.exchange === true
  if (control !== null && control !== 'none' && (exchange || noClobber || update === 'none-fail')) {
    throw new UsageError(
      'mv: cannot combine --backup with --exchange, -n, or --update=none-fail\n' +
        "Try 'mv --help' for more information.",
      1,
    )
  }
  const [targetDir, noTargetDir] = targetFlags('mv', flags)
  return mvFlags({
    noClobber,
    verbose: flags.v === true || flags.verbose === true,
    update,
    backup: control,
    suffix: suffix ?? DEFAULT_BACKUP_SUFFIX,
    targetDir,
    noTargetDir,
    exchange,
    noCopy: flags.no_copy === true,
  })
}

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

// Remove copied source entries children first, GNU rm style. A failed
// removal is reported per entry ('mv: cannot remove ...') and the remaining
// entries are still attempted; directories with a failed descendant are
// skipped silently like GNU, which never reports the not-empty ancestors of
// a file it could not remove. Returns whether the source changed at all and
// whether it is fully gone.
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

// An unused sibling of `target` to stage a swap through. The name is probed
// instead of assumed: renames overwrite on most backends, so a fixed
// `.~xchg~` would silently destroy a real file of that name. null means no
// free slot was found.
async function holdingPath(stat: StatFn, target: PathSpec): Promise<PathSpec | null> {
  for (let attempt = 0; attempt < HOLDING_ATTEMPTS; attempt += 1) {
    const tag = attempt === 0 ? '.~xchg~' : `.~xchg${String(attempt)}~`
    const candidate = siblingPath(target, tag)
    if (!(await pathExists(stat, candidate))) return candidate
  }
  return null
}

// Put a partially completed swap back the way it was. Returns true when the
// operands are back in their original places.
async function undoExchange(
  strategy: NativeMove,
  src: PathSpec,
  target: PathSpec,
  holding: PathSpec,
  staged: boolean,
  swapped: boolean,
): Promise<boolean> {
  if (!staged) return true
  try {
    if (swapped) await strategy.rename(src, target)
    await strategy.rename(holding, src)
  } catch (err) {
    if (!isFsError(err)) throw err
    return false
  }
  return true
}

// Swap two entries through a staging name (--exchange). Both sides must
// exist. Deliberate divergence: GNU issues one atomic
// renameat2(RENAME_EXCHANGE), which no backend exposes, so the swap is
// staged through an unused sibling of the target and is *not* atomic. The
// staging name is probed for a free slot so an existing `.~xchg~` is never
// clobbered, and a failure part-way rolls the operands back. Where GNU's
// renameat2 probe degrades a missing side to 'Unknown error -1', the honest
// errno text is reported instead. A cross-mount exchange fails like GNU on a
// cross-device rename.
async function exchangePair(
  strategy: MoveStrategy,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  errors: string[],
  writes: Record<string, ByteSource>,
  lines: string[] | undefined,
): Promise<void> {
  if (isPrimitiveMove(strategy)) {
    errors.push(
      `mv: cannot exchange '${src.virtual}' and '${target.virtual}': Invalid cross-device link`,
    )
    return
  }
  if (!(await pathExists(stat, src)) || !(await pathExists(stat, target))) {
    errors.push(
      `mv: cannot exchange '${src.virtual}' and '${target.virtual}': No such file or directory`,
    )
    return
  }
  const holding = await holdingPath(stat, target)
  if (holding === null) {
    errors.push(`mv: cannot exchange '${src.virtual}' and '${target.virtual}': File exists`)
    return
  }
  let staged = false
  let swapped = false
  try {
    await strategy.rename(src, holding)
    staged = true
    await strategy.rename(target, src)
    swapped = true
    await strategy.rename(holding, target)
  } catch (err) {
    if (!isFsError(err)) throw err
    const restored = await undoExchange(strategy, src, target, holding, staged, swapped)
    errors.push(
      `mv: cannot exchange '${src.virtual}' and '${target.virtual}': ${String(fsStrerror(err))}`,
    )
    if (!restored) {
      writes[holding.mountPath] = new Uint8Array()
      errors.push(`mv: '${src.virtual}' left at '${holding.virtual}' after a failed exchange`)
    }
    return
  }
  writes[src.mountPath] = new Uint8Array()
  writes[target.mountPath] = new Uint8Array()
  if (lines !== undefined) lines.push(`exchanged '${src.virtual}' <-> '${target.virtual}'`)
}

// Move sources to a destination, fanning out into a directory. NativeMove
// uses an atomic backend rename. PrimitiveMove handles cross-mount moves by
// copying the tree (parents first, via cpWalk plus mkdir/write) and then
// removing the source children first. Failures follow GNU mv on a
// cross-device move: a copy failure keeps the whole source and skips
// removal, a removal failure (e.g. a source mount with no unlink) reports
// 'cannot remove' and leaves the copied destination in place; either way
// the remaining sources still move. -n/--update/--backup gate whole source
// operands (rename semantics), never individual entries of a tree.
export async function mvGeneric(
  paths: PathSpec[],
  stat: StatFn,
  strategy: MoveStrategy,
  flags: MvFlags,
  index?: IndexCacheStore,
  backendKey?: BackendKeyFn,
  readdir?: ReaddirFn,
): Promise<[ByteSource | null, IOResult]> {
  const keyOf = backendKey ?? backendKeyDefault
  const [sources, dstOperand] = splitOperands('mv', paths, flags.targetDir, flags.noTargetDir)
  let dst: PathSpec
  let dstIsDir: boolean
  if (dstOperand === null) {
    const firstSource = sources[0]
    if (firstSource === undefined) return [null, new IOResult()]
    dst =
      flags.targetDir instanceof PathSpec
        ? flags.targetDir
        : wrapTargetDir(firstSource, String(flags.targetDir))
    const err = await targetDirError('mv', stat, dst)
    if (err !== null) {
      return [null, new IOResult({ stderr: ENC.encode(`${err}\n`), exitCode: 1 })]
    }
    dstIsDir = true
  } else if (flags.noTargetDir) {
    dst = dstOperand
    dstIsDir = false
  } else {
    dst = dstOperand
    dstIsDir = await isDirectory(stat, dst, index)
  }
  let versionReaddir = readdir
  if (versionReaddir === undefined && isPrimitiveMove(strategy)) {
    versionReaddir = strategy.readdir
  }
  const policy: TransferPolicy = {
    cmdName: 'mv',
    noClobber: flags.noClobber,
    update: flags.update,
    backup: flags.backup,
    suffix: flags.suffix,
  }
  const writes: Record<string, ByteSource> = {}
  const lines: string[] = []
  const errors: string[] = []
  for (const [src, target] of copyTargets(sources, dst, dstIsDir)) {
    const { exists: srcExists, isDir: srcIsDir } = await entryKind(stat, src)
    if (!srcExists) {
      errors.push(`mv: cannot stat '${src.virtual}': No such file or directory`)
      continue
    }
    if (keyOf(src) === keyOf(target)) {
      errors.push(`mv: '${src.virtual}' and '${target.virtual}' are the same file`)
      continue
    }
    if (flags.exchange) {
      await exchangePair(
        strategy,
        stat,
        src,
        target,
        errors,
        writes,
        flags.verbose ? lines : undefined,
      )
      continue
    }
    if (keyOf(target).startsWith(keyOf(src) + '/')) {
      errors.push(
        `mv: cannot move '${src.virtual}' to a subdirectory of itself, '${target.virtual}'`,
      )
      continue
    }
    const { exists: targetExists, isDir: targetIsDir } = await entryKind(stat, target)
    const mismatch = overwriteTypeError('mv', src, srcIsDir, target, targetExists, targetIsDir)
    if (mismatch !== null) {
      errors.push(mismatch)
      continue
    }
    if (flags.noCopy && isPrimitiveMove(strategy)) {
      errors.push(
        `mv: cannot move '${src.virtual}' to '${target.virtual}': Invalid cross-device link`,
      )
      continue
    }
    // A backup renames the target aside first, so -b -T installs over a
    // nonempty directory (GNU 9.7) instead of hitting this refusal.
    if (
      srcIsDir &&
      targetIsDir &&
      flags.noTargetDir &&
      versionReaddir !== undefined &&
      !backupDisplaces(flags.backup)
    ) {
      let children: string[]
      try {
        children = await versionReaddir(target)
      } catch (err) {
        if (!isFsError(err)) throw err
        // Reading it as "empty" would clobber a directory whose contents
        // could not be verified.
        errors.push(`mv: cannot overwrite '${target.virtual}': ${String(fsStrerror(err))}`)
        continue
      }
      if (children.length > 0) {
        errors.push(`mv: cannot overwrite '${target.virtual}': Directory not empty`)
        continue
      }
    }
    if (!(await overwriteGate(policy, stat, src, target, errors))) continue
    const made = await makeBackup(
      policy,
      strategy,
      stat,
      versionReaddir,
      target,
      writes,
      errors,
      index,
    )
    if (!made.ok) continue
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
    if (flags.verbose) {
      let line = `renamed '${src.virtual}' -> '${target.virtual}'`
      if (made.backup !== null) line += ` (backup: '${made.backup.virtual}')`
      lines.push(line)
    }
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [output, new IOResult({ writes, stderr, exitCode: errors.length > 0 ? 1 : 0 })]
}
