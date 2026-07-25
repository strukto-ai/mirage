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

import { mountPrefixOf, rekey } from '../../../utils/key_prefix.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import {
  FileType,
  PathSpec,
  type CopyStrategy,
  type FileStat,
  type NativeCopy,
  type NativeMove,
  type PrimitiveCopy,
  type PrimitiveMove,
  type ReaddirFn,
  type StatFn,
} from '../../../types.ts'
import { UsageError } from '../../errors.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { modifiedTs } from '../../../core/generic/find.ts'
import { DEFAULT_BACKUP_SUFFIX, backupControl, backupTarget } from '../utils/backup.ts'
import {
  backendKeyDefault,
  copyTargets,
  isDirectory,
  pathExists,
  type BackendKeyFn,
} from '../utils/copy.ts'
import { fsStrerror, isFsError, isMissingPath } from '../../../utils/errors.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'

const ENC = new TextEncoder()

const UPDATE_MODES = ['all', 'none', 'none-fail', 'older'] as const

// PATH-valued flags (-t) reach single-mount commands as PathSpec, so the
// bag is wider than the string wire type; plain string records assign
// fine.
export type Flags = Record<string, string | boolean | string[] | PathSpec>

export interface CpFlags {
  recursive: boolean
  noClobber: boolean
  verbose: boolean
  update: string | null
  backup: string | null
  suffix: string
  targetDir: PathSpec | string | null
  noTargetDir: boolean
}

export function cpFlags(init: Partial<CpFlags> = {}): CpFlags {
  return {
    recursive: init.recursive ?? false,
    noClobber: init.noClobber ?? false,
    verbose: init.verbose ?? false,
    update: init.update ?? null,
    backup: init.backup ?? null,
    suffix: init.suffix ?? DEFAULT_BACKUP_SUFFIX,
    targetDir: init.targetDir ?? null,
    noTargetDir: init.noTargetDir ?? false,
  }
}

// Per-entry overwrite policy shared by cp and mv: the command name for
// error prefixes, -n, the --update mode, the canonical backup control and
// the simple-backup suffix.
export interface TransferPolicy {
  cmdName: string
  noClobber: boolean
  update: string | null
  backup: string | null
  suffix: string
}

