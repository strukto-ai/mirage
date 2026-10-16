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

import type { LinearAccessor } from '../../accessor/linear.ts'
import { FileChangeKind, type FileEvent, type JsonValue, type PathSpec } from '../../types.ts'
import { eventAt, field, textField } from '../../watch/events.ts'
import { getIssue, listTeams } from './client.ts'
import { issueDirname, teamDirname } from './pathing.ts'

// The issue fields a project file lists, so a change to one makes the team's
// projects stale.
const PROJECT_ROW_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'stateId',
  'projectId',
  'archivedAt',
  'teamId',
])

const ISSUE_FILES = ['issue.json', 'comments.jsonl'] as const

/**
 * Map one Linear webhook delivery onto mount paths.
 *
 * The consumer owns the receiver and passes the delivery's `type` (the
 * `Linear-Event` header) with the JSON body. Nothing here runs a loop. `Issue`
 * and `Comment` map; every other entity maps to nothing.
 *
 * An issue is the directory `teams/<team>/issues/<KEY-N>__<id>` with
 * `issue.json` and `comments.jsonl`, both named as `readdir` names them. An
 * issue body carries its team, so its path needs no call; a comment names only
 * its issue, which is read once through `issue(id)` and remembered. A team the
 * mount's `teamIds` leaves out maps to nothing.
 *
 * A new issue creates both files and a removed one deletes its directory. An
 * archived issue leaves the listing as a removed one does, and one restored
 * from the archive comes back as new. An issue moved to another team changes
 * its key too, so its old place is gone: the old team's `issues` is UNKNOWN. A
 * project file lists its team's issues with their keys, titles and states, so
 * an issue that is or was in a project and is created, removed, archived,
 * moved or changes one of those is UNKNOWN on its team's `projects`. A comment
 * created, edited or removed updates its issue's `comments.jsonl`.
 *
 * Mirrors Python `LinearEventHook` (`core/linear/watch.py`).
 */
export class LinearEventHook {
  private readonly accessor: LinearAccessor
  private readonly teams = new Map<string, Record<string, unknown>>()
  private readonly issues = new Map<string, string>()

  constructor(accessor: LinearAccessor) {
    this.accessor = accessor
  }

  private async teamDir(teamId: string | undefined, team: JsonValue): Promise<string | null> {
    if (teamId === undefined) return null
    const wanted = this.accessor.teamIds
    if (wanted !== null && wanted.length > 0 && !wanted.includes(teamId)) return null
    if (team !== null && typeof team === 'object' && textField(team, 'key') !== undefined) {
      this.teams.set(teamId, { ...(team as Record<string, unknown>) })
    }
    if (!this.teams.has(teamId)) {
      for (const listed of await listTeams(this.accessor.transport)) {
        this.teams.set(String(listed.id), listed)
      }
    }
    const known = this.teams.get(teamId)
    return known !== undefined ? `teams/${teamDirname(known)}` : null
  }

  private async issueDir(issue: JsonValue): Promise<string | null> {
    const issueId = textField(issue, 'id')
    const team = field(issue, 'team') ?? null
    const teamId = textField(issue, 'teamId') ?? textField(team, 'id')
    const teamDir = await this.teamDir(teamId, team)
    if (issueId === undefined) return null
    if (teamDir === null || teamId === undefined) {
      this.issues.delete(issueId)
      return null
    }
    let key = textField(issue, 'identifier')
    const number = field(issue, 'number')
    const prefix = this.teams.get(teamId)?.key
    if (
      key === undefined &&
      typeof prefix === 'string' &&
      typeof number === 'number' &&
      Number.isInteger(number)
    ) {
      key = `${prefix}-${String(number)}`
    }
    const place = `${teamDir}/issues/` + issueDirname({ id: issueId, identifier: key ?? null })
    this.issues.set(issueId, place)
    return place
  }

  private async issue(
    root: PathSpec,
    action: string | undefined,
    payload: JsonValue,
  ): Promise<readonly FileEvent[]> {
    const data = field(payload, 'data') ?? null
    const before = field(payload, 'updatedFrom') ?? null
    const changed = new Set(
      before !== null && typeof before === 'object' && !Array.isArray(before)
        ? Object.keys(before)
        : [],
    )
    const inProject = textField(data, 'projectId') !== undefined || changed.has('projectId')
    const listed =
      inProject && (action !== 'update' || [...changed].some((k) => PROJECT_ROW_FIELDS.has(k)))
    const events: FileEvent[] = []
    const teams: string[] = []
    const oldTeam = textField(before, 'teamId')
    const oldDir = await this.teamDir(oldTeam, null)
    if (oldDir !== null) {
      teams.push(oldDir)
      events.push(eventAt(root, `${oldDir}/issues`, FileChangeKind.UNKNOWN))
    }
    const place = await this.issueDir(data)
    if (place !== null) {
      teams.push(place.slice(0, place.lastIndexOf('/issues/')))
      const archived = (field(data, 'archivedAt') ?? null) !== null
      if (action === 'remove' || (archived && changed.has('archivedAt'))) {
        events.push(eventAt(root, place, FileChangeKind.DELETE))
      } else if (
        action === 'create' ||
        oldTeam !== undefined ||
        (field(before, 'archivedAt') ?? null) !== null
      ) {
        for (const name of ISSUE_FILES) {
          events.push(eventAt(root, `${place}/${name}`, FileChangeKind.CREATE))
        }
      } else if (!archived) {
        events.push(eventAt(root, `${place}/issue.json`, FileChangeKind.UPDATE))
      }
    }
    if (listed) {
      for (const team of teams)
        events.push(eventAt(root, `${team}/projects`, FileChangeKind.UNKNOWN))
    }
    return events
  }

  private async comment(root: PathSpec, payload: JsonValue): Promise<readonly FileEvent[]> {
    const data = field(payload, 'data') ?? null
    const issueId = textField(data, 'issueId') ?? textField(field(data, 'issue') ?? null, 'id')
    if (issueId === undefined) return []
    let place = this.issues.get(issueId) ?? null
    if (place === null) {
      const issue = await getIssue(this.accessor.transport, issueId)
      place = await this.issueDir(issue as JsonValue)
    }
    if (place === null) return []
    return [eventAt(root, `${place}/comments.jsonl`, FileChangeKind.UPDATE)]
  }

  async toEvents(
    root: PathSpec,
    eventType: string,
    payload: JsonValue,
  ): Promise<readonly FileEvent[]> {
    if (eventType === 'Issue') return this.issue(root, textField(payload, 'action'), payload)
    if (eventType === 'Comment') return this.comment(root, payload)
    return []
  }
}
