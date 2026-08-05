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

const SHORT_SHA = 7
const INDENT = '    '
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/** A commit as far as rendering is concerned, whoever read it. */
export interface CommitFacts {
  readonly oid: string
  readonly message: string
  readonly authorName: string
  readonly authorEmail: string
  /** Seconds since the epoch. */
  readonly authorTime: number
  /** The author's UTC offset in minutes, git's own sign convention. */
  readonly authorTimezoneMinutes: number
  readonly parents: readonly string[]
}

/**
 * How many hex digits an abbreviated id needs in a repository.
 *
 * git widens the abbreviation as a repository grows, so `--oneline` on a large
 * repository prints nine characters where a fresh one prints seven, and a build
 * that always printed seven disagreed with real git on every line of every big
 * repository.
 *
 * Measured against git 2.50.1 rather than read off its source, and the boundary
 * is sharp: 16,383 packed objects abbreviate to 7 and 16,384 to 8, which is one
 * hex digit per two bits of object count, floored at git's seven. Confirmed
 * again at 20,102 (8), 70,102 (9) and 184,401 (9).
 *
 * Only packed objects count. The same 70,102 objects abbreviate to 7 while loose
 * and to 9 once packed, which is consistent with it being an estimate: a pack
 * index states its object count in its header, while counting loose objects
 * means walking 256 directories.
 *
 * @param packed how many objects the repository's packs hold
 */
export function abbrevLength(packed: number): number {
  const bits = packed <= 0 ? 0 : Math.floor(Math.log2(packed)) + 1
  return Math.max(SHORT_SHA, Math.ceil(bits / 2))
}

/**
 * Abbreviate an object id the way `--oneline` prints it.
 *
 * @param sha hex object id
 * @param length how many hex digits to keep, from abbrevLength
 */
export function short(sha: string, length: number = SHORT_SHA): string {
  return sha.slice(0, length)
}

/**
 * Render a commit time in git's default date format.
 *
 * `Fri Jan 16 11:30:00 2026 +0000`: the day of the month is not padded, which is
 * why this is built by hand. The stored offset is minutes east of UTC and the
 * timestamp is read in that offset, so a commit prints the wall clock its author
 * saw.
 *
 * @param timestamp seconds since the epoch
 * @param offsetMinutes the author's UTC offset in minutes
 */
function gitDate(timestamp: number, offsetMinutes: number): string {
  const shifted = new Date((timestamp + offsetMinutes * 60) * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const hours = Math.floor(Math.abs(offsetMinutes) / 60)
  const minutes = Math.abs(offsetMinutes) % 60
  const day = DAYS[shifted.getUTCDay()] ?? ''
  const month = MONTHS[shifted.getUTCMonth()] ?? ''
  return (
    `${day} ${month} ${String(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:` +
    `${pad(shifted.getUTCSeconds())} ${String(shifted.getUTCFullYear())} ` +
    `${sign}${pad(hours)}${pad(minutes)}`
  )
}

/** The first line of a commit message. */
function subject(commit: CommitFacts): string {
  return (commit.message.split('\n', 1)[0] ?? '').replace(/\s+$/, '')
}

/**
 * One `--oneline` row: abbreviated id then subject.
 *
 * @param commit the commit to render
 * @param length how many hex digits of the id to print
 */
export function oneline(commit: CommitFacts, length: number = SHORT_SHA): string {
  return `${short(commit.oid, length)} ${subject(commit)}`
}

/**
 * A commit message indented the way log and show print it.
 *
 * Every line is indented by four spaces, blank lines included, so an empty line
 * inside a message renders as four spaces rather than as an empty one. Verified
 * against git 2.47.3; it is trailing whitespace on purpose.
 */
function messageBlock(commit: CommitFacts): string[] {
  return commit.message
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => `${INDENT}${line}`)
}

/**
 * A full log entry: the header block and the indented message.
 *
 * A merge carries an extra `Merge:` line naming its parents in abbreviated form,
 * which git prints between the id and the author for both `log` and `show`.
 *
 * @param commit the commit to render
 * @param length how many hex digits of a parent id to print
 */
export function entry(commit: CommitFacts, length: number = SHORT_SHA): string[] {
  const lines = [`commit ${commit.oid}`]
  if (commit.parents.length > 1) {
    lines.push(`Merge: ${commit.parents.map((p) => short(p, length)).join(' ')}`)
  }
  lines.push(
    `Author: ${commit.authorName} <${commit.authorEmail}>`,
    `Date:   ${gitDate(commit.authorTime, commit.authorTimezoneMinutes)}`,
    '',
    ...messageBlock(commit),
  )
  return lines
}
