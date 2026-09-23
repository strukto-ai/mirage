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

import { backupControl, backupTarget } from '../../../../commands/builtin/utils/backup.ts'
import { DEFAULT_BACKUP_SUFFIX } from '../../../../commands/builtin/utils/constants.ts'
import { UsageError } from '../../../../commands/errors.ts'
import { specOf } from '../../../../commands/spec/builtins.ts'
import { parseCommand, parseToKwargs } from '../../../../commands/spec/parser.ts'
import { FlagView } from '../../../../commands/spec/flag_view.ts'
import { type ParsedArgs } from '../../../../commands/spec/parser.ts'
import {
  ambiguousOptionError,
  missingValueError,
  unexpectedValueError,
  unknownOptionError,
  usageHint,
} from '../../../../commands/spec/usage.ts'
import { type ByteSource, materialize } from '../../../../io/types.ts'
import { type FileStat, FileType, PathSpec, wordText } from '../../../../types.ts'
import {
  fsStrerror,
  isEacces,
  isEexist,
  isEisdir,
  isEnoent,
  isErofs,
} from '../../../../utils/errors.ts'
import { CycleError, gnuBasename, gnuDirname } from '../../../../utils/path.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import { PolicyDenied } from '../../../../policy/index.ts'
import { pathAllowed } from '../../../../context/session_context.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import type { Namespace } from '../../../mount/namespace/namespace.ts'
import type { SessionState } from '../../../session/session.ts'
import { absPath, fail, readOnlyError, result } from '../shared.ts'
import { posixRelative } from './links.ts'
import { linkTargetStat, pathReaddir, resolvePathStat } from './probe.ts'
import type { Result } from '../types.ts'

const TARGET_DIR_LONG = '--target-directory'
const SUFFIX_LONG = '--suffix'
const VALUED_SHORTS = 'tS'
const ENC = new TextEncoder()

/** The ln flag bag, parsed once. */
export interface LnFlags {
  readonly symbolic: boolean
  readonly force: boolean
  readonly noDereference: boolean
  readonly verbose: boolean
  readonly relative: boolean
  readonly logical: boolean
  readonly directory: boolean
  readonly noTarget: boolean
  readonly backup: string | null
  readonly suffix: string
}

/** One link to make: its source operand and where it lands. */
interface LinkPlan {
  readonly source: string | PathSpec
  readonly linkAbs: string
  /** The link name as GNU would spell it in a message (`d/f.txt`). */
  readonly linkTyped: string
}

// Parse the ln flag bag once into a frozen struct. -L and -P are one
// switch and the later occurrence wins, as in GNU (-LP links the symlink
// itself, -PL its target); a hard link of a symlink is the -P default.
// Throws UsageError for a --backup control GNU does not know.
export function parseFlags(fl: FlagView): LnFlags {
  const raw: unknown = fl.raw('backup')
  const backupRaw = typeof raw === 'string' || typeof raw === 'boolean' ? raw : undefined
  const suffixRaw = fl.asStr('suffix')
  const suffix = suffixRaw === undefined || suffixRaw === '' ? null : suffixRaw
  const deref = fl.typedOrder('logical', 'physical')
  return Object.freeze({
    symbolic: fl.asBool('symbolic'),
    force: fl.asBool('force'),
    noDereference: fl.asBool('no_dereference'),
    verbose: fl.asBool('verbose'),
    relative: fl.asBool('relative'),
    logical: deref.length > 0 && deref[deref.length - 1] === 'logical',
    directory: fl.asBool('directory') || fl.asBool('F'),
    noTarget: fl.asBool('no_target_directory'),
    backup: backupControl('ln', backupRaw, suffix),
    suffix: suffix ?? DEFAULT_BACKUP_SUFFIX,
  })
}

