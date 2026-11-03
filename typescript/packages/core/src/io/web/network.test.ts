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

import { runWithEgress } from '../gateway.ts'
import { type NetworkRule, networkRule, runWithNetwork } from '../network.ts'
import { Policies } from '../../policy/policies.ts'
import type * as AsyncContext from '../../utils/async_context.ts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { refuseUnseenAddresses, routed, watchNetwork } from './network.ts'

// A page's storage: every concurrently bound call is live at once.
vi.mock('../../utils/async_context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AsyncContext>()
  return {
    ...actual,
    asyncContextIsolatesTasks: false,
    createAsyncContext: () => new actual.FallbackStorage(),
  }
})

// Where a request goes under the bindings live as it is made.
function urlOf(input: RequestInfo | URL): string {
  const to = routed(input)
  return to instanceof Request ? to.url : String(to)
}

// A binding: the rule, the workspace's policies, the session it runs for,
// and whether a file op made it.
type Binding = readonly [NetworkRule | null, Policies, string, boolean]

// Where a request to localhost:5003 made under `two` goes while a call
// under `one` still runs.
async function apart(one: Binding, two: Binding): Promise<string> {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = runWithEgress(one[0], one[1], () => held, one[2], one[3])
  try {
    return await runWithEgress(
      two[0],
      two[1],
      () => Promise.resolve().then(() => urlOf('http://localhost:5003/')),
      two[2],
      two[3],
    )
  } finally {
    release()
    await first
  }
}

// What fetch answers beneath the watcher, which wraps it once.
let answer: typeof fetch = () => Promise.reject(new Error('no answer'))

