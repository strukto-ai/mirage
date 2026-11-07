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
import { GitHubAccount } from '../../../../accessor/github.ts'
import type * as IssueModule from '../../../../core/github/issue.ts'
import type { Context } from '../../../config.ts'
import type { PathSpec } from '../../../../types.ts'
import { context } from '../../../../../tests/workspace/fixtures/context.ts'

const FIELDS = vi.fn<typeof IssueModule.issueFields>()
const CALLS: unknown[][] = []
let REOPEN_ROW: Record<string, unknown> = {}
const FAILING = new Set<number>()
const url = (number: number) => `https://github.com/o/r/issues/${String(number)}`
const LIST = vi.fn<typeof IssueModule.listIssueFields>()

vi.mock('../../../../core/github/issue.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof IssueModule>()
  return {
    ...actual,
    getIssue: (_t: unknown, _r: unknown, number: number) => {
      CALLS.push(['get', number])
      return Promise.resolve({ number, title: 't', url: url(number), ...REOPEN_ROW })
    },
    commentIssue: (_t: unknown, _r: unknown, number: number, body: string) => {
      CALLS.push(['comment', number, body])
      return Promise.resolve({})
    },
    editIssue: (_t: unknown, _r: unknown, number: number, body: unknown) => {
      CALLS.push(['edit', number, body])
      if (FAILING.has(number)) return Promise.reject(new Error('Validation Failed (HTTP 422)'))
      return Promise.resolve({ url: url(number) })
    },
    issueFields: (...args: Parameters<typeof IssueModule.issueFields>) => FIELDS(...args),
    listIssueFields: (...args: Parameters<typeof IssueModule.listIssueFields>) => LIST(...args),
  }
})

const { ISSUE_FIELDS, editCmd, listCmd, reopenCmd, viewCmd } = await import('./issue.ts')

const ACCOUNT = new GitHubAccount({ token: 't' })

function args(flags: Context['flags'] = {}): [GitHubAccount, PathSpec[], string[], Context] {
  return [ACCOUNT, [], ['4'], context({ flags: { repo: 'o/r', ...flags } })]
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
    expect(json(await viewCmd(...args({ json: 'title,isPinned' })))).toEqual({
      isPinned: true,
      title: 'bug',
    })
    expect(FIELDS.mock.calls[0]?.[3]).toEqual({ issue: 'title,isPinned,id', pull: 'title,id' })
  })

  it('prints a pull request with the fields only an issue has at their zero', async () => {
    FIELDS.mockResolvedValueOnce({ __typename: 'PullRequest', title: 'docs', id: 'PR_1' })
    expect(
      json(
        await viewCmd(
          ...args({ json: 'title,isPinned,stateReason,closedByPullRequestsReferences' }),
        ),
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
    const out = json(await viewCmd(...args({ json: 'comments' }))) as {
      comments: { body: string }[]
    }
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
    expect(json(await viewCmd(...args({ json: 'projectItems' })))).toEqual({ projectItems: [] })
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
        ...args({ json: 'number,stateReason', state: 'all', author: 'me', label: ['bug'] }),
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

function decode(bytes: unknown): string {
  return new TextDecoder().decode(bytes as Uint8Array)
}

describe('gh issue reopen', () => {
  beforeEach(() => {
    CALLS.length = 0
  })

  it('comments before it reopens', async () => {
    REOPEN_ROW = { state: 'closed', merged: false }
    const result = await reopenCmd(...args({ comment: 'back' }))
    if (result === null) throw new Error('expected a result tuple')
    expect(decode(result[0])).toBe('✓ Reopened issue o/r#4 (t)\n')
    expect(result[1].exitCode).toBe(0)
    expect(CALLS).toEqual([
      ['get', 4],
      ['comment', 4, 'back'],
      ['edit', 4, { state: 'open' }],
    ])
  })

  it('leaves an open issue alone', async () => {
    REOPEN_ROW = { state: 'open', merged: false }
    const result = await reopenCmd(...args({ comment: 'back' }))
    if (result === null) throw new Error('expected a result tuple')
    expect(result[1].exitCode).toBe(0)
    expect(decode(result[1].stderr)).toBe('! Issue o/r#4 (t) is already open\n')
    expect(CALLS).toEqual([['get', 4]])
  })

  it('posts no comment for an empty one', async () => {
    REOPEN_ROW = { state: 'closed' }
    await reopenCmd(...args({ comment: '' }))
    expect(CALLS).toEqual([
      ['get', 4],
      ['edit', 4, { state: 'open' }],
    ])
  })
})

describe('gh issue selectors', () => {
  const at = (texts: string[], flags: Context['flags'] = {}) =>
    [ACCOUNT, [], texts, context({ flags })] as [GitHubAccount, PathSpec[], string[], Context]

  beforeEach(() => {
    CALLS.length = 0
    REOPEN_ROW = {}
    FAILING.clear()
  })

  // cobra's counts: exactly one issue for each verb but edit, which takes
  // at least one.
  it('refuses any count but one, and edit none, as gh does', async () => {
    await expect(viewCmd(...at([], { repo: 'o/r' }))).rejects.toThrow(
      'accepts 1 arg(s), received 0',
    )
    await expect(viewCmd(...at(['1', '2'], { repo: 'o/r' }))).rejects.toThrow(
      'accepts 1 arg(s), received 2',
    )
    await expect(editCmd(...at([], { repo: 'o/r', title: 't' }))).rejects.toThrow(
      'requires at least 1 arg(s), only received 0',
    )
    expect(CALLS).toEqual([])
  })

  it('refuses an edit with no field before it reads anything', async () => {
    await expect(editCmd(...at(['4'], { repo: 'o/r' }))).rejects.toThrow(
      'field to edit flag required when not running interactively',
    )
    expect(CALLS).toEqual([])
  })

  it('edits every issue named, reading each first, and prints their URLs in order', async () => {
    const result = await editCmd(...at(['5', '#4'], { repo: 'o/r', add_label: ['bug'] }))
    if (result === null) throw new Error('expected a result tuple')
    expect(new TextDecoder().decode(result[0] as Uint8Array)).toBe(`${url(4)}\n${url(5)}\n`)
    expect(CALLS).toEqual([
      ['get', 5],
      ['get', 4],
      ['edit', 5, { labels: ['bug'] }],
      ['edit', 4, { labels: ['bug'] }],
    ])
  })

  it('names each issue it could not edit, and the count, as gh does', async () => {
    FAILING.add(5)
    const result = await editCmd(...at(['5', '4'], { repo: 'o/r', title: 'x' }))
    if (result === null) throw new Error('expected a result tuple')
    expect(new TextDecoder().decode(result[0] as Uint8Array)).toBe(`${url(4)}\n`)
    expect(result[1].exitCode).toBe(1)
    expect(new TextDecoder().decode(result[1].stderr as Uint8Array)).toBe(
      `failed to update ${url(5)}: Validation Failed (HTTP 422)\ngh issue edit: failed to update 1 issue\n`,
    )
  })

  it('puts every issue in the repository a URL names, and refuses two', async () => {
    await editCmd(...at(['1', 'https://github.com/a/b/issues/2'], { title: 'x' }))
    expect(CALLS.slice(0, 2)).toEqual([
      ['get', 1],
      ['get', 2],
    ])
    await expect(
      editCmd(
        ...at(['https://github.com/a/b/issues/1', 'https://github.com/c/d/issues/2'], {
          title: 'x',
        }),
      ),
    ).rejects.toThrow('multiple issues must be in same repo: found "c/d", expected "a/b"')
  })
})
