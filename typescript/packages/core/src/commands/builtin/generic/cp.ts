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

import { pathVisible } from '../../../utils/hidden.ts'
import { mountedPath, respelled } from '../../../utils/key_prefix.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import {
  FileType,
  LINK_TARGET_KEY,
  PathSpec,
  type CopyDeref,
  type CopyStrategy,
  type FileStat,
  type NativeCopy,
  type NativeMove,
  type PrimitiveCopy,
  type PrimitiveMove,
  type ReaddirFn,
  type StatFn,
  type Visibility,
} from '../../../types.ts'
import { UsageError } from '../../errors.ts'
import { argmatchError, extraOperandError } from '../../spec/usage.ts'
import { argmatch } from '../../spec/argmatch.ts'
import type { FlagView } from '../../spec/flag_view.ts'
import { modifiedTs } from '../../../core/generic/find.ts'
import { backupControl, backupTarget } from '../utils/backup.ts'
import { DEFAULT_BACKUP_SUFFIX } from '../utils/constants.ts'
import {
  STAT_REFUSALS,
  backendKeyDefault,
  copyTargets,
  isDirectory,
  pathExists,
  type BackendKeyFn,
} from '../utils/copy.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import {
  fsStrerror,
  isDotWalkError,
  isEacces,
  isEnotdir,
  isFsError,
  isMissingPath,
} from '../../../errors/fs.ts'
import { typedLink } from '../utils/links.ts'
import { absentDestError, descendantPath, nearestAncestor, spelledFrom } from '../utils/paths.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import type { LinkView } from '../../../doors/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { CycleError, resolvePath } from '../../../utils/path.ts'
import { shellQuoteAlways } from '../../../utils/quote.ts'
import type { FsCondition } from '../../../errors/types.ts'

const ENC = new TextEncoder()

const UPDATE_MODES = ['all', 'none', 'none-fail', 'older'] as const

export interface CpFlags {
  recursive: boolean
  noClobber: boolean
  interactive: boolean
  verbose: boolean
  update: string | null
  backup: string | null
  suffix: string
  targetDir: PathSpec | null
  noTargetDir: boolean
  dereference: CopyDeref
}

/**
 * Namespace symlink facts and dispatcher primitives for cp and mv.
 * Links live above every backend, so no copy strategy lists one and a tree
 * copy has to recreate each by name. `relay` and `relayStat` are the door's
 * own transfer primitives, which copy what a followed link leads to on
 * whatever mount it lives. Mirrors Python's TransferLinks.
 */
export interface TransferLinks {
  links: LinkView
  dispatch: DispatchFn
  cwd: string
  relay: PrimitiveCopy
  relayStat: StatFn
  /** The session's visibility; a link it hides is not copied. */
  visibility?: Visibility
}

// Each option of cp's link policy, and what it asks for; the last typed wins
// (coreutils 9.7: `-L -P` copies the link, `-P -L` what it names).
const DEREF_OPTIONS: Readonly<Record<string, CopyDeref>> = {
  dereference: 'always',
  no_dereference: 'never',
  H: 'command_line',
  d: 'never',
  archive: 'never',
}

export function cpFlags(init: Partial<CpFlags> = {}): CpFlags {
  return {
    recursive: init.recursive ?? false,
    noClobber: init.noClobber ?? false,
    interactive: init.interactive ?? false,
    verbose: init.verbose ?? false,
    update: init.update ?? null,
    backup: init.backup ?? null,
    suffix: init.suffix ?? DEFAULT_BACKUP_SUFFIX,
    targetDir: init.targetDir ?? null,
    noTargetDir: init.noTargetDir ?? false,
    dereference: init.dereference ?? 'always',
  }
}

// Per-entry overwrite policy shared by cp and mv: the command name for
// error prefixes, -n, the --update mode, the canonical backup control, the
// simple-backup suffix and -i's question for one target.
export interface TransferPolicy {
  cmdName: string
  noClobber: boolean
  update: string | null
  backup: string | null
  suffix: string
  ask?: ((target: PathSpec) => Promise<boolean>) | null
}

/**
 * GNU's -i: ask on stderr before replacing a target and read one line of
 * stdin as the answer. Only a line starting with `y` or `Y` is yes (rpmatch
 * in the C locale); the end of input is no. A yes is recorded in `accepted`,
 * since it is no failure. Mirrors Python's prompter.
 */
export function prompter(
  cmdName: string,
  stdin: ByteSource | null,
  errors: string[],
  accepted: string[],
): (target: PathSpec) => Promise<boolean> {
  const replies = stdin !== null ? new AsyncLineIterator(stdin) : null
  return async (target: PathSpec): Promise<boolean> => {
    errors.push(`${cmdName}: overwrite ${shellQuoteAlways(target.rawPath)}? `)
    const reply = replies !== null ? await replies.readline() : null
    const first = reply?.[0]
    if (first !== 0x79 && first !== 0x59) return false
    accepted.push(target.virtual)
    return true
  }
}

// The collected messages as stderr: one per line, except that a question
// leaves the cursor after it, as a terminal prompt does. Mirrors Python's
// stderr_of.
export function stderrOf(errors: readonly string[]): Uint8Array | null {
  if (errors.length === 0) return null
  return ENC.encode(errors.map((line) => (line.endsWith('? ') ? line : `${line}\n`)).join(''))
}

function isPrimitiveCopy(strategy: CopyStrategy): strategy is PrimitiveCopy {
  return 'readBytes' in strategy
}

