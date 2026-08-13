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

import type { LinkView, MountView } from '../../../../ops/types.ts'
import type { PathSpec } from '../../../../types.ts'
import { fnmatch } from '../../../../utils/fnmatch.ts'
import { respellOne } from '../../../../utils/path.ts'
import { lstripSlash, rstripSlash } from '../../../../utils/slash.ts'
import type { MemberKind } from '../archive/types.ts'
import {
  OTHER_FILESYSTEM,
  scanOperand,
  type DirProbe,
  type StatFn,
  type WalkFn,
} from '../archive/walk.ts'
import type { CreateResult, Member } from './types.ts'

// Every diagnostic below is GNU tar 1.35's own wording, pinned on
// debian:stable-slim; only the hint line is mirage's, for the reason
// usage.oldOptionError gives (mirage's tar serves no --usage).
const USAGE_HINT = "Try 'tar --help' for more information."
const EMPTY_ARCHIVE = 'tar: Cowardly refusing to create an empty archive'
const FATAL_TRAILER = 'tar: Error is not recoverable: exiting now'
const ERROR_TRAILER = 'tar: Exiting with failure status due to previous errors'
const SELF_DUMP = 'archive cannot contain itself; not dumped'
// The exit GNU gives an operand it could not read, and a -C it could not
// enter. Both are fatal for the whole run, not per-operand.
const CREATE_ERROR_EXIT = 2

export type { DirProbe, StatFn, WalkFn }

export interface CreateDeps {
  archive: PathSpec
  exclude: string | null
  dereference: boolean
  stat: StatFn
  walk: WalkFn
  isDir: DirProbe
  // Every `-C` the operands were based on, in order, checked inside
  // the plan because GNU chdirs at each one before reading anything.
  directories?: readonly PathSpec[]
  links?: LinkView | null
  mounts?: MountView | null
}

function refusal(notices: string[]): CreateResult {
  return { members: [], notices, exitCode: CREATE_ERROR_EXIT, write: false }
}

// Whether GNU's `--exclude` pattern matches this member name. GNU's
// exclusion is unanchored: the pattern is tried against the whole name
// and against every suffix that starts at a path component, so `a.txt`,
// `d/a.txt` and `sub/b.txt` all match entries under `d`. Wildcards cross
// slashes (`*/b.txt` matches `d/sub/b.txt`), which is tar's default for
// exclusion patterns. A directory's trailing slash is not part of what
// the pattern sees. Info-ZIP's `-x` is the anchored counterpart, which
// is why the two are not shared.
function excluded(name: string, pattern: string): boolean {
  const bare = rstripSlash(name)
  if (fnmatch(bare, pattern)) return true
  let cut = bare.indexOf('/')
  while (cut !== -1) {
    if (fnmatch(bare.slice(cut + 1), pattern)) return true
    cut = bare.indexOf('/', cut + 1)
  }
  return false
}

// Drop excluded names and everything beneath an excluded directory. GNU
// does not walk into a directory it excluded, so `--exclude sub` takes
// `d/sub/` and `d/sub/b.txt` together; matching each name in isolation
// would keep the children of a pruned directory.
function pruned(names: readonly string[], pattern: string | null): string[] {
  if (pattern === null) return [...names]
  const kept: string[] = []
  const cutDirs: string[] = []
  for (const name of names) {
    if (cutDirs.some((cut) => name.startsWith(cut))) continue
    if (excluded(name, pattern)) {
      if (name.endsWith('/')) cutDirs.push(name)
      continue
    }
    kept.push(name)
  }
  return kept
}

// Split a spelled path into the name tar stores and what it drops. tar
// stores no name that could climb out of the directory it is extracted
// into, so it removes everything through the *last* `..` segment:
// `x/../y/f3` is stored as `y/f3` and `/data/sub/../file` as `file`. Only
// when the path has no `..` does the leading slash become the thing
// removed. A `.` segment escapes nothing and survives, so `./file` is
// stored verbatim. Info-ZIP makes the opposite choice and keeps `..` in
// the member name, which is why zip_cmd does not share this. Returns the
// name and the prefix removed to get it ('' when nothing was), and each
// distinct prefix earns one notice naming it.
export function stripPrefix(spelled: string): [string, string] {
  const segments = spelled.split('/')
  let last = -1
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '..') last = i
  }
  if (last >= 0) {
    const rest = segments.slice(last + 1).join('/')
    const prefix = segments.slice(0, last + 1).join('/')
    return [rest, rest !== '' ? `${prefix}/` : prefix]
  }
  if (spelled.startsWith('/')) return [lstripSlash(spelled), '/']
  return [spelled, '']
}

// GNU's notice for a prefix it refused to store.
function removingLeading(prefix: string): string {
  return `tar: Removing leading \`${prefix}' from member names`
}

