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

import { describe, expect, it } from 'vitest'
import { LinearAccessor } from '../../accessor/linear.ts'
import { FileChangeKind, PathSpec, type JsonValue } from '../../types.ts'
import type { LinearTransport } from './client.ts'
import { ISSUE_QUERY, TEAM_LIST_QUERY } from './queries.ts'
import { LinearEventHook } from './watch.ts'

const { CREATE: C, UPDATE: U, DELETE: D, UNKNOWN: X } = FileChangeKind
const ENG = { id: 't1', key: 'ENG', name: 'Engineering' }
const OPS = { id: 't2', key: 'OPS', name: 'Operations' }
const ENG_DIR = '/l/teams/ENG__Engineering__t1'
const ISSUE_DIR = `${ENG_DIR}/issues/ENG-7__i1`
const ROOT = new PathSpec({ virtual: '/l', directory: '/l', vfsPath: '' })

function fake(teamIds?: string[]): { hook: LinearEventHook; calls: string[] } {
  const calls: string[] = []
  const transport: LinearTransport = {
    graphql(query, variables) {
      if (query === TEAM_LIST_QUERY) {
        calls.push('teams')
        return Promise.resolve({
          teams: { nodes: [ENG, OPS], pageInfo: { hasNextPage: false, endCursor: null } },
        })
      }
      if (query === ISSUE_QUERY) {
        const issueId = String(variables?.issueId)
        calls.push(`issue ${issueId}`)
        const team = issueId === 'i1' ? OPS : ENG
        return Promise.resolve({ issue: { id: issueId, identifier: 'ENG-9', team } })
      }
      throw new Error(`unexpected query ${query}`)
    },
  }
  const accessor = new LinearAccessor(transport, teamIds !== undefined ? { teamIds } : {})
  return { hook: new LinearEventHook(accessor), calls }
}

function issue(fields: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return { id: 'i1', identifier: 'ENG-7', team: ENG, ...fields }
}

async function map(
  hook: LinearEventHook,
  eventType: string,
  payload: JsonValue,
): Promise<[FileChangeKind, string][]> {
  const events = await hook.toEvents(ROOT, eventType, payload)
  return events.map((e) => [e.kind, e.path.virtual])
}

describe('LinearEventHook', () => {
  it('creates both files of a new issue without a call', async () => {
    const { hook, calls } = fake()
    expect(await map(hook, 'Issue', { action: 'create', data: issue() })).toEqual([
      [C, `${ISSUE_DIR}/issue.json`],
      [C, `${ISSUE_DIR}/comments.jsonl`],
    ])
    expect(calls).toEqual([])
  })

  it('updates issue.json for an edit', async () => {
    const { hook } = fake()
    expect(
      await map(hook, 'Issue', {
        action: 'update',
        data: issue({ priority: 2 }),
        updatedFrom: { priority: 1 },
      }),
    ).toEqual([[U, `${ISSUE_DIR}/issue.json`]])
  })

  it('removes a removed or archived issue and brings a restored one back', async () => {
    const { hook } = fake()
    expect(await map(hook, 'Issue', { action: 'remove', data: issue() })).toEqual([[D, ISSUE_DIR]])
    expect(
      await map(hook, 'Issue', {
        action: 'update',
        data: issue({ archivedAt: '2026-10-01T00:00:00.000Z' }),
        updatedFrom: { archivedAt: null },
      }),
    ).toEqual([[D, ISSUE_DIR]])
    const restored = await map(hook, 'Issue', {
      action: 'update',
      data: issue({ archivedAt: null }),
      updatedFrom: { archivedAt: '2026-10-01T00:00:00.000Z' },
    })
    expect(restored.map(([kind]) => kind)).toEqual([C, C])
  })

  it("leaves the old team's listing when an issue moves team", async () => {
    const { hook, calls } = fake()
    const ops = '/l/teams/OPS__Operations__t2'
    expect(
      await map(hook, 'Issue', {
        action: 'update',
        data: { id: 'i1', teamId: 't2', number: 3, team: OPS, projectId: 'p1' },
        updatedFrom: { teamId: 't1', number: 7 },
      }),
    ).toEqual([
      [X, `${ENG_DIR}/issues`],
      [C, `${ops}/issues/OPS-3__i1/issue.json`],
      [C, `${ops}/issues/OPS-3__i1/comments.jsonl`],
      [X, `${ENG_DIR}/projects`],
      [X, `${ops}/projects`],
    ])
    expect(calls).toEqual(['teams'])
  })

  it('tells a project only of the fields its file lists', async () => {
    const { hook } = fake()
    const quiet = {
      action: 'update',
      data: issue({ projectId: 'p1' }),
      updatedFrom: { priority: 1 },
    }
    expect(await map(hook, 'Issue', quiet)).toEqual([[U, `${ISSUE_DIR}/issue.json`]])
    expect(await map(hook, 'Issue', { ...quiet, updatedFrom: { title: 'old' } })).toEqual([
      [U, `${ISSUE_DIR}/issue.json`],
      [X, `${ENG_DIR}/projects`],
    ])
  })

  it('reads a comment issue once', async () => {
    const { hook, calls } = fake()
    const comment = { action: 'create', data: { id: 'c1', issueId: 'i9' } }
    const path = `${ENG_DIR}/issues/ENG-9__i9/comments.jsonl`
    expect(await map(hook, 'Comment', comment)).toEqual([[U, path]])
    expect(await map(hook, 'Comment', { ...comment, action: 'remove' })).toEqual([[U, path]])
    expect(calls).toEqual(['issue i9'])
  })

  it('maps a team the mount leaves out to nothing', async () => {
    const { hook } = fake(['t2'])
    expect(await map(hook, 'Issue', { action: 'create', data: issue() })).toEqual([])
    expect(await map(hook, 'Project', { action: 'create', data: {} })).toEqual([])
  })

  it('forgets an issue moved to a team the mount leaves out', async () => {
    const { hook, calls } = fake(['t1'])
    await map(hook, 'Issue', { action: 'create', data: issue() })
    const moved = {
      action: 'update',
      data: { id: 'i1', teamId: 't2', team: OPS },
      updatedFrom: { teamId: 't1' },
    }
    expect(await map(hook, 'Issue', moved)).toEqual([[X, `${ENG_DIR}/issues`]])
    const comment = { action: 'create', data: { id: 'c1', issueId: 'i1' } }
    expect(await map(hook, 'Comment', comment)).toEqual([])
    expect(calls).toEqual(['issue i1'])
  })
})