/** The GNU option error the parser reported, if any. */
export function optionRefusal(parsed: ParsedArgs): [string, number] | null {
  const dec = new TextDecoder()
  const ambiguousFirst = parsed.ambiguousOptions[0]
  if (parsed.optionErrorKinds[0] === 'ambiguous' && ambiguousFirst !== undefined) {
    const [msg, code] = ambiguousOptionError('ln', ...ambiguousFirst)
    return [dec.decode(msg), code]
  }
  const invalid = parsed.invalidOptions[0]
  if (invalid !== undefined) {
    const [msg, code] =
      parsed.optionErrorKinds[0] === 'unexpected_value'
        ? unexpectedValueError('ln', invalid)
        : unknownOptionError('ln', invalid)
    return [dec.decode(msg), code]
  }
  if (ambiguousFirst !== undefined) {
    const [msg, code] = ambiguousOptionError('ln', ...ambiguousFirst)
    return [dec.decode(msg), code]
  }
  const needsValue = parsed.needsValueOptions[0]
  if (needsValue !== undefined) {
    const [msg, code] = missingValueError('ln', needsValue)
    return [dec.decode(msg), code]
  }
  return null
}

// The operands as classified, and -t's value as typed. The spec parse
// resolves every path against the cwd, which is what a link is made at,
// but a message spells what the user typed ('e/f.txt'), and only the
// classified words still carry that. The parse already validated the
// options, so this walk only has to know which of ln's spellings consume
// a word.
export function operandWords(
  args: readonly (string | PathSpec)[],
): [(string | PathSpec)[], string | null] {
  const operands: (string | PathSpec)[] = []
  let targetTyped: string | null = null
  let parsing = true
  let i = 0
  while (i < args.length) {
    const arg = args[i] ?? ''
    const tok = wordText(arg)
    if (parsing && tok === '--') {
      parsing = false
    } else if (parsing && tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=')
      const name = eq === -1 ? tok : tok.slice(0, eq)
      if (TARGET_DIR_LONG.startsWith(name)) {
        if (eq !== -1) {
          targetTyped = tok.slice(eq + 1)
        } else if (i + 1 < args.length) {
          i += 1
          targetTyped = wordText(args[i] ?? '')
        }
      } else if (SUFFIX_LONG.startsWith(name) && eq === -1 && i + 1 < args.length) {
        i += 1
      }
    } else if (parsing && tok.startsWith('-') && tok.length > 1) {
      for (let j = 1; j < tok.length; j += 1) {
        const letter = tok[j] ?? ''
        if (!VALUED_SHORTS.includes(letter)) continue
        let value = tok.slice(j + 1)
        if (value === '' && i + 1 < args.length) {
          i += 1
          value = wordText(args[i] ?? '')
        }
        if (letter === 't') targetTyped = value
        break
      }
    } else {
      operands.push(arg)
    }
    i += 1
  }
  return [operands, targetTyped]
}

async function pathStat(dispatch: DispatchFn, virtual: string): Promise<FileStat | null> {
  return await resolvePathStat(dispatch, PathSpec.fromStrPath(virtual))
}

// What a destination operand names once links are resolved. GNU
// dereferences a destination that is a link to a directory and links
// inside that directory; -n keeps the link itself as the name. A real
// directory is the directory either way.
// Whether a path's own name is in its parent's listing: the door's proof
// of a directory, repeated here because a stat row settles nothing. An
// API tree synthesizes its directories (a postgres schema lists tables/
// and views/ for a schema nobody created, a grouping mount stats every
// path under a live collection as one), and linking *into* an invented
// directory would bury the name the user typed. Compared on the final
// segment, because backends disagree on entry shape.
async function listedByParent(dispatch: DispatchFn, virtual: string): Promise<boolean> {
  const stripped = rstripSlash(virtual)
  const cut = stripped.lastIndexOf('/')
  const name = stripped.slice(cut + 1)
  if (name === '') return false
  const listing = await pathReaddir(dispatch, stripped.slice(0, cut) || '/')
  return listing.some((entry) => {
    const s = rstripSlash(entry)
    return s.slice(s.lastIndexOf('/') + 1) === name
  })
}

// Whether the session may know that a path is a link. A hidden path is
// nonexistent for the session, so a link there is not one ln may follow,
// copy or resolve. The door checks the typed path before it follows a
// link, and every namespace read in this module has to answer the same
// way, or a link inside hidden space leads ln out of it: into the
// directory it points at, or to the target string a hard link would copy.
function visibleLink(namespace: Namespace, virtual: string): boolean {
  return pathAllowed(virtual) && namespace.isLink(virtual)
}

