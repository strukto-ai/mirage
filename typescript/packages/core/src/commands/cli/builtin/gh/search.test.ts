import { describe, expect, it, vi } from 'vitest'
import type { FlagValue } from '../../../spec/types.ts'
import { GitHubApiError } from '../../../../core/github/client.ts'
import { search } from '../../../../core/github/search.ts'
import { materialize } from '../../../../io/types.ts'
import { searchSpec } from './search.ts'
import { cliInvocation } from '../../../../workspace/fixtures/cli_invocation.ts'

vi.mock('../../../../core/github/search.ts', () => ({ search: vi.fn(() => Promise.resolve([])) }))

const cases: [string, Record<string, FlagValue>, string][] = [
  [
    'issues',
    {
      label: ['bug,help wanted'],
      repo: ['integ/a', 'other/b'],
      locked: 'false',
      no_assignee: true,
    },
    '"two words" is:unlocked label:"help wanted" label:bug no:assignee repo:integ/a repo:other/b type:issue',
  ],
  [
    'prs',
    { app: 'bot', review_requested: 'integ/team', merged: 'false', draft: true },
    '"two words" author:app/bot draft:true is:unmerged team-review-requested:integ/team type:pr',
  ],
  [
    'repos',
    { owner: ['integ,other'], include_forks: 'only', number_topics: '>2' },
    '"two words" fork:only topics:>2 user:integ user:other',
  ],
  [
    'code',
    { match: ['file'], extension: 'ts', repo: ['integ/a'] },
    '"two words" extension:ts in:file repo:integ/a',
  ],
  [
    'commits',
    { author_name: 'A Person', merge: 'false', visibility: ['public'] },
    '"two words" author-name:"A Person" is:public merge:false',
  ],
]

describe('search qualifiers match native gh', () => {
  it.each(cases)('%s', async (kind, flags, expected) => {
    const leaf = searchSpec().subcommands.find((item) => item.name === kind)
    if (!leaf?.fn) throw new Error('missing search handler')
    await leaf.fn(
      cliInvocation({
        config: { token: 't' },
        argv: ['search', kind, 'two words'],
        texts: ['two words'],
        flags: { ...flags, limit: '30', json: 'url' },
        spec: leaf,
      }),
    )
    expect(vi.mocked(search).mock.lastCall?.[2]).toBe(expected)
  })
})

const URL = 'https://api.example.test/search/issues?q=needle+type%3Aissue'

describe('a failed search reads as gh words it', () => {
  it.each([
    [
      422,
      'Validation Failed',
      '{"message":"Validation Failed","errors":[{"message":"bad repo"}]}',
      'Invalid search query "needle type:issue".\nbad repo\n',
    ],
    [
      422,
      'Validation Failed',
      '{"message":"Validation Failed","errors":[{"code":"x"}]}',
      'Invalid search query "needle type:issue".\n\n',
    ],
    [
      422,
      'Validation Failed',
      '{"message":"Validation Failed"}',
      `HTTP 422: Validation Failed (${URL})\n`,
    ],
    [500, 'Internal Server Error', '{"foo":1}', `HTTP 500:  (${URL})\n`],
    [502, 'Bad Gateway', 'upstream unavailable\n', `HTTP 502: 502 Bad Gateway (${URL})\n`],
  ] as const)('%s %s', async (status, message, body, stderr) => {
    vi.mocked(search).mockRejectedValueOnce(new GitHubApiError(message, status, body, URL))
    const leaf = searchSpec().subcommands.find((item) => item.name === 'issues')
    if (!leaf?.fn) throw new Error('missing search handler')
    const result = await leaf.fn(
      cliInvocation({
        config: { token: 't' },
        argv: ['search', 'issues', 'needle'],
        texts: ['needle'],
        flags: { limit: '30' },
        spec: leaf,
      }),
    )
    if (result === null) throw new Error('missing search result')
    const io = result[1]
    expect(result[0]).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(await materialize(io.stderr))).toBe(stderr)
  })
})