// Whether an --update mode can skip or fail an individual entry. 'all'
// copies unconditionally, so it needs no per-entry decision and must not
// cost a target probe or forfeit a whole-tree dirCopy.
export function updateGates(mode: string | null): boolean {
  return mode !== null && mode !== 'all'
}

// Whether a backup control actually moves an existing target aside. 'none'
// is a no-op control, so it needs no per-entry decision.
export function backupDisplaces(control: string | null): boolean {
  return control !== null && control !== 'none'
}

// Resolve -u/--update[=UPDATE] to a GNU update mode.
export function updateMode(cmdName: string, fl: FlagView): string | null {
  const value: unknown = fl.raw('update')
  if (value === undefined || value === false) return null
  if (value === true) return 'older'
  const shown = typeof value === 'string' ? value : ''
  const match = argmatch(shown, UPDATE_MODES)
  if (match.matched) return match.word
  throw argmatchError(cmdName, '--update', shown, UPDATE_MODES, 1, match.kind)
}

// The --suffix value, an empty one reading as absent: GNU 9.7
// `cp --backup --suffix= f g` writes the default `g~`, not a backup whose
// name is the original's. Python's twin is cp.suffix_flag.
export function suffixFlag(fl: FlagView): string | null {
  const value = fl.asStr('suffix')
  return value === undefined || value === '' ? null : value
}

// The raw -b/--backup value, absent shapes reading as undefined. The parser
// lands both spellings on the canonical `backup` dest, so the key already
// carries GNU's last-occurrence-wins value.
export function backupRaw(fl: FlagView): string | boolean | undefined {
  const value: unknown = fl.raw('backup')
  if (typeof value === 'string' || typeof value === 'boolean') return value
  return undefined
}