// Resolve the links along a path the session may see; a hidden path
// stays as typed. Throws CycleError as `follow` does.
function followVisible(namespace: Namespace, virtual: string): string {
  return pathAllowed(virtual) ? namespace.follow(virtual) : virtual
}

async function dirAt(
  namespace: Namespace,
  dispatch: DispatchFn,
  virtual: string,
  noDereference: boolean,
): Promise<[string, FileStat | null]> {
  let resolved = virtual
  if (visibleLink(namespace, virtual)) {
    if (noDereference) return [virtual, null]
    try {
      resolved = namespace.follow(virtual)
    } catch (err) {
      if (err instanceof CycleError) return [virtual, null]
      throw err
    }
  }
  const stat = await pathStat(dispatch, resolved)
  if (
    stat !== null &&
    stat.type === FileType.DIRECTORY &&
    !namespace.isMountRoot(resolved) &&
    !(await listedByParent(dispatch, resolved))
  ) {
    return [resolved, null]
  }
  return [resolved, stat]
}

// The link a TARGET gets inside a directory: GNU names it after the
// target's basename, spelled under the directory as typed.
function into(source: string | PathSpec, dirAbs: string, dirTyped: string): LinkPlan {
  const base = gnuBasename(rstripSlash(wordText(source)))
  const joined = dirAbs === '/' ? `/${base}` : `${rstripSlash(dirAbs)}/${base}`
  return { source, linkAbs: joined, linkTyped: `${rstripSlash(dirTyped)}/${base}` }
}

// Turn ln's operands into the links to make, GNU's four forms: `ln -t DIR
// TARGET...` and `ln TARGET... DIR` link every target into the directory;
// `ln TARGET` links into the cwd; `ln TARGET LINK` names the link, unless
// LINK is a directory and -T did not forbid descending into it. Returns
// the plans, or an empty list with the refusal to print.
export async function planLinks(
  namespace: Namespace,
  dispatch: DispatchFn,
  cwd: string,
  operands: readonly (string | PathSpec)[],
  targetDir: string | null,
  targetTyped: string | null,
  flags: LnFlags,
): Promise<[LinkPlan[], string | null]> {
  const hint = `${usageHint('ln')}\n`
  if (targetDir !== null) {
    const typed = targetTyped ?? targetDir
    const [resolved, stat] = await dirAt(
      namespace,
      dispatch,
      absPath(targetDir, cwd),
      flags.noDereference,
    )
    if (stat === null) return [[], `ln: failed to access '${typed}': No such file or directory\n`]
    if (stat.type !== FileType.DIRECTORY) return [[], `ln: target '${typed}' is not a directory\n`]
    return [operands.map((op) => into(op, resolved, typed)), null]
  }
  const first = operands[0]
  if (first === undefined) return [[], null]
  if (operands.length === 1) {
    if (flags.noTarget) {
      return [[], `ln: missing destination file operand after '${wordText(first)}'\n${hint}`]
    }
    return [[into(first, cwd, '.')], null]
  }
  if (flags.noTarget) {
    const extra = operands[2]
    if (extra !== undefined) return [[], `ln: extra operand '${wordText(extra)}'\n${hint}`]
    const link = operands[1]
    if (link === undefined) return [[], null]
    return [[{ source: first, linkAbs: absPath(link, cwd), linkTyped: wordText(link) }], null]
  }
  const last = operands[operands.length - 1] ?? first
  const lastAbs = absPath(last, cwd)
  const [resolved, stat] = await dirAt(namespace, dispatch, lastAbs, flags.noDereference)
  const isDir = stat !== null && stat.type === FileType.DIRECTORY
  if (operands.length === 2 && !isDir) {
    return [[{ source: first, linkAbs: lastAbs, linkTyped: wordText(last) }], null]
  }
  if (!isDir) {
    if (stat === null) return [[], `ln: target '${wordText(last)}': No such file or directory\n`]
    return [[], `ln: target '${wordText(last)}': Not a directory\n`]
  }
  return [operands.slice(0, -1).map((op) => into(op, resolved, wordText(last))), null]
}

