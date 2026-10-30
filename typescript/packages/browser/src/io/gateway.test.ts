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

import { runWithEgress } from '@struktoai/mirage-core/io/gateway'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import { Policies } from '@struktoai/mirage-core/policy/policies'
import type { NetworkContext, NetworkResultContext } from '@struktoai/mirage-core/policy/types'
import { Limit } from '@struktoai/mirage-core/types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { watch } from './gateway.ts'

// What the page's fetch was handed, and answers as the test sets.
const sent: { url: string; init: RequestInit | undefined }[] = []
let answer: () => Response = () => new Response('ok')

// Counts each method's calls and keeps how each request ended.
class Watch implements Policy {
  readonly asked: NetworkContext[] = []
  readonly ended: NetworkResultContext[] = []
  constructor(private readonly limit: Limit | null = null) {}

  preNetwork(ctx: NetworkContext): Limit | null {
    this.asked.push(ctx)
    return this.limit
  }

  postNetwork(ctx: NetworkResultContext): null {
    this.ended.push(ctx)
    return null
  }
}

function judged<T>(policy: Policy, fn: () => Promise<T>): Promise<T> {
  return runWithEgress(null, new Policies([policy]), fn)
}

describe('the page gateway', () => {
  beforeAll(() => {
    vi.stubGlobal('location', { href: 'https://page.test/' })
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: input instanceof Request ? input.url : String(input), init })
      return Promise.resolve(answer())
    })
    watch()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('refuses an upload past the Limit before sending it', async () => {
    const policy = new Watch(new Limit({ maxBytes: 10 }))
    sent.length = 0
    await expect(
      judged(policy, () => fetch('https://api.test/up', { method: 'POST', body: 'x'.repeat(100) })),
    ).rejects.toThrow('Failed to fetch')
    expect(sent).toEqual([])
    expect(policy.ended.map((ctx) => [ctx.ended, ctx.bytesSent])).toEqual([['limit', 0]])
  })

  it('refuses a redirect the page would follow, and hands back one it handles', async () => {
    const policy = new Watch()
    answer = () => ({ type: 'opaqueredirect', body: null }) as Response
    await expect(judged(policy, () => fetch('https://api.test/a'))).rejects.toThrow(
      'Failed to fetch',
    )
    const manual = await judged(policy, () => fetch('https://api.test/a', { redirect: 'manual' }))
    expect(manual.type).toBe('opaqueredirect')
    answer = () => new Response('ok')
  })

  it("keeps a Request's own signal and the response's URL", async () => {
    const policy = new Watch()
    const stop = new AbortController()
    sent.length = 0
    answer = () => {
      const response = new Response('ok')
      Object.defineProperty(response, 'url', { value: 'https://api.test/b' })
      return response
    }
    const response = await judged(policy, () =>
      fetch(new Request('https://api.test/b', { signal: stop.signal })),
    )
    expect(response.url).toBe('https://api.test/b')
    expect(await response.text()).toBe('ok')
    stop.abort()
    expect(sent[0]?.init?.signal?.aborted).toBe(true)
    expect(policy.ended.map((ctx) => [ctx.ended, ctx.bytesReceived])).toEqual([['closed', 2]])
    answer = () => new Response('ok')
  })

  it('asks a workspace once when its calls nest', async () => {
    const policy = new Watch()
    const policies = new Policies([policy])
    await runWithEgress(null, policies, () =>
      runWithEgress(null, policies, async () => (await fetch('https://api.test/c')).text()),
    )
    expect(policy.asked).toHaveLength(1)
    expect(policy.ended).toHaveLength(1)
  })
})
