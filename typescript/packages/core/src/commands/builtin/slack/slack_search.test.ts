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

import { describe, expect, it } from 'vitest'
import type { SlackResponse } from '../../../core/slack/_client.ts'
import { materialize } from '../../../io/types.ts'
import { FakeSlackTransport, makeFakeResource, type Responder } from './_test_util.ts'
import { SLACK_SEARCH } from './slack_search.ts'

const DEC = new TextDecoder()

async function runSearch(
  flags: Record<string, string | boolean>,
  responder: Responder = (): SlackResponse => ({ ok: true, messages: { matches: [] } }),
): Promise<{ out: string; transport: FakeSlackTransport }> {
  const cmd = SLACK_SEARCH[0]
  if (cmd === undefined) throw new Error('slack-search not registered')
  const transport = new FakeSlackTransport(responder)
  const resource = makeFakeResource(transport)
  const result = await cmd.fn(resource.accessor, [], [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: '', transport }
  const [bs] = result
  if (bs === null) return { out: '', transport }
  const buf = bs instanceof Uint8Array ? bs : await materialize(bs as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), transport }
}

describe('slack-search command', () => {
  it('calls search.messages with query, default count=20, page=1', async () => {
    const { transport } = await runSearch({ query: 'hello' })
    expect(transport.calls[0]?.endpoint).toBe('search.messages')
    expect(transport.calls[0]?.params).toMatchObject({
      query: 'hello',
      count: '20',
      page: '1',
      sort: 'timestamp',
    })
  })

  it('respects --count', async () => {
    const { transport } = await runSearch({ query: 'hello', count: '7' })
    expect(transport.calls[0]?.params).toMatchObject({ count: '7' })
  })

  it('respects --page', async () => {
    const { transport } = await runSearch({ query: 'hello', count: '100', page: '3' })
    expect(transport.calls[0]?.params).toMatchObject({ count: '100', page: '3' })
  })

  it('returns the JSON response bytes', async () => {
    const { out } = await runSearch({ query: 'hi' }, () => ({
      ok: true,
      messages: { matches: [{ ts: '1.0', text: 'hi there' }] },
    }))
    const parsed = JSON.parse(out) as { messages: { matches: { text: string }[] } }
    expect(parsed.messages.matches[0]?.text).toBe('hi there')
  })

  it('throws when --query missing', async () => {
    await expect(runSearch({})).rejects.toThrow(/query/)
  })

  it('rejects --count above 100', async () => {
    await expect(runSearch({ query: 'q', count: '101' })).rejects.toThrow(/count/)
  })

  it('rejects --page below 1', async () => {
    await expect(runSearch({ query: 'q', page: '0' })).rejects.toThrow(/page/)
  })

  it('rejects non-integer --count', async () => {
    await expect(runSearch({ query: 'q', count: 'abc' })).rejects.toThrow(/count/)
  })
})