// -t arrives as the PathSpec of the word that spelled it. Mirrors Python.
export function targetFlags(cmdName: string, fl: FlagView): [PathSpec | null, boolean] {
  const raw: unknown = fl.raw('target_directory')
  const targetDir = raw instanceof PathSpec ? raw : null
  const noTarget = fl.asBool('no_target_directory')
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
export function parseFlags(fl: FlagView): CpFlags {
  const update = updateMode('cp', fl)
  const suffix = suffixFlag(fl)
  const control = backupControl('cp', backupRaw(fl), suffix)
  // -i and -n set one answer, so the later of the two wins.
  const asking = fl.typedOrder('interactive', 'no_clobber').at(-1)
  const noClobber = asking === 'no_clobber'
  if (control !== null && control !== 'none' && (noClobber || update === 'none-fail')) {
    throw new UsageError(
      'cp: --backup is mutually exclusive with -n or --update=none-fail\n' +
        "Try 'cp --help' for more information.",
      1,
    )
  }
  const [targetDir, noTargetDir] = targetFlags('cp', fl)
  const recursive = fl.asBool('r') || fl.asBool('recursive') || fl.asBool('archive')
  const last = fl.typedOrder(...Object.keys(DEREF_OPTIONS)).at(-1)
  // With no link option a recursive copy copies links as links and any other
  // copy follows them (cp.c's DEREF_UNDEFINED default).
  const dereference: CopyDeref =
    last !== undefined ? (DEREF_OPTIONS[last] ?? 'always') : recursive ? 'never' : 'always'
  return cpFlags({
    recursive,
    noClobber,
    interactive: asking === 'interactive',
    verbose: fl.asBool('verbose'),
    update,
    backup: control,
    suffix: suffix ?? DEFAULT_BACKUP_SUFFIX,
    targetDir,
    noTargetDir,
    dereference,
  })
}

// What stands at a path, asked through the door; null where nothing does,
// which is where a new link goes. Mirrors Python's _entry_at.
async function entryAt(dispatch: DispatchFn, spec: PathSpec): Promise<FileStat | null> {
  try {
    const [there] = await dispatch('stat', spec)
    return there !== null && typeof there === 'object' && 'type' in there
      ? (there as FileStat)
      : null
  } catch (err) {
    if (isMissingPath(err) || isEnotdir(err) || (err as { code?: string }).code === 'ELOOP')
      return null
    throw err
  }
}

/** Stat the entry itself for overwrite and backup decisions. */
export async function linkStat(copies: TransferLinks, path: PathSpec): Promise<FileStat> {
  return copies.links.statAt(path.virtual) ?? (await copies.relayStat(path))
}

export async function renameLink(
  copies: TransferLinks,
  src: PathSpec,
  target: PathSpec,
): Promise<void> {
  await copies.dispatch('rename', src, [target])
}

/** Copy a symlink through the shared overwrite and backup policy. */
export async function makeLink(
  copies: TransferLinks,
  src: PathSpec,
  target: PathSpec,
  text: string,
  policy: TransferPolicy,
  writes: Record<string, ByteSource>,
  errors: string[],
  lines: string[] | undefined,
): Promise<boolean> {
  const stat: StatFn = (path) => linkStat(copies, path)
  const targetLink = copies.links.statAt(target.virtual)
  const there = targetLink ?? (await entryAt(copies.dispatch, target))
  if (there?.type === FileType.DIRECTORY) {
    errors.push(
      `${policy.cmdName}: cannot overwrite directory '${target.rawPath}' with non-directory`,
    )
    return false
  }
  if (!(await overwriteGate(policy, stat, src, target, errors))) return false
  const made = await makeBackup(
    policy,
    targetLink === null ? copies.relay : { rename: (a, b) => renameLink(copies, a, b) },
    stat,
    copies.relay.readdir,
    target,
    writes,
    errors,
    undefined,
    copies,
  )
  if (!made.ok) return false
  try {
    if (await pathExists(stat, target)) await copies.dispatch('unlink', target)
    await copies.dispatch('symlink', target, [], { target: text })
  } catch (err) {
    if (!isFsError(err)) throw err
    errors.push(
      `${policy.cmdName}: cannot create symbolic link '${target.rawPath}': ${String(fsStrerror(err))}`,
    )
    return false
  }
  writes[target.mountPath] = new Uint8Array()
  lines?.push(transferLine(src, target, made.backup))
  return true
}

/**
 * Recreate the links below a copied directory, which its copy could not see.
 * Without -L each lands as a link with its target verbatim, dangling and
 * looping ones included. Under -L each is what it leads to: a file's bytes, a
 * directory's whole tree (the links below it included), and `cannot stat` for
 * one that leads nowhere or loops (coreutils 9.7). A link that leads back into
 * a tree being copied is refused as GNU names it, `cannot copy cyclic symbolic
 * link`, rather than copied until the name is too long, which is where GNU
 * stops. Mirrors Python's copy_tree_links.
 */
export async function copyTreeLinks(
  copies: TransferLinks,
  deref: CopyDeref,
  src: PathSpec,
  target: PathSpec,
  errors: string[],
  lines: string[] | undefined,
  policy: TransferPolicy,
  writes: Record<string, ByteSource>,
  reads: Record<string, Uint8Array>,
  seen: readonly string[] = [],
): Promise<void> {
  const base = rstripSlash(src.virtual) || '/'
  const dstBase = rstripSlash(target.virtual)
  const shownSrc = rstripSlash(src.rawPath) || src.rawPath
  const shownDst = rstripSlash(target.rawPath) || target.rawPath
  const below = [...copies.links.subtree(base)].sort((a, b) => compareCodePoints(a[0], b[0]))
  for (const [virtual, row] of below) {
    if (!pathVisible(copies.visibility, virtual)) continue
    const rel = virtual.slice(rstripSlash(base).length + 1)
    const landing = `${dstBase}/${rel}`
    const shown = `${shownSrc}/${rel}`
    if (deref !== 'always') {
      const raw = row.extra[LINK_TARGET_KEY]
      const text = typeof raw === 'string' ? raw : ''
      await makeLink(
        copies,
        respelled(PathSpec.fromStrPath(virtual), shown),
        respelled(PathSpec.fromStrPath(landing), `${shownDst}/${rel}`),
        text,
        policy,
        writes,
        errors,
        lines,
      )
      continue
    }
    let resolved: string
    try {
      resolved = copies.links.resolve(virtual)
    } catch (err) {
      if (!(err instanceof CycleError)) throw err
      errors.push(`cp: cannot stat '${shown}': ${posixPhrase('ELOOP')}`)
      continue
    }
    const leads = await copies.links.targetStat(virtual)
    if (leads === null) {
      errors.push(`cp: cannot stat '${shown}': No such file or directory`)
      continue
    }
    if (leads.type !== FileType.DIRECTORY) {
      const entry = respelled(PathSpec.fromStrPath(resolved), shown)
      await copyEntries(
        'cp',
        copies.relay,
        copies.relayStat,
        entry,
        PathSpec.fromStrPath(landing),
        [{ path: entry.virtual, isDir: false }],
        errors,
        undefined,
        { policy, writes, reads, lines, copies },
      )
      continue
    }
    const inside = rstripSlash(resolved) || '/'
    if ([...seen, base].some((d) => d === inside || d.startsWith(`${rstripSlash(inside)}/`))) {
      errors.push(`cp: cannot copy cyclic symbolic link '${shown}'`)
      continue
    }
    const followed = PathSpec.fromStrPath(inside)
    const placed = PathSpec.fromStrPath(landing)
    const entries = await cpWalk(
      copies.relay.readdir,
      copies.relayStat,
      followed,
      undefined,
      'cp',
      errors,
      copies.links,
    )
    await copyEntries(
      'cp',
      copies.relay,
      copies.relayStat,
      followed,
      placed,
      entries,
      errors,
      undefined,
      {
        policy,
        writes,
        reads,
        ...(lines !== undefined ? { lines } : {}),
        copies,
      },
    )
    await copyTreeLinks(
      copies,
      deref,
      respelled(followed, shown),
      respelled(placed, `${shownDst}/${rel}`),
      errors,
      lines,
      policy,
      writes,
      reads,
      [...seen, base],
    )
  }
}

// Split operands into sources and destination, GNU arity errors. With -t
// every operand is a source and the target directory is the destination.
// -T requires exactly two operands.
export function splitOperands(
  cmdName: string,
  paths: PathSpec[],
  targetDir: PathSpec | null,
  noTargetDir: boolean,
): [PathSpec[], PathSpec] {
  const hint = `Try '${cmdName} --help' for more information.`
  const first = paths[0]
  if (first === undefined) {
    throw new UsageError(`${cmdName}: missing file operand\n${hint}`, 1)
  }
  if (targetDir !== null) return [[...paths], targetDir]
  if (paths.length === 1) {
    throw new UsageError(
      `${cmdName}: missing destination file operand after '${first.rawPath}'\n${hint}`,
      1,
    )
  }
  if (noTargetDir && paths.length > 2) {
    throw extraOperandError(cmdName, paths[2]?.rawPath ?? '')
  }
  return [paths.slice(0, -1), paths[paths.length - 1] ?? first]
}

// The error line when a -t operand is missing or not a directory.
export async function targetDirError(
  cmdName: string,
  stat: StatFn,
  target: PathSpec,
): Promise<string | null> {
  let condition: FsCondition
  try {
    const info = await stat(target)
    if (info.type === FileType.DIRECTORY) return null
    condition = 'ENOTDIR'
  } catch (err) {
    if (isEnotdir(err)) condition = 'ENOTDIR'
    else if ((err as { code?: unknown }).code === 'ELOOP') condition = 'ELOOP'
    else if (isMissingPath(err)) condition = 'ENOENT'
    else throw err
  }
  return `${cmdName}: target directory '${target.rawPath}': ${posixPhrase(condition)}`
}

// Probe a destination for {exists, isDir, condition}. cp and mv are not
// `mkdir -p`: neither creates the destination's parent, so a missing or
// non-directory component is a per-operand failure, and GNU surfaces the two
// at different phases. A non-directory fails the destination stat itself:
// `reg/x` at any depth, and `reg/` typed with a slash over a plain file, are
// both "cannot stat 'DST': Not a directory". A merely absent parent fails the
// create or the rename ("cannot create regular file" for cp, "cannot move"
// for mv), so the condition comes back bare and each caller words it in its
// own voice. null means the destination exists or its parent is a usable
// directory.
//
// The backends answer ENOENT for a path under a plain file just as they do
// for a genuinely absent one (only a slashed operand makes the stat itself
// say ENOTDIR), so the chain is walked upward until something exists
// (absentDestError); the common case (the parent is there) costs a
// single stat.
export async function destKind(
  stat: StatFn,
  target: PathSpec,
): Promise<{ exists: boolean; isDir: boolean; condition: FsCondition | null }> {
  let info: FileStat | null = null
  try {
    info = await stat(target)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOTDIR') return { exists: false, isDir: false, condition: 'ENOTDIR' }
    if (code === 'ELOOP') return { exists: false, isDir: false, condition: 'ELOOP' }
    // Its `..` passes a name that is not there: the chain of the path it
    // simplifies to says nothing about this one.
    if (isDotWalkError(err)) return { exists: false, isDir: false, condition: 'ENOENT' }
    if (!isMissingPath(err)) throw err
  }
  if (info !== null)
    return { exists: true, isDir: info.type === FileType.DIRECTORY, condition: null }
  return { exists: false, isDir: false, condition: await absentDestError(stat, target) }
}

// Whether a slash-terminated destination refuses a non-directory. POSIX
// resolves `missing/` as `missing/.`, so the name may only ever be a
// directory: rename(2) and open(2) refuse to put a file there with ENOTDIR
// where a bare `missing` would take it. GNU 9.7 words it at the create
// ("mv: cannot move 'f' to 'missing/': Not a directory", "cp: cannot create
// regular file 'missing/': Not a directory"); a directory source passes,
// since the slash asked for exactly what it is. An existing destination
// never reaches this: a directory receives the move inside it, and a
// non-directory has already failed the stat.
export function slashRefusesFile(
  target: PathSpec,
  targetExists: boolean,
  srcIsDir: boolean,
): boolean {
  return !targetExists && target.rawPath.endsWith('/') && !srcIsDir
}

// Probe a source operand, keeping the errno the kernel reports: `cp /plain/child /dst`
// is `cannot stat 'X': Not a directory`, not "No such file or directory". The
// backends cannot supply that distinction, because stat answers ENOENT for a
// path under a plain file just as it does for a genuinely absent one (only
// readdir splits the two). So the chain is walked the way destKind walks
// a destination's: the first component that does exist decides, and a plain
// file there means ENOTDIR. Walking happens only on the failure path.
export async function sourceKind(
  stat: StatFn,
  path: PathSpec,
): Promise<{ exists: boolean; isDir: boolean; condition: FsCondition | null }> {
  let info: FileStat | null = null
  try {
    info = await stat(path)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOTDIR') return { exists: false, isDir: false, condition: 'ENOTDIR' }
    if (code === 'ELOOP') return { exists: false, isDir: false, condition: 'ELOOP' }
    if (!isMissingPath(err)) throw err
  }
  if (info !== null)
    return { exists: true, isDir: info.type === FileType.DIRECTORY, condition: null }
  const [, isDir] = await nearestAncestor(stat, path)
  return { exists: false, isDir: false, condition: isDir ? 'ENOENT' : 'ENOTDIR' }
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
    return `${cmdName}: cannot overwrite non-directory '${target.rawPath}' with directory '${src.rawPath}'`
  }
  if (!srcIsDir && targetIsDir) {
    return `${cmdName}: cannot overwrite directory '${target.rawPath}' with non-directory '${src.rawPath}'`
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
  const ask = policy.ask ?? null
  if (!policy.noClobber && !updateGates(policy.update) && ask === null) return true
  let targetInfo: FileStat
  try {
    targetInfo = await stat(target)
  } catch (err) {
    // A probe failure here is not permission to clobber: returning true on an
    // auth error or timeout would silently defeat -n / --update=none.
    if (!isMissingPath(err) && !isEnotdir(err)) throw err
    return true
  }
  if (policy.noClobber || policy.update === 'none') return false
  if (policy.update === 'none-fail') {
    errors.push(`${policy.cmdName}: not replacing '${target.rawPath}'`)
    return false
  }
  if (policy.update === 'older') {
    let srcInfo: FileStat
    try {
      srcInfo = await stat(src)
    } catch (err) {
      if (!isMissingPath(err) && !isEnotdir(err)) throw err
      return true
    }
    const srcTs = modifiedTs(srcInfo.modified)
    const targetTs = modifiedTs(targetInfo.modified)
    if (srcTs !== null && targetTs !== null && srcTs <= targetTs) return false
  }
  // -i asks last, once the target survived the update checks.
  return ask !== null ? ask(target) : true
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
    errors.push(`${cmdName}: cannot backup '${target.rawPath}': Operation not supported`)
    return false
  }
  await strategy.dirCopy(target, backup)
  return true
}

