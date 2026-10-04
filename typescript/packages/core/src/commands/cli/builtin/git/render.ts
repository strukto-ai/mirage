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

import { decodeText, encodeText } from '../../../../shell/bytes.ts'
import type { StatusEntry, Upstream } from './types.ts'

const UNCHANGED = ' '
const UNTRACKED = '?'
const UNMERGED_COLUMN = 'U'

// Width of the label column, which git fixes per section rather than measuring:
// wide enough for the longest label the section can print ("typechange:" among
// the changes, "deleted by them:" among the conflicts).
const LABEL_WIDTH = 12
const CONFLICT_WIDTH = 17

const STAGED_LABELS: Record<string, string> = {
  M: 'modified:',
  A: 'new file:',
  D: 'deleted:',
  R: 'renamed:',
  C: 'copied:',
  T: 'typechange:',
}

const WORK_LABELS: Record<string, string> = {
  M: 'modified:',
  D: 'deleted:',
  T: 'typechange:',
}

const CONFLICT_LABELS: Record<string, string> = {
  DD: 'both deleted:',
  AU: 'added by us:',
  UD: 'deleted by them:',
  UA: 'added by them:',
  DU: 'deleted by us:',
  AA: 'both added:',
  UU: 'both modified:',
}

// Every escape git spells with a letter rather than an octal triple.
const ESCAPES: Record<number, string> = {
  0x07: '\\a',
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
  0x0b: '\\v',
  0x22: '\\"',
  0x5c: '\\\\',
}

const ON_BRANCH = 'On branch '
export const DETACHED_AT = 'HEAD detached at '
export const DETACHED_FROM = 'HEAD detached from '
export const NO_BRANCH = 'Not currently on any branch.'
const NO_COMMITS = 'No commits yet'
const BRANCH_MARK = '## '
const NO_COMMITS_BRANCH = 'No commits yet on '

const STAGED_HEADER = 'Changes to be committed:'
const UNMERGED_HEADER = 'Unmerged paths:'
const WORK_HEADER = 'Changes not staged for commit:'
const UNTRACKED_HEADER = 'Untracked files:'

const UNSTAGE_HINT = '  (use "git restore --staged <file>..." to unstage)'
const UNCACHE_HINT = '  (use "git rm --cached <file>..." to unstage)'
const RESOLVE_HINT = '  (use "git add <file>..." to mark resolution)'
// git widens the first hint to name `rm` as soon as the section holds a
// deletion, because `git add` alone does stage one but reads as the wrong advice
// for a file that is gone.
const WORK_HINT = '  (use "git add <file>..." to update what will be committed)'
const WORK_HINT_DELETED = '  (use "git add/rm <file>..." to update what will be committed)'
const DISCARD_HINT = '  (use "git restore <file>..." to discard changes in working directory)'
const UNTRACKED_HINT = '  (use "git add <file>..." to include in what will be committed)'

const CONFLICT_HEADER = [
  'You have unmerged paths.',
  '  (fix conflicts and run "git commit")',
  '  (use "git merge --abort" to abort the merge)',
]
const RESOLVED_HEADER = [
  'All conflicts fixed but you are still merging.',
  '  (use "git commit" to conclude merge)',
]

const CLEAN = 'nothing to commit, working tree clean'
const CLEAN_INITIAL = 'nothing to commit (create/copy files and use "git add" to track)'
const UNSTAGED_ONLY = 'no changes added to commit (use "git add" and/or "git commit -a")'
const UNTRACKED_ONLY =
  'nothing added to commit but untracked files present (use "git add" to track)'
// The two things `-uno` says instead, and they are not the same line: with
// something staged git notes what it skipped, and with nothing at all it says
// the tree is empty of changes but stops short of calling it clean, since it did
// not look.
const UNTRACKED_HIDDEN = 'Untracked files not listed (use -u option to show untracked files)'
const CLEAN_UNSCANNED = 'nothing to commit (use -u to show untracked files)'

const ENC = new TextEncoder()

/**
 * Spell a path the way git spells it, quoting only when it must.
 *
 * git C-quotes a path holding anything that would not survive being read back: a
 * quote, a backslash, a control character, or a byte outside ASCII. The
 * machine-readable formats also quote a path holding a space, and the
 * human-readable one does not, which is not an inconsistency: only the former is
 * parsed by splitting on whitespace. Verified both ways against git 2.47.
 *
 * `core.quotePath=false` turns `fully` off, and a byte outside ASCII then passes
 * through as itself while everything else is quoted as before (git's
 * cq_must_quote, pinned against git 2.50). A byte that is not UTF-8 arrives as a
 * surrogate escape and is quoted, or passed through, as that byte.
 *
 * @param path repository-relative path
 * @param porcelain whether a space alone forces quoting
 * @param fully whether a byte outside ASCII forces quoting
 */