// Python `as_str(a) or as_str(b)` twin: the first non-empty string wins,
// an empty string reads as absent.
export function firstStr(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

function isPrimitiveCopy(strategy: CopyStrategy): strategy is PrimitiveCopy {
  return 'readBytes' in strategy
}

// Whether an --update mode can skip or fail an individual entry. 'all'
// copies unconditionally, so it needs no per-entry decision and must not
// cost a target probe or forfeit a whole-tree dirCopy.
function updateGates(mode: string | null): boolean {
  return mode !== null && mode !== 'all'
}

// Whether a backup control actually moves an existing target aside. 'none'
// is a no-op control, so it needs no per-entry decision.
export function backupDisplaces(control: string | null): boolean {
  return control !== null && control !== 'none'
}

// Resolve -u/--update[=UPDATE] to a GNU update mode.
export function updateMode(cmdName: string, flags: Flags): string | null {
  let value: unknown = flags.update
  if (value === undefined || value === false) value = flags.u
  if (value === undefined || value === false) return null
  if (value === true) return 'older'
  if (typeof value === 'string' && (UPDATE_MODES as readonly string[]).includes(value)) {
    return value
  }
  const shown = typeof value === 'string' ? value : ''
  throw new UsageError(
    `${cmdName}: invalid argument '${shown}' for '--update'\n` +
      'Valid arguments are:\n' +
      "  - 'all'\n" +
      "  - 'none'\n" +
      "  - 'none-fail'\n" +
      "  - 'older'\n" +
      `Try '${cmdName} --help' for more information.`,
    1,
  )
}

// The raw -b/--backup value, absent shapes reading as undefined. The parser
// mirrors the two spellings, so either key already carries GNU's
// last-occurrence-wins value.
export function backupRaw(flags: Flags): string | boolean | undefined {
  let value: unknown = flags.backup
  if (value === undefined || value === false) value = flags.b
  if (typeof value === 'string' || typeof value === 'boolean') return value
  return undefined
}

// -t values arrive as PathSpec on the single-mount dispatch path and as
// resolved virtual-path strings on the cross-mount relay path; accept both.
export function targetFlags(cmdName: string, flags: Flags): [PathSpec | string | null, boolean] {
  let raw: unknown = flags.t
  if (raw === undefined) raw = flags.target_directory
  const targetDir: PathSpec | string | null =
    raw instanceof PathSpec || typeof raw === 'string' ? raw : null
  const noTarget = flags.T === true || flags.no_target_directory === true
  if (targetDir !== null && noTarget) {
    throw new UsageError(
      `${cmdName}: cannot combine --target-directory (-t) and --no-target-directory (-T)`,
      1,
    )
  }
  return [targetDir, noTarget]
}

// Parse the cp flag bag once into a frozen struct. -f/-i are accepted
// no-ops (non-interactive control plane: overwrite always proceeds unless
// -n/--update say otherwise), and --strip-trailing-slashes is a no-op
// because PathSpec already normalizes trailing slashes.
export function parseCpFlags(flags: Flags): CpFlags {
  const update = updateMode('cp', flags)
  const suffix = firstStr(flags.S, flags.suffix)
  const control = backupControl('cp', backupRaw(flags), suffix)
  const noClobber = flags.n === true || flags.no_clobber === true
  if (control !== null && control !== 'none' && (noClobber || update === 'none-fail')) {
    throw new UsageError(
      'cp: --backup is mutually exclusive with -n or --update=none-fail\n' +
        "Try 'cp --help' for more information.",
      1,
    )
  }
  const [targetDir, noTargetDir] = targetFlags('cp', flags)
  return cpFlags({
    recursive:
      flags.r === true ||
      flags.R === true ||
      flags.recursive === true ||
      flags.a === true ||
      flags.archive === true,
    noClobber,
    verbose: flags.v === true || flags.verbose === true,
    update,
    backup: control,
    suffix: suffix ?? DEFAULT_BACKUP_SUFFIX,
    targetDir,
    noTargetDir,
  })
}

// Split operands into sources and destination, GNU arity errors. With -t
// every operand is a source and the returned destination is null (the
// caller wraps the target-directory string itself). -T requires exactly
// two operands.
export function splitOperands(
  cmdName: string,
  paths: PathSpec[],
  targetDir: PathSpec | string | null,
  noTargetDir: boolean,
): [PathSpec[], PathSpec | null] {
  const hint = `Try '${cmdName} --help' for more information.`
  const first = paths[0]
  if (first === undefined) {
    throw new UsageError(`${cmdName}: missing file operand\n${hint}`, 1)
  }
  if (targetDir !== null) return [[...paths], null]
  if (paths.length === 1) {
    throw new UsageError(
      `${cmdName}: missing destination file operand after '${first.rawPath}'\n${hint}`,
      1,
    )
  }
  if (noTargetDir && paths.length > 2) {
    throw extraOperandError(cmdName, paths[2]?.rawPath ?? '')
  }
  const dst = paths[paths.length - 1]
  return [paths.slice(0, -1), dst ?? null]
}

// Build the -t directory PathSpec from a same-mount reference operand.
export function wrapTargetDir(ref: PathSpec, virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual, rekey(ref.virtual, ref.resourcePath, virtual))
}

// GNU error line when a -t operand is missing or not a directory.
export async function targetDirError(
  cmdName: string,
  stat: StatFn,
  target: PathSpec,
): Promise<string | null> {
  let info: FileStat
  try {
    info = await stat(target)
  } catch (err) {
    if (!isMissingPath(err)) throw err
    return `${cmdName}: target directory '${target.virtual}': No such file or directory`
  }
  if (info.type !== FileType.DIRECTORY) {
    return `${cmdName}: target directory '${target.virtual}': Not a directory`
  }
  return null
}

// Probe a path once for {exists, isDir}.
export async function entryKind(
  stat: StatFn,
  path: PathSpec,
): Promise<{ exists: boolean; isDir: boolean }> {
  let info: FileStat
  try {
    info = await stat(path)
  } catch (err) {
    if (!isMissingPath(err)) throw err
    return { exists: false, isDir: false }
  }
  return { exists: true, isDir: info.type === FileType.DIRECTORY }
}

// GNU dir/non-dir overwrite mismatch line, or null when compatible.
export function overwriteTypeError(
  cmdName: string,
  src: PathSpec,
  srcIsDir: boolean,
  target: PathSpec,
  targetExists: boolean,
  targetIsDir: boolean,
): string | null {
  if (!targetExists) return null
  if (srcIsDir && !targetIsDir) {
    return `${cmdName}: cannot overwrite non-directory '${target.virtual}' with directory '${src.virtual}'`
  }
  if (!srcIsDir && targetIsDir) {
    return `${cmdName}: cannot overwrite directory '${target.virtual}' with non-directory '${src.virtual}'`
  }
  return null
}

