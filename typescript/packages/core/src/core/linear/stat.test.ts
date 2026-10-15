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
import type { FileStat } from '../../types.ts'
import { ContentType, FileType, PathSpec } from '../../types.ts'
import { LinearVFS } from '../../vfs/linear/linear.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { LinearTransport } from './client.ts'
import { normalizeIssue, normalizeTeam, toJsonBytes } from './normalize.ts'
import { Slot } from '../hierarchy/scope.ts'
import { detectScope } from './scope.ts'
import { stat } from './stat.ts'

class NoopTransport implements LinearTransport {
  graphql(): Promise<Record<string, unknown>> {
    throw new Error('should not be called')
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: mountKey(virtual, prefix) })
}

describe('linear stat', () => {
  it('stats the root and teams without a call', async () => {
    const accessor = new LinearAccessor(new NoopTransport())
    expect((await stat(accessor, spec('/'))).type).toBe(FileType.DIRECTORY)
    expect((await stat(accessor, spec('/teams'))).type).toBe(FileType.DIRECTORY)
  })

  it('is ENOENT for a path no shape names', async () => {
    const accessor = new LinearAccessor(new NoopTransport())
    await expect(stat(accessor, spec('/nonexistent/path'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
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
      return Promise.resolve({ documents: connection(DOCUMENTS) })
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

const ISSUE_DIR = '/teams/ENG__Engineering__TEAM1/issues/ENG-1__ISSUE1'

function mounted(accessor: LinearAccessor): Workspace {
  const vfs = Object.assign(new LinearVFS({ apiKey: 'lin_api_test' }), { accessor })
  return new Workspace({ '/linear/': vfs })
}

async function statAt(accessor: LinearAccessor, path: string): Promise<FileStat> {
  return (await mounted(accessor).dispatch('stat', '/linear' + path)) as FileStat
}

// Every node below the mount, keyed by its path below it.
async function walkNodes(ws: Workspace): Promise<[string, FileStat][]> {
  const stack = ['/linear']
  const nodes: [string, FileStat][] = []
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    for (const child of (await ws.dispatch('readdir', current)) as string[]) {
      const s = (await ws.dispatch('stat', child)) as FileStat
      if (s.type === FileType.DIRECTORY) stack.push(child)
      nodes.push([child.slice('/linear'.length), s])
    }
  }
  return nodes
}

describe('linear stat of a listed row', () => {
  it('answers a team with its id and time', async () => {
    const s = await statAt(
      new LinearAccessor(new FixtureTransport()),
      '/teams/ENG__Engineering__TEAM1',
    )
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.extra.team_id).toBe('TEAM1')
    expect(s.modified).toBe('2026-04-05T00:00:00Z')
  })

  it('answers an issue directory with its id and time', async () => {
    const s = await statAt(new LinearAccessor(new FixtureTransport()), ISSUE_DIR)
    expect(s.type).toBe(FileType.DIRECTORY)
    expect(s.extra.issue_id).toBe('ISSUE1')
    expect(s.modified).toBe('2026-04-03T00:00:00Z')
  })

  it('reports the rendered size of issue.json', async () => {
    const s = await statAt(new LinearAccessor(new FixtureTransport()), ISSUE_DIR + '/issue.json')
    expect(s.content).toBe(ContentType.JSON)
    expect(s.size).toBe(toJsonBytes(normalizeIssue(ISSUES[0] ?? {})).length)
    expect(s.modified).toBe('2026-04-03T00:00:00Z')
    expect(s.extra.issue_id).toBe('ISSUE1')
  })

  it('times comments.jsonl by its newest comment', async () => {
    const s = await statAt(
      new LinearAccessor(new FixtureTransport()),
      ISSUE_DIR + '/comments.jsonl',
    )
    expect(s.content).toBe(ContentType.TEXT)
    expect(s.modified).toBe('2026-04-03T12:00:00Z')
  })

  it('reports the rendered size of team.json', async () => {
    // The team-dir listing computes team.json's size from the team object
    // the find already fetched, so stat answers the rendered byte length.
    const s = await statAt(
      new LinearAccessor(new FixtureTransport()),
      '/teams/ENG__Engineering__TEAM1/team.json',
    )
    expect(s.content).toBe(ContentType.JSON)
    expect(s.size).toBe(toJsonBytes(normalizeTeam(TEAM)).length)
    expect(s.modified).toBe('2026-04-05T00:00:00Z')
    expect(s.extra.team_id).toBe('TEAM1')
  })
})

describe('linear size push-down', () => {
  it('stat size equals the read byte length for every file in the tree', async () => {
    // The fskit invariant: whatever size stat reports at lookup must equal
    // the byte length a read delivers, for every file in the tree.
    const transport = new FixtureTransport()
    const ws = mounted(new LinearAccessor(transport))
    const files = (await walkNodes(ws)).filter(([, s]) => s.type !== FileType.DIRECTORY)
    expect(files.length).toBe(9)
    // Sizing never refetches an issue: the issues listing already carries the
    // payloads, so walking the whole tree costs no per-file issue fetch.
    expect(transport.issueFetches).toBe(0)
    for (const [child, s] of files) {
      const body = (await ws.dispatch('read', '/linear' + child)) as Uint8Array
      expect(s.size, child).toBe(body.length)
    }
  })
})

// Mirrors python's test_stat_extra_names_the_id_the_path_carries: every
// id-addressed node's stat carries its id under the key its path slot names
// (team_id, member_id, issue_id, ...). The member kind wrote `user_id` while
// its slot and trello's member say `member_id`.
describe('linear stat extra', () => {
  it('names the id the path carries', async () => {
    const nodes = await walkNodes(mounted(new LinearAccessor(new FixtureTransport())))
    expect(nodes.some(([path]) => path.includes('/members/'))).toBe(true)
    for (const [path, s] of nodes) {
      const match = detectScope(spec(path))
      const segments = match.scope?.segments ?? []
      const last = segments[segments.length - 1]
      if (typeof last === 'string' && s.type === FileType.DIRECTORY) continue
      const idKeys = segments.flatMap((seg) =>
        seg instanceof Slot && seg.idKey !== null ? [seg.idKey] : [],
      )
      const idKey = idKeys[idKeys.length - 1] ?? ''
      expect(s.extra[idKey], path).toBe(match.slots[idKey])
    }
  })
})