export function quotePath(path: string, porcelain: boolean, fully = true): string {
  const raw = encodeText(path)
  const special = raw.some((byte) => mustQuote(byte, fully))
  if (!special && !(porcelain && path.includes(' '))) return path
  if (!special) return `"${path}"`
  const out: number[] = []
  for (const byte of raw) {
    const escape = ESCAPES[byte]
    if (escape !== undefined) out.push(...ENC.encode(escape))
    else if (mustQuote(byte, fully))
      out.push(...ENC.encode(`\\${byte.toString(8).padStart(3, '0')}`))
    else out.push(byte)
  }
  return `"${decodeText(new Uint8Array(out))}"`
}

/** Whether one byte of a path forces the whole path into quotes. */
function mustQuote(byte: number, fully: boolean): boolean {
  return byte in ESCAPES || byte < 0x20 || byte === 0x7f || (fully && byte > 0x7f)
}

/** One row of `--short` / `--porcelain` output. */
function shortLine(entry: StatusEntry, fully: boolean): string {
  let path = quotePath(entry.path, true, fully)
  if (entry.original !== null) path = `${quotePath(entry.original, true, fully)} -> ${path}`
  return `${entry.indexStatus}${entry.treeStatus} ${path}`
}

/**
 * The `## ` header `--branch` prepends to the short formats.
 *
 * @param branch the branch HEAD names, null when detached
 * @param noCommits whether HEAD resolves to nothing yet
 */
export function branchLine(
  branch: string | null,
  noCommits: boolean,
  upstream: Upstream | null = null,
): string {
  if (branch === null) return `${BRANCH_MARK}HEAD (no branch)`
  if (noCommits) return `${BRANCH_MARK}${NO_COMMITS_BRANCH}${branch}`
  if (upstream === null) return `${BRANCH_MARK}${branch}`
  const counts = upstream.gone ? ['gone'] : []
  if (upstream.ahead) counts.push(`ahead ${String(upstream.ahead)}`)
  if (upstream.behind) counts.push(`behind ${String(upstream.behind)}`)
  const shown = counts.length ? ` [${counts.join(', ')}]` : ''
  return `${BRANCH_MARK}${branch}...${upstream.label}${shown}`
}

function commits(count: number): string {
  return `${String(count)} commit${count === 1 ? '' : 's'}`
}

/**
 * What the long status says about a branch and its upstream.
 *
 * Pinned against git 2.47.3 and 2.50.1 (`format_tracking_info`).
 */
export function trackingLines(upstream: Upstream): string[] {
  const name = upstream.label
  if (upstream.gone)
    return [
      `Your branch is based on '${name}', but the upstream is gone.`,
      '  (use "git branch --unset-upstream" to fixup)',
    ]
  if (!upstream.ahead && !upstream.behind) return [`Your branch is up to date with '${name}'.`]
  if (!upstream.behind)
    return [
      `Your branch is ahead of '${name}' by ${commits(upstream.ahead)}.`,
      '  (use "git push" to publish your local commits)',
    ]
  if (!upstream.ahead)
    return [
      `Your branch is behind '${name}' by ${commits(upstream.behind)}, and can be fast-forwarded.`,
      '  (use "git pull" to update your local branch)',
    ]
  return [
    `Your branch and '${name}' have diverged,`,
    `and have ${String(upstream.ahead)} and ${String(upstream.behind)} different commits each, respectively.`,
    '  (use "git pull" if you want to integrate the remote branch with yours)',
  ]
}

/** The whole of `--short` / `--porcelain` output. */
export function shortFormat(
  rows: readonly StatusEntry[],
  header: string | null,
  fully = true,
): string {
  const lines = header === null ? [] : [header]
  lines.push(...rows.map((row) => shortLine(row, fully)))
  return lines.map((line) => `${line}\n`).join('')
}

/** One block of the long format, or nothing when it has no entries. */
function section(header: string, hints: readonly string[], entries: readonly string[]): string[] {
  if (entries.length === 0) return []
  return [header, ...hints, ...entries, '']
}

/** One entry line: a tab, a padded label, then the path. */
function labelled(label: string, path: string, width: number): string {
  return `\t${label.padEnd(width)}${path}`
}

/** The entry lines of the "Changes to be committed" section. */
function stagedEntries(rows: readonly StatusEntry[], fully: boolean): string[] {
  const lines: string[] = []
  for (const row of rows) {
    if ([UNCHANGED, UNTRACKED, UNMERGED_COLUMN, '!'].includes(row.indexStatus)) continue
    const label = STAGED_LABELS[row.indexStatus] ?? 'modified:'
    let path = quotePath(row.path, false, fully)
    if (row.original !== null) path = `${quotePath(row.original, false, fully)} -> ${path}`
    lines.push(labelled(label, path, LABEL_WIDTH))
  }
  return lines
}

/** The entry lines of the "Changes not staged for commit" section. */
function workEntries(rows: readonly StatusEntry[], fully: boolean): string[] {
  const lines: string[] = []
  for (const row of rows) {
    if (row.indexStatus === UNMERGED_COLUMN) continue
    if (row.treeStatus === UNCHANGED || row.treeStatus === UNTRACKED || row.treeStatus === '!')
      continue
    const label = WORK_LABELS[row.treeStatus] ?? 'modified:'
    lines.push(labelled(label, quotePath(row.path, false, fully), LABEL_WIDTH))
  }
  return lines
}

