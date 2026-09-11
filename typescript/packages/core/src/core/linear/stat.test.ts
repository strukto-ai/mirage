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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { LinearAccessor } from '../../accessor/linear.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { FileStat } from '../../types.ts'
import { ContentType, FileType, PathSpec } from '../../types.ts'
import type { LinearTransport } from './client.ts'
import { read } from './read.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

class NoopTransport implements LinearTransport {
  graphql(): Promise<Record<string, unknown>> {
    throw new Error('should not be called')
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('linear stat modified', () => {
  it('returns modified from the cached team entry', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.put(
      '/teams/ENG__Engineering__TEAM1',
      new IndexEntry({
        id: 'TEAM1',
        name: 'Engineering',
        resourceType: 'linear/team',
        remoteTime: '2026-04-05T00:00:00Z',
        vfsName: 'ENG__Engineering__TEAM1',
      }),
    )
    const s = await stat(
      new LinearAccessor(new NoopTransport()),
      spec('/teams/ENG__Engineering__TEAM1'),
      idx,
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.extra.team_id).toBe('TEAM1')
    expect(s.modified).toBe('2026-04-05T00:00:00Z')
  })

  it('reports the pushed-down size for a cached issue.json entry', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.put(
      '/teams/ENG__Engineering__TEAM1/issues/ENG-1__ISSUE1/issue.json',
      new IndexEntry({
        id: 'ISSUE1',
        name: 'issue.json',
        resourceType: 'linear/issue_json',
        remoteTime: '2026-04-05T00:00:00Z',
        vfsName: 'issue.json',
        size: 321,
      }),
    )
    const s = await stat(
      new LinearAccessor(new NoopTransport()),
      spec('/teams/ENG__Engineering__TEAM1/issues/ENG-1__ISSUE1/issue.json'),
      idx,
    )
    expect(s.content).toBe(ContentType.JSON)
    expect(s.size).toBe(321)
    expect(s.modified).toBe('2026-04-05T00:00:00Z')
    expect(s.extra.issue_id).toBe('ISSUE1')
  })
})

const TEAM = {
  id: 'TEAM1',
  key: 'ENG',
  name: 'Engineering',
  description: 'Builds the thing',
  timezone: 'UTC',
  updatedAt: '2026-04-05T00:00:00Z',
  states: { nodes: [{ id: 'ST1', name: 'Todo', type: 'unstarted' }] },
}

const USERS = [
  {
    id: 'USER1',
    name: 'Alice',
    displayName: 'Alice',
    email: 'alice@example.com',
    active: true,
    admin: false,
    url: 'https://linear.app/u/alice',
    updatedAt: '2026-04-01T00:00:00Z',
  },
]

const ISSUES = [
  {
    id: 'ISSUE1',
    identifier: 'ENG-1',
    title: 'Fix the naïve cache ✨',
    description: 'size-unknown files read as empty',
    priority: 2,
    url: 'https://linear.app/i/ENG-1',
    createdAt: '2026-04-02T00:00:00Z',
    updatedAt: '2026-04-03T00:00:00Z',
    team: { id: 'TEAM1', key: 'ENG', name: 'Engineering' },
    state: { id: 'ST1', name: 'Todo' },
    project: { id: 'PROJ1', name: 'Mount' },
    cycle: { id: 'CYC1', name: 'Cycle 1', number: 1 },
    assignee: { id: 'USER1', name: 'Alice', email: 'alice@example.com' },
    creator: null,
    labels: { nodes: [{ id: 'L1', name: 'bug' }] },
  },
  {
    id: 'ISSUE2',
    identifier: 'ENG-2',
    title: 'Second issue',
    description: '',
    priority: 0,
    url: 'https://linear.app/i/ENG-2',
    createdAt: '2026-04-02T00:00:00Z',
    updatedAt: '2026-04-04T00:00:00Z',
    team: { id: 'TEAM1', key: 'ENG', name: 'Engineering' },
    state: { id: 'ST1', name: 'Todo' },
    project: null,
    cycle: null,
    assignee: null,
    creator: null,
    labels: { nodes: [] },
  },
]