async function restoreBackupLink(
  copies: TransferLinks,
  backup: PathSpec,
  link: FileStat,
  cmdName: string,
  errors: string[],
): Promise<void> {
  try {
    if (await pathExists((path) => linkStat(copies, path), backup)) {
      await copies.dispatch('unlink', backup)
    }
    const raw = link.extra[LINK_TARGET_KEY]
    await copies.dispatch('symlink', backup, [], { target: typeof raw === 'string' ? raw : '' })
  } catch (err) {
    if (!isFsError(err)) throw err
    errors.push(`${cmdName}: cannot restore backup '${backup.rawPath}': ${String(fsStrerror(err))}`)
  }
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
  copies?: TransferLinks,
): Promise<{ backup: PathSpec | null; ok: boolean }> {
  if (policy.backup === null) return { backup: null, ok: true }
  if (!(await pathExists(stat, target))) return { backup: null, ok: true }
  let backup: PathSpec | null
  try {
    // A failed version scan must not degrade to `.~1~`/the simple suffix:
    // that would overwrite existing backup history.
    backup = await backupTarget(
      copies?.relay.readdir ?? readdir,
      target,
      policy.backup,
      policy.suffix,
    )
  } catch (err) {
    if (!isFsError(err)) throw err
    errors.push(`${policy.cmdName}: cannot backup '${target.rawPath}': ${String(fsStrerror(err))}`)
    return { backup: null, ok: false }
  }
  if (backup === null) return { backup: null, ok: true }
  const backupLink =
    copies !== undefined && !('rename' in strategy) ? copies.links.statAt(backup.virtual) : null
  let removedLink = false
  let made = false
  try {
    if (copies !== undefined && backupLink !== null) {
      await copies.dispatch('unlink', backup)
      removedLink = true
    }
    made = await duplicateForBackup(strategy, stat, target, backup, errors, policy.cmdName, index)
  } catch (err) {
    if (!isFsError(err)) throw err
    errors.push(`${policy.cmdName}: cannot backup '${target.rawPath}': ${String(fsStrerror(err))}`)
    return { backup: null, ok: false }
  } finally {
    if (removedLink && !made && copies !== undefined && backupLink !== null) {
      await restoreBackupLink(copies, backup, backupLink, policy.cmdName, errors)
    }
  }
  if (!made) return { backup: null, ok: false }
  writes[backup.mountPath] = new Uint8Array()
  return { backup, ok: true }
}

