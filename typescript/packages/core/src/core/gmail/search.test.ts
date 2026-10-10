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

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { MountMode, type PathSpec } from '../../types.ts'
import { GmailVFS } from '../../vfs/gmail/gmail.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

const BASE = 'https://gmail.test'
const DEC = new TextDecoder()
const LABELS = [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'TRASH', name: 'TRASH', type: 'system' },
  { id: 'Label_1', name: 'Work', type: 'user' },
]

interface Message {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: string
  snippet: string
  payload: {
    mimeType: string
    headers: { name: string; value: string }[]
    parts: {
      mimeType: string
      filename?: string
      body: { data?: string; attachmentId?: string; size?: number }
    }[]
  }
}

function b64(text: string): string {
  return Buffer.from(text).toString('base64url')
}

function message(
  id: string,
  labelIds: string[],
  day: string,
  sender: string,
  subject: string,
  body: string,
  attachment = '',
): Message {
  const parts: Message['payload']['parts'] = [{ mimeType: 'text/plain', body: { data: b64(body) } }]
  if (attachment !== '') {
    parts.push({
      filename: attachment,
      mimeType: 'text/plain',
      body: { attachmentId: `A${id}`, size: 5 },
    })
  }
  return {
    id,
    threadId: id,
    labelIds,
    internalDate: String(Date.parse(`${day}T09:00:00Z`)),
    snippet: body,
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: sender },
        { name: 'To', value: 'me@example.com' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: 'Mon, 5 Jan 2026 09:00:00 +0000' },
      ],
      parts,
    },
  }
}

const MESSAGES = [
  message(
    'a1',
    ['INBOX'],
    '2026-01-05',
    'Ana Lima <ana@example.com>',
    'Budget review',
    'numbers for travel',
    'plan.txt',
  ),
  message(
    'b2',
    ['INBOX', 'Label_1'],
    '2026-01-06',
    'Bo <bo@example.com>',
    'Lunch',
    'deploy friday',
  ),
  message('c3', ['TRASH'], '2026-01-06', 'Cy <cy@example.com>', 'Old', 'deploy'),
  message('d4', ['INBOX'], '2026-01-07', 'Di <di@example.com>', 'Notes', 'quiet'),
]

function holds(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(text)
}

function header(m: Message, name: string): string {
  return m.payload.headers.find((h) => h.name === name)?.value ?? ''
}

/**
 * The Gmail API a label walk and its search reach. A bare word matches whole
 * words of the From, To, Cc and Subject headers and the body in any case,
 * `filename:` an attachment name, and `after:`/`before:` take epoch seconds,
 * as Gmail does. Mirrors Python's `FakeGmail`.
 */
class FakeGmail {
  readonly searches: string[] = []
  constructor(private readonly fails = false) {}

  readonly fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/labels') return this.json({ labels: LABELS })
    if (path === '/messages') return this.list(url.searchParams)
    const attachment = /^\/messages\/[^/]+\/attachments\//.exec(path)
    if (attachment !== null) return this.json({ data: b64('plan\n') })
    const id = path.slice('/messages/'.length)
    return this.json(MESSAGES.find((m) => m.id === id) ?? {})
  }

  private json(body: unknown, status = 200): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }

  private list(params: URLSearchParams): Promise<Response> {
    const query = params.get('q') ?? ''
    if (query !== '' && !query.startsWith('after:')) {
      this.searches.push(query)
      if (this.fails) return this.json({ error: { message: 'rate limited' } }, 429)
    }
    const label = params.get('labelIds')
    const found = MESSAGES.filter(
      (m) => (label === null || m.labelIds.includes(label)) && this.matches(m, query),
    ).map((m) => ({ id: m.id, threadId: m.threadId }))
    return this.json({ messages: found.slice(0, Number(params.get('maxResults') ?? 100)) })
  }

  private matches(m: Message, query: string): boolean {
    const seconds = Math.floor(Number(m.internalDate) / 1000)
    for (const term of query.split(' ').filter((t) => t !== '')) {
      if (term.startsWith('after:')) {
        if (seconds <= Number(term.slice(6))) return false
      } else if (term.startsWith('before:')) {
        if (seconds >= Number(term.slice(7))) return false
      } else if (term.startsWith('filename:')) {
        if (!m.payload.parts.some((p) => holds(p.filename ?? '', term.slice(9)))) return false
      } else {
        const body = Buffer.from(m.payload.parts[0]?.body.data ?? '', 'base64url').toString()
        const texts = [...['From', 'To', 'Cc', 'Subject'].map((n) => header(m, n)), body]
        if (!texts.some((t) => holds(t, term))) return false
      }
    }
    return true
  }
}

class CountingGmail extends GmailVFS {
  readonly reads: string[] = []
  override read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    if (path.vfsPath.endsWith('.gmail.json')) this.reads.push(path.vfsPath.split('__').pop() ?? '')
    return super.read(path, index, offset, size)
  }
}

type Ran = [string, number, string[], string[]]

async function onGmail(line: string, fake = new FakeGmail(), contentSearch = true): Promise<Ran> {
  vi.stubGlobal('fetch', fake.fetch)
  const vfs = new CountingGmail({ accessToken: 't', apiBase: BASE, contentSearch })
  const ws = new Workspace(
    { '/gmail': new Mount(vfs, { mode: MountMode.READ }) },
    { shellParser: await getTestParser() },
  )
  try {
    const result = await ws.shell(line)
    const reads = vfs.reads.map((name) => name.replace('.gmail.json', '')).sort()
    return [DEC.decode(result.stdout), result.exitCode, reads, fake.searches]
  } finally {
    await ws.close()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('filesContaining', () => {
  it.each([
    ['grep -rlw deploy /gmail', ['b2', 'b2', 'c3']],
    ['grep -rlw Ana /gmail/INBOX', ['a1']],
    ['grep -rlw plan /gmail/INBOX', ['a1']],
    ['grep -rlw deploy /gmail/INBOX/2026-01-06', ['b2']],
    ['rg -lw friday /gmail/Work', ['b2']],
  ])('reads only the messages search names for %s', async (line, reads) => {
    const full = await onGmail(line, new FakeGmail(), false)
    const [out, code, read] = await onGmail(line)
    expect([out, code]).toEqual(full.slice(0, 2))
    expect(read).toEqual(reads)
  })

  it('searches a label day within its bounds', async () => {
    const [, , , searches] = await onGmail('grep -rlw deploy /gmail/INBOX/2026-01-06')
    expect(searches).toEqual([
      'deploy after:1767657599 before:1767744000',
      'eploy after:1767657599 before:1767744000',
      'filename:deploy after:1767657599 before:1767744000',
      'filename:eploy after:1767657599 before:1767744000',
    ])
  })

  it.each([
    ['grep -rlw inbox /gmail', () => new FakeGmail()],
    ['grep -rlw Jan /gmail', () => new FakeGmail()],
    ['grep -rlw nothing /gmail', () => new FakeGmail()],
    ['grep -rlw deploy /gmail', () => new FakeGmail(true)],
  ])('reads every message when search cannot answer %s', async (line, fake) => {
    const full = await onGmail(line, new FakeGmail(), false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect((await onGmail(line, fake())).slice(0, 3)).toEqual(full.slice(0, 3))
    } finally {
      warn.mockRestore()
    }
  })
})