/** The entry lines of the "Unmerged paths" section. */
function unmergedEntries(rows: readonly StatusEntry[], fully: boolean): string[] {
  const lines: string[] = []
  for (const row of rows) {
    const label = CONFLICT_LABELS[`${row.indexStatus}${row.treeStatus}`]
    if (label === undefined) continue
    lines.push(labelled(label, quotePath(row.path, false, fully), CONFLICT_WIDTH))
  }
  return lines
}

/** The entry lines of the "Untracked files" section. */
function untrackedEntries(rows: readonly StatusEntry[], fully: boolean): string[] {
  return rows
    .filter((row) => row.indexStatus === UNTRACKED)
    .map((row) => `\t${quotePath(row.path, false, fully)}`)
}

/**
 * git's closing line, which says what the sections above did not.
 *
 * Exactly one line, or none: the line exists to explain why `git commit` would
 * refuse, so with something already staged there is nothing to explain and git
 * says nothing. `-uno` does not add a line, it substitutes the two that mention
 * untracked files, which is why it is threaded through here rather than appended
 * by the caller.
 */
function trailer(
  staged: readonly string[],
  work: readonly string[],
  unmerged: readonly string[],
  untracked: readonly string[],
  noCommits: boolean,
  hideUntracked: boolean,
): string[] {
  if (staged.length > 0) return hideUntracked ? [UNTRACKED_HIDDEN] : []
  if (work.length > 0 || unmerged.length > 0) return [UNSTAGED_ONLY]
  if (untracked.length > 0) return [UNTRACKED_ONLY]
  if (noCommits) return [CLEAN_INITIAL]
  return [hideUntracked ? CLEAN_UNSCANNED : CLEAN]
}

/**
 * The default, human-readable status report.
 *
 * @param rows every row, already in git's order
 * @param branch the branch HEAD names, null when detached
 * @param commit the abbreviated commit HEAD holds, set only when detached
 * @param noCommits whether HEAD resolves to nothing yet
 * @param merging whether a merge is in progress
 * @param hideUntracked whether `-uno` suppressed the scan
 */
export function longFormat(
  rows: readonly StatusEntry[],
  branch: string | null,
  detached: string,
  noCommits: boolean,
  merging: boolean,
  hideUntracked: boolean,
  fully = true,
  upstream: Upstream | null = null,
): string {
  const staged = stagedEntries(rows, fully)
  const unmerged = unmergedEntries(rows, fully)
  const work = workEntries(rows, fully)
  const untracked = untrackedEntries(rows, fully)
  const lines: string[] = [branch !== null ? `${ON_BRANCH}${branch}` : detached]
  if (upstream !== null) lines.push(...trackingLines(upstream), '')
  if (noCommits) lines.push('', NO_COMMITS, '')
  if (merging) {
    lines.push(...(unmerged.length > 0 ? CONFLICT_HEADER : RESOLVED_HEADER), '')
  }
  // A merge in progress removes the unstage hint, because unstaging is not what
  // resolving a conflict means and git stops offering it.
  const stagedHints = merging ? [] : [noCommits ? UNCACHE_HINT : UNSTAGE_HINT]
  lines.push(...section(STAGED_HEADER, stagedHints, staged))
  lines.push(...section(UNMERGED_HEADER, [RESOLVE_HINT], unmerged))
  // Read off the rendered lines rather than the rows, so the hint can only ever
  // describe entries this section actually prints: an unmerged path can also
  // carry a D and is reported elsewhere.
  const deleted = work.some((line) => line.startsWith(`\t${WORK_LABELS.D ?? ''}`))
  lines.push(...section(WORK_HEADER, [deleted ? WORK_HINT_DELETED : WORK_HINT, DISCARD_HINT], work))
  lines.push(...section(UNTRACKED_HEADER, [UNTRACKED_HINT], untracked))
  const ignored = rows
    .filter((row) => row.indexStatus === '!')
    .map((row) => `\t${quotePath(row.path, false, fully)}`)
  lines.push(
    ...section(
      'Ignored files:',
      ['  (use "git add -f <file>..." to include in what will be committed)'],
      ignored,
    ),
  )
  lines.push(...trailer(staged, work, unmerged, untracked, noCommits, hideUntracked))
  return lines.map((line) => `${line}\n`).join('')
}

/** A repository-relative path spelled from a directory inside the work tree. */
export function relativePath(path: string, prefix: string): string {
  if (prefix === '') return path
  const base = prefix.split('/')
  const parts = path.split('/').filter((part) => part !== '')
  let shared = 0
  while (shared < base.length && base[shared] === parts[shared]) shared++
  const name = [...base.slice(shared).map(() => '..'), ...parts.slice(shared)].join('/') || '.'
  return name + (path.endsWith('/') ? '/' : '')
}

/** Render status paths relative to an invocation inside the work tree. */
export function relativeEntries(rows: StatusEntry[], prefix: string): StatusEntry[] {
  if (prefix === '') return rows
  return rows.map((row) => ({
    ...row,
    path: relativePath(row.path, prefix),
    original: row.original === null ? null : relativePath(row.original, prefix),
  }))
}
