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
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { TVLY } from './index.ts'

const DEC = new TextDecoder()

// One reply for every request, each request recorded with the JSON body it
// carried.
function stubApi(body: unknown): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: unknown, init?: RequestInit) => {
      bodies.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
      )
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }),
      )
    }),
  )
  return bodies
}

async function run(line: string): Promise<[number, string, string]> {
  const ws = new Workspace({})
  ws.registerCli('tvly', TVLY, { api_key: 'tvly-k' })
  try {
    const io = await ws.shell(line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

// Mirrors python's tests/commands/cli/builtin/tvly/test_extract.py.
describe('tvly extract', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prints each page whole, then each failure', async () => {
    stubApi({
      results: [{ url: 'https://a', raw_content: 'A\n\n\n\nbody' }],
      failed_results: [{ url: 'https://b', error: 'timeout' }, {}],
    })
    const [code, out] = await run('tvly extract https://a https://b')
    expect(code).toBe(0)
    expect(out).toBe(
      '# https://a\n\nA\n\nbody\n\n' +
        'Failed: https://b: timeout\n' +
        'Failed: undefined: undefined\n',
    )
  })

  it('always sends a timeout in the body', async () => {
    const bodies = stubApi({ results: [] })
    await run('tvly extract https://a --format text --query q')
    expect(bodies[0]).toEqual({ urls: ['https://a'], query: 'q', format: 'text', timeout: 30 })
  })

  it('sends the timeout the line gave', async () => {
    const bodies = stubApi({ results: [] })
    await run('tvly extract https://a --timeout 5')
    expect(bodies[0]?.timeout).toBe(5)
  })

  it.each([
    ['tvly extract', "error: missing required argument 'urls'\n"],
    [
      `tvly extract ${Array.from({ length: 21 }, (_, i) => `u${String(i)}`).join(' ')}`,
      'error: Maximum 20 URLs per request.\n',
    ],
    [
      'tvly extract u --format html',
      "error: option '--format <format>' argument 'html' is invalid. " +
        'Allowed choices are markdown, text.\n',
    ],
  ])('refuses %s as tvly does', async (line, stderr) => {
    expect(await run(line)).toEqual([2, '', stderr])
  })
})
