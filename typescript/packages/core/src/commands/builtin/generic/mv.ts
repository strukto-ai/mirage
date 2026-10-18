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

import { underPath } from '../../../utils/key_prefix.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import {
  FileType,
  type MoveStrategy,
  type NativeMove,
  type PrimitiveMove,
  type ReaddirFn,
  type StatFn,
} from '../../../types.ts'
import { isFifo } from '../../../utils/stat_view.ts'
import { UsageError } from '../../errors.ts'
import { usageHint } from '../../spec/usage.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { beforeFullScan } from '../utils/tree.ts'
import { backupControl, siblingPath } from '../utils/backup.ts'
import { DEFAULT_BACKUP_SUFFIX } from '../utils/constants.ts'
import {
  STAT_REFUSALS,
  backendKeyDefault,
  copyTargets,
  pathExists,
  typedName,
  type BackendKeyFn,
} from '../utils/copy.ts'
import {
  errorVirtualPath,
  fsStrerror,
  innerSuffix,
  isFsError,
  isLandedMove,
  isStaleWrite,
  virtualOf,
  withInner,
} from '../../../errors/fs.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { descendantPath } from '../utils/paths.ts'
import {
  type TransferLinks,
  linkStat,
  renameLink,
  backupDisplaces,
  backupRaw,
  copyEntries,
  cpWalk,
  destKind,
  justCreatedError,
  sameFileError,
  sourceKind,
  makeBackup,
  overwriteGate,
  overwriteTypeError,
  prompter,
  slashRefusesFile,
  splitOperands,
  stderrOf,
  suffixFlag,
  targetDirError,
  targetFlags,
  typeMismatchError,
  updateGates,
  updateMode,
  type TransferPolicy,
} from './cp.ts'
import type { FlagView } from '../../spec/flag_view.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import type { FsCondition } from '../../../errors/types.ts'

const ENC = new TextEncoder()

// Bound on the --exchange staging-name probe.
const HOLDING_ATTEMPTS = 100

export interface MvFlags {
  noClobber: boolean
  interactive: boolean
  verbose: boolean
  update: string | null
  backup: string | null
  suffix: string
  targetDir: PathSpec | null
  noTargetDir: boolean
  exchange: boolean
  noCopy: boolean
}