// The bytes a hard link copies, or the refusal in ln's words.
async function sourceBytes(
  namespace: Namespace,
  dispatch: DispatchFn,
  srcAbs: string,
  typed: string,
  linkTyped: string,
  flags: LnFlags,
): Promise<[Uint8Array | null, string | null]> {
  let resolved = srcAbs
  if (visibleLink(namespace, srcAbs)) {
    try {
      resolved = namespace.follow(srcAbs)
    } catch (err) {
      if (err instanceof CycleError) {
        return [null, `ln: failed to access '${typed}': Too many levels of symbolic links\n`]
      }
      throw err
    }
  }
  const stat = await pathStat(dispatch, resolved)
  if (stat === null) return [null, `ln: failed to access '${typed}': No such file or directory\n`]
  if (stat.type === FileType.DIRECTORY) {
    if (flags.directory) {
      return [
        null,
        `ln: failed to create hard link '${linkTyped}' => '${typed}': Operation not permitted\n`,
      ]
    }
    return [null, `ln: ${typed}: hard link not allowed for directory\n`]
  }
  // A source whose stat passes but whose read fails (a policy deny, a
  // backend that answers stat but not read) is refused the way GNU
  // refuses a source it cannot reach at all, so the remaining operands
  // still link.
  try {
    const [data] = await dispatch('read', PathSpec.fromStrPath(resolved))
    return [data instanceof Uint8Array ? data : await materialize(data as ByteSource), null]
  } catch (err) {
    const why = fsStrerror(err)
    if (why === null) throw err
    return [null, `ln: failed to access '${typed}': ${why}\n`]
  }
}