// Decide whether an existing target may be replaced. -n and --update=none
// skip silently; --update=none-fail records GNU's `not replacing` error;
// --update=older replaces only when the source is strictly newer. A source
// or target with no usable mtime always replaces (freshness cannot be
// proven).
export async function overwriteGate(
  policy: TransferPolicy,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  errors: string[],
): Promise<boolean> {
  // No gating flag: skip the target probe entirely so API-backed mounts
  // pay no extra stat per entry.
  if (!policy.noClobber && !updateGates(policy.update)) return true
  let targetInfo: FileStat
  try {
    targetInfo = await stat(target)
  } catch (err) {
    // A probe failure here is not permission to clobber: returning true on an
    // auth error or timeout would silently defeat -n / --update=none.
    if (!isMissingPath(err)) throw err
    return true
  }
  if (policy.noClobber || policy.update === 'none') return false
  if (policy.update === 'none-fail') {
    errors.push(`${policy.cmdName}: not replacing '${target.virtual}'`)
    return false
  }
  if (policy.update === 'older') {
    let srcInfo: FileStat
    try {
      srcInfo = await stat(src)
    } catch (err) {
      if (!isMissingPath(err)) throw err
      return true
    }
    const srcTs = modifiedTs(srcInfo.modified)
    const targetTs = modifiedTs(targetInfo.modified)
    if (srcTs !== null && targetTs !== null && srcTs <= targetTs) return false
  }
  return true
}

// Materialize the backup: mv renames the target away, cp copies it. A
// directory target needs a tree transfer, not a byte copy: the primitive
// (cross-mount) strategies walk it entry by entry and a native copy defers to
// dirCopy, while a native rename already carries a whole subtree. Returns
// true when the backup landed in full.
async function duplicateForBackup(
  strategy: CopyStrategy | PrimitiveMove | NativeMove,
  stat: StatFn,
  target: PathSpec,
  backup: PathSpec,
  errors: string[],
  cmdName: string,
  index?: IndexCacheStore,
): Promise<boolean> {
  if ('rename' in strategy) {
    await strategy.rename(target, backup)
    return true
  }
  const targetIsDir = await isDirectory(stat, target, index)
  if ('readBytes' in strategy) {
    if (!targetIsDir) {
      const data = await strategy.readBytes(target)
      await strategy.write(backup, data)
      return true
    }
    const entries = await cpWalk(strategy.readdir, stat, target, index)
    const { copiedAll } = await copyEntries(
      cmdName,
      strategy,
      stat,
      target,
      backup,
      entries,
      errors,
      index,
    )
    return copiedAll
  }
  if (!targetIsDir) {
    await strategy.copy(target, backup)
    return true
  }
  if (strategy.dirCopy === undefined) {
    errors.push(`${cmdName}: cannot backup '${target.virtual}': Operation not supported`)
    return false
  }
  await strategy.dirCopy(target, backup)
  return true
}

// Back up an existing target before it is overwritten. Returns the backup
// path (null when no backup was needed) and whether the transfer may
// proceed.
export async function makeBackup(
  policy: TransferPolicy,
  strategy: CopyStrategy | PrimitiveMove | NativeMove,
  stat: StatFn,
  readdir: ReaddirFn | undefined,
  target: PathSpec,
  writes: Record<string, ByteSource>,
  errors: string[],
  index?: IndexCacheStore,
): Promise<{ backup: PathSpec | null; ok: boolean }> {
  if (policy.backup === null) return { backup: null, ok: true }
  if (!(await pathExists(stat, target))) return { backup: null, ok: true }
  let backup: PathSpec | null
  try {
    // A failed version scan must not degrade to `.~1~`/the simple suffix:
    // that would overwrite existing backup history.
    backup = await backupTarget(readdir, target, policy.backup, policy.suffix)
  } catch (err) {
    if (!isFsError(err)) throw err
    errors.push(`${policy.cmdName}: cannot backup '${target.virtual}': ${String(fsStrerror(err))}`)
    return { backup: null, ok: false }
  }
  if (backup === null) return { backup: null, ok: true }
  let made: boolean
  try {
    made = await duplicateForBackup(strategy, stat, target, backup, errors, policy.cmdName, index)
  } catch (err) {
    if (!isFsError(err)) throw err
    errors.push(`${policy.cmdName}: cannot backup '${target.virtual}': ${String(fsStrerror(err))}`)
    return { backup: null, ok: false }
  }
  if (!made) return { backup: null, ok: false }
  writes[backup.mountPath] = new Uint8Array()
  return { backup, ok: true }
}

