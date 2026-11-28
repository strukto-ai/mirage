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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlackAccessor } from '../../accessor/slack.ts'
import { ALL_COMMANDS } from '../../policy/builtin/output_cap.ts'
import { Limit, MountMode } from '../../types.ts'
import { SlackVFS } from '../../vfs/slack/slack.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import type { JsonValue } from '../../../tests/fixtures/kit_fake.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  LISTING,
  SEARCH_FILES,
  SEARCH_MESSAGES,
  SEARCHER,
  SlackWorkspace,
  type SlackOptions,
  UNTIL_CLEARED,
  USER_TOKEN,
  USERS,
} from '../../../tests/core/slack/workspace.ts'
import type * as History from './history.ts'
import { getHistoryJsonl } from './history.ts'
import { MAX_PAGES, searchMessages } from './search.ts'

// The days read are counted where a day's chat.jsonl is read: listing a day
// fetches its history too, the same request, so the requests alone cannot
// tell a read day from a listed one.
vi.mock('./history.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof History>()
  return { ...actual, getHistoryJsonl: vi.fn(actual.getHistoryJsonl) }
})

const DEC = new TextDecoder()
let origin = ''
let workspace: SlackWorkspace

beforeAll(async () => {
  origin = await serve('slack')
})

beforeEach(async () => {
  workspace = new SlackWorkspace(origin)
  await workspace.reset()
})

afterEach(async () => {
  await workspace.close()
})

describe('searchMessages', () => {
  it('calls search.messages with query, count, page, sort=timestamp', async () => {
    const out = await searchMessages(workspace.accessor(), 'hello', 5)
    expect(await workspace.run.params('GET', SEARCH_MESSAGES)).toEqual([
      { query: 'hello', count: '5', page: '1', sort: 'timestamp' },
    ])
    const parsed = JSON.parse(DEC.decode(out)) as { ok: boolean }
    expect(parsed.ok).toBe(true)
  })

  it('defaults count to 20 and page to 1', async () => {
    await searchMessages(workspace.accessor(), 'q')
    expect((await workspace.run.params('GET', SEARCH_MESSAGES))[0]).toMatchObject({
      count: '20',
      page: '1',
    })
  })

  it('forwards explicit page number', async () => {
    await searchMessages(workspace.accessor(), 'q', 50, 3)
    expect((await workspace.run.params('GET', SEARCH_MESSAGES))[0]).toMatchObject({
      count: '50',
      page: '3',
    })
  })

  it('returns bytes encoding the JSON response', async () => {
    const out = await searchMessages(workspace.accessor(), 'lunch')
    const decoded = JSON.parse(DEC.decode(out)) as {
      messages: { matches: { ts: string }[] }
    }
    expect(decoded.messages.matches.map((m) => m.ts)).toEqual(['1762214460.000001'])
  })

  it('uses search token override when transport is NodeSlackTransport with searchToken', async () => {
    await searchMessages(workspace.accessor({ searchToken: SEARCHER }), 'q')
    expect(await workspace.run.headers('GET', SEARCH_MESSAGES)).toEqual([
      { authorization: `Bearer ${SEARCHER}` },
    ])
  })

  it('falls back to the accessor transport when no search token', async () => {
    await searchMessages(workspace.accessor(), 'q')
    expect(await workspace.run.headers('GET', SEARCH_MESSAGES)).toEqual([
      { authorization: `Bearer ${USER_TOKEN}` },
    ])
  })
})

class SearchSlackVFS extends SlackVFS {
  override readonly name = 'slack'
  constructor(override readonly accessor: SlackAccessor) {
    super()
  }
}

type Ran = [string, number, string[], string[]]

async function onSlack(line: string, walkLimit = 1000, options: SlackOptions = {}): Promise<Ran> {
  vi.mocked(getHistoryJsonl).mockClear()
  await workspace.record()
  const limits = { [ALL_COMMANDS]: new Limit({ walkLimit }) }
  const ws = new Workspace(
    {
      '/slack': new Mount(new SearchSlackVFS(workspace.accessor(options)), {
        mode: MountMode.READ,
        commandLimits: limits,
      }),
    },
    {},
  )
  try {
    const result = await ws.shell(line)
    const reads = vi
      .mocked(getHistoryJsonl)
      .mock.calls.map(([, channel, day]) => `${channel}/${day}`)
      .sort()
    return [DEC.decode(result.stdout), result.exitCode, reads, await workspace.searches()]
  } finally {
    await ws.close()
  }
}

async function ownAnswer(route: string, query: string): Promise<Record<string, JsonValue>> {
  return workspace.run.call('GET', `${route}?query=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${USER_TOKEN}` },
  })
}

type Arrange = () => Promise<void>

const asIs: Arrange = () => Promise.resolve()

// Slack's own answer, its page count past what Mirage reads.
const tooManyPages: Arrange = async () => {
  const page = await ownAnswer(SEARCH_MESSAGES, 'deploy')
  const messages = page.messages as { paging: { pages: number } }
  messages.paging.pages = MAX_PAGES + 1
  await workspace.run.answerNext('GET', SEARCH_MESSAGES, 200, page, UNTIL_CLEARED)
}

// A real workspace's URL is on its own domain, whose words a file's permalink
// carries; the fake answers with its own origin.
const onItsOwnDomain: Arrange = () => workspace.answerAuth({ url: 'https://acme.slack.com/' })