export function mvFlags(init: Partial<MvFlags> = {}): MvFlags {
  return {
    noClobber: init.noClobber ?? false,
    interactive: init.interactive ?? false,
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

// Parse the mv flag bag once into a frozen struct. The last of -f, -i and
// -n decides: -i asks before each overwrite, -n skips, -f replaces.
// --strip-trailing-slashes is a no-op because PathSpec already normalizes
// trailing slashes.
export function parseFlags(fl: FlagView): MvFlags {
  const update = updateMode('mv', fl)
  const suffix = suffixFlag(fl)
  const control = backupControl('mv', backupRaw(fl), suffix)
  const answer = fl.typedOrder('force', 'interactive', 'no_clobber').at(-1)
  const noClobber = answer === 'no_clobber'
  const exchange = fl.asBool('exchange')
  if (control !== null && control !== 'none' && (exchange || noClobber || update === 'none-fail')) {
    throw new UsageError(
      `mv: cannot combine --backup with --exchange, -n, or --update=none-fail\n${usageHint('mv')}`,
      1,
    )
  }
  const [targetDir, noTargetDir] = targetFlags('mv', fl)
  return mvFlags({
    noClobber,
    interactive: answer === 'interactive',
    verbose: fl.asBool('verbose'),
    update,
    backup: control,
    suffix: suffix ?? DEFAULT_BACKUP_SUFFIX,
    targetDir,
    noTargetDir,
    exchange,
    noCopy: fl.asBool('no_copy'),
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

// GNU's line for a target mv cannot replace. On one filesystem the rename
// refuses the overwrite itself. Across filesystems GNU removes the target
// before it copies, so the failed removal is what it reports (coreutils 9.7).
// Mirrors Python's _replace_error.
function replaceError(src: PathSpec, target: PathSpec, reason: string, across: boolean): string {
  if (across) {
    return `mv: inter-device move failed: '${src.rawPath}' to '${target.rawPath}'; unable to remove target: ${reason}`
  }
  return `mv: cannot overwrite '${target.rawPath}': ${reason}`
}

// GNU's line for a source mv could not move onto its target. Mirrors
// Python's _move_error.
function moveError(src: PathSpec, target: PathSpec, reason: string): string {
  return `mv: cannot move '${src.rawPath}' to '${target.rawPath}': ${reason}`
}

// Remove copied source entries children first, GNU rm style. A failed
// removal is reported per entry ('mv: cannot remove ...') and the remaining
// entries are still attempted; directories with a failed descendant are
// skipped silently like GNU, which never reports the not-empty ancestors of
// a file it could not remove. Returns whether the source is fully gone.
async function removeEntries(
  strategy: PrimitiveMove,
  stat: StatFn,
  src: PathSpec,
  entries: { path: string; kind: FileType }[],
  errors: string[],
  lines?: string[],
): Promise<boolean> {
  const failed: string[] = []
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const node = entries[i]
    if (node === undefined) continue
    const isDir = node.kind === FileType.DIRECTORY
    const base = rstripSlash(node.path)
    if (isDir && failed.some((f) => f.startsWith(base + '/'))) {
      failed.push(base)
      continue
    }
    const spec = descendantPath(src, node.path)
    try {
      if (isDir) await strategy.rmdir(spec)
      else await strategy.unlink(spec)
    } catch (err) {
      if (!isFsError(err)) throw err
      if (!(await entryGone(strategy, stat, spec, isDir))) {
        errors.push(`mv: cannot remove '${spec.rawPath}': ${String(fsStrerror(err))}`)
        failed.push(base)
        continue
      }
    }
    lines?.push(`removed ${isDir ? 'directory ' : ''}'${spec.rawPath}'`)
  }
  return failed.length === 0
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
  lines: string[] | undefined,
): Promise<void> {
  const refused = `mv: cannot exchange '${src.rawPath}' and '${target.rawPath}'`
  if (isPrimitiveMove(strategy)) {
    errors.push(`${refused}: ${posixPhrase('EXDEV')}`)
    return
  }
  if (typedName(src) === '.' || typedName(src) === '..') {
    errors.push(`${refused}: ${posixPhrase('EBUSY')}`)
    return
  }
  if (!(await pathExists(stat, src)) || !(await pathExists(stat, target))) {
    errors.push(`${refused}: ${posixPhrase('ENOENT')}`)
    return
  }
  const holding = await holdingPath(stat, target)
  if (holding === null) {
    errors.push(`${refused}: ${posixPhrase('EEXIST')}`)
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
    errors.push(`${refused}: ${String(fsStrerror(err))}`)
    if (!restored) {
      errors.push(`mv: '${src.rawPath}' left at '${holding.rawPath}' after a failed exchange`)
    }
    return
  }
  if (lines !== undefined) lines.push(`exchanged '${src.rawPath}' <-> '${target.rawPath}'`)
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
  backendKey?: BackendKeyFn,
  readdir?: ReaddirFn,
  // Judges one (source, target) pair before the move touches anything,
  // the backup included, throwing to refuse it; the adapter wires the
  // hidden-reveal check here so a refused move mutates nothing (no
  // half-copy, no destination renamed aside by -b). Consulted only for
  // a directory source, since a file carries nothing below it to
  // reveal.
  guard?: (src: PathSpec, dst: PathSpec) => void,
  copies?: TransferLinks,
  // Where -i reads its answers.
  stdin?: ByteSource | null,
  // Whether a path is a mount root, which a move can neither replace nor
  // rename aside; undefined outside a workspace.
  mountRoot?: (path: string) => boolean,
  // The command's dispatcher, which lets a source's mount refuse a tree
  // copied across mounts; undefined outside a workspace.
  dispatch?: DispatchFn,
): Promise<[ByteSource | null, IOResult]> {
  if (copies !== undefined) stat = (path) => linkStat(copies, path)
  const keyOf = backendKey ?? backendKeyDefault
  const [sources, dst] = splitOperands('mv', paths, flags.targetDir, flags.noTargetDir)
  let dstIsDir: boolean
  let dstExists: boolean
  let dstErr: FsCondition | null = null
  if (flags.targetDir !== null) {
    const err = await targetDirError('mv', stat, dst)
    if (err !== null) {
      return [null, new IOResult({ stderr: ENC.encode(`${err}\n`), exitCode: 1 })]
    }
    dstIsDir = true
    dstExists = true
  } else if (flags.noTargetDir) {
    dstIsDir = false
    dstExists = true
  } else {
    const probe = await destKind(stat, dst)
    dstExists = probe.exists
    dstIsDir = probe.isDir
    dstErr = probe.condition
  }
  let versionReaddir = readdir
  if (versionReaddir === undefined && isPrimitiveMove(strategy)) {
    versionReaddir = strategy.readdir
  }
  const errors: string[] = []
  const accepted: string[] = []
  const policy: TransferPolicy = {
    cmdName: 'mv',
    noClobber: flags.noClobber,
    update: flags.update,
    backup: flags.backup,
    suffix: flags.suffix,
    ask: flags.interactive ? prompter('mv', stdin ?? null, errors, accepted) : null,
  }
  const lines: string[] = []
  const created = new Set<string>()
  for (const [src, target] of copyTargets(sources, dst, dstIsDir, dstExists, dstErr)) {
    const { kind: srcKind, condition: srcErr } = await sourceKind(stat, src)
    const srcIsDir = srcKind === FileType.DIRECTORY
    if (srcErr !== null) {
      errors.push(`mv: cannot stat '${src.rawPath}': ${posixPhrase(srcErr)}`)
      continue
    }
    if (target.walkError !== null && target.rawPath === '') {
      // GNU stats an empty destination as the directory it is typed in, as
      // if it were `.`: a file cannot overwrite it, and a directory renamed
      // onto it is busy (coreutils 9.7).
      errors.push(
        srcIsDir
          ? moveError(src, target, posixPhrase('EBUSY'))
          : typeMismatchError('mv', src, target, false),
      )
      continue
    }
    if (keyOf(src) === keyOf(target)) {
      errors.push(sameFileError('mv', src, target))
      continue
    }
    if (flags.exchange) {
      await exchangePair(strategy, stat, src, target, errors, flags.verbose ? lines : undefined)
      continue
    }
    // A source typed as `.` or `..` names no entry a rename can take, so
    // GNU's rename answers EBUSY once the gates let it run, before any
    // subdirectory verdict (coreutils 9.7). Across mounts GNU copies it and
    // then refuses to remove it; mirage refuses first.
    const busy = typedName(src) === '.' || typedName(src) === '..'
    if (!busy && keyOf(target).startsWith(keyOf(src) + '/')) {
      errors.push(
        `mv: cannot move '${src.rawPath}' to a subdirectory of itself, '${target.rawPath}'`,
      )
      continue
    }
    const probe =
      !flags.noTargetDir && target.virtual === dst.virtual
        ? { exists: dstExists, isDir: dstIsDir, condition: dstErr }
        : await destKind(stat, target)
    const { exists: targetExists, isDir: targetIsDir, condition: targetErr } = probe
    // mv's own order: the destination's stat refuses before the rename
    // does. A chain that is merely absent is left to the backend rename
    // below, which answers ENOENT in the same words (and on a dirless
    // store may well succeed), unless a slash asked for a directory a
    // file source can never be.
    if (targetErr !== null && STAT_REFUSALS.has(targetErr)) {
      errors.push(`mv: cannot stat '${target.rawPath}': ${posixPhrase(targetErr)}`)
      continue
    }
    if (slashRefusesFile(target, targetExists, srcIsDir)) {
      errors.push(moveError(src, target, posixPhrase(targetErr ?? 'ENOTDIR')))
      continue
    }
    // GNU lets -n, --update and -i decide before it weighs a type mismatch,
    // and -u never holds a directory back (coreutils 9.7).
    const gate = srcIsDir && policy.update === 'older' ? { ...policy, update: null } : policy
    if (!(await overwriteGate(gate, stat, src, target, errors))) continue
    // A backup renames the target aside, whatever its kind.
    const mismatch = !backupDisplaces(flags.backup)
      ? overwriteTypeError('mv', src, srcIsDir, target, targetExists, targetIsDir)
      : null
    if (mismatch !== null) {
      errors.push(mismatch)
      continue
    }
    if (
      created.has(keyOf(target)) &&
      !(flags.noClobber || updateGates(flags.update) || flags.backup === 'numbered')
    ) {
      errors.push(justCreatedError('mv', src, target))
      continue
    }
    if (busy) {
      errors.push(moveError(src, target, posixPhrase('EBUSY')))
      continue
    }
    if (mountRoot?.(target.virtual) === true) {
      // A mount root stands on another filesystem than the directory holding
      // it, so the rename crosses devices, and the root can be neither renamed
      // aside nor removed (coreutils 9.7).
      const busyPhrase = posixPhrase('EBUSY')
      if (backupDisplaces(flags.backup)) {
        errors.push(`mv: cannot backup '${target.rawPath}': ${busyPhrase}`)
      } else if (flags.noCopy) {
        errors.push(moveError(src, target, posixPhrase('EXDEV')))
      } else {
        errors.push(replaceError(src, target, busyPhrase, true))
      }
      continue
    }
    const across = isPrimitiveMove(strategy)
    // GNU refuses to replace a non-empty directory whether the target was
    // named outright (-T) or mapped under an existing destination
    // directory, so this cannot be gated on noTargetDir. It runs after the
    // clobber gate because -n and --update=none skip such a target
    // silently at exit 0, and a backup renames the target aside first, so
    // -b installs over it instead. With --no-copy a move across mounts meets
    // the other device first (all GNU 9.7).
    if (
      srcIsDir &&
      targetIsDir &&
      versionReaddir !== undefined &&
      !backupDisplaces(flags.backup) &&
      !(across && flags.noCopy)
    ) {
      let children: string[]
      try {
        children = await versionReaddir(target)
      } catch (err) {
        if (!isFsError(err)) throw err
        // Reading it as "empty" would clobber a directory whose contents
        // could not be verified.
        errors.push(replaceError(src, target, String(fsStrerror(err)), across))
        continue
      }
      if (children.length > 0) {
        errors.push(replaceError(src, target, posixPhrase('ENOTEMPTY'), across))
        continue
      }
    }
    // The reveal guard answers before the backup so a refused move
    // cannot leave the destination renamed aside; only a directory
    // source has anything below it to re-anchor, so a file passes.
    if (guard !== undefined && srcIsDir) {
      try {
        guard(src, target)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(moveError(src, target, String(fsStrerror(err))))
        continue
      }
    }
    const backupStrategy =
      copies !== undefined
        ? { rename: (a: PathSpec, b: PathSpec) => renameLink(copies, a, b) }
        : strategy
    if (across && flags.noCopy) {
      // GNU renames the target aside before its rename meets the other
      // device, and leaves it there (coreutils 9.7).
      const made = await makeBackup(
        policy,
        backupStrategy,
        stat,
        versionReaddir,
        target,
        errors,
        copies,
      )
      if (made.ok) errors.push(moveError(src, target, posixPhrase('EXDEV')))
      continue
    }
    const sourceLink = copies !== undefined && copies.links.statAt(src.virtual) !== null
    // Refuse an undeletable source before a backup moves the target aside.
    if (isPrimitiveMove(strategy) && !sourceLink) {
      try {
        strategy.checkUnlink?.(src)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(moveError(src, target, String(fsStrerror(err))))
        continue
      }
    }
    // Across mounts the tree is copied file by file, so the source's mount is
    // asked before a backup or a removal touches the destination.
    if (isPrimitiveMove(strategy) && srcIsDir && !sourceLink) {
      await beforeFullScan(dispatch, src, 'mv')
    }
    // A cross-mount move removes the target first, and a pipe cannot be
    // removed: GNU stops there, keeping the source (`mv f >(cat)`).
    if (
      across &&
      targetExists &&
      !targetIsDir &&
      !sourceLink &&
      (await targetIsFifo(stat, target))
    ) {
      errors.push(replaceError(src, target, posixPhrase('EPERM'), across))
      continue
    }
    const made = await makeBackup(
      policy,
      backupStrategy,
      stat,
      versionReaddir,
      target,
      errors,
      copies,
    )
    if (!made.ok) continue
    if (copies !== undefined && sourceLink) {
      try {
        await renameLink(copies, src, target)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(moveError(src, target, String(fsStrerror(err))))
        continue
      }
    } else if (isPrimitiveMove(strategy)) {
      if (targetErr === 'ENOENT') {
        // GNU's rename meets the absent parent before it falls back to a
        // copy across devices.
        errors.push(moveError(src, target, posixPhrase(targetErr)))
        continue
      }
      if (targetIsDir && made.backup === null) {
        // GNU removes the target before it copies across devices, so an
        // empty directory there is made anew (-v: `created directory`).
        try {
          await strategy.rmdir(target)
        } catch (err) {
          if (!isFsError(err)) throw err
          errors.push(replaceError(src, target, String(fsStrerror(err)), across))
          continue
        }
      }
      // Across mounts GNU copies and then removes, and -v says so entry by
      // entry instead of `renamed` (coreutils 9.7).
      const verbose = flags.verbose ? lines : undefined
      const entries = await cpWalk(strategy.readdir, stat, src)
      const copiedAll = await copyEntries('mv', strategy, stat, src, target, entries, errors, {
        copies,
        lines: verbose,
        rootBackup: made.backup,
      })
      // GNU keeps the whole source tree when any copy failed; the
      // destination keeps the entries that landed.
      if (!copiedAll) continue
      const removedAll = await removeEntries(strategy, stat, src, entries, errors, verbose)
      // GNU leaves the copied destination in place and reports the source
      // entries it could not remove.
      if (!removedAll) continue
      if (!srcIsDir) created.add(keyOf(target))
      continue
    } else {
      try {
        await strategy.rename(src, target)
      } catch (err) {
        if (!isFsError(err)) throw err
        // A stale key inside a walk is named; other refusals, the operand.
        const stale = isStaleWrite(err)
        const inner = stale ? innerSuffix(src, err) || innerSuffix(target, err) : ''
        const from = withInner(src.rawPath, inner)
        if (isLandedMove(err)) {
          // Copy landed, source delete lost: GNU's cross-device unlink failure.
          errors.push(`mv: cannot remove '${from}': ${String(fsStrerror(err))}`)
          if (!srcIsDir) created.add(keyOf(target))
          continue
        }
        // A backend rename that refuses (e.g. a destination whose parent
        // chain is not all directories) is one failed operand, not an
        // aborted command: GNU reports it and keeps going with the
        // remaining sources.
        const to = withInner(target.rawPath, inner)
        // A refused write names the end that changed; its path is spelt as typed or resolved.
        const lost = errorVirtualPath(err)
        const atTarget = underPath(lost, target.virtual) || underPath(lost, virtualOf(target))
        const changed = !stale ? '' : `'${atTarget ? to : from}' `
        errors.push(`mv: cannot move '${from}' to '${to}': ${changed}${String(fsStrerror(err))}`)
        continue
      }
    }
    if (!srcIsDir) created.add(keyOf(target))
    if (flags.verbose) {
      let line = `renamed '${src.rawPath}' -> '${target.rawPath}'`
      if (made.backup !== null) line += ` (backup: '${made.backup.rawPath}')`
      lines.push(line)
    }
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  return [
    output,
    new IOResult({
      stderr: stderrOf(errors),
      exitCode: errors.length > accepted.length ? 1 : 0,
    }),
  ]
}

/** Whether a move's existing target is a pipe (a process substitution's
 * descriptor). Mirrors Python's _target_is_fifo. */
async function targetIsFifo(stat: StatFn, target: PathSpec): Promise<boolean> {
  try {
    return isFifo(await stat(target))
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`mv: target ${target.virtual} gave no stat: ${String(err)}`)
    return false
  }
}