// Announce a removed prefix the first time this run drops it. Emitted in
// place rather than collected and prepended, because GNU interleaves
// these with the per-operand errors in operand order.
function announcePrefix(prefix: string, dropped: string[], notices: string[]): void {
  if (prefix === '' || dropped.includes(prefix)) return
  dropped.push(prefix)
  notices.push(removingLeading(prefix))
}

// The name tar records for a path spelled as the operand was typed. The
// traversal prefix is dropped (see stripPrefix) and a directory carries
// the trailing slash that tells an extractor it holds no content. An
// operand that is all traversal — `tar -cf a.tar ..` — leaves nothing to
// name, and GNU stores that directory as `./`.
function memberName(spelled: string, kind: MemberKind): string {
  const [name] = stripPrefix(spelled)
  if (kind === 'dir') {
    if (name === '') return './'
    if (!name.endsWith('/')) return `${name}/`
  }
  return name
}

/**
 * Decide every member of a new archive, before writing any of it.
 *
 * One pass per operand, in the order they were typed, each contributing
 * itself and then its subtree. GNU walks a directory operand rather than
 * refusing it, and mirage now does too; the one deliberate divergence is
 * ordering, since GNU emits siblings in readdir order (filesystem-dependent)
 * and this sorts them, the same choice `du` already documents.
 */
export async function planCreate(
  paths: readonly PathSpec[],
  deps: CreateDeps,
): Promise<CreateResult> {
  if (paths.length === 0) return refusal([EMPTY_ARCHIVE, USAGE_HINT])
  for (const directory of deps.directories ?? []) {
    // GNU chdirs at each -C in turn, before reading a single operand,
    // so the FIRST one it cannot enter is fatal for the whole run and
    // no members are written. Checking only the last would archive the
    // operands that followed a bad earlier one.
    if (!(await deps.isDir(directory))) {
      return refusal([
        `tar: ${directory.rawPath}: Cannot open: No such file or directory`,
        FATAL_TRAILER,
      ])
    }
  }
  const members: Member[] = []
  const notices: string[] = []
  const dropped: string[] = []
  let exitCode = 0
  for (const path of paths) {
    // GNU strips a trailing slash off the operand before naming the
    // member, and re-adds one only for a member that really is a
    // directory: `tar -cf a.tar dlink/` stores `dlink`, the symlink,
    // exactly as `tar -cf a.tar dlink` does.
    const trimmedRaw = rstripSlash(path.rawPath)
    const raw = trimmedRaw === '' ? path.rawPath : trimmedRaw
    const base = rstripSlash(path.virtual) || '/'
    const scan = await scanOperand(path, {
      stat: deps.stat,
      walk: deps.walk,
      links: deps.links ?? null,
      mounts: deps.mounts ?? null,
      dereference: deps.dereference,
      recurse: true,
    })
    // GNU announces the prefix it refuses to store before it reports what
    // it could not read, and keeps both in operand order — a later
    // operand's notice must not jump ahead of an earlier operand's error.
    // The operand's own spelling carries the prefix even when nothing
    // under it can be archived, which is why `tar -cf a.tar sub/../missing`
    // still announces `sub/../`.
    announcePrefix(stripPrefix(raw)[1], dropped, notices)
    // Each name is then stripped on its own, so one operand can owe two
    // notices: `tar -cf a.tar ..` drops `..` from the directory and `../`
    // from everything under it.
    const named = scan.entries.map((entry) => {
      const spelled = respellOne(entry.namePath, base, raw)
      announcePrefix(stripPrefix(spelled)[1], dropped, notices)
      return [memberName(spelled, entry.kind), entry] as const
    })
    for (const problem of scan.problems) {
      const shown = respellOne(problem.path, base, raw)
      if (problem.fatal !== true) {
        notices.push(`tar: ${shown}: ${problem.reason ?? ''}`)
        continue
      }
      notices.push(`tar: ${shown}: Cannot stat: ${problem.reason ?? ''}`)
      exitCode = CREATE_ERROR_EXIT
    }
    if (scan.missing) continue
    for (const crossing of scan.crossings) {
      const shown = memberName(respellOne(crossing, base, raw), 'dir')
      notices.push(`tar: ${shown}: ${OTHER_FILESYSTEM}`)
    }
    const keep = new Set(
      pruned(
        named.map(([name]) => name),
        deps.exclude,
      ),
    )
    for (const [name, entry] of named) {
      if (!keep.has(name)) continue
      const read = entry.read ?? null
      if (read !== null && read.virtual === deps.archive.virtual) {
        notices.push(`tar: ${name}: ${SELF_DUMP}`)
        continue
      }
      members.push({ name, kind: entry.kind, path: read, target: entry.target ?? '' })
    }
  }
  // GNU closes a run that failed an operand with one trailer, after
  // everything it did manage to name.
  if (exitCode !== 0) notices.push(ERROR_TRAILER)
  return { members, notices, exitCode, write: true }
}
