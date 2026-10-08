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
import type * as PullModule from '../../../../core/github/pull.ts'
import type { CLIInvocation } from '../../types.ts'
import { PathSpec } from '../../../../types.ts'

let ROWS: Record<string, unknown>[] = []
// What real gh 2.85 printed for `gh pr diff --name-only` over this diff: the
// `b/` side of each header, a quoted name kept quoted, a rename by its new name.
const NAME_ONLY_DIFF =
  'diff --git a/README.md b/README.md\n' +
  'deleted file mode 100644\n' +
  '--- a/README.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n' +
  'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n' +
  'new file mode 100644\n' +
  'diff --git a/docs/contributing.md b/moved/contributing.md\n' +
  'similarity index 100%\n' +
  'diff --git "a/q\\"t.txt" "b/q\\"t.txt"\n' +
  'diff --git a/sub dir/x y.txt b/sub dir/x y.txt\n' +
  '+++ b/sub dir/x y.txt\t\n'
const FIELDS = vi.fn<typeof PullModule.pullRequestFields>()
const LIST = vi.fn<typeof PullModule.listPullRequestFields>()

vi.mock('./accessor.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AccessorModule>()
  return { ...actual, ghTransport: () => ({}) }
})

vi.mock('../../../../core/github/pull.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof PullModule>()
  return {
    ...actual,
    diffPull: () => Promise.resolve(NAME_ONLY_DIFF),
    pullChecks: () => Promise.resolve(ROWS),
    pullRequestFields: (...args: Parameters<typeof PullModule.pullRequestFields>) =>
      FIELDS(...args),
    listPullRequestFields: (...args: Parameters<typeof PullModule.listPullRequestFields>) =>
      LIST(...args),
  }
})

const { PR_FIELDS, checksCmd, diffCmd, listCmd, viewCmd } = await import('./pull.ts')

function json(result: Awaited<ReturnType<typeof viewCmd>>): Record<string, unknown> {
  if (result === null) throw new Error('expected a result tuple')
  return JSON.parse(new TextDecoder().decode(result[0] as Uint8Array)) as Record<string, unknown>
}

function inv(flags: CLIInvocation['flags'] = {}): CLIInvocation {
  return {
    config: { token: 't' },
    argv: [],
    paths: [],
    texts: ['5'],
    flags: { repo: 'o/r', ...flags },
    stdin: null,
    cwd: PathSpec.fromStrPath('/'),
    env: {},
  }
}

async function bucketOf(row: Record<string, unknown>): Promise<unknown> {
  ROWS = [{ name: 't', ...row }]
  const result = await checksCmd(inv({ json: 'name,bucket' }))
  if (result === null) throw new Error('expected a result tuple')
  const parsed = JSON.parse(new TextDecoder().decode(result[0] as Uint8Array)) as {
    bucket: unknown
  }[]
  return parsed[0]?.bucket
}

describe('gh pr checks buckets', () => {
  it.each([
    ['success', 'pass'],
    ['neutral', 'skipping'],
    ['skipped', 'skipping'],
    ['failure', 'fail'],
    ['error', 'fail'],
    ['timed_out', 'fail'],
    ['action_required', 'fail'],
    ['cancelled', 'cancel'],
    ['stale', 'pending'],
  ])('buckets the %s conclusion the way gh buckets it', async (conclusion, bucket) => {
    expect(await bucketOf({ conclusion })).toBe(bucket)
  })

  it.each(['queued', 'in_progress', 'pending', 'requested', 'waiting'])(
    'treats the %s status as pending',
    async (status) => {
      expect(await bucketOf({ status })).toBe('pending')
    },
  )

  it('treats an unknown state as pending rather than failed', async () => {
    expect(await bucketOf({ conclusion: 'invented' })).toBe('pending')
  })

  it('does not fail the command for a cancelled check', async () => {
    ROWS = [{ name: 't', conclusion: 'cancelled' }]
    const result = await checksCmd(inv())
    expect(result?.[1].exitCode ?? 0).toBe(0)
  })

  it('still exits one for a failing check', async () => {
    ROWS = [{ name: 't', conclusion: 'failure' }]
    const result = await checksCmd(inv())
    expect(result?.[1].exitCode).toBe(1)
  })
})

