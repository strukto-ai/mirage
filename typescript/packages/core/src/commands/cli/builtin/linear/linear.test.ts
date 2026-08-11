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

import { describe, expect, it, vi } from 'vitest'
import type * as UtilModule from './util.ts'
import type { LinearTransport } from '../../../../core/linear/_client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { LINEAR } from './index.ts'
import { addLabel } from './issue/add_label.ts'
import { create } from './issue/create.ts'
import { setProject } from './issue/set_project.ts'
import * as reads from './reads.ts'

const DEC = new TextDecoder()

const GRAPHQL: { query: string; variables: Record<string, unknown> }[] = []
let RESPONDER: (
  query: string,
  variables: Record<string, unknown>,
) => Record<string, unknown> = () => ({})

class FakeTransport implements LinearTransport {
  graphql(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    GRAPHQL.push({ query, variables })
    return Promise.resolve(RESPONDER(query, variables))
  }
}

vi.mock('./util.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return { ...actual, linearTransport: () => new FakeTransport() }
})

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('expected a result tuple')
  return result
}

function makeInv(config: unknown, flags: CLIInvocation['flags']): CLIInvocation {
  return { config, argv: [], paths: [], texts: [], flags, stdin: null, env: {} }
}

function leaf(...path: string[]) {
  let node = LINEAR
  for (const name of path) {
    const child = node.subcommands.find((c) => c.name === name)
    if (child === undefined) throw new Error(`no subcommand ${name}`)
    node = child
  }
  return node
}

const TEAM = { id: 'team-1', key: 'ENG', name: 'Engineering', states: { nodes: [] } }
const NO_MORE = { hasNextPage: false, endCursor: null }

describe('linear tree', () => {
  it('keeps the mount grammar and registers itself', () => {
    expect(LINEAR.subcommands.map((g) => g.name)).toEqual([
      'team',
      'issue',
      'project',
      'cycle',
      'label',
      'comment',
      'user',
      'document',
      'search',
    ])
    expect(leaf('issue').subcommands.map((v) => v.name)).toEqual([
      'list',
      'get',
      'create',
      'update',
      'assign',
      'transition',
      'set-priority',
      'set-project',
      'add-label',
    ])
    expect(cliSpecFor('linear')).toBe(LINEAR)
  })

  it('classifies writers and keeps issue operands positional', () => {
    for (const verb of [
      'create',
      'update',
      'assign',
      'transition',
      'set-priority',
      'set-project',
      'add-label',
    ]) {
      expect(leaf('issue', verb).write).toBe(true)
    }
    expect(leaf('issue', 'get').write).toBe(false)
    expect(leaf('issue', 'get').rest).not.toBeNull()
    expect(leaf('issue', 'list').rest).toBeNull()
  })
})

describe('linear verbs', () => {
  it('team list filters by config.teamIds', async () => {
    GRAPHQL.length = 0
    RESPONDER = () => ({
      teams: { nodes: [TEAM, { id: 'team-2', key: 'OPS' }], pageInfo: NO_MORE },
    })
    const [out] = unwrap(await reads.teamList(makeInv({ apiKey: 'k', teamIds: ['team-2'] }, {})))
    const rows = JSON.parse(DEC.decode(out as Uint8Array)) as { team_id: string }[]
    expect(rows.map((r) => r.team_id)).toEqual(['team-2'])
  })

  it('issue create resolves the team and reads stdin for the description', async () => {
    GRAPHQL.length = 0
    RESPONDER = (query) => {
      if (query.includes('issueCreate')) return { issueCreate: { issue: { id: 'i-1' } } }
      if (query.includes('teams')) return { teams: { nodes: [TEAM], pageInfo: NO_MORE } }
      return { issue: { id: 'i-1', identifier: 'ENG-9', title: 'Title' } }
    }
    const inv: CLIInvocation = {
      ...makeInv({ apiKey: 'k' }, { team: 'ENG', title: 'Title' }),
      stdin: new TextEncoder().encode('body from stdin'),
    }
    const [out] = unwrap(await create(inv))
    const created = GRAPHQL.find((c) => c.query.includes('issueCreate'))
    expect(created?.variables).toEqual({
      input: { title: 'Title', teamId: 'team-1', description: 'body from stdin' },
    })
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toMatchObject({ issue_key: 'ENG-9' })
  })

  it('add-label resolves a label name on the issue team', async () => {
    GRAPHQL.length = 0
    RESPONDER = (query) => {
      if (query.includes('issueUpdate')) return { issueUpdate: { success: true } }
      if (query.includes('IssueLookup')) return { issues: { nodes: [{ id: 'i-1' }] } }
      if (query.includes('TeamLabels')) {
        return {
          team: { labels: { nodes: [{ id: 'lbl-bug', name: 'bug' }], pageInfo: NO_MORE } },
        }
      }
      return {
        issue: {
          id: 'i-1',
          identifier: 'ENG-42',
          team: { id: 'team-1' },
          labels: { nodes: [{ id: 'lbl-old' }] },
        },
      }
    }
    await addLabel({ ...makeInv({ apiKey: 'k' }, { label_name: 'bug' }), texts: ['ENG-42'] })
    const update = GRAPHQL.find((c) => c.query.includes('issueUpdate'))
    expect(update?.variables).toEqual({
      id: 'i-1',
      input: { labelIds: ['lbl-old', 'lbl-bug'] },
    })
    const labelsCall = GRAPHQL.find((c) => c.query.includes('TeamLabels'))
    expect(labelsCall?.variables).toMatchObject({ teamId: 'team-1' })
  })

  it('set-project resolves a project name on the issue team', async () => {
    GRAPHQL.length = 0
    RESPONDER = (query) => {
      if (query.includes('issueUpdate')) return { issueUpdate: { success: true } }
      if (query.includes('IssueLookup')) return { issues: { nodes: [{ id: 'i-1' }] } }
      if (query.includes('TeamProjects')) {
        return {
          team: {
            projects: { nodes: [{ id: 'prj-search', name: 'Search' }], pageInfo: NO_MORE },
          },
        }
      }
      return { issue: { id: 'i-1', identifier: 'ENG-42', team: { id: 'team-1' } } }
    }
    await setProject({ ...makeInv({ apiKey: 'k' }, { project_name: 'Search' }), texts: ['ENG-42'] })
    const update = GRAPHQL.find((c) => c.query.includes('issueUpdate'))
    expect(update?.variables).toEqual({
      id: 'i-1',
      input: { projectId: 'prj-search' },
    })
  })

  it('search takes the flag or the operand', async () => {
    GRAPHQL.length = 0
    RESPONDER = () => ({ searchIssues: { nodes: [{ identifier: 'ENG-1' }] } })
    await reads.search({ ...makeInv({ apiKey: 'k' }, {}), texts: ['login bug'] })
    await reads.search(makeInv({ apiKey: 'k' }, { query: 'crash' }))
    expect(GRAPHQL[0]?.variables).toMatchObject({ term: 'login bug' })
    expect(GRAPHQL[1]?.variables).toMatchObject({ term: 'crash' })
    await expect(reads.search(makeInv({ apiKey: 'k' }, {}))).rejects.toThrow(
      'a search query is required',
    )
  })
})
