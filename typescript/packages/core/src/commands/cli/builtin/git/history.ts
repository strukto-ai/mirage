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

import type { FlagView } from '../../../spec/types.ts'
import { isoTimestamp } from '../../../../utils/dates.ts'
import { BadDateError } from './errors.ts'
import type { CommitFacts } from './format.ts'
import { touches } from './pickaxe.ts'
import { commitFacts, type Repo } from './repo.ts'

/** The parsed shape of a `git log` invocation. */
export interface LogFlags {
  /** `-n`, how many commits to print. */
  readonly maxCount: number | null
  /** `--oneline`, one abbreviated row per commit. */
  readonly oneline: boolean
  /** `--reverse`, oldest first. */
  readonly reverse: boolean
  /** `-S`, the pickaxe string. */
  readonly search: string | null
  /** `--since` as an epoch second. */
  readonly since: number | null
  /** `--until` as an epoch second. */
  readonly until: number | null
}

/**
 * Read a date flag as an epoch second, refusing what it cannot read.
 *
 * Accepts an ISO-8601 date or a bare epoch second. git accepts far more
 * (`2 weeks ago`, `yesterday`); anything else is refused here rather than
 * silently ignored, which would quietly widen the window.
 */
function timestamp(value: string | null, flag: string): number | null {
  if (value === null) return null
  const parsed = isoTimestamp(value)
  if (parsed !== null) return parsed
  const asNumber = Number(value)
  if (value.trim() !== '' && Number.isFinite(asNumber)) return asNumber
  throw new BadDateError(flag, value)
}

/** Read the raw log flag kwargs into a frozen struct. */
export function parseFlags(fl: FlagView): LogFlags {
  return {
    maxCount: fl.asInt('n') ?? null,
    oneline: fl.asBool('oneline'),
    reverse: fl.asBool('reverse'),
    search: fl.asStr('S') ?? null,
    since: timestamp(fl.asStr('since') ?? null, '--since'),
    until: timestamp(fl.asStr('until') ?? null, '--until'),
  }
}

/**
 * Walk history from one commit, newest first, along every parent.
 *
 * Ordered by commit time with ties broken by insertion, which is what a git log
 * without `--topo-order` prints. Each commit is visited once however many
 * branches reach it.
 */
async function* walkHistory(repo: Repo, start: string): AsyncGenerator<CommitFacts> {
  const seen = new Set<string>([start])
  const queue: CommitFacts[] = [await commitFacts(repo, start)]
  while (queue.length > 0) {
    queue.sort((a, b) => b.authorTime - a.authorTime)
    const next = queue.shift()
    if (next === undefined) break
    yield next
    for (const parent of next.parents) {
      if (seen.has(parent)) continue
      seen.add(parent)
      queue.push(await commitFacts(repo, parent))
    }
  }
}

/**
 * The commits a log invocation prints, in the order it prints them.
 *
 * Order of operations is git's: walk history, drop what the filters reject, cut
 * to `-n`, and only then reverse. Reversing last is what makes
 * `-S <name> --reverse` name the commit that introduced a string rather than the
 * most recent one to touch it.
 *
 * @param repo repository to walk
 * @param start the commit id to walk back from
 * @param flags the parsed invocation
 */
export async function select(repo: Repo, start: string, flags: LogFlags): Promise<CommitFacts[]> {
  const selected: CommitFacts[] = []
  for await (const commit of walkHistory(repo, start)) {
    if (flags.since !== null && commit.authorTime <= flags.since) continue
    if (flags.until !== null && commit.authorTime > flags.until) continue
    if (flags.search !== null && !(await touches(repo, commit.oid, commit.parents, flags.search))) {
      continue
    }
    selected.push(commit)
    if (flags.maxCount !== null && selected.length >= flags.maxCount) break
  }
  if (flags.reverse) selected.reverse()
  return selected
}
