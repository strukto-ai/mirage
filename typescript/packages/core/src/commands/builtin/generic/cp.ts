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

import { closeQuietly, primeStream } from '../../../io/stream.ts'

import { respelled } from '../../../utils/key_prefix.ts'
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
} from '../../../types.ts'
import { UsageError } from '../../errors.ts'
import { beforeFullWalk } from '../utils/tree.ts'
import { wordRefusalError, extraOperandError, usageHint } from '../../spec/usage.ts'
import { matchWord } from '../../spec/word_choice.ts'
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
  typedName,
  type BackendKeyFn,
} from '../utils/copy.ts'
import { posixPhrase } from '../../../errors/posix.ts'
import {
  enoent,
  fsStrerror,
  isDotWalkError,
  isEacces,
  isEnotdir,
  isFsError,
  isMissingPath,
} from '../../../errors/fs.ts'
import { nameLocation, typedLink } from '../utils/links.ts'
import { followedStat } from '../../../view/namespace_view.ts'
import {
  absentDestError,
  descendantPath,
  entryKind,
  nearestAncestor,
  spelledFrom,
} from '../utils/paths.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import type { LinkView } from '../../../view/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { CycleError, parent, resolvePath } from '../../../utils/path.ts'
import { shellQuoteAlways } from '../../../utils/quote.ts'
import type { FsCondition, WalkDeclinedError } from '../../../errors/types.ts'
import { classify } from '../../../errors/classify.ts'

const ENC = new TextEncoder()

const UPDATE_MODES = ['all', 'none', 'none-fail', 'older'] as const
const SPECIAL_FILE_NOUNS: ReadonlyMap<FileType, string> = new Map([
  [FileType.FIFO, 'fifo'],
  [FileType.CHAR_DEVICE, 'special file'],
  [FileType.BLOCK_DEVICE, 'special file'],
  [FileType.SOCKET, 'special file'],
])

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
 * copy has to recreate each by name. `relay` and `relayStat` are the dispatcher's
 * own transfer primitives, which copy what a followed link leads to on
 * whatever mount it lives. Mirrors Python's TransferLinks.
 */
export interface TransferLinks {
  links: LinkView
  dispatch: DispatchFn
  cwd: string
  relay: PrimitiveCopy
  relayStat: StatFn
  /** Whether the mount the copy runs on serves a path; absent where every path
   * is its own. */
  owns?: (virtual: string) => boolean
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
  return 'read' in strategy
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
  const match = matchWord(shown, UPDATE_MODES)
  if (match.matched) return match.word
  throw wordRefusalError(cmdName, '--update', shown, UPDATE_MODES, 1, match.kind)
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
      `cp: --backup is mutually exclusive with -n or --update=none-fail\n${usageHint('cp')}`,
      1,
    )
  }
  const [targetDir, noTargetDir] = targetFlags('cp', fl)
  const recursive = fl.asBool('r') || fl.asBool('recursive') || fl.asBool('archive')
  const last = fl.typedOrder(...Object.keys(DEREF_OPTIONS)).at(-1)
  // With no link option a recursive copy copies links as links and any other
  // copy follows them (GNU cp 9.7 with none of -H, -L, -P, -d).
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

// What stands at a path, asked through the dispatcher; null where nothing does,
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

/**
 * stat(2) of a destination, over a table whose stat is lstat(2). cp opens its
 * destination the way open(2) does, through a link at the name: a link to a
 * directory is that directory, one to a file is the file it writes through, and
 * one that leads nowhere is no destination at all (cp then refuses to write
 * through it). Mirrors Python's dest_stat.
 */
export function destStat(stat: StatFn, copies: TransferLinks | undefined): StatFn {
  return async (path: PathSpec) => {
    const row = await followedStat(stat, copies?.links, path)
    if (row.type === FileType.SYMLINK) throw enoent(path)
    return row
  }
}

/**
 * The destination as the link standing at its name, null where none does. The
 * router follows a destination to what its link leads to, which is what a plain
 * copy writes, through the link. GNU's backup renames the destination itself, a
 * link included, and the copy then lands at the name, so a backup is made of
 * this and the copy goes here: through the mount's own copy, which keeps the
 * source's mode, or through the dispatcher where the name sits on another mount
 * (`owns`). Mirrors Python's link_name.
 */
export function linkName(copies: TransferLinks, target: PathSpec): PathSpec | null {
  const where = nameLocation(copies.links, target, copies.cwd)
  if (where === null || copies.links.statAt(where) === null) return null
  if (where === target.virtual) return target
  return new PathSpec({
    virtual: where,
    directory: where.slice(0, where.lastIndexOf('/') + 1) || '/',
    vfsPath: stripSlash(where),
    rawPath: target.rawPath,
  })
}