// Make one link, appending GNU's line to `errors` or `out`. A symlink
// stores the target as typed (or relative under -r). A hard link of a
// symlink is the link itself, so it becomes a second symlink with the
// same target, unless -L asks for the target's bytes; a hard link of a
// file is a byte copy through the op door.
export async function makeLink(
  namespace: Namespace,
  dispatch: DispatchFn,
  cwd: string,
  plan: LinkPlan,
  flags: LnFlags,
  errors: string[],
  out: string[],
): Promise<void> {
  const kind = flags.symbolic ? 'symbolic link' : 'hard link'
  const typed = plan.linkTyped
  const targetTyped = wordText(plan.source)
  let linkTarget: string | null = null
  let data: Uint8Array | null = null
  if (flags.symbolic) {
    linkTarget = targetTyped
    if (flags.relative) {
      // --relative: rewrite the target relative to the link's own
      // directory so the link stays valid addressed from anywhere. GNU
      // canonicalizes existing symlink components of both ends first, so
      // an aliased directory resolves to its real path (the link survives
      // the alias being moved/removed); a loop falls back to the lexical
      // answer.
      let linkDir = gnuDirname(plan.linkAbs)
      let targetAbs = absPath(plan.source, cwd)
      try {
        targetAbs = followVisible(namespace, targetAbs)
        linkDir = followVisible(namespace, linkDir)
      } catch (err) {
        if (!(err instanceof CycleError)) throw err
      }
      linkTarget = posixRelative(targetAbs, linkDir)
    }
  } else {
    const srcAbs = absPath(plan.source, cwd)
    if (visibleLink(namespace, srcAbs) && !flags.logical) {
      linkTarget = namespace.readlink(srcAbs)
    } else {
      const [bytes, refusal] = await sourceBytes(
        namespace,
        dispatch,
        srcAbs,
        targetTyped,
        typed,
        flags,
      )
      if (refusal !== null) {
        errors.push(refusal)
        return
      }
      data = bytes
    }
  }
  if (pathAllowed(plan.linkAbs) && namespace.isMountRoot(plan.linkAbs)) {
    errors.push(`ln: failed to create ${kind} '${typed}': File exists\n`)
    return
  }
  const linkSpec = PathSpec.fromStrPath(plan.linkAbs)
  let backupNote = ''
  const control = flags.backup
  const backs = control !== null && control !== 'none'
  if (typed.endsWith('/')) {
    // A link name typed with a slash asks for a directory the link can
    // never be, and GNU settles it before -f or -b touch anything there:
    // those two lstat the name first, and `reg/` over a file (or a link
    // to one) is ENOTDIR, `failed to access`, with the file kept and
    // nothing renamed aside. Without them symlink(2) and link(2) answer
    // `missing/` with ENOENT and anything standing behind the slash with
    // EEXIST, so GNU creates nothing where the normalized name would have
    // made a link called `missing`. A directory there took the link
    // inside it in planLinks, so only a non-directory and the absent name
    // are settled here, and a plain file without a flag falls to the
    // door's "File exists" below.
    const linked = visibleLink(namespace, plan.linkAbs)
    const behind = linked
      ? await linkTargetStat(namespace, dispatch, plan.linkAbs, null)
      : await pathStat(dispatch, plan.linkAbs)
    if (behind !== null && behind.type !== FileType.DIRECTORY && (flags.force || backs)) {
      errors.push(`ln: failed to access '${typed}': Not a directory\n`)
      return
    }
    if (!linked && behind === null) {
      const arrow = flags.symbolic ? '' : ` => '${targetTyped}'`
      errors.push(`ln: failed to create ${kind} '${typed}'${arrow}: No such file or directory\n`)
      return
    }
    if (linked && behind?.type !== FileType.DIRECTORY) {
      errors.push(`ln: failed to create ${kind} '${typed}': File exists\n`)
      return
    }
  }
  // GNU's same-name check, before any backup or removal: -f would
  // otherwise unlink the source it is about to link, leaving `ln -sf a a`
  // a self-loop where a file was. GNU waives it when a backup keeps the
  // original, so `ln -sfb a a` still goes through.
  if (
    flags.force &&
    !backs &&
    absPath(plan.source, cwd) === plan.linkAbs &&
    (visibleLink(namespace, plan.linkAbs) || (await pathStat(dispatch, plan.linkAbs)) !== null)
  ) {
    errors.push(`ln: '${targetTyped}' and '${typed}' are the same file\n`)
    return
  }
  // The door refuses an occupied name for a symlink; a byte copy would
  // overwrite one, and a backup has to see it first, so those two probe.
  // A backup moves a file aside, never a directory: GNU refuses the
  // directory (`ln -bT a d` is `cannot overwrite directory`) where it
  // would otherwise rename the whole tree to `d~`. A symlink standing
  // there is what -T names, and that one is backed up.
  let occupied = false
  if (data !== null || backs) {
    const found = visibleLink(namespace, plan.linkAbs)
      ? null
      : await pathStat(dispatch, plan.linkAbs)
    if (backs && found !== null && found.type === FileType.DIRECTORY) {
      errors.push(`ln: ${typed}: cannot overwrite directory\n`)
      return
    }
    occupied = found !== null || visibleLink(namespace, plan.linkAbs)
  }
  if (occupied && backs) {
    const backup = await backupTarget(
      async (p) => await pathReaddir(dispatch, p.virtual),
      linkSpec,
      control,
      flags.suffix,
    )
    if (backup !== null) {
      try {
        await dispatch('rename', linkSpec, [backup])
      } catch (err) {
        errors.push(`ln: cannot backup '${typed}': ${fsStrerror(err) ?? String(err)}\n`)
        return
      }
      backupNote = `'${typed}${backup.virtual.slice(plan.linkAbs.length)}' ~ `
      occupied = false
    }
  } else if (flags.force) {
    // GNU -f is "remove the destination, then link", which is why it
    // replaces a regular file and not only a link. The door refuses an
    // occupied name (symlink(2)'s EEXIST), so the removal is what makes
    // the flag work rather than a formality; a destination that is not
    // there is what -f is for, so its miss is the expected case and not
    // an error.
    try {
      await dispatch('unlink', linkSpec)
    } catch (err) {
      if (isEisdir(err)) {
        errors.push(`ln: ${typed}: cannot overwrite directory\n`)
        return
      }
      if (!isEnoent(err)) throw err
    }
    occupied = false
  }
  if (occupied) {
    errors.push(`ln: failed to create ${kind} '${typed}': File exists\n`)
    return
  }
  try {
    if (linkTarget !== null) {
      await dispatch('symlink', linkSpec, [], { target: linkTarget })
    } else {
      await dispatch('write', linkSpec, [data ?? new Uint8Array()])
    }
  } catch (err) {
    if (isEexist(err)) {
      // The door owns the existence rule (it is the only layer that can
      // see both the node table and the backend); ln owns the wording.
      errors.push(`ln: failed to create ${kind} '${typed}': File exists\n`)
      return
    }
    if (isErofs(err)) {
      // The mount voice, as `touch` on the same read-only mount answers:
      // the refusal is about the mount, and one grant must not describe
      // itself two ways.
      errors.push(readOnlyError('ln', namespace, linkSpec))
      return
    }
    if (err instanceof PolicyDenied || isEacces(err)) {
      // A policy deny, which ln voices as its own per-operand line.
      errors.push(
        `ln: failed to create ${kind} '${typed}': ${fsStrerror(err) ?? 'Permission denied'}\n`,
      )
      return
    }
    throw err
  }
  if (flags.verbose) {
    // A symlink reports the target it stored (relative under -r); a hard
    // link reports its source as typed.
    const shown = flags.symbolic && linkTarget !== null ? linkTarget : targetTyped
    const arrow = flags.symbolic ? '->' : '=>'
    out.push(`${backupNote}'${typed}' ${arrow} '${shown}'\n`)
  }
}

