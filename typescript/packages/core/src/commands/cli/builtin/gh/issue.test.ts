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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AccessorModule from './accessor.ts'
import type * as IssueModule from '../../../../core/github/issue.ts'
import type { CLIInvocation } from '../../types.ts'
import { PathSpec } from '../../../../types.ts'

const FIELDS = vi.fn<typeof IssueModule.issueFields>()
const LIST = vi.fn<typeof IssueModule.listIssueFields>()

vi.mock('./accessor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AccessorModule>()
  return { ...actual, ghTransport: () => ({}) }
})

vi.mock('../../../../core/github/issue.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof IssueModule>()
  return {
    ...actual,
    issueFields: (...args: Parameters<typeof IssueModule.issueFields>) => FIELDS(...args),
    listIssueFields: (...args: Parameters<typeof IssueModule.listIssueFields>) => LIST(...args),
  }
})

const { ISSUE_FIELDS, listCmd, viewCmd } = await import('./issue.ts')

function inv(flags: CLIInvocation['flags'] = {}): CLIInvocation {
  return {
    config: { token: 't' },
    argv: [],
    paths: [],
    texts: ['4'],
    flags: { repo: 'o/r', ...flags },
    stdin: null,
    cwd: PathSpec.fromStrPath('/'),
    env: {},
  }
}

function json(result: Awaited<ReturnType<typeof viewCmd>>): unknown {
  if (result === null) throw new Error('expected a result tuple')
  return JSON.parse(new TextDecoder().decode(result[0] as Uint8Array)) as unknown
}

// Every field `gh issue view --json` and `gh issue list --json` accept in gh 2.85.
const GH_FIELDS = [
  'assignees',
  'author',
  'body',
  'closed',
  'closedAt',
  'closedByPullRequestsReferences',
  'comments',
  'createdAt',
  'id',
  'isPinned',
  'labels',
  'milestone',
  'number',
  'projectCards',
  'projectItems',
  'reactionGroups',
  'state',
  'stateReason',
  'title',
  'updatedAt',
  'url',
]

describe('gh issue view --json', () => {
  beforeEach(() => {
    FIELDS.mockReset()
    LIST.mockReset()
  })

  it('offers every field gh 2.85 does', () => {
    expect([...ISSUE_FIELDS].sort()).toEqual(GH_FIELDS)
  })

  it('asks for the number as an issue or a pull request, without issue-only fields for one', async () => {
    FIELDS.mockResolvedValueOnce({ __typename: 'Issue', title: 'bug', isPinned: true, id: 'I_1' })
    expect(json(await viewCmd(inv({ json: 'title,isPinned' })))).toEqual({
      isPinned: true,
      title: 'bug',
    })
    expect(FIELDS.mock.calls[0]?.[3]).toEqual({ issue: 'title,isPinned,id', pull: 'title,id' })
  })

  it('prints a pull request with the fields only an issue has at their zero', async () => {
    FIELDS.mockResolvedValueOnce({ __typename: 'PullRequest', title: 'docs', id: 'PR_1' })
    expect(
      json(
        await viewCmd(inv({ json: 'title,isPinned,stateReason,closedByPullRequestsReferences' })),
      ),
    ).toEqual({
      closedByPullRequestsReferences: [],
      isPinned: false,
      stateReason: '',
      title: 'docs',
    })
  })

  it('pages comments through the half the number turned out to be', async () => {
    const page = (body: string, next: string | null) => ({
      __typename: 'PullRequest',
      comments: {
        nodes: [{ body }],
        pageInfo: { hasNextPage: next !== null, endCursor: next },
      },
    })
    FIELDS.mockResolvedValueOnce(page('first', 'c1')).mockResolvedValueOnce(page('second', null))
    const out = json(await viewCmd(inv({ json: 'comments' }))) as { comments: { body: string }[] }
    expect(out.comments.map((comment) => comment.body)).toEqual(['first', 'second'])
    const selections = FIELDS.mock.calls[1]?.[3]
    expect(selections?.issue).toBe('')
    expect(selections?.pull).toContain('comments(first: 100, after: $endCursor)')
    expect(FIELDS.mock.calls[1]?.[4]).toBe('c1')
  })

  it('adds the number and reads project items apart', async () => {
    FIELDS.mockResolvedValueOnce({
      __typename: 'Issue',
      id: 'I_1',
      number: 4,
    }).mockResolvedValueOnce({
      __typename: 'Issue',
      projectItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    })
    expect(json(await viewCmd(inv({ json: 'projectItems' })))).toEqual({ projectItems: [] })
    expect(FIELDS.mock.calls[0]?.[3]).toEqual({ issue: 'id,number', pull: 'id,number' })
    expect(FIELDS.mock.calls[1]?.[3].issue).toMatch(/^projectItems\(first: 100\)/)
  })
})

describe('gh issue list --json', () => {
  beforeEach(() => {
    LIST.mockReset()
  })

  it('lists over GraphQL with the states and narrowing gh sends', async () => {
    LIST.mockResolvedValueOnce([{ number: 3, stateReason: 'COMPLETED' }])
    const out = json(
      await listCmd(
        inv({ json: 'number,stateReason', state: 'all', author: 'me', label: ['bug'] }),
      ),
    )
    expect(out).toEqual([{ number: 3, stateReason: 'COMPLETED' }])
    expect(LIST.mock.calls[0]?.[2]).toEqual({
      states: ['OPEN', 'CLOSED'],
      assignee: undefined,
      author: 'me',
      labels: ['bug'],
    })
    expect(LIST.mock.calls[0]?.[3]).toBe(30)
    expect(LIST.mock.calls[0]?.[4]).toBe('number,stateReason')
  })
})