// Every field `gh pr view --json` and `gh pr list --json` accept in gh 2.85.
const GH_FIELDS = [
  'additions',
  'assignees',
  'author',
  'autoMergeRequest',
  'baseRefName',
  'baseRefOid',
  'body',
  'changedFiles',
  'closed',
  'closedAt',
  'closingIssuesReferences',
  'comments',
  'commits',
  'createdAt',
  'deletions',
  'files',
  'fullDatabaseId',
  'headRefName',
  'headRefOid',
  'headRepository',
  'headRepositoryOwner',
  'id',
  'isCrossRepository',
  'isDraft',
  'labels',
  'latestReviews',
  'maintainerCanModify',
  'mergeCommit',
  'mergeStateStatus',
  'mergeable',
  'mergedAt',
  'mergedBy',
  'milestone',
  'number',
  'potentialMergeCommit',
  'projectCards',
  'projectItems',
  'reactionGroups',
  'reviewDecision',
  'reviewRequests',
  'reviews',
  'state',
  'statusCheckRollup',
  'title',
  'updatedAt',
  'url',
]

describe('gh pr view --json', () => {
  beforeEach(() => {
    FIELDS.mockReset()
    LIST.mockReset()
  })

  it('offers every field gh 2.85 does', () => {
    expect([...PR_FIELDS].sort()).toEqual(GH_FIELDS)
  })

  it('asks one query for the fields named, plus the id and number gh adds', async () => {
    FIELDS.mockResolvedValueOnce({ title: 'DOC', changedFiles: 8, id: 'PR_1', number: 5 })
    expect(json(await viewCmd(inv({ json: 'title,changedFiles' })))).toEqual({
      changedFiles: 8,
      title: 'DOC',
    })
    expect(FIELDS).toHaveBeenCalledTimes(1)
    expect(FIELDS.mock.calls[0]?.[3]).toBe('title,changedFiles,id,number')
  })

  it('answers number alone from the line, as gh does', async () => {
    expect(json(await viewCmd(inv({ json: 'number' })))).toEqual({ number: 5 })
    expect(FIELDS).not.toHaveBeenCalled()
  })

  it('exports files, commits and reviews in the shapes gh prints', async () => {
    FIELDS.mockResolvedValueOnce({
      files: { nodes: [{ additions: 6, deletions: 6, path: 'README.md' }] },
      commits: {
        nodes: [
          {
            commit: {
              authors: { nodes: [{ name: 'Work', email: 'w@example.test', user: null }] },
              messageHeadline: 'DOC: fix typos',
              messageBody: 'and terms',
              oid: 'abc',
              committedDate: '2025-08-12T03:37:28Z',
              authoredDate: '2025-08-12T03:37:28Z',
            },
          },
        ],
      },
      reviews: {
        nodes: [
          {
            id: 'PRR_1',
            author: { login: 'me' },
            authorAssociation: 'CONTRIBUTOR',
            submittedAt: '2025-08-17T20:15:50Z',
            body: 'please review',
            state: 'COMMENTED',
            commit: { oid: 'abc' },
            reactionGroups: [{ content: 'EYES', users: { totalCount: 0 } }],
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: 'c' },
      },
    })
    const out = json(await viewCmd(inv({ json: 'files,commits,reviews' })))
    expect(out.files).toEqual([{ path: 'README.md', additions: 6, deletions: 6 }])
    expect(Object.keys((out.files as Record<string, unknown>[])[0] ?? {})).toEqual([
      'path',
      'additions',
      'deletions',
    ])
    expect(out.commits).toEqual([
      {
        authoredDate: '2025-08-12T03:37:28Z',
        authors: [{ email: 'w@example.test', id: '', login: '', name: 'Work' }],
        committedDate: '2025-08-12T03:37:28Z',
        messageBody: 'and terms',
        messageHeadline: 'DOC: fix typos',
        oid: 'abc',
      },
    ])
    expect(out.reviews).toEqual([
      {
        id: 'PRR_1',
        author: { login: 'me' },
        authorAssociation: 'CONTRIBUTOR',
        body: 'please review',
        submittedAt: '2025-08-17T20:15:50Z',
        includesCreatedEdit: false,
        reactionGroups: [],
        state: 'COMMENTED',
        commit: { oid: 'abc' },
      },
    ])
  })

  it('reads a paged connection to its end', async () => {
    FIELDS.mockResolvedValueOnce({
      reviews: { nodes: [{ id: 'R1' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
    }).mockResolvedValueOnce({
      reviews: { nodes: [{ id: 'R2' }], pageInfo: { hasNextPage: false, endCursor: 'c2' } },
    })
    const out = json(await viewCmd(inv({ json: 'reviews' })))
    expect((out.reviews as { id: string }[]).map((review) => review.id)).toEqual(['R1', 'R2'])
    expect(FIELDS.mock.calls[1]?.[3]).toContain('reviews(first: 100, after: $endCursor)')
    expect(FIELDS.mock.calls[1]?.[4]).toBe('c1')
  })

  it('reads the status checks of the one commit gh rolls them up on', async () => {
    const rollup = (nodes: unknown[], next: string | null) => ({
      statusCheckRollup: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } },
              },
            },
          },
        ],
      },
    })
    FIELDS.mockResolvedValueOnce(
      rollup(
        [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }],
        'c1',
      ),
    ).mockResolvedValueOnce(
      rollup(
        [{ __typename: 'StatusContext', context: 'ci', state: 'PENDING', createdAt: 't' }],
        null,
      ),
    )
    const out = json(await viewCmd(inv({ json: 'statusCheckRollup' })))
    expect(out.statusCheckRollup).toEqual([
      {
        __typename: 'CheckRun',
        completedAt: '0001-01-01T00:00:00Z',
        conclusion: 'SUCCESS',
        detailsUrl: '',
        name: 'test',
        startedAt: '0001-01-01T00:00:00Z',
        status: 'COMPLETED',
        workflowName: '',
      },
      {
        __typename: 'StatusContext',
        context: 'ci',
        startedAt: 't',
        state: 'PENDING',
        targetUrl: '',
      },
    ])
    expect(FIELDS.mock.calls[1]?.[3]).toContain('contexts(first:100, after: $endCursor)')
  })

  it('prints no status checks as null when no commit carries them', async () => {
    FIELDS.mockResolvedValueOnce({ statusCheckRollup: { nodes: [] } })
    expect(json(await viewCmd(inv({ json: 'statusCheckRollup' })))).toEqual({
      statusCheckRollup: null,
    })
  })

  it('never asks for project cards, which print null', async () => {
    FIELDS.mockResolvedValueOnce({ id: 'PR_1', number: 5 })
    expect(json(await viewCmd(inv({ json: 'projectCards' })))).toEqual({ projectCards: null })
    expect(FIELDS.mock.calls[0]?.[3]).toBe('id,number')
  })

  it('reads project items apart and reads a missing scope as none', async () => {
    FIELDS.mockResolvedValueOnce({ id: 'PR_1', number: 5 }).mockRejectedValueOnce(
      new Error(
        "GraphQL: Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes.",
      ),
    )
    expect(json(await viewCmd(inv({ json: 'projectItems' })))).toEqual({ projectItems: [] })
    expect(FIELDS.mock.calls[1]?.[3]).toMatch(/^projectItems\(first: 100\)/)
  })

  it('keeps any other failure of the project items query', async () => {
    FIELDS.mockResolvedValueOnce({ id: 'PR_1', number: 5 }).mockRejectedValueOnce(
      new Error('GraphQL: something else'),
    )
    await expect(viewCmd(inv({ json: 'projectItems' }))).rejects.toThrow('something else')
  })

  it('refuses a field gh does not export before asking anything', async () => {
    await expect(viewCmd(inv({ json: 'nosuch' }))).rejects.toThrow('Unknown JSON field: "nosuch"')
    expect(FIELDS).not.toHaveBeenCalled()
  })
})