// The cp verbose line, with GNU's backup annotation when one exists.
function transferLine(src: PathSpec, target: PathSpec, backup: PathSpec | null): string {
  let line = `'${src.virtual}' -> '${target.virtual}'`
  if (backup !== null) line += ` (backup: '${backup.virtual}')`
  return line
}

function descendantPath(root: PathSpec, virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual, rekey(root.virtual, root.resourcePath, virtual))
}

function mountedPath(root: PathSpec, mountPath: string): PathSpec {
  const prefix = mountPrefixOf(root.virtual, root.resourcePath)
  const virtual = prefix !== '' ? prefix + mountPath : mountPath
  return PathSpec.fromStrPath(virtual, stripSlash(mountPath))
}

// Recreate a source tree's directories under the destination root. Only
// needed on the per-entry policy path, where a whole-tree dirCopy cannot be
// used: without this, a directory holding no files would never appear at the
// destination, and an entirely empty tree would copy to nothing. A backend
// exposing no mkdir (directories are implied by keys) is a no-op. Parents
// sort before children so a nested tree lands in order.
async function mirrorDirs(
  strategy: NativeCopy,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  srcBase: string,
  dstBase: string,
  writes: Record<string, ByteSource>,
  errors: string[],
  index?: IndexCacheStore,
): Promise<void> {
  if (strategy.mkdir === undefined) return
  const mounts = [srcBase, ...(await strategy.find(src, { type: 'd' }))]
  const unique = [...new Set(mounts)].sort((a, b) => a.length - b.length)
  for (const entryMount of unique) {
    const entryDst = mountedPath(target, dstBase + entryMount.slice(srcBase.length))
    if (await isDirectory(stat, entryDst, index)) continue
    try {
      await strategy.mkdir(entryDst)
    } catch (err) {
      if (!isFsError(err)) throw err
      errors.push(`cp: cannot create directory '${entryDst.virtual}': ${String(fsStrerror(err))}`)
      continue
    }
    writes[entryDst.mountPath] = new Uint8Array()
  }
}

// List a tree as {path, isDir} pairs, parents before children. The type is
// captured while the tree is intact so a caller that deletes as it goes (mv)
// never re-stats a path whose virtual parent has since vanished. Mirrors the
// Python cp `walk`; used only by the primitive (no native copy) path.
export async function cpWalk(
  readdir: ReaddirFn,
  stat: StatFn,
  root: PathSpec,
  index?: IndexCacheStore,
): Promise<{ path: string; isDir: boolean }[]> {
  const info = await stat(root, index)
  if (info.type !== FileType.DIRECTORY) return [{ path: root.virtual, isDir: false }]
  const entries: { path: string; isDir: boolean }[] = [{ path: root.virtual, isDir: true }]
  const queue: PathSpec[] = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    if (directory === undefined) break
    for (const child of await readdir(directory)) {
      const childSpec = descendantPath(root, child)
      const childInfo = await stat(childSpec, index)
      const isDir = childInfo.type === FileType.DIRECTORY
      entries.push({ path: child, isDir })
      if (isDir) queue.push(childSpec)
    }
  }
  return entries
}