const COMMENTS: Record<string, Record<string, unknown>[]> = {
  ISSUE1: [
    {
      id: 'CMT1',
      body: 'résumé attached',
      url: 'https://linear.app/c/1',
      createdAt: '2026-04-03T00:00:00Z',
      updatedAt: '2026-04-03T12:00:00Z',
      user: { id: 'USER1', name: 'Alice', displayName: 'Alice', email: 'alice@example.com' },
    },
  ],
}

const PROJECTS = [
  {
    id: 'PROJ1',
    name: 'Mount',
    description: 'Mount everything',
    status: { type: 'started' },
    url: 'https://linear.app/p/mount',
    updatedAt: '2026-04-04T00:00:00Z',
    lead: { id: 'USER1' },
  },
]

const CYCLES = [
  {
    id: 'CYC1',
    name: 'Cycle 1',
    number: 1,
    startsAt: '2026-04-01T00:00:00Z',
    endsAt: '2026-04-14T00:00:00Z',
    updatedAt: '2026-04-04T00:00:00Z',
  },
]

const DOCUMENTS = [
  {
    id: 'DOC1',
    title: 'Spec',
    content: 'unicode body ✓',
    url: 'https://linear.app/d/spec',
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-02T00:00:00Z',
    project: { id: 'PROJ1', name: 'Mount' },
    creator: { id: 'USER1', name: 'Alice', email: 'alice@example.com' },
  },
]

function connection(nodes: unknown[]): Record<string, unknown> {
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null } }
}

class FixtureTransport implements LinearTransport {
  issueFetches = 0

  graphql(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const match = /(?:query|mutation)\s+(\w+)/.exec(query)
    const op = match?.[1] ?? ''
    if (op === 'Teams') return Promise.resolve({ teams: connection([TEAM]) })
    if (op === 'TeamMembers') return Promise.resolve({ team: { members: connection(USERS) } })
    if (op === 'TeamIssues') return Promise.resolve({ team: { issues: connection(ISSUES) } })
    if (op === 'TeamProjects') return Promise.resolve({ team: { projects: connection(PROJECTS) } })
    if (op === 'TeamCycles') return Promise.resolve({ team: { cycles: connection(CYCLES) } })
    if (op === 'TeamDocuments') {
      return Promise.resolve({ team: { documents: connection(DOCUMENTS) } })
    }
    if (op === 'Issue') {
      this.issueFetches += 1
      const issue = ISSUES.find((i) => i.id === variables?.issueId)
      return Promise.resolve({ issue: issue ?? null })
    }
    if (op === 'IssueComments') {
      const issueId = typeof variables?.issueId === 'string' ? variables.issueId : ''
      return Promise.resolve({ issue: { comments: connection(COMMENTS[issueId] ?? []) } })
    }
    throw new Error(`unexpected operation: ${op}`)
  }
}

describe('linear size push-down', () => {
  it('stat size equals the read byte length for every file in the tree', async () => {
    // The fskit invariant: whatever size stat reports at lookup must equal
    // the byte length a read delivers, for every file in the tree.
    const transport = new FixtureTransport()
    const accessor = new LinearAccessor(transport)
    const idx = new RAMIndexCacheStore()
    const stack = ['/']
    const files: [string, FileStat][] = []
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined) break
      const listing = await readdir(accessor, spec(current), idx)
      for (const child of listing) {
        const s = await stat(accessor, spec(child), idx)
        if (s.type === FileType.DIRECTORY) stack.push(child)
        else files.push([child, s])
      }
    }
    expect(files.length).toBe(9)
    // Sizing never refetches an issue: the issues listing already carries the
    // payloads, so walking the whole tree costs no per-file issue fetch.
    expect(transport.issueFetches).toBe(0)
    for (const [child, s] of files) {
      const body = await read(accessor, spec(child), idx)
      expect(s.size, child).toBe(body.length)
    }
  })
})