/** Copy a symlink through the shared overwrite and backup policy. */
export async function makeLink(
  copies: TransferLinks,
  src: PathSpec,
  target: PathSpec,
  text: string,
  policy: TransferPolicy,
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
    errors,
    copies,
  )
  if (!made.ok) return false
  lines?.push(transferLine(src, target, made.backup, policy.cmdName))
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
  seen: readonly string[] = [],
  blocked: readonly string[] = [],
): Promise<void> {
  const base = rstripSlash(src.virtual) || '/'
  const dstBase = rstripSlash(target.virtual)
  const shownSrc = rstripSlash(src.rawPath) || src.rawPath
  const shownDst = rstripSlash(target.rawPath) || target.rawPath
  const below = [...copies.links.subtree(base)].sort((a, b) => compareCodePoints(a[0], b[0]))
  for (const [virtual, row] of below) {
    // A source directory whose tree the copy left out keeps its links out too.
    if (blocked.some((root) => within(virtual, root))) continue
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
      errors.push(`cp: cannot stat '${shown}': ${posixPhrase('ENOENT')}`)
      continue
    }
    const placed = respelled(PathSpec.fromStrPath(landing), `${shownDst}/${rel}`)
    if (leads.type !== FileType.DIRECTORY) {
      const entry = respelled(PathSpec.fromStrPath(resolved), shown)
      await copyEntries(
        'cp',
        copies.relay,
        copies.relayStat,
        entry,
        placed,
        [{ path: entry.virtual, kind: leads.type }],
        errors,
        { policy, lines, copies },
      )
      continue
    }
    const inside = rstripSlash(resolved) || '/'
    if ([...seen, base].some((d) => d === inside || d.startsWith(`${rstripSlash(inside)}/`))) {
      errors.push(`cp: cannot copy cyclic symbolic link '${shown}'`)
      continue
    }
    const followed = respelled(PathSpec.fromStrPath(inside), shown)
    const entries = await walk(
      copies.relay.readdir,
      copies.relayStat,
      followed,
      'cp',
      errors,
      copies.links,
    )
    const roots: string[] = []
    await copyEntries('cp', copies.relay, copies.relayStat, followed, placed, entries, errors, {
      policy,
      ...(lines !== undefined ? { lines } : {}),
      copies,
      blocked: roots,
    })
    await copyTreeLinks(
      copies,
      deref,
      followed,
      placed,
      errors,
      lines,
      policy,
      [...seen, base],
      roots,
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
  const hint = usageHint(cmdName)
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
): Promise<{ kind: FileType | null; condition: FsCondition | null }> {
  let info: FileStat | null = null
  try {
    info = await stat(path)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOTDIR') return { kind: null, condition: 'ENOTDIR' }
    if (code === 'ELOOP') return { kind: null, condition: 'ELOOP' }
    if (!isMissingPath(err)) throw err
  }
  if (info !== null) return { kind: info.type, condition: null }
  const [, isDir] = await nearestAncestor(stat, path)
  return { kind: null, condition: isDir ? 'ENOENT' : 'ENOTDIR' }
}

// GNU's line for a special file that a recursive copy cannot make, null for a
// kind copied as bytes. Under -R GNU recreates a FIFO or a device instead of
// reading it. No mount can store one, so the create fails as mknod would,
// with ENOTSUP, and the source is never read: a live pipe keeps its bytes.
// Mirrors Python's `_special_file_error`.
function specialFileError(cmdName: string, kind: FileType | null, dst: PathSpec): string | null {
  const noun = kind === null ? undefined : SPECIAL_FILE_NOUNS.get(kind)
  if (noun === undefined) return null
  return `${cmdName}: cannot create ${noun} '${dst.rawPath}': ${posixPhrase('ENOTSUP')}`
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
  if (!targetExists || srcIsDir === targetIsDir) return null
  return typeMismatchError(cmdName, src, target, srcIsDir)
}

// GNU's line for a directory and a non-directory meeting at one name.
export function typeMismatchError(
  cmdName: string,
  src: PathSpec,
  target: PathSpec,
  srcIsDir: boolean,
): string {
  if (srcIsDir) {
    return `${cmdName}: cannot overwrite non-directory '${target.rawPath}' with directory '${src.rawPath}'`
  }
  return `${cmdName}: cannot overwrite directory '${target.rawPath}' with non-directory '${src.rawPath}'`
}

// GNU's line for a source that is its own destination.
export function sameFileError(cmdName: string, src: PathSpec, target: PathSpec): string {
  return `${cmdName}: '${src.rawPath}' and '${target.rawPath}' are the same file`
}

// GNU's line for a destination this line already wrote.
export function justCreatedError(cmdName: string, src: PathSpec, target: PathSpec): string {
  return `${cmdName}: will not overwrite just-created '${target.rawPath}' with '${src.rawPath}'`
}

// Whether a directory stands where a file is about to be copied. A probe the
// backend refuses answers false, so the create that follows reports the
// refusal in its own words, as it did before the probe. Mirrors Python's
// _holds_directory.
async function holdsDirectory(stat: StatFn, path: PathSpec): Promise<boolean> {
  try {
    return await isDirectory(stat, path)
  } catch (err) {
    if (!isFsError(err)) throw err
    console.debug(`cp: destination probe of ${path.virtual} failed: ${String(err)}`)
    return false
  }
}

// GNU's line for a file a directory stands in the way of, met once the
// overwrite gates let the file through (-n and -u skip it, -i asks first).
// Under a backup cp tries the create, which the directory refuses; otherwise
// it refuses the overwrite itself (coreutils 9.7). Mirrors Python's
// _onto_directory.
function ontoDirectory(
  cmdName: string,
  src: PathSpec,
  target: PathSpec,
  backup: string | null,
): string {
  if (backupDisplaces(backup)) {
    return `${cmdName}: cannot create regular file '${target.rawPath}': ${posixPhrase('EISDIR')}`
  }
  return typeMismatchError(cmdName, src, target, false)
}

// Free a non-directory's name for a directory copied onto it. GNU refuses the
// overwrite unless a backup moves the entry aside, and then renames it to its
// backup name. A source typed as `.` or `..` is never backed up, so the entry
// is removed instead, which -v reports. No gate or -i question applies to a
// directory source (coreutils 9.7). Outside a workspace nothing can rename
// the entry, so the overwrite is refused as it is without a backup. A link at
// the name is the entry moved or removed, not what it leads to, and the tree
// then lands at its name (linkName). Returns the name freed for the
// directory, null when it stays taken. Mirrors Python's _clear_for_directory.
async function clearForDirectory(
  policy: TransferPolicy,
  copies: TransferLinks | undefined,
  stat: StatFn,
  src: PathSpec,
  dest: PathSpec,
  errors: string[],
  lines: string[] | undefined,
): Promise<PathSpec | null> {
  if (copies === undefined || !backupDisplaces(policy.backup)) {
    errors.push(typeMismatchError(policy.cmdName, src, dest, true))
    return null
  }
  const target = linkName(copies, dest) ?? dest
  const typed = typedName(src)
  if (typed === '.' || typed === '..') {
    try {
      await copies.dispatch('unlink', target)
    } catch (err) {
      if (!isFsError(err)) throw err
      errors.push(
        `${policy.cmdName}: cannot remove '${target.rawPath}': ${String(fsStrerror(err))}`,
      )
      return null
    }
    lines?.push(`removed '${target.rawPath}'`)
    return target
  }
  const made = await makeBackup(
    policy,
    { rename: (a: PathSpec, b: PathSpec) => renameLink(copies, a, b) },
    stat,
    undefined,
    target,
    errors,
    copies,
  )
  return made.ok ? target : null
}

// Decide whether an existing target may be replaced. -n and --update=none
// skip silently; --update=none-fail records GNU's `not replacing` error;
// --update=older replaces only when the source is strictly newer. A source
// or target with no usable mtime always replaces (freshness cannot be
// proven). A copy that writes through a link at the target's name compares
// the source with what the link leads to; one whose backup moves the link
// aside compares with the link itself (GNU cp 9.7). `copies` is given for a
// copy that writes through such a link, and left out for one that renames
// onto it or copies a link as a link.
export async function overwriteGate(
  policy: TransferPolicy,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  errors: string[],
  copies?: TransferLinks,
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
    if (copies !== undefined && policy.backup === null) {
      try {
        targetInfo = await destStat(stat, copies)(target)
      } catch (err) {
        if (isMissingPath(err) || isEnotdir(err)) return true
        if (!isFsError(err)) throw err
        // GNU names a link whose target its stat may not reach and goes on
        // with the next entry (coreutils 9.7).
        errors.push(
          `${policy.cmdName}: cannot stat '${target.rawPath}': ${fsStrerror(err) ?? String(err)}`,
        )
        return false
      }
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
): Promise<boolean> {
  if ('rename' in strategy) {
    await strategy.rename(target, backup)
    return true
  }
  const targetIsDir = await isDirectory(stat, target)
  if ('read' in strategy) {
    if (!targetIsDir) {
      const data = await primeStream(strategy.read(target))
      try {
        await strategy.write(backup, data)
      } finally {
        await closeQuietly(data)
      }
      return true
    }
    const entries = await walk(strategy.readdir, stat, target)
    const copiedAll = await copyEntries(cmdName, strategy, stat, target, backup, entries, errors)
    return copiedAll
  }
  if (!targetIsDir) {
    await strategy.copy(target, backup)
    return true
  }
  if (strategy.dirCopy === undefined) {
    errors.push(`${cmdName}: cannot backup '${target.rawPath}': ${posixPhrase('ENOTSUP')}`)
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
  errors: string[],
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
    made = await duplicateForBackup(strategy, stat, target, backup, errors, policy.cmdName)
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
  return { backup, ok: true }
}

// The verbose line for one copied entry, with GNU's backup note. GNU prints
// it before the create, so a create that fails still shows it; mv words a
// copy across mounts `copied`. Mirrors Python's transfer_line.
function transferLine(
  src: PathSpec,
  target: PathSpec,
  backup: PathSpec | null,
  cmdName = 'cp',
): string {
  let line = `'${src.rawPath}' -> '${target.rawPath}'`
  if (backup !== null) line += ` (backup: '${backup.rawPath}')`
  return cmdName === 'mv' ? `copied ${line}` : line
}

/**
 * GNU's verdict on a source this cp already began to copy, as the stderr line
 * and whether it is only a warning, or null to copy it. Copied again to the
 * same place, it is a warning and is skipped. A directory meeting a second
 * place would be a hard link to a directory, which cp refuses unless -L or -H
 * followed it there; a file is copied again (coreutils 9.7). A file under a
 * backup that moves the first copy aside goes on to the just-created rule.
 * Mirrors Python's _repeated_source.
 */
function repeatedSource(
  earlier: PathSpec | undefined,
  src: PathSpec,
  target: PathSpec,
  srcIsDir: boolean,
  flags: CpFlags,
  keyOf: BackendKeyFn,
): [string, boolean] | null {
  if (earlier === undefined) return null
  if (keyOf(earlier) === keyOf(target)) {
    if (!srcIsDir && backupDisplaces(flags.backup)) return null
    const noun = srcIsDir ? 'directory' : 'file'
    return [`cp: warning: source ${noun} '${src.rawPath}' specified more than once`, true]
  }
  if (srcIsDir && flags.dereference === 'never') {
    return [
      `cp: will not create hard link '${target.rawPath}' to directory '${earlier.rawPath}'`,
      false,
    ]
  }
  return null
}

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
): Promise<string[]> {
  const dirs = new Set([srcBase, ...(await strategy.find(src, { type: 'd' }))])
  const files = await strategy.find(src, { type: 'f' })
  const unique = [...new Set([...dirs, ...files])].sort(compareCodePoints)
  const lines: string[] = []
  for (const entryMount of unique) {
    const entry = spelledFrom(PathSpec.fromStrPath(entryMount), src)
    const entryDst = spelledFrom(
      PathSpec.fromStrPath(dstBase + entryMount.slice(srcBase.length)),
      target,
    )
    if (dirs.has(entryMount) && (await isDirectory(stat, entryDst))) continue
    lines.push(`'${entry.rawPath}' -> '${entryDst.rawPath}'`)
  }
  return lines
}

// Copy one entry natively, or by bytes where a link leads elsewhere. The
// dispatcher follows a link standing at the destination name, so a native
// copy whose link leads onto another mount answers EXDEV; that entry goes
// through the relay's read and write instead, which follow the link wherever
// it lands. Every other entry keeps the backend's copy (a Drive document
// stays a document). Mirrors Python's _copy_entry.
async function copyEntry(
  strategy: NativeCopy,
  copies: TransferLinks | undefined,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  try {
    await strategy.copy(src, dst)
  } catch (err) {
    if ((err as { code?: string }).code !== 'EXDEV' || copies === undefined) throw err
    const data = await primeStream(copies.relay.read(src))
    try {
      await copies.relay.write(dst, data)
    } finally {
      await closeQuietly(data)
    }
  }
}

// Whether `path` is `root` or below it. Mirrors Python's within.
export function within(path: string, root: string): boolean {
  const base = rstripSlash(root)
  return rstripSlash(path) === base || path.startsWith(`${base}/`)
}

// Recreate a source tree's directories under the destination root, for the
// per-entry path. A directory that cannot be made, or whose name a
// non-directory holds that no backup moves aside, is GNU's line and its tree
// is left out; its siblings still copy, as GNU's walk goes on (coreutils
// 9.7). Returns the source directories whose trees the file pass leaves out,
// and the destination directories this made, whose entries cannot be taken
// yet (null where the backend has no directories). Mirrors Python's
// _mirror_dirs.
async function mirrorDirs(
  strategy: NativeCopy,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  srcBase: string,
  dstBase: string,
  errors: string[],
  policy: TransferPolicy,
  copies: TransferLinks | undefined,
  intoItself: boolean,
  lines?: string[],
  // Collects the source directories the walk may not open, which are still
  // made at the destination; absent lets the refusal propagate.
  unreadable?: string[],
): Promise<{ blocked: string[]; made: Set<string> | null }> {
  if (strategy.mkdir === undefined) return { blocked: [], made: null }
  // A destination inside the source leaves its own subtree out, as the
  // file pass does.
  const listed = await strategy.find(src, {
    type: 'd',
    ...(unreadable === undefined ? {} : { unreadable }),
  })
  const mounts = [srcBase, ...listed].filter((found) => !(intoItself && within(found, dstBase)))
  // Shortest first so a parent is created before its children, then by name:
  // sorting on length alone leaves equal-length siblings in whatever order
  // the Set happened to hold, which is insertion order here and hash order in
  // Python. Same key on both sides, same output.
  const unique = [...new Set(mounts)].sort((a, b) => a.length - b.length || compareCodePoints(a, b))
  const blocked: string[] = []
  const made = new Set<string>()
  for (const entryMount of unique) {
    if (blocked.some((root) => within(entryMount, root))) continue
    const dstMount = dstBase + entryMount.slice(srcBase.length)
    const entryDst = spelledFrom(PathSpec.fromStrPath(dstMount), target)
    const entry = spelledFrom(PathSpec.fromStrPath(entryMount), src)
    try {
      // A directory meets a link at its name as the link itself, where a file
      // writes through it (GNU's lstat for a directory source, coreutils 9.7).
      const { exists, isDir } = await entryKind(stat, entryDst)
      if (isDir) continue
      if (
        !exists ||
        (await clearForDirectory(policy, copies, stat, entry, entryDst, errors, lines)) !== null
      ) {
        await strategy.mkdir(entryDst)
        made.add(dstMount)
        if (lines !== undefined) lines.push(`'${entry.rawPath}' -> '${entryDst.rawPath}'`)
        continue
      }
    } catch (err) {
      if (!isFsError(err)) throw err
      errors.push(`cp: cannot create directory '${entryDst.rawPath}': ${String(fsStrerror(err))}`)
    }
    blocked.push(entryMount)
  }
  return { blocked, made }
}

// List a tree as {path, kind} pairs, parents before children. The kind is
// captured while the tree is intact so a caller that deletes as it goes (mv)
// never re-stats a path whose virtual parent has since vanished, and a copy
// knows a FIFO from a file without opening it. Mirrors the Python cp `walk`;
// used only by the primitive (no native copy) path. A folder a backend lists
// with a trailing slash (box, dropbox, gdrive) is walked without it. A
// directory the session may not open, or an entry it may not stat (a rule
// refused it below the operand), is GNU's `cannot access` / `cannot stat`
// line when `errors` is given and the walk goes on without its contents;
// with no channel the refusal propagates rather than leave a silent gap.
export async function walk(
  readdir: ReaddirFn,
  stat: StatFn,
  root: PathSpec,
  cmdName = 'cp',
  errors?: string[],
  links?: LinkView,
): Promise<{ path: string; kind: FileType }[]> {
  const info = await stat(root)
  if (info.type !== FileType.DIRECTORY) return [{ path: root.virtual, kind: info.type }]
  const entries: { path: string; kind: FileType }[] = [
    { path: root.virtual, kind: FileType.DIRECTORY },
  ]
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
        childInfo = await stat(childSpec)
      } catch (err) {
        if (errors === undefined || !isEacces(err)) throw err
        errors.push(`${cmdName}: cannot stat '${childSpec.rawPath}': ${String(fsStrerror(err))}`)
        continue
      }
      entries.push({ path: child, kind: childInfo.type })
      if (childInfo.type === FileType.DIRECTORY) queue.push(childSpec)
    }
  }
  return entries
}