// The cp verbose line, with GNU's backup annotation when one exists.
function transferLine(src: PathSpec, target: PathSpec, backup: PathSpec | null): string {
  let line = `'${src.rawPath}' -> '${target.rawPath}'`
  if (backup !== null) line += ` (backup: '${backup.rawPath}')`
  return line
}

// Recreate a source tree's directories under the destination root. Only
// needed on the per-entry policy path, where a whole-tree dirCopy cannot be
// used: without this, a directory holding no files would never appear at the
// destination, and an entirely empty tree would copy to nothing. A backend
// exposing no mkdir (directories are implied by keys) is a no-op. Parents
// sort before children so a nested tree lands in order.
// GNU -v lines for a tree about to be copied natively, parents first. GNU
// `cp -rv` reports every file and every directory it creates, including the
// source root itself; a directory already at the destination is merged into
// without a line. Read before the copy, so the destination still shows which
// directories exist. Deliberate divergence: GNU's sibling order follows
// readdir, which no backend can reproduce, so entries are sorted
// lexicographically instead. That keeps every parent ahead of its children
// (GNU's only load-bearing ordering guarantee) and is stable across backends.
async function treeLines(
  strategy: NativeCopy,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  srcBase: string,
  dstBase: string,
  index?: IndexCacheStore,
): Promise<string[]> {
  const dirs = new Set([srcBase, ...(await strategy.find(src, { type: 'd' }))])
  const files = await strategy.find(src, { type: 'f' })
  const unique = [...new Set([...dirs, ...files])].sort(compareCodePoints)
  const lines: string[] = []
  for (const entryMount of unique) {
    const entry = spelledFrom(mountedPath(src, entryMount), src)
    const entryDst = spelledFrom(
      mountedPath(target, dstBase + entryMount.slice(srcBase.length)),
      target,
    )
    if (dirs.has(entryMount) && (await isDirectory(stat, entryDst, index))) continue
    lines.push(`'${entry.rawPath}' -> '${entryDst.rawPath}'`)
  }
  return lines
}

// A failed mkdir stops the whole source, mirroring copyEntries and GNU: the
// children of a directory that could not be created cannot land, so reporting
// one line per descendant (and then copying the files anyway) would be both
// noisy and wrong. Returns false when the caller must skip the file pass.
// Whether `path` is `root` or below it. Mirrors Python's within.
export function within(path: string, root: string): boolean {
  const base = rstripSlash(root)
  return rstripSlash(path) === base || path.startsWith(`${base}/`)
}