const filesWithoutShares: Arrange = async () => {
  const page = await ownAnswer(SEARCH_FILES, 'Launch')
  for (const match of (page.files as { matches: Record<string, JsonValue>[] }).matches) {
    delete match.shares
  }
  await workspace.run.answerNext('GET', SEARCH_FILES, 200, page, UNTIL_CLEARED)
}

const refused: Arrange = async () => {
  await workspace.refuse(SEARCH_MESSAGES, 'ratelimited')
  await workspace.refuse(SEARCH_FILES, 'ratelimited')
}

const reset: Arrange = async () => {
  for (const route of [SEARCH_MESSAGES, SEARCH_FILES]) {
    await workspace.run.answerNext('GET', route, null, undefined, UNTIL_CLEARED)
  }
}

const slow: Arrange = async () => {
  for (const route of [SEARCH_MESSAGES, SEARCH_FILES]) {
    await workspace.run.answerNext(
      'GET',
      route,
      200,
      undefined,
      UNTIL_CLEARED,
      undefined,
      undefined,
      2_000,
    )
  }
}

describe('filesContaining', () => {
  it.each([
    ['grep -rlw deploy /slack/channels', ['C1/2025-11-03', 'C1/2025-11-06', 'C2/2025-11-04']],
    ['grep -rlw rocket /slack/channels/general__C1', ['C1/2025-11-04']],
    ['grep -rlw Launch /slack/channels/general__C1', ['C1/2025-11-05']],
    ['grep -rlw Launch /slack/channels', ['C1/2025-11-05', 'C2/2025-11-07']],
    [
      'grep -rlw deploy /slack',
      ['C1/2025-11-03', 'C1/2025-11-06', 'C2/2025-11-04', 'D1/2025-11-03'],
    ],
    ['grep -rlw deploy /slack/dms', ['D1/2025-11-03']],
    ['rg -lw deploy /slack/dms/ana__D1', ['D1/2025-11-03']],
  ])('reads only the days search names for %s', async (line, reads) => {
    // A file hit names every day a message shares it, not its upload:
    // plan.txt is uploaded in general on 2025-11-05 and shared again in
    // random on 2025-11-07.
    const full = await onSlack(line, -1)
    const [out, code, read] = await onSlack(line)
    expect([out, code]).toEqual(full.slice(0, 2))
    expect(read).toEqual(reads)
  })

  it('reads a day rather than searching it', async () => {
    const line = 'grep -rlw deploy /slack/channels/general__C1/2025-11-06'
    const full = await onSlack(line, -1)
    const [out, code, read, searches] = await onSlack(line)
    expect([out, code, read]).toEqual(full.slice(0, 3))
    expect([searches, await workspace.count(USERS)]).toEqual([[], 0])
  })

  it('shares one user and channel listing among the patterns of one grep', async () => {
    await onSlack('grep -rlw -e deploy -e lunch /slack/channels', 1000, {
      searchToken: SEARCHER,
    })
    expect([await workspace.count(USERS), await workspace.count(LISTING, SEARCHER)]).toEqual([1, 1])
  })

  it('searches a channel by name and its reactions too', async () => {
    const [, , , searches] = await onSlack('grep -rlw rocket /slack/channels/general__C1')
    expect(searches).toEqual([
      'in:#general rocket',
      'in:#general ocket',
      'in:#general rocket',
      'in:#general ocket',
      'in:#general has::rocket:',
    ])
  })

  it.each([
    ['grep -rlw text /slack/channels', asIs, {}],
    ['grep -rlw Lima /slack/channels', asIs, {}],
    ['grep -rlw nothing /slack/channels', asIs, {}],
    ['grep -rlw deploy /slack/channels', tooManyPages, {}],
    ['grep -rlw acme /slack/channels', onItsOwnDomain, {}],
    ['grep -rlw Launch /slack/channels', filesWithoutShares, {}],
    ['grep -rlw deploy /slack/channels', refused, {}],
    ['grep -rlw deploy /slack/channels', reset, {}],
    ['grep -rlw deploy /slack/channels', slow, { timeout: 0.5 }],
  ] as [string, Arrange, SlackOptions][])(
    'reads every day when search cannot answer %s',
    async (line, arrange, options) => {
      const full = await onSlack(line, -1)
      await arrange()
      const warn = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
      try {
        expect((await onSlack(line, 1000, options)).slice(0, 3)).toEqual(full.slice(0, 3))
      } finally {
        warn.mockRestore()
      }
    },
  )

  // Twin of test_a_channel_the_search_user_is_not_in_is_read: random is
  // private and the search token's user (ben) is not in it, so no search names
  // its days; ruling them out would miss its deploy.
  it.each(['grep -rlw deploy /slack/channels', 'rg -lw deploy /slack/channels/random__C2'])(
    'reads a channel the search user is not in: %s',
    async (line) => {
      const full = await onSlack(line, -1)
      expect((await onSlack(line, 1000, { searchToken: SEARCHER })).slice(0, 3)).toEqual(
        full.slice(0, 3),
      )
    },
  )

  // Twin of test_a_dm_the_search_user_is_not_in_is_read: the listing's token
  // holds a DM the search token's user is not in (ana's, which ben cannot
  // see), so no search names its days.
  it.each(['grep -rlw deploy /slack', 'grep -rlw deploy /slack/dms'])(
    'reads a DM the search user is not in: %s',
    async (line) => {
      const full = await onSlack(line, -1)
      expect((await onSlack(line, 1000, { searchToken: SEARCHER })).slice(0, 3)).toEqual(
        full.slice(0, 3),
      )
    },
  )
})