describe('gh pr list --json', () => {
  beforeEach(() => {
    LIST.mockReset()
  })

  it('lists over GraphQL with the states gh sends for --state', async () => {
    LIST.mockResolvedValueOnce([{ number: 3, files: { nodes: [] } }])
    const out = json(await listCmd(inv({ json: 'number,files', state: 'closed' })))
    expect(out).toEqual([{ files: [], number: 3 }])
    expect(LIST.mock.calls[0]?.[2]).toEqual({
      states: ['CLOSED', 'MERGED'],
      base: undefined,
      head: undefined,
    })
    expect(LIST.mock.calls[0]?.[3]).toBe(30)
    expect(LIST.mock.calls[0]?.[4]).toBe(
      'number,files(first: 100) {nodes {additions,deletions,path}}',
    )
  })

  it('asks for project cards and items inline, as gh pr list does', async () => {
    LIST.mockResolvedValueOnce([])
    await listCmd(inv({ json: 'projectCards,projectItems', state: 'all' }))
    expect(LIST.mock.calls[0]?.[4]).toMatch(
      /^projectCards\(first:100\).*,projectItems\(first:100\)/,
    )
  })
})

describe('gh pr diff --name-only', () => {
  it('prints the b side of each header, as gh does', async () => {
    const result = await diffCmd(inv({ name_only: true }))
    if (result === null) throw new Error('expected a result tuple')
    expect(new TextDecoder().decode(result[0] as Uint8Array)).toBe(
      'README.md\n"caf\\303\\251.txt"\nmoved/contributing.md\n"q\\"t.txt"\nsub dir/x y.txt\n',
    )
  })
})