// ln [OPTION]... TARGET... : GNU ln over the namespace and the op door.
//
// -s makes a namespace symbolic link. Without it mirage has no hard link
// to offer, so the "link" is a byte copy through the op door, with one
// faithful exception: a hard link of a symlink is the link itself (GNU's
// default, -P), so it becomes a second symlink with the same target, and
// -L copies the target's bytes instead.
//
// The operand grammar is GNU's: -t DIR, a trailing directory operand, a
// single operand (into the cwd) and -T; a destination that is a link to a
// directory is dereferenced unless -n. -b, --backup=CONTROL and -S move an
// occupant aside before the link is made; -f removes it. -d/-F only change
// the wording of the refusal a directory source gets, since nobody is root
// here. Every write is a dispatch op, so session grants and admission
// policies fire at the door; this handler keeps the operand semantics and
// renders refusals in ln's own words.
export async function handleLn(
  namespace: Namespace,
  dispatch: DispatchFn,
  session: SessionState,
  args: (string | PathSpec)[],
): Promise<Result> {
  const spec = specOf('ln')
  const parsed = parseCommand(
    spec,
    args.map((a) => wordText(a)),
    session.cwd,
    'ln',
  )
  const refusal = optionRefusal(parsed)
  if (refusal !== null) return fail('ln', refusal[0], refusal[1])
  const fl = new FlagView(parseToKwargs(parsed), spec)
  let flags: LnFlags
  try {
    flags = parseFlags(fl)
  } catch (err) {
    if (err instanceof UsageError) return fail('ln', `${err.message}\n`, err.exitCode)
    throw err
  }
  const [operands, targetTyped] = operandWords(args)
  if (operands.length === 0) return fail('ln', `ln: missing file operand\n${usageHint('ln')}\n`)
  // GNU's order: the operand count first, then -r, then the -T/-t clash.
  if (flags.relative && !flags.symbolic) {
    return fail('ln', 'ln: cannot do --relative without --symbolic\n')
  }
  const rawDir: unknown = fl.raw('target_directory')
  const targetDir =
    rawDir instanceof PathSpec ? rawDir.virtual : typeof rawDir === 'string' ? rawDir : null
  if (targetDir !== null && flags.noTarget) {
    return fail('ln', 'ln: cannot combine --target-directory and --no-target-directory\n')
  }
  const [plans, refused] = await planLinks(
    namespace,
    dispatch,
    session.cwd,
    operands,
    targetDir,
    targetTyped,
    flags,
  )
  if (refused !== null) return fail('ln', refused)
  const errors: string[] = []
  const out: string[] = []
  for (const plan of plans) {
    await makeLink(namespace, dispatch, session.cwd, plan, flags, errors, out)
  }
  return result('ln', {
    out: out.length > 0 ? ENC.encode(out.join('')) : null,
    exitCode: errors.length > 0 ? 1 : 0,
    ...(errors.length > 0 ? { stderr: errors.join('') } : {}),
  })
}