async function mirrorDirs(
  strategy: NativeCopy,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  srcBase: string,
  dstBase: string,
  writes: Record<string, ByteSource>,
  errors: string[],
  intoItself: boolean,
  index?: IndexCacheStore,
  lines?: string[],
): Promise<boolean> {
  if (strategy.mkdir === undefined) return true
  // A destination inside the source leaves its own subtree out, as the
  // file pass does.
  const mounts = [srcBase, ...(await strategy.find(src, { type: 'd' }))].filter(
    (found) => !(intoItself && within(found, dstBase)),
  )
  // Shortest first so a parent is created before its children, then by name:
  // sorting on length alone leaves equal-length siblings in whatever order
  // the Set happened to hold, which is insertion order here and hash order in
  // Python. Same key on both sides, same output.
  const unique = [...new Set(mounts)].sort((a, b) => a.length - b.length || compareCodePoints(a, b))
  for (const entryMount of unique) {
    const entryDst = spelledFrom(
      mountedPath(target, dstBase + entryMount.slice(srcBase.length)),
      target,
    )
    if (await isDirectory(stat, entryDst, index)) continue
    try {
      await strategy.mkdir(entryDst)
    } catch (err) {
      if (!isFsError(err)) throw err
      errors.push(`cp: cannot create directory '${entryDst.rawPath}': ${String(fsStrerror(err))}`)
      return false
    }
    writes[entryDst.mountPath] = new Uint8Array()
    if (lines !== undefined) {
      const entry = spelledFrom(mountedPath(src, entryMount), src)
      lines.push(`'${entry.rawPath}' -> '${entryDst.rawPath}'`)
    }
  }
  return true
}