// Copy a walked source tree entry by entry with GNU per-entry errors: the
// shared primitive-transfer loop of cp and mv. A directory that cannot be
// made, or whose name a non-directory holds that no backup moves aside,
// leaves its own tree out; a failed read or write is reported; either way the
// remaining entries still copy, like GNU cp/mv on a cross-device transfer.
// Every error line carries fsStrerror, so a backend missing the needed op
// reports `Operation not supported` instead of aborting the command. A FIFO
// or device is GNU's failed recreate (specialFileError), never read. `policy`
// applies -n/--update/--backup per file entry, like GNU during a recursive
// merge (null overwrites unconditionally); `lines` is an optional per-entry
// sink, a file's line written before its create; `rootBackup` is the backup
// the caller made of the target, which the source's own line notes. Returns
// whether every entry landed.
export async function copyEntries(
  cmdName: string,
  strategy: PrimitiveCopy | PrimitiveMove,
  stat: StatFn,
  src: PathSpec,
  target: PathSpec,
  entries: { path: string; kind: FileType }[],
  errors: string[],
  opts: {
    policy?: TransferPolicy
    lines?: string[] | undefined
    copies?: TransferLinks | undefined
    rootBackup?: PathSpec | null
    blocked?: string[]
  } = {},
): Promise<boolean> {
  const srcBase = rstripSlash(src.virtual)
  const dstBase = rstripSlash(target.virtual)
  let copiedAll = true
  const blocked = opts.blocked ?? []
  const made = new Set<string>()
  const entryPolicy: TransferPolicy = opts.policy ?? {
    cmdName,
    noClobber: false,
    update: null,
    backup: null,
    suffix: DEFAULT_BACKUP_SUFFIX,
  }
  for (const { path: entry, kind } of entries) {
    if (blocked.some((root) => within(entry, root))) continue
    const entrySpec = descendantPath(src, entry)
    const entryDstSpec = descendantPath(target, dstBase + entry.slice(srcBase.length))
    if (kind === FileType.DIRECTORY) {
      try {
        const { exists, isDir } = await entryKind(stat, entryDstSpec)
        if (isDir) continue
        const free =
          !exists ||
          (await clearForDirectory(
            entryPolicy,
            opts.copies,
            stat,
            entrySpec,
            entryDstSpec,
            errors,
            opts.lines,
          )) !== null
        if (free) {
          await strategy.mkdir(entryDstSpec)
          made.add(entryDstSpec.virtual)
          opts.lines?.push(
            cmdName === 'mv'
              ? `created directory '${entryDstSpec.rawPath}'`
              : `'${entrySpec.rawPath}' -> '${entryDstSpec.rawPath}'`,
          )
          continue
        }
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(
          `${cmdName}: cannot create directory '${entryDstSpec.rawPath}': ${String(fsStrerror(err))}`,
        )
      }
      copiedAll = false
      blocked.push(entry)
      continue
    }
    const link = opts.copies?.links.statAt(entry)
    if (opts.copies !== undefined && link != null) {
      const errorCount = errors.length
      const raw = link.extra[LINK_TARGET_KEY]
      await makeLink(
        opts.copies,
        entrySpec,
        entryDstSpec,
        typeof raw === 'string' ? raw : '',
        entryPolicy,
        errors,
        opts.lines,
      )
      if (errors.length > errorCount) copiedAll = false
      continue
    }
    if (
      opts.policy !== undefined &&
      !(await overwriteGate(
        opts.policy,
        stat,
        entrySpec,
        entryDstSpec,
        errors,
        'unlink' in strategy ? undefined : opts.copies,
      ))
    )
      continue
    if (
      entry !== src.virtual &&
      !made.has(parent(entryDstSpec.virtual)) &&
      (await holdsDirectory(stat, entryDstSpec))
    ) {
      errors.push(ontoDirectory(cmdName, entrySpec, entryDstSpec, opts.policy?.backup ?? null))
      copiedAll = false
      continue
    }
    const refusal = specialFileError(cmdName, kind, entryDstSpec)
    if (refusal !== null) {
      opts.lines?.push(transferLine(entrySpec, entryDstSpec, null, cmdName))
      errors.push(refusal)
      copiedAll = false
      continue
    }
    let backup: PathSpec | null = entry === src.virtual ? (opts.rootBackup ?? null) : null
    if (opts.policy !== undefined) {
      const made = await makeBackup(
        opts.policy,
        strategy,
        stat,
        strategy.readdir,
        entryDstSpec,
        errors,
        opts.copies,
      )
      if (!made.ok) {
        copiedAll = false
        continue
      }
      backup = made.backup
    }
    opts.lines?.push(transferLine(entrySpec, entryDstSpec, backup, cmdName))
    if (!(await transferFile(strategy, entrySpec, entryDstSpec, cmdName, errors))) {
      copiedAll = false
    }
  }
  return copiedAll
}