// Copy a walked source tree entry by entry with GNU per-entry errors: the
// shared primitive-transfer loop of cp and mv. A failed mkdir aborts the
// source (its children cannot be created); a failed read or write is
// reported and the remaining entries still copy, like GNU cp/mv on a
// cross-device transfer. Every error line carries fsStrerror, so a backend
// missing the needed op reports `Operation not supported` instead of
// aborting the command. `policy` applies -n/--update/--backup per file
// entry, like GNU during a recursive merge (null overwrites
// unconditionally); `writes`/`reads`/`lines` are optional per-entry sinks.
// Returns whether every entry landed and whether the destination changed
// at all.
export async function copyEntries(
  cmdName: string,
  strategy: PrimitiveCopy | PrimitiveMove,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  entries: { path: string; isDir: boolean }[],
  errors: string[],
  index?: IndexCacheStore,
  opts: {
    policy?: TransferPolicy
    writes?: Record<string, ByteSource>
    reads?: Record<string, Uint8Array>
    lines?: string[] | undefined
  } = {},
): Promise<{ copiedAll: boolean; wroteAny: boolean }> {
  const srcBase = rstripSlash(src.virtual)
  const dstBase = rstripSlash(target.virtual)
  let copiedAll = true
  let wroteAny = false
  for (const { path: entry, isDir } of entries) {
    const entrySpec = descendantPath(src, entry)
    const entryDstSpec = descendantPath(target, dstBase + entry.slice(srcBase.length))
    if (isDir) {
      try {
        if (!(await isDirectory(stat, entryDstSpec, index))) {
          await strategy.mkdir(entryDstSpec)
          wroteAny = true
          if (opts.writes !== undefined) opts.writes[entryDstSpec.mountPath] = new Uint8Array()
          if (opts.lines !== undefined) {
            opts.lines.push(`'${entry}' -> '${entryDstSpec.virtual}'`)
          }
        }
      } catch (err) {
        // GNU stops this source: the children of a directory it could
        // not create cannot land.
        if (!isFsError(err)) throw err
        errors.push(
          `${cmdName}: cannot create directory '${entryDstSpec.virtual}': ${String(fsStrerror(err))}`,
        )
        return { copiedAll: false, wroteAny }
      }
      continue
    }
    let backup: PathSpec | null = null
    if (opts.policy !== undefined) {
      if (!(await overwriteGate(opts.policy, stat, entrySpec, entryDstSpec, errors))) continue
      const made = await makeBackup(
        opts.policy,
        strategy,
        stat,
        strategy.readdir,
        entryDstSpec,
        opts.writes ?? {},
        errors,
        index,
      )
      if (!made.ok) {
        copiedAll = false
        continue
      }
      backup = made.backup
    }
    let data: Uint8Array
    try {
      data = await strategy.readBytes(entrySpec)
    } catch (err) {
      if (!isFsError(err)) throw err
      errors.push(`${cmdName}: cannot open '${entry}' for reading: ${String(fsStrerror(err))}`)
      copiedAll = false
      continue
    }
    try {
      // write takes bytes, not a stream: file materialized here.
      await strategy.write(entryDstSpec, data)
    } catch (err) {
      if (!isFsError(err)) throw err
      errors.push(
        `${cmdName}: cannot create regular file '${entryDstSpec.virtual}': ${String(fsStrerror(err))}`,
      )
      copiedAll = false
      continue
    }
    wroteAny = true
    if (opts.reads !== undefined) opts.reads[entrySpec.virtual] = data
    if (opts.writes !== undefined) opts.writes[entryDstSpec.mountPath] = new Uint8Array()
    if (opts.lines !== undefined) opts.lines.push(transferLine(entrySpec, entryDstSpec, backup))
  }
  return { copiedAll, wroteAny }
}