// List a tree as {path, isDir} pairs, parents before children. The type is
// captured while the tree is intact so a caller that deletes as it goes (mv)
// never re-stats a path whose virtual parent has since vanished. Mirrors the
// Python cp `walk`; used only by the primitive (no native copy) path. A
// folder a backend lists with a trailing slash (box, dropbox, gdrive) is
// walked without it. A directory the session may not open, or an entry it may not stat (a rule
// refused it below the operand), is GNU's `cannot access` / `cannot stat`
// line when `errors` is given and the walk goes on without its contents;
// with no channel the refusal propagates rather than leave a silent gap.
export async function cpWalk(
  readdir: ReaddirFn,
  stat: StatFn,
  root: PathSpec,
  index?: IndexCacheStore,
  cmdName = 'cp',
  errors?: string[],
  links?: LinkView,
): Promise<{ path: string; isDir: boolean }[]> {
  const info = await stat(root, index)
  if (info.type !== FileType.DIRECTORY) return [{ path: root.virtual, isDir: false }]
  const entries: { path: string; isDir: boolean }[] = [{ path: root.virtual, isDir: true }]
  const queue: PathSpec[] = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    if (directory === undefined) break
    let children: string[]
    try {
      children = await readdir(directory)
    } catch (err) {
      if (errors === undefined || !isEacces(err)) throw err
      errors.push(`${cmdName}: cannot access '${directory.rawPath}': ${String(fsStrerror(err))}`)
      continue
    }
    for (const listed of children) {
      const child = rstripSlash(listed)
      const childSpec = descendantPath(root, child)
      if (links?.statAt(childSpec.virtual) != null) continue
      let childInfo
      try {
        childInfo = await stat(childSpec, index)
      } catch (err) {
        if (errors === undefined || !isEacces(err)) throw err
        errors.push(`${cmdName}: cannot stat '${childSpec.rawPath}': ${String(fsStrerror(err))}`)
        continue
      }
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
    copies?: TransferLinks | undefined
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
            opts.lines.push(`'${entrySpec.rawPath}' -> '${entryDstSpec.rawPath}'`)
          }
        }
      } catch (err) {
        // GNU stops this source: the children of a directory it could
        // not create cannot land.
        if (!isFsError(err)) throw err
        errors.push(
          `${cmdName}: cannot create directory '${entryDstSpec.rawPath}': ${String(fsStrerror(err))}`,
        )
        return { copiedAll: false, wroteAny }
      }
      continue
    }
    const link = opts.copies?.links.statAt(entry)
    if (opts.copies !== undefined && link != null) {
      const errorCount = errors.length
      const raw = link.extra[LINK_TARGET_KEY]
      const made = await makeLink(
        opts.copies,
        entrySpec,
        entryDstSpec,
        typeof raw === 'string' ? raw : '',
        opts.policy ?? {
          cmdName,
          noClobber: false,
          update: null,
          backup: null,
          suffix: DEFAULT_BACKUP_SUFFIX,
        },
        opts.writes ?? {},
        errors,
        opts.lines,
      )
      wroteAny = wroteAny || made
      if (errors.length > errorCount) copiedAll = false
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
        opts.copies,
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
        `${cmdName}: cannot create regular file '${entryDstSpec.rawPath}': ${String(fsStrerror(err))}`,
      )
      copiedAll = false
      continue
    }
    wroteAny = true
    if (opts.reads !== undefined) opts.reads[entrySpec.mountPath] = data
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
  // The link standing at the name a destination was typed as, its own row,
  // null where none stands (the router has followed the operand by the time
  // cp runs); undefined outside a workspace. Mirrors Python's link_at.
  linkAt?: (path: PathSpec) => FileStat | null,
  // The namespace's links and the door that makes them, so a link is copied
  // as a link where the policy says to; undefined outside a workspace, where
  // no link can stand.
  copies?: TransferLinks,
  // Where -i reads its answers.
  stdin?: ByteSource | null,
): Promise<[ByteSource | null, IOResult]> {
  const keyOf = backendKey ?? backendKeyDefault
  const [sources, dst] = splitOperands('cp', paths, flags.targetDir, flags.noTargetDir)
  let dstIsDir: boolean
  let dstExists: boolean
  let dstErr: FsCondition | null = null
  if (flags.targetDir !== null) {
    const err = await targetDirError('cp', stat, dst)
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
  if (versionReaddir === undefined && isPrimitiveCopy(strategy)) {
    versionReaddir = strategy.readdir
  }
  const errors: string[] = []
  const accepted: string[] = []
  const policy: TransferPolicy = {
    cmdName: 'cp',
    noClobber: flags.noClobber,
    update: flags.update,
    backup: flags.backup,
    suffix: flags.suffix,
    ask: flags.interactive ? prompter('cp', stdin ?? null, errors, accepted) : null,
  }
  const perEntryNative =
    flags.noClobber ||
    flags.interactive ||
    updateGates(flags.update) ||
    backupDisplaces(flags.backup)
  const writes: Record<string, ByteSource> = {}
  const reads: Record<string, Uint8Array> = {}
  const lines: string[] = []
  let warned = 0
  const seen = new Set<string>()
  const created = new Set<string>()
  const guardsCreated = !(
    flags.noClobber ||
    updateGates(flags.update) ||
    flags.backup === 'numbered'
  )
  for (const [src, target] of copyTargets(sources, dst, dstIsDir, dstExists, dstErr)) {
    if (dstIsDir && seen.has(keyOf(src)) && !backupDisplaces(flags.backup)) {
      errors.push(`cp: warning: source file '${src.rawPath}' specified more than once`)
      warned += 1
      continue
    }
    seen.add(keyOf(src))
    const link =
      copies !== undefined && flags.dereference === 'never'
        ? typedLink(copies.links, src, copies.cwd)
        : null
    if (copies !== undefined && link !== null) {
      // The router followed the operand, but the policy copies the link
      // itself, whatever it leads to (coreutils 9.7). Onto a destination that
      // is no directory the link replaces the name as typed, never what a link
      // standing there leads to.
      const named = resolvePath(src.rawPath || src.virtual, copies.cwd)
      const landing =
        target !== dst ? target.virtual : resolvePath(dst.rawPath || dst.virtual, copies.cwd)
      if (named === landing) {
        errors.push(`cp: '${src.rawPath}' and '${target.rawPath}' are the same file`)
        continue
      }
      if (guardsCreated && created.has(keyOf(target))) {
        if (policy.ask && !(await policy.ask(target))) continue
        errors.push(`cp: will not overwrite just-created '${target.rawPath}' with '${src.rawPath}'`)
        continue
      }
      const raw = link.extra[LINK_TARGET_KEY]
      const text = typeof raw === 'string' ? raw : ''
      const made = await makeLink(
        copies,
        respelled(PathSpec.fromStrPath(named), src.rawPath),
        respelled(PathSpec.fromStrPath(landing), target.rawPath),
        text,
        policy,
        writes,
        errors,
        flags.verbose ? lines : undefined,
      )
      if (made) created.add(keyOf(target))
      continue
    }
    const { isDir: srcIsDir, condition: srcErr } = await sourceKind(stat, src)
    if (srcErr !== null) {
      errors.push(`cp: cannot stat '${src.rawPath}': ${posixPhrase(srcErr)}`)
      continue
    }
    if (flags.noTargetDir && !srcIsDir && target.walkError !== null && target.rawPath === '') {
      // Under -T, GNU stats an empty destination as the directory it is
      // typed in, which a file cannot overwrite (coreutils 9.7). A
      // directory source it merges into the working directory; mirage
      // refuses that at the create, since reading the empty name as the
      // working directory is what `walkError` is for.
      errors.push(`cp: cannot overwrite directory '' with non-directory '${src.rawPath}'`)
      continue
    }
    if (keyOf(src) === keyOf(target)) {
      errors.push(`cp: '${src.rawPath}' and '${target.rawPath}' are the same file`)
      continue
    }
    // GNU copies a directory into its own subtree too: everything but the
    // new copy itself, before it says it could not (cp -r d d).
    const intoItself = flags.recursive && keyOf(target).startsWith(keyOf(src) + '/')
    if (!flags.recursive && srcIsDir) {
      errors.push(`cp: -r not specified; omitting directory '${src.rawPath}'`)
      continue
    }
    const probe =
      !flags.noTargetDir && target.virtual === dst.virtual
        ? { exists: dstExists, isDir: dstIsDir, condition: dstErr }
        : await destKind(stat, target)
    const { exists: targetExists, isDir: targetIsDir } = probe
    let targetErr = probe.condition
    if (targetErr !== null && STAT_REFUSALS.has(targetErr)) {
      errors.push(`cp: cannot stat '${target.rawPath}': ${posixPhrase(targetErr)}`)
      continue
    }
    // The create fails on the absent parent before the slash matters, so a
    // chain verdict keeps its ENOENT (`cp f deep/missing/`).
    if (slashRefusesFile(target, targetExists, srcIsDir)) targetErr ??= 'ENOTDIR'
    if (targetErr !== null) {
      const noun = srcIsDir ? 'directory' : 'regular file'
      errors.push(`cp: cannot create ${noun} '${target.rawPath}': ${posixPhrase(targetErr)}`)
      continue
    }
    const mismatch = overwriteTypeError('cp', src, srcIsDir, target, targetExists, targetIsDir)
    if (mismatch !== null) {
      errors.push(mismatch)
      continue
    }
    if (!targetExists && linkAt !== undefined && linkAt(target) !== null) {
      // A dangling link: the stat followed it to nothing, but the name is
      // taken. GNU will not create the file it points at (POSIX would), and
      // the link is a non-directory to a tree.
      if (srcIsDir) {
        errors.push(
          `cp: cannot overwrite non-directory '${target.rawPath}' with directory '${src.rawPath}'`,
        )
        continue
      }
      if (flags.verbose) lines.push(transferLine(src, target, null))
      errors.push(`cp: not writing through dangling symlink '${target.rawPath}'`)
      continue
    }
    if (intoItself) {
      errors.push(`cp: cannot copy a directory, '${src.rawPath}', into itself, '${target.rawPath}'`)
    }
    if (flags.recursive && srcIsDir) {
      const srcBase = rstripSlash(src.mountPath)
      const dstBase = rstripSlash(target.mountPath)
      if (isPrimitiveCopy(strategy)) {
        const walked = await cpWalk(strategy.readdir, stat, src, index, 'cp', errors, copies?.links)
        const entries = intoItself
          ? walked.filter((entry) => !within(entry.path, target.virtual))
          : walked
        await copyEntries('cp', strategy, stat, src, target, entries, errors, index, {
          policy,
          writes,
          reads,
          lines: flags.verbose ? lines : undefined,
          copies,
        })
        if (copies !== undefined) {
          await copyTreeLinks(
            copies,
            flags.dereference,
            src,
            target,
            errors,
            flags.verbose ? lines : undefined,
            policy,
            writes,
            reads,
          )
        }
        continue
      }
      if (strategy.dirCopy !== undefined && !perEntryNative && !intoItself) {
        if (flags.verbose) {
          lines.push(...(await treeLines(strategy, stat, src, target, srcBase, dstBase, index)))
        }
        await strategy.dirCopy(src, target)
        for (const entryMount of await strategy.find(src, { type: 'f' })) {
          const entryDst = mountedPath(target, dstBase + entryMount.slice(srcBase.length))
          writes[entryDst.mountPath] = new Uint8Array()
        }
        if (copies !== undefined) {
          await copyTreeLinks(
            copies,
            flags.dereference,
            src,
            target,
            errors,
            flags.verbose ? lines : undefined,
            policy,
            writes,
            reads,
          )
        }
        continue
      }
      // Per-entry policy forfeits dirCopy, so the tree's directories are
      // recreated here: a files-only pass would drop every directory that
      // holds no files (GNU keeps them).
      const mirrored = await mirrorDirs(
        strategy,
        stat,
        src,
        target,
        srcBase,
        dstBase,
        writes,
        errors,
        intoItself,
        index,
        flags.verbose ? lines : undefined,
      )
      if (!mirrored) continue
      for (const entryMount of await strategy.find(src, { type: 'f' })) {
        if (intoItself && within(entryMount, dstBase)) continue
        const entry = spelledFrom(mountedPath(src, entryMount), src)
        const entryDst = spelledFrom(
          mountedPath(target, dstBase + entryMount.slice(srcBase.length)),
          target,
        )
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
          copies,
        )
        if (!made.ok) continue
        await strategy.copy(entry, entryDst)
        writes[entryDst.mountPath] = new Uint8Array()
        if (flags.verbose) lines.push(transferLine(entry, entryDst, made.backup))
      }
      if (copies !== undefined) {
        await copyTreeLinks(
          copies,
          flags.dereference,
          src,
          target,
          errors,
          flags.verbose ? lines : undefined,
          policy,
          writes,
          reads,
        )
      }
      continue
    }
    if (guardsCreated && created.has(keyOf(target))) {
      // -i asks first: GNU only meets the just-created rule once the answer
      // says to replace.
      if (policy.ask && !(await policy.ask(target))) continue
      errors.push(`cp: will not overwrite just-created '${target.rawPath}' with '${src.rawPath}'`)
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
      copies,
    )
    if (!made.ok) continue
    if (isPrimitiveCopy(strategy)) {
      let data: Uint8Array
      try {
        // write takes bytes, not a stream: the file is materialized here.
        data = await strategy.readBytes(src)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(`cp: cannot open '${src.rawPath}' for reading: ${String(fsStrerror(err))}`)
        continue
      }
      try {
        await strategy.write(target, data)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(
          `cp: cannot create regular file '${target.rawPath}': ${String(fsStrerror(err))}`,
        )
        continue
      }
      reads[src.mountPath] = data
    } else {
      try {
        await strategy.copy(src, target)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(
          `cp: cannot create regular file '${target.rawPath}': ${String(fsStrerror(err))}`,
        )
        continue
      }
    }
    writes[target.mountPath] = new Uint8Array()
    created.add(keyOf(target))
    if (flags.verbose) lines.push(transferLine(src, target, made.backup))
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  return [
    output,
    new IOResult({
      writes,
      reads: { ...reads },
      cache: Object.keys(reads),
      stderr: stderrOf(errors),
      exitCode: errors.length > warned + accepted.length ? 1 : 0,
    }),
  ]
}