/**
 * Copy one file between the strategy's mounts, reporting a failure in GNU's
 * words; false when it failed. A store-to-store copy goes first where the
 * strategy has one: the destination's store copies from the source's without
 * the bytes passing through mirage. EXDEV from it says the stores cannot, and
 * a declined walk says a hide or rule wants the copy made by parts; either way
 * the bytes move through a read and a write, the file materialized in
 * between. Mirrors Python's transfer_file.
 */
export async function transferFile(
  strategy: PrimitiveCopy | PrimitiveMove,
  src: PathSpec,
  dst: PathSpec,
  cmdName: string,
  errors: string[],
): Promise<boolean> {
  if (strategy.copy !== undefined) {
    try {
      await strategy.copy(src, dst)
      return true
    } catch (err) {
      if ((err as Partial<WalkDeclinedError>).declined !== true && classify(err) !== 'EXDEV') {
        if (!isFsError(err)) throw err
        errors.push(
          (err as { virtualPath?: unknown }).virtualPath === src.virtual
            ? `${cmdName}: cannot open '${src.rawPath}' for reading: ${String(fsStrerror(err))}`
            : `${cmdName}: cannot create regular file '${dst.rawPath}': ${String(fsStrerror(err))}`,
        )
        return false
      }
    }
  }
  let data: ByteSource
  const reading = { failed: false }
  try {
    data = await primeStream(strategy.read(src), () => {
      reading.failed = true
    })
  } catch (err) {
    if (!isFsError(err)) throw err
    errors.push(`${cmdName}: cannot open '${src.rawPath}' for reading: ${String(fsStrerror(err))}`)
    return false
  }
  try {
    await strategy.write(dst, data)
  } catch (err) {
    if (!isFsError(err)) throw err
    errors.push(
      reading.failed
        ? `${cmdName}: error reading '${src.rawPath}': ${String(fsStrerror(err))}`
        : `${cmdName}: cannot create regular file '${dst.rawPath}': ${String(fsStrerror(err))}`,
    )
    return false
  } finally {
    await closeQuietly(data)
  }
  return true
}

