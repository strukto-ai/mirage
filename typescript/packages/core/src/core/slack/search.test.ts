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
import type * as History from './history.ts'

vi.mock('./history.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof History>()
  return { ...actual, getHistoryJsonl: vi.fn(actual.getHistoryJsonl) }
})

import { SlackAccessor } from '../../accessor/slack.ts'
import { MountMode } from '../../types.ts'
import { SlackVFSBase } from '../../vfs/slack/slack.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import {
  NodeSlackTransport,
  SlackApiError,
  type SlackResponse,
  type SlackTransport,
} from './client.ts'
import { getHistoryJsonl } from './history.ts'
import { MAX_PAGES, searchFiles, searchMessages } from './search.ts'

const DEC = new TextDecoder()

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: () => SlackResponse = () => ({ ok: true })) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder())
  }
}

describe('searchMessages', () => {
  it('calls search.messages with query, count, page, sort=timestamp', async () => {
    const t = new FakeTransport(() => ({ ok: true, messages: { matches: [] } }))
    const out = await searchMessages(new SlackAccessor(t), 'hello', 5)
    expect(t.calls[0]?.endpoint).toBe('search.messages')
    expect(t.calls[0]?.params).toEqual({
      query: 'hello',
      count: '5',
      page: '1',
      sort: 'timestamp',
    })
    const parsed = JSON.parse(DEC.decode(out)) as { ok: boolean }
    expect(parsed.ok).toBe(true)
  })

  it('defaults count to 20 and page to 1', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await searchMessages(new SlackAccessor(t), 'q')
    expect(t.calls[0]?.params).toMatchObject({ count: '20', page: '1' })
  })

  it('forwards explicit page number', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await searchMessages(new SlackAccessor(t), 'q', 50, 3)
    expect(t.calls[0]?.params).toMatchObject({ count: '50', page: '3' })
  })

  it('returns bytes encoding the JSON response', async () => {
    const t = new FakeTransport(() => ({ ok: true, messages: { matches: [{ ts: '1.0' }] } }))
    const out = await searchMessages(new SlackAccessor(t), 'q')
    const decoded = JSON.parse(DEC.decode(out)) as {
      messages: { matches: { ts: string }[] }
    }
    expect(decoded.messages.matches[0]?.ts).toBe('1.0')
  })

  it('uses search token override when transport is NodeSlackTransport with searchToken', async () => {
    const observedAuths: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      observedAuths.push(headers.Authorization ?? '')
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, messages: { matches: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }) as typeof fetch
    try {
      const transport = new NodeSlackTransport('main-token', 'search-token')
      await searchMessages(new SlackAccessor(transport), 'q')
      expect(observedAuths[0]).toBe('Bearer search-token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('falls back to the accessor transport when no search token', async () => {
    const observedAuths: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      observedAuths.push(headers.Authorization ?? '')
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, messages: { matches: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }) as typeof fetch
    try {
      const transport = new NodeSlackTransport('main-token')
      await searchMessages(new SlackAccessor(transport), 'q')
      expect(observedAuths[0]).toBe('Bearer main-token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('searchFiles', () => {
  it('calls search.files with query, count, page, sort=timestamp', async () => {
    const t = new FakeTransport(() => ({ ok: true, files: { matches: [] } }))
    await searchFiles(new SlackAccessor(t), 'doc', 5, 2)
    expect(t.calls[0]?.endpoint).toBe('search.files')
    expect(t.calls[0]?.params).toEqual({
      query: 'doc',
      count: '5',
      page: '2',
      sort: 'timestamp',
    })
  })
})

const DAY = 86_400
const START = 1762128000
const CHANNELS = [
  { id: 'C1', name: 'general', created: START },
  { id: 'C2', name: 'random', created: START },
]
const DMS = [{ id: 'D1', user: 'U1', created: START }]
const PROFILE = { real_name: 'Ana Lima', display_name: 'ana' }
const USERS = [{ id: 'U1', name: 'ana', real_name: 'Ana Lima', profile: PROFILE }]
const PLAN = {
  id: 'F1',
  name: 'plan.txt',
  title: 'Launch plan',
  mimetype: 'text/plain',
  filetype: 'text',
  size: 5,
  timestamp: START + 2 * DAY + 60,
  url_private_download: 'https://files.slack.com/files-pri/T1-F1/download/plan.txt',
  permalink: 'https://acme.slack.com/files/U1/F1/plan.txt',
}

interface Message {
  type: string
  user: string
  text: string
  ts: string
  reactions?: { name: string; users: string[]; count: number }[]
  files?: (typeof PLAN)[]
  user_profile?: typeof PROFILE
}

function message(at: number, text: string, extra: Partial<Message> = {}): Message {
  return { type: 'message', user: 'U1', text, ts: `${String(at)}.000001`, ...extra }
}

const MESSAGES: Record<string, Message[]> = {
  C1: [
    message(START + 60, 'the deploy is done at acme'),
    message(START + DAY + 60, 'lunch at noon', {
      reactions: [{ name: 'rocket', users: ['U1'], count: 1 }],
    }),
    message(START + 2 * DAY + 60, '', { files: [PLAN] }),
    message(START + 3 * DAY + 60, 'deploy again', { user_profile: PROFILE }),
  ],
  C2: [
    message(START + DAY + 60, 'a random deploy in Lima'),
    message(START + 4 * DAY + 60, '', { files: [PLAN] }),
  ],
  D1: [message(START + 60, 'deploy in a dm')],
}

function holds(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<!\\w)${escaped}(?!\\w)`, 'i').test(text)
}

/**
 * The Slack Web API a channel walk and its search reach. Search matches
 * whole words in any case, as Slack does: message text (`search.messages`),
 * a reaction name (`has::name:`) and a file's name or title
 * (`search.files`, naming every message that shares it unless `shares` is
 * off), scoped by `in:#name`. Every page answers `pages` as its page count;
 * a search rejects with `fails` when set. Mirrors Python's `FakeSlack`.
 */
class FakeSlack implements SlackTransport {
  readonly searches: string[] = []
  userLists = 0
  constructor(
    private readonly pages = 1,
    private readonly fails: Error | null = null,
    private readonly shares = true,
  ) {}

  call(endpoint: string, params: Record<string, string> = {}): Promise<SlackResponse> {
    if (endpoint === 'conversations.list') {
      return Promise.resolve({
        ok: true,
        channels: (params.types ?? '').includes('im') ? DMS : CHANNELS,
      })
    }
    if (endpoint === 'users.list') {
      this.userLists += 1
      return Promise.resolve({ ok: true, members: USERS })
    }
    if (endpoint === 'auth.test')
      return Promise.resolve({ ok: true, url: 'https://acme.slack.com/' })
    if (endpoint === 'conversations.history') {
      const oldest = Number(params.oldest ?? 0)
      const latest = params.latest === undefined ? Infinity : Number(params.latest)
      const found = [...(MESSAGES[params.channel ?? ''] ?? [])]
        .reverse()
        .filter((m) => oldest <= Number(m.ts) && Number(m.ts) <= latest)
      return Promise.resolve({ ok: true, messages: found.slice(0, Number(params.limit)) })
    }
    const query = params.query ?? ''
    this.searches.push(query)
    if (this.fails !== null) return Promise.reject(this.fails)
    return Promise.resolve({
      ok: true,
      [endpoint.slice('search.'.length)]: this.search(endpoint, query),
    })
  }

  private search(endpoint: string, query: string): Record<string, unknown> {
    const words = query.split(' ').filter((w) => w !== '')
    const names = words.filter((w) => w.startsWith('in:#')).map((w) => w.slice(4))
    const reaction = words.filter((w) => w.startsWith('has::')).map((w) => w.slice(5, -1))
    const text = words.filter((w) => !w.startsWith('in:#') && !w.startsWith('has::')).join(' ')
    const ids = CHANNELS.filter((c) => names.length === 0 || names.includes(c.name)).map(
      (c) => c.id,
    )
    if (names.length === 0) ids.push('D1')
    const matches: Record<string, unknown>[] = []
    for (const id of ids) {
      for (const m of MESSAGES[id] ?? []) {
        const hit =
          reaction.length > 0
            ? (m.reactions ?? []).some((r) => reaction.includes(r.name))
            : holds(m.text, text)
        if (endpoint === 'search.messages' && m.text !== '' && hit) {
          matches.push({ ts: m.ts, channel: { id } })
        }
        if (endpoint === 'search.files' && reaction.length === 0) {
          for (const f of m.files ?? []) {
            if (holds(f.name, text) || holds(f.title, text)) matches.push(this.file(f))
          }
        }
      }
    }
    return { matches, paging: { pages: this.pages } }
  }

  private file(file: typeof PLAN): Record<string, unknown> {
    const found = { id: file.id, timestamp: file.timestamp }
    if (!this.shares) return found
    const shares: Record<string, Record<string, { ts: string }[]>> = {}
    for (const [id, messages] of Object.entries(MESSAGES)) {
      for (const m of messages) {
        if ((m.files ?? []).some((f) => f.id === file.id)) {
          const kind = id.startsWith('D') ? 'private' : 'public'
          const rows = ((shares[kind] ??= {})[id] ??= [])
          rows.push({ ts: m.ts })
        }
      }
    }
    return { ...found, shares }
  }

  downloadFile(): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode('plan\n'))
  }

  searchAvailable(): boolean {
    return true
  }
}

