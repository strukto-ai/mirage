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

import type { GitHubAccessor } from '../../accessor/github.ts'
import { FileChangeKind, type FileEvent, type JsonValue, type PathSpec } from '../../types.ts'
import { eventAt, field, textField } from '../../watch/events.ts'

// The most commits GitHub lists in one push delivery; a push at the cap may
// have lost some, so its paths are not the whole change.
const COMMIT_CAP = 2048

// The lists each pushed commit carries, and the change each one is.
const ACTIONS = ['added', 'removed', 'modified'] as const

/**
 * Map one GitHub `push` webhook delivery onto mount paths.
 *
 * The consumer owns the receiver (a repository webhook for `push`) and passes
 * the event name from the `X-GitHub-Event` header with the JSON body. Nothing
 * here runs a loop. A mount reads one ref of one repository, so only a push to
 * that ref maps to anything.
 *
 * Each pushed commit lists the paths it added, removed and modified, so a
 * path's change is its first and last action across the push: one added and
 * then removed within the push never existed outside it and maps to nothing.
 * A forced push, a branch created or deleted, and a push at GitHub's commit cap
 * do not say what changed between the old head and the new one, so the whole
 * mount is UNKNOWN. Each event evicts the root listing above it, so the next
 * read fetches the new head's tree.
 *
 * Mirrors Python `GitHubEventHook` (`core/github/watch.py`).
 */
export class GitHubEventHook {
  private readonly accessor: GitHubAccessor

  constructor(accessor: GitHubAccessor) {
    this.accessor = accessor
  }

  toEvents(root: PathSpec, eventName: string, payload: JsonValue): Promise<readonly FileEvent[]> {
    return Promise.resolve(this.map(root, eventName, payload))
  }

  private map(root: PathSpec, eventName: string, payload: JsonValue): readonly FileEvent[] {
    if (eventName !== 'push') return []
    const { owner, repo, ref } = this.accessor
    const repository = field(payload, 'repository') ?? null
    const name = textField(repository, 'full_name') ?? ''
    if (name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) return []
    const pushed = textField(payload, 'ref')
    if (pushed !== `refs/heads/${ref}` && pushed !== `refs/tags/${ref}`) return []
    const commits = field(payload, 'commits')
    if (
      ['forced', 'created', 'deleted'].some((flag) => field(payload, flag) === true) ||
      !Array.isArray(commits) ||
      commits.length >= COMMIT_CAP
    ) {
      return [eventAt(root, '', FileChangeKind.UNKNOWN)]
    }
    const first = new Map<string, string>()
    const last = new Map<string, string>()
    for (const commit of commits) {
      for (const action of ACTIONS) {
        const paths = field(commit, action)
        for (const path of Array.isArray(paths) ? paths : []) {
          if (typeof path !== 'string') continue
          if (!first.has(path)) first.set(path, action)
          last.set(path, action)
        }
      }
    }
    const events: FileEvent[] = []
    for (const [path, action] of first) {
      const final = last.get(path)
      if (action === 'added' && final === 'removed') continue
      const kind =
        action === 'added'
          ? FileChangeKind.CREATE
          : final === 'removed'
            ? FileChangeKind.DELETE
            : FileChangeKind.UPDATE
      events.push(eventAt(root, path, kind))
    }
    return events
  }
}
