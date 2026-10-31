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

import { networkRule, runWithNetwork } from '@struktoai/mirage-core/io/network'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { routed, watchNetwork } from './network.ts'

describe('the page network watcher', () => {
  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('follows no redirect under a rule, since a page cannot see where one goes', async () => {
    const asked: (RequestRedirect | undefined)[] = []
    vi.stubGlobal('location', { href: 'https://page.test/' })
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(init?.redirect)
      const type = init?.redirect === 'manual' ? 'opaqueredirect' : 'basic'
      return Promise.resolve({ type } as Response)
    })
    watchNetwork()
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

  it('sends a request where the bound rule routes its host and port', async () => {
    vi.stubGlobal('location', { href: 'https://page.test/' })
    const rule = networkRule({
      routes: { 'localhost:5003': '127.0.0.1:61001', 'api.test:443': '[::1]:8443' },
    })
    const under = (input: RequestInfo | URL): Promise<string> =>
      runWithNetwork(rule, () => {
        const to = routed(input)
        return Promise.resolve(to instanceof Request ? to.url : String(to))
      })
    expect(await under('http://localhost:5003/a?b=1')).toBe('http://127.0.0.1:61001/a?b=1')
    expect(await under('https://api.test/x')).toBe('https://[::1]:8443/x')
    expect(await under(new Request('ws://localhost:5003/s'))).toBe('ws://127.0.0.1:61001/s')
    expect(await under('http://localhost:5004/')).toBe('http://localhost:5004/')
    expect(routed('http://localhost:5003/')).toBe('http://localhost:5003/')
  })
})