// Copy sources to a destination, fanning out into a directory. NativeCopy
// uses backend copy/find operations for an efficient same-store copy.
// PrimitiveCopy handles cross-mount copies by walking via readdir/stat and
// applying mkdir or write(readBytes(...)) to each entry. --update/--backup
// force the per-entry native loop (a whole-tree dirCopy cannot honor
// per-file decisions). Sources that streamed through the client are
// recorded as reads so applyIo can populate the file cache: a cp is also a
// full read.
export async function cpGeneric(
  paths: PathSpec[],
  stat: StatFn,
  strategy: CopyStrategy,
  flags: CpFlags,
  index?: IndexCacheStore,
  backendKey?: BackendKeyFn,
  readdir?: ReaddirFn,
): Promise<[ByteSource | null, IOResult]> {
  const keyOf = backendKey ?? backendKeyDefault
  const [sources, dstOperand] = splitOperands('cp', paths, flags.targetDir, flags.noTargetDir)
  let dst: PathSpec
  let dstIsDir: boolean
  if (dstOperand === null) {
    const firstSource = sources[0]
    if (firstSource === undefined) return [null, new IOResult()]
    dst =
      flags.targetDir instanceof PathSpec
        ? flags.targetDir
        : wrapTargetDir(firstSource, String(flags.targetDir))
    const err = await targetDirError('cp', stat, dst)
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
  if (versionReaddir === undefined && isPrimitiveCopy(strategy)) {
    versionReaddir = strategy.readdir
  }
  const policy: TransferPolicy = {
    cmdName: 'cp',
    noClobber: flags.noClobber,
    update: flags.update,
    backup: flags.backup,
    suffix: flags.suffix,
  }
  const perEntryNative = updateGates(flags.update) || backupDisplaces(flags.backup)
  const writes: Record<string, ByteSource> = {}
  const reads: Record<string, Uint8Array> = {}
  const lines: string[] = []
  const errors: string[] = []
  for (const [src, target] of copyTargets(sources, dst, dstIsDir)) {
    const { exists: srcExists, isDir: srcIsDir } = await entryKind(stat, src)
    if (!srcExists) {
      errors.push(`cp: cannot stat '${src.virtual}': No such file or directory`)
      continue
    }
    if (keyOf(src) === keyOf(target)) {
      errors.push(`cp: '${src.virtual}' and '${target.virtual}' are the same file`)
      continue
    }
    if (flags.recursive && keyOf(target).startsWith(keyOf(src) + '/')) {
      errors.push(`cp: cannot copy a directory, '${src.virtual}', into itself, '${target.virtual}'`)
      continue
    }
    if (!flags.recursive && srcIsDir) {
      errors.push(`cp: -r not specified; omitting directory '${src.virtual}'`)
      continue
    }
    const { exists: targetExists, isDir: targetIsDir } = await entryKind(stat, target)
    const mismatch = overwriteTypeError('cp', src, srcIsDir, target, targetExists, targetIsDir)
    if (mismatch !== null) {
      errors.push(mismatch)
      continue
    }
    if (flags.recursive && srcIsDir) {
      const srcBase = rstripSlash(src.mountPath)
      const dstBase = rstripSlash(target.mountPath)
      if (isPrimitiveCopy(strategy)) {
        const entries = await cpWalk(strategy.readdir, stat, src, index)
        await copyEntries('cp', strategy, stat, src, target, entries, errors, index, {
          policy,
          writes,
          reads,
          lines: flags.verbose ? lines : undefined,
        })
        continue
      }
      if (strategy.dirCopy !== undefined && !perEntryNative) {
        if (flags.noClobber && targetExists) continue
        await strategy.dirCopy(src, target)
        for (const entryMount of await strategy.find(src, { type: 'f' })) {
          const entry = mountedPath(src, entryMount)
          const entryDst = mountedPath(target, dstBase + entryMount.slice(srcBase.length))
          writes[entryDst.mountPath] = new Uint8Array()
          if (flags.verbose) lines.push(`'${entry.virtual}' -> '${entryDst.virtual}'`)
        }
        continue
      }
      // Per-entry policy forfeits dirCopy, so the tree's directories are
      // recreated here: a files-only pass would drop every directory that
      // holds no files (GNU keeps them).
      await mirrorDirs(strategy, stat, src, target, srcBase, dstBase, writes, errors, index)
      for (const entryMount of await strategy.find(src, { type: 'f' })) {
        const entry = mountedPath(src, entryMount)
        const entryDst = mountedPath(target, dstBase + entryMount.slice(srcBase.length))
        if (!(await overwriteGate(policy, stat, entry, entryDst, errors))) continue
        const made = await makeBackup(
          policy,
          strategy,
          stat,
          versionReaddir,
          entryDst,
          writes,
          errors,
          index,
        )
        if (!made.ok) continue
        await strategy.copy(entry, entryDst)
        writes[entryDst.mountPath] = new Uint8Array()
        if (flags.verbose) lines.push(transferLine(entry, entryDst, made.backup))
      }
      continue
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
    if (isPrimitiveCopy(strategy)) {
      let data: Uint8Array
      try {
        // write takes bytes, not a stream: the file is materialized here.
        data = await strategy.readBytes(src)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(`cp: cannot open '${src.virtual}' for reading: ${String(fsStrerror(err))}`)
        continue
      }
      try {
        await strategy.write(target, data)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(
          `cp: cannot create regular file '${target.virtual}': ${String(fsStrerror(err))}`,
        )
        continue
      }
      reads[src.virtual] = data
    } else {
      await strategy.copy(src, target)
    }
    writes[target.mountPath] = new Uint8Array()
    if (flags.verbose) lines.push(transferLine(src, target, made.backup))
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [
    output,
    new IOResult({
      writes,
      reads: { ...reads },
      cache: Object.keys(reads),
      stderr,
      exitCode: errors.length > 0 ? 1 : 0,
    }),
  ]
}
