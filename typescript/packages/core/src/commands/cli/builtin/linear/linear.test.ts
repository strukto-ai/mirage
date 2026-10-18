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

import { compileSpec } from '../../../spec/compile.ts'
import { describe, expect, it } from 'vitest'
import { LinearAccessor } from '../../../../accessor/linear.ts'
import type { LinearTransport } from '../../../../core/linear/client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import { LINEAR } from './index.ts'
import { addLabel } from './issue/add_label.ts'
import { create } from './issue/create.ts'
import { setProject } from './issue/set_project.ts'
import * as reads from './reads.ts'
import { context } from '../../../../../tests/workspace/fixtures/context.ts'

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

const ACCESSOR = new LinearAccessor(new FakeTransport())

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('expected a result tuple')
  return result
}

function leaf(...path: string[]) {
  let node = LINEAR.spec
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
    expect(LINEAR.spec.subcommands.map((g) => g.name)).toEqual([
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
      expect(LINEAR.handlers[['issue', verb].join(' ')]?.write).toBe(true)
    }
    expect(LINEAR.handlers[['issue', 'get'].join(' ')]?.write).toBe(false)
    expect(compileSpec(leaf('issue', 'get')).rest).not.toBeNull()
    expect(compileSpec(leaf('issue', 'list')).rest).toBeNull()
  })
})

describe('linear verbs', () => {
  it('team list filters by the accessor teamIds', async () => {
    GRAPHQL.length = 0
    RESPONDER = () => ({
      teams: { nodes: [TEAM, { id: 'team-2', key: 'OPS' }], pageInfo: NO_MORE },
    })
    const scoped = new LinearAccessor(new FakeTransport(), { teamIds: ['team-2'] })
    const [out] = unwrap(await reads.teamList(scoped, [], [], context()))
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
    const [out] = unwrap(
      await create(
        ACCESSOR,
        [],
        [],
        context({
          flags: { team: 'ENG', title: 'Title' },
          stdin: new TextEncoder().encode('body from stdin'),
        }),
      ),
    )
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
    await addLabel(ACCESSOR, [], ['ENG-42'], context({ flags: { label_name: 'bug' } }))
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
    await setProject(ACCESSOR, [], ['ENG-42'], context({ flags: { project_name: 'Search' } }))
    const update = GRAPHQL.find((c) => c.query.includes('issueUpdate'))
    expect(update?.variables).toEqual({
      id: 'i-1',
      input: { projectId: 'prj-search' },
    })
  })

  it('search takes the flag or the operand', async () => {
    GRAPHQL.length = 0
    RESPONDER = () => ({ searchIssues: { nodes: [{ id: 'i-1', identifier: 'ENG-1' }] } })
    await reads.search(ACCESSOR, [], ['login bug'], context())
    await reads.search(ACCESSOR, [], [], context({ flags: { query: 'crash' } }))
    expect(GRAPHQL[0]?.variables).toMatchObject({ term: 'login bug' })
    expect(GRAPHQL[1]?.variables).toMatchObject({ term: 'crash' })
    await expect(reads.search(ACCESSOR, [], [], context())).rejects.toThrow(
      'a search query is required',
    )
  })
})
