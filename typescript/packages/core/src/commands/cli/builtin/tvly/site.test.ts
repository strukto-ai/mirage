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
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
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

async function run(
  line: string,
  config: Record<string, unknown> = { api_key: 'tvly-k' },
): Promise<[number, string, string]> {
  const ws = new Workspace({ '/work': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.registerCli('tvly', TVLY, config)
  try {
    const io = await ws.shell(line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

// Mirrors python's tests/commands/cli/builtin/tvly/test_site.py.
describe('tvly crawl and map', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('prints one url a line for map', async () => {
    const bodies = stubApi({ results: ['https://a/', 'https://a/b'] })
    expect(await run('tvly map https://a --limit 2')).toEqual([0, 'https://a/\nhttps://a/b\n', ''])
    expect(bodies[0]).toEqual({ url: 'https://a', limit: 2, timeout: 150 })
  })

  it('sends the site filters as lists', async () => {
    const bodies = stubApi({ results: [] })
    await run(
      "tvly map https://a --select-paths '/docs/.*, /blog/.*' --allow-external --no-external",
    )
    expect(bodies[0]?.select_paths).toEqual(['/docs/.*', '/blog/.*'])
    expect(bodies[0]?.allow_external).toBe(false)
  })

  it('saves each crawled page under its slug', async () => {
    stubApi({
      results: [
        { url: 'https://a.example/guide/', raw_content: 'one' },
        { url: 'https://a.example/Guide', raw_content: 'two' },
        { url: 'https://a.example/empty', raw_content: '' },
      ],
    })
    expect(
      await run(
        'cd /work && tvly crawl https://a.example --output-dir pages && ' +
          'ls pages && cat pages/a.example_guide.md',
      ),
    ).toEqual([
      0,
      'a.example_Guide-2.md\na.example_guide.md\n# https://a.example/guide/\n\none\n',
      'Saved 2 pages to pages/\n',
    ])
  })

  it('needs a key the config sets', async () => {
    expect(await run('tvly map https://a', {})).toEqual([
      3,
      '',
      '\n  > The map command requires a Tavily API key.\n\n' +
        "  No api_key is set in this tvly install's config.\n\n" +
        '  Tip: tvly search and tvly extract work without an API key ' +
        '(subject to a rate-limit cap).\n\n',
    ])
  })

  it('refuses more than one start', async () => {
    expect(await run('tvly crawl a b')).toEqual([
      2,
      '',
      "error: too many arguments for 'crawl'. Expected 1 argument but got 2: a, b.\n",
    ])
  })
})