describe('the page network watcher', () => {
  beforeAll(() => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => answer(input, init))
    watchNetwork()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('follows no redirect under a rule, since a page cannot see where one goes', async () => {
    const asked: (RequestRedirect | undefined)[] = []
    vi.stubGlobal('location', { href: 'https://page.test/' })
    answer = (_input, init) => {
      asked.push(init?.redirect)
      const type = init?.redirect === 'manual' ? 'opaqueredirect' : 'basic'
      return Promise.resolve({ type } as Response)
    }
    const rule = networkRule({ allowed_domains: ['api.test'] })
    await expect(runWithNetwork(rule, () => fetch('https://api.test/a'))).rejects.toThrow(
      'Failed to fetch',
    )
    await expect(runWithNetwork(rule, () => fetch('https://other.test/'))).rejects.toThrow(
      'Failed to fetch',
    )
    const manual = await runWithNetwork(rule, () =>
      fetch('https://api.test/a', { redirect: 'manual' }),
    )
    expect(manual.type).toBe('opaqueredirect')
    expect((await fetch('https://other.test/')).type).toBe('basic')
    expect(asked).toEqual(['manual', 'manual', undefined])
  })

  it('follows a redirect it can see hop by hop, judging each hop', async () => {
    const sent: string[] = []
    answer = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      const headers = new Headers(init?.headers)
      const auth = ['authorization', 'cookie', 'proxy-authorization'].map(
        (name) => headers.get(name) ?? '-',
      )
      sent.push(`${init?.method ?? 'GET'} ${url} ${auth.join(' ')}`)
      const to = { 'https://api.test/a': 'https://dl.test/f', 'https://api.test/b': '/c' }[url]
      if (url === 'https://api.test/bad') {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://other.test/' } }),
        )
      }
      if (to !== undefined) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: to } }))
      }
      return Promise.resolve(new Response(url))
    }
    const rule = networkRule({ allowed_domains: ['api.test', 'dl.test'] })
    const download = await runWithNetwork(rule, () =>
      fetch('https://api.test/a', {
        method: 'POST',
        body: 'x',
        headers: {
          authorization: 'Bearer t',
          cookie: 'session=s',
          'proxy-authorization': 'Basic p',
          'content-type': 'text/plain',
        },
      }),
    )
    expect(await download.text()).toBe('https://dl.test/f')
    const relative = await runWithNetwork(rule, () =>
      fetch('https://api.test/b', { headers: { authorization: 'Bearer t', cookie: 'session=s' } }),
    )
    expect(await relative.text()).toBe('https://api.test/c')
    await expect(runWithNetwork(rule, () => fetch('https://api.test/bad'))).rejects.toThrow(
      'Failed to fetch',
    )
    expect(sent).toEqual([
      'POST https://api.test/a Bearer t session=s Basic p',
      'GET https://dl.test/f - - -',
      'GET https://api.test/b Bearer t session=s -',
      'GET https://api.test/c Bearer t session=s -',
      'GET https://api.test/bad - - -',
    ])
  })

  it('refuses a rule that denies an address it never sees', () => {
    for (const entry of ['10.0.0.0/8', '169.254.169.254', '10.0.0.1:22', '::1', '[::1]:8080']) {
      expect(() => {
        refuseUnseenAddresses({ denied_domains: [entry] })
      }).toThrow(entry)
    }
    refuseUnseenAddresses({
      allowed_domains: ['10.0.0.0/8'],
      denied_domains: ['*:22', 'evil.test', '*.evil.test:443'],
    })
    refuseUnseenAddresses(false)
    refuseUnseenAddresses(undefined)
  })

  it('sends a request where the bound rule routes its host and port', async () => {
    vi.stubGlobal('location', { href: 'https://page.test/' })
    const rule = networkRule({
      routes: {
        'localhost:5003': '127.0.0.1:61001',
        'api.test:443': 'api.test:8443',
        'other.test:443': '[::1]:8443',
      },
    })
    const under = (input: RequestInfo | URL): Promise<string> =>
      runWithNetwork(rule, async () => {
        await Promise.resolve()
        const to = routed(input)
        return to instanceof Request ? to.url : String(to)
      })
    expect(await under('http://localhost:5003/a?b=1')).toBe('http://127.0.0.1:61001/a?b=1')
    expect(await under('https://api.test/x')).toBe('https://api.test:8443/x')
    await expect(under('https://other.test/x')).rejects.toThrow(/cannot route other.test/)
    expect(await under(new Request('ws://localhost:5003/s'))).toBe('ws://127.0.0.1:61001/s')
    expect(await under('http://localhost:5004/')).toBe('http://localhost:5004/')
    expect(routed('http://localhost:5003/')).toBe('http://localhost:5003/')
  })

  it("routes a file call inside a session's line as the line goes", async () => {
    vi.stubGlobal('location', { href: 'https://page.test/' })
    const base = networkRule({ routes: { 's3.test:443': 's3.test:9000' } })
    const session = networkRule({ routes: { 's3.test:443': 's3.test:9001' } })
    const policies = new Policies([])
    const url = await runWithEgress(
      session,
      policies,
      () =>
        runWithEgress(base, policies, () => Promise.resolve(urlOf('https://s3.test/b')), 'a', true),
      'a',
    )
    expect(url).toBe('https://s3.test:9001/b')
  })

  it('refuses a request two live workspaces route apart', async () => {
    vi.stubGlobal('location', { href: 'https://page.test/' })
    const one = networkRule({ routes: { 'localhost:5003': '127.0.0.1:1' } })
    const two = networkRule({ routes: { 'localhost:5003': '127.0.0.1:2' } })
    const lines = apart([one, new Policies([]), 'a', false], [two, new Policies([]), 'a', false])
    await expect(lines).rejects.toThrow(/route localhost:5003 apart/)
  })

  it('refuses a request two live sessions of one workspace route apart', async () => {
    vi.stubGlobal('location', { href: 'https://page.test/' })
    const one = networkRule({ routes: { 'localhost:5003': '127.0.0.1:1' } })
    const two = networkRule({ routes: { 'localhost:5003': '127.0.0.1:2' } })
    const policies = new Policies([])
    const lines = apart([one, policies, 'a', false], [two, policies, 'b', false])
    await expect(lines).rejects.toThrow(/route localhost:5003 apart/)
  })

  it("refuses a file op another session's line routes apart", async () => {
    vi.stubGlobal('location', { href: 'https://page.test/' })
    const base = networkRule({ routes: { 'localhost:5003': '127.0.0.1:1' } })
    const session = networkRule({ routes: { 'localhost:5003': '127.0.0.1:2' } })
    const policies = new Policies([])
    const op = apart([session, policies, 'b', false], [base, policies, 'a', true])
    await expect(op).rejects.toThrow(/route localhost:5003 apart/)
  })

  it("routes a file op beside its own session's line, a glob's read too, as the line goes", async () => {
    vi.stubGlobal('location', { href: 'https://page.test/' })
    const base = networkRule({ routes: { 'localhost:5003': '127.0.0.1:1' } })
    const session = networkRule({ routes: { 'localhost:5003': '127.0.0.1:2' } })
    const policies = new Policies([])
    expect(await apart([session, policies, 'a', false], [base, policies, 'a', true])).toBe(
      'http://127.0.0.1:2/',
    )
  })
})