// Copy sources to a destination, fanning out into a directory. NativeCopy
// uses backend copy/find operations for an efficient same-store copy.
// PrimitiveCopy handles cross-mount copies by walking via readdir/stat and
// applying mkdir or write(read(...)) to each entry. --update/--backup
// force the per-entry native loop (a whole-tree dirCopy cannot honor
// per-file decisions).
export async function cpGeneric(
  paths: PathSpec[],
  stat: StatFn,
  strategy: CopyStrategy,
  flags: CpFlags,
  backendKey?: BackendKeyFn,
  readdir?: ReaddirFn,
  // The link standing at the name a destination was typed as, its own row,
  // null where none stands (the router has followed the operand by the time
  // cp runs); undefined outside a workspace. Mirrors Python's link_at.
  linkAt?: (path: PathSpec) => FileStat | null,
  // The namespace's links and the dispatcher that makes them, so a link is copied
  // as a link where the policy says to; undefined outside a workspace, where
  // no link can stand.
  copies?: TransferLinks,
  // Where -i reads its answers.
  stdin?: ByteSource | null,
  // The command's dispatcher, which lets a source's mount refuse a tree
  // copied file by file; undefined outside a workspace.
  dispatch?: DispatchFn,
): Promise<[ByteSource | null, IOResult]> {
  const keyOf = backendKey ?? backendKeyDefault
  const [sources, dst] = splitOperands('cp', paths, flags.targetDir, flags.noTargetDir)
  const toDest = destStat(stat, copies)
  let dstIsDir: boolean
  let dstExists: boolean
  let dstErr: FsCondition | null = null
  if (flags.targetDir !== null) {
    const err = await targetDirError('cp', toDest, dst)
    if (err !== null) {
      return [null, new IOResult({ stderr: ENC.encode(`${err}\n`), exitCode: 1 })]
    }
    dstIsDir = true
    dstExists = true
  } else if (flags.noTargetDir) {
    dstIsDir = false
    dstExists = true
  } else {
    const probe = await destKind(toDest, dst)
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
  const lines: string[] = []
  let warned = 0
  // Where each source's first copy went, by source and by link name.
  const firstCopy = new Map<string, PathSpec>()
  const firstLink = new Map<string, PathSpec>()
  const created = new Set<string>()
  const guardsCreated = !(
    flags.noClobber ||
    updateGates(flags.update) ||
    flags.backup === 'numbered'
  )
  for (const [src, dest] of copyTargets(sources, dst, dstIsDir, dstExists, dstErr, '.')) {
    let target = dest
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
        errors.push(sameFileError('cp', src, target))
        continue
      }
      const repeat = repeatedSource(firstLink.get(named), src, target, false, flags, keyOf)
      if (repeat !== null) {
        errors.push(repeat[0])
        if (repeat[1]) warned += 1
        continue
      }
      if (!firstLink.has(named)) firstLink.set(named, target)
      if (guardsCreated && created.has(keyOf(target))) {
        if (policy.ask && !(await policy.ask(target))) continue
        errors.push(justCreatedError('cp', src, target))
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
        errors,
        flags.verbose ? lines : undefined,
      )
      if (made) created.add(keyOf(target))
      continue
    }
    const { kind: srcKind, condition: srcErr } = await sourceKind(stat, src)
    if (srcErr !== null) {
      errors.push(`cp: cannot stat '${src.rawPath}': ${posixPhrase(srcErr)}`)
      continue
    }
    const srcIsDir = srcKind === FileType.DIRECTORY
    if (flags.noTargetDir && !srcIsDir && target.walkError !== null && target.rawPath === '') {
      // Under -T, GNU stats an empty destination as the directory it is
      // typed in, which a file cannot overwrite (coreutils 9.7). A
      // directory source it merges into the working directory; mirage
      // refuses that at the create, since reading the empty name as the
      // working directory is what `walkError` is for.
      errors.push(typeMismatchError('cp', src, target, false))
      continue
    }
    if (keyOf(src) === keyOf(target)) {
      errors.push(sameFileError('cp', src, target))
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
        : await destKind(toDest, target)
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
      // GNU announces a file before the create this refuses; a directory's
      // line waits for its mkdir.
      if (flags.verbose && !srcIsDir) lines.push(transferLine(src, target, null))
      errors.push(`cp: cannot create ${noun} '${target.rawPath}': ${posixPhrase(targetErr)}`)
      continue
    }
    // A directory onto a non-directory is refused before any gate, unless a
    // backup moves the entry aside (below); a file a directory stands in the
    // way of waits for the gates (further below).
    const mismatch =
      srcIsDir && (copies === undefined || !backupDisplaces(flags.backup))
        ? overwriteTypeError('cp', src, srcIsDir, target, targetExists, targetIsDir)
        : null
    if (mismatch !== null) {
      errors.push(mismatch)
      continue
    }
    if (!targetExists && linkAt !== undefined && linkAt(target) !== null) {
      // A dangling link: the stat followed it to nothing, but the name is
      // taken. GNU will not create the file it points at (POSIX would), and
      // the link is a non-directory to a tree.
      if (srcIsDir) {
        errors.push(typeMismatchError('cp', src, target, true))
        continue
      }
      if (flags.verbose) lines.push(transferLine(src, target, null))
      errors.push(`cp: not writing through dangling symlink '${target.rawPath}'`)
      continue
    }
    const repeat = repeatedSource(firstCopy.get(keyOf(src)), src, target, srcIsDir, flags, keyOf)
    if (repeat !== null) {
      errors.push(repeat[0])
      if (repeat[1]) warned += 1
      continue
    }
    if (!firstCopy.has(keyOf(src))) firstCopy.set(keyOf(src), target)
    if (intoItself) {
      errors.push(`cp: cannot copy a directory, '${src.rawPath}', into itself, '${target.rawPath}'`)
    }
    if (flags.recursive && srcIsDir) {
      if (guardsCreated && created.has(keyOf(target))) {
        // As a file would be, but a directory is asked nothing.
        errors.push(justCreatedError('cp', src, target))
        continue
      }
      // A whole-tree copy reads nothing here; any other copy goes file by
      // file, so the source's mount is asked before the destination is
      // touched.
      const wholeTree =
        !isPrimitiveCopy(strategy) &&
        strategy.dirCopy !== undefined &&
        !perEntryNative &&
        !intoItself &&
        !targetExists
      if (!wholeTree) await beforeFullWalk(dispatch, src, 'cp')
      if (targetExists && !targetIsDir) {
        const freed = await clearForDirectory(
          policy,
          copies,
          stat,
          src,
          target,
          errors,
          flags.verbose ? lines : undefined,
        )
        if (freed === null) continue
        target = freed
      }
      const srcBase = rstripSlash(src.virtual)
      const dstBase = rstripSlash(target.virtual)
      if (isPrimitiveCopy(strategy)) {
        const walked = await walk(strategy.readdir, stat, src, 'cp', errors, copies?.links)
        const entries = intoItself
          ? walked.filter((entry) => !within(entry.path, target.virtual))
          : walked
        const leftOut: string[] = []
        await copyEntries('cp', strategy, stat, src, target, entries, errors, {
          policy,
          lines: flags.verbose ? lines : undefined,
          copies,
          blocked: leftOut,
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
            [],
            leftOut,
          )
        }
        continue
      }
      // A whole-tree copy cannot honor a merge's per-entry rules (a Drive copy
      // adds a second entry of the same name, a Box one refuses the tree), so
      // only a fresh destination takes it.
      if (wholeTree && strategy.dirCopy !== undefined) {
        const tree = flags.verbose
          ? await treeLines(strategy, stat, src, target, srcBase, dstBase)
          : []
        let copied = true
        try {
          await strategy.dirCopy(src, target)
        } catch (err) {
          if (classify(err) !== 'ENOTSUP') {
            const reason = fsStrerror(err)
            if (reason === null) throw err
            errors.push(
              (err as { virtualPath?: unknown }).virtualPath === src.virtual
                ? `cp: cannot open directory '${src.rawPath}': ${reason}`
                : `cp: cannot create directory '${target.rawPath}': ${reason}`,
            )
            continue
          }
          copied = false
        }
        if (copied) {
          lines.push(...tree)
          if (copies !== undefined) {
            await copyTreeLinks(
              copies,
              flags.dereference,
              src,
              target,
              errors,
              flags.verbose ? lines : undefined,
              policy,
            )
          }
          continue
        }
      }
      // Per-entry policy forfeits dirCopy, as does a tree copy the
      // dispatcher declines or the backend cannot make in one call, so the
      // tree's directories are recreated here: a files-only pass would drop
      // every directory that holds no files (GNU keeps them).
      if (wholeTree) await beforeFullWalk(dispatch, src, 'cp')
      // A directory the walk may not open is GNU's line; it is made at the
      // destination and the rest of the tree still copies.
      const unreadable: string[] = []
      const mirrored = await mirrorDirs(
        strategy,
        stat,
        src,
        target,
        srcBase,
        dstBase,
        errors,
        policy,
        copies,
        intoItself,
        flags.verbose ? lines : undefined,
        unreadable,
      )
      const files = await strategy.find(src, { type: 'f', unreadable })
      for (const root of new Set(unreadable)) {
        errors.push(
          `cp: cannot access '${spelledFrom(PathSpec.fromStrPath(root), src).rawPath}': ${posixPhrase('EACCES')}`,
        )
      }
      for (const entryMount of files) {
        if (intoItself && within(entryMount, dstBase)) continue
        if (mirrored.blocked.some((root) => within(entryMount, root))) continue
        const dstMount = dstBase + entryMount.slice(srcBase.length)
        const entry = spelledFrom(PathSpec.fromStrPath(entryMount), src)
        const entryDst = spelledFrom(PathSpec.fromStrPath(dstMount), target)
        if (!(await overwriteGate(policy, stat, entry, entryDst, errors, copies))) continue
        if (
          mirrored.made !== null &&
          !mirrored.made.has(parent(dstMount)) &&
          (await holdsDirectory(stat, entryDst))
        ) {
          errors.push(ontoDirectory('cp', entry, entryDst, flags.backup))
          continue
        }
        const made = await makeBackup(
          policy,
          strategy,
          stat,
          versionReaddir,
          entryDst,
          errors,
          copies,
        )
        if (!made.ok) continue
        if (flags.verbose) lines.push(transferLine(entry, entryDst, made.backup))
        try {
          await copyEntry(strategy, copies, entry, entryDst)
        } catch (err) {
          if (!isFsError(err)) throw err
          errors.push(
            `cp: cannot create regular file '${entryDst.rawPath}': ${String(fsStrerror(err))}`,
          )
          continue
        }
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
          [],
          mirrored.blocked.map((root) => PathSpec.fromStrPath(root).virtual),
        )
      }
      continue
    }
    if (guardsCreated && created.has(keyOf(target))) {
      // -i asks first: GNU only meets the just-created rule once the answer
      // says to replace.
      if (policy.ask && !(await policy.ask(target))) continue
      errors.push(justCreatedError('cp', src, target))
      continue
    }
    if (!(await overwriteGate(policy, stat, src, target, errors, copies))) continue
    if (targetIsDir) {
      errors.push(ontoDirectory('cp', src, target, flags.backup))
      continue
    }
    const refusal = flags.recursive ? specialFileError('cp', srcKind, target) : null
    if (refusal !== null) {
      if (flags.verbose) lines.push(transferLine(src, target, null))
      errors.push(refusal)
      continue
    }
    let copier: CopyStrategy = strategy
    let mover: CopyStrategy | NativeMove = strategy
    if (copies !== undefined && policy.backup !== null) {
      const linked = linkName(copies, target)
      if (linked !== null) {
        target = linked
        mover = { rename: (a: PathSpec, b: PathSpec) => renameLink(copies, a, b) }
        if (copies.owns !== undefined && !copies.owns(target.virtual)) copier = copies.relay
      }
    }
    const made = await makeBackup(policy, mover, stat, versionReaddir, target, errors, copies)
    if (!made.ok) continue
    if (flags.verbose) lines.push(transferLine(src, target, made.backup))
    if (isPrimitiveCopy(copier)) {
      if (!(await transferFile(copier, src, target, 'cp', errors))) continue
    } else {
      try {
        await copier.copy(src, target)
      } catch (err) {
        if (!isFsError(err)) throw err
        errors.push(
          `cp: cannot create regular file '${target.rawPath}': ${String(fsStrerror(err))}`,
        )
        continue
      }
    }
    created.add(keyOf(target))
  }
  const output: ByteSource | null = lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : null
  return [
    output,
    new IOResult({
      stderr: stderrOf(errors),
      exitCode: errors.length > warned + accepted.length ? 1 : 0,
    }),
  ]
}