class SearchSlackVFS extends SlackVFSBase {
  override readonly name = 'slack'
  override readonly accessor: SlackAccessor
  constructor(transport: SlackTransport, contentSearch: boolean) {
    super()
    this.accessor = new SlackAccessor(transport, { contentSearch })
  }
}

type Ran = [string, number, string[], string[]]

async function onSlack(line: string, fake = new FakeSlack(), contentSearch = true): Promise<Ran> {
  vi.mocked(getHistoryJsonl).mockClear()
  const ws = new Workspace(
    { '/slack': new Mount(new SearchSlackVFS(fake, contentSearch), { mode: MountMode.READ }) },
    { shellParser: await getTestParser() },
  )
  try {
    const result = await ws.shell(line)
    const reads = vi
      .mocked(getHistoryJsonl)
      .mock.calls.map(([, channel, day]) => `${channel}/${day}`)
      .sort()
    return [DEC.decode(result.stdout), result.exitCode, reads, fake.searches]
  } finally {
    await ws.close()
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
  ])('reads only the days search names for %s', async (line, reads) => {
    // A file hit names every day a message shares it, not its upload.
    const full = await onSlack(line, new FakeSlack(), false)
    const [out, code, read] = await onSlack(line)
    expect([out, code]).toEqual(full.slice(0, 2))
    expect(read).toEqual(reads)
  })

  it('reads a day rather than searching it', async () => {
    const line = 'grep -rlw deploy /slack/channels/general__C1/2025-11-06'
    const full = await onSlack(line, new FakeSlack(), false)
    const [out, code, read, searches] = await onSlack(line)
    expect([out, code, read]).toEqual(full.slice(0, 3))
    expect(searches).toEqual([])
  })

  it('shares one user listing among the patterns of one grep', async () => {
    const fake = new FakeSlack()
    await onSlack('grep -rlw -e deploy -e lunch /slack/channels', fake)
    expect(fake.userLists).toBe(1)
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
    ['grep -rlw text /slack/channels', () => new FakeSlack()],
    ['grep -rlw Lima /slack/channels', () => new FakeSlack()],
    ['grep -rlw nothing /slack/channels', () => new FakeSlack()],
    ['grep -rlw deploy /slack/channels', () => new FakeSlack(MAX_PAGES + 1)],
    ['grep -rlw acme /slack/channels', () => new FakeSlack()],
    ['grep -rlw Launch /slack/channels', () => new FakeSlack(1, null, false)],
    [
      'grep -rlw deploy /slack/channels',
      () => new FakeSlack(1, new SlackApiError('search.messages', 'ratelimited')),
    ],
    ['grep -rlw deploy /slack/channels', () => new FakeSlack(1, new TypeError('fetch failed'))],
    [
      'grep -rlw deploy /slack/channels',
      () => new FakeSlack(1, new DOMException('timed out', 'TimeoutError')),
    ],
    ['grep -rlw deploy /slack/dms', () => new FakeSlack()],
  ])('reads every day when search cannot answer %s', async (line, fake) => {
    const full = await onSlack(line, new FakeSlack(), false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect((await onSlack(line, fake())).slice(0, 3)).toEqual(full.slice(0, 3))
    } finally {
      warn.mockRestore()
    }
  })
})
