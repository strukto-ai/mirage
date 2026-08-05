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

import { readOptional, under, writeFile } from './io.ts'
import type { Dispatch } from './types.ts'

const LOGS_DIR = 'logs'
const HEAD_LOG = 'logs/HEAD'
const ZERO = '0'.repeat(40)

const ENC = new TextEncoder()

/**
 * One reflog line, in git's own format.
 *
 * `<old> <new> <identity> <epoch> <offset>\t<message>`, with the old id all
 * zeroes when there was nothing there before. The tab is load-bearing: it is
 * what separates the fixed fields from a message that may itself contain spaces.
 *
 * @param before the id the ref held, zeroes when it held none
 * @param after the id it now holds
 * @param who the identity, `Name <email>`
 * @param when epoch seconds
 * @param message what happened, e.g. `commit: add delta`
 */
function entry(
  before: string,
  after: string,
  who: string,
  when: number,
  message: string,
): Uint8Array {
  return ENC.encode(`${before} ${after} ${who} ${String(when)} +0000\t${message}\n`)
}

/**
 * Add one line to a reflog, creating it if it is not there.
 *
 * Read-modify-write rather than an append op, because not every backend offers
 * one and a reflog is small. Losing the history here would only cost the `@{n}`
 * syntax, but `git branch` reads it to say where a detached HEAD detached from,
 * so an absent log makes a perfectly good checkout read as `(no branch)`.
 */
async function append(
  dispatch: Dispatch,
  gitdir: string,
  path: string,
  line: Uint8Array,
): Promise<void> {
  const target = under(gitdir, path)
  const existing = (await readOptional(dispatch, target)) ?? new Uint8Array(0)
  const merged = new Uint8Array(existing.length + line.length)
  merged.set(existing)
  merged.set(line, existing.length)
  await writeFile(dispatch, target, merged)
}

/**
 * Record one move of HEAD, and of the branch it is on.
 *
 * git writes both logs on every update: `logs/HEAD` always, and the branch's own
 * log when HEAD is attached to one. Both carry the same line.
 *
 * @param dispatch workspace op dispatcher
 * @param gitdir this checkout's git directory, which owns the logs
 * @param ref the branch ref that also moved, null when HEAD is detached
 * @param before the id HEAD held, null when it held none
 * @param after the id it now holds
 * @param who the identity to record
 * @param when epoch seconds
 * @param message what happened
 */
export async function record(
  dispatch: Dispatch,
  gitdir: string,
  ref: string | null,
  before: string | null,
  after: string,
  who: string,
  when: number,
  message: string,
): Promise<void> {
  const line = entry(before ?? ZERO, after, who, when, message)
  await append(dispatch, gitdir, HEAD_LOG, line)
  if (ref !== null) await append(dispatch, gitdir, `${LOGS_DIR}/${ref}`, line)
}
