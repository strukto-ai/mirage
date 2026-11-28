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

const ANSWER = {
  query: 'q',
  answer: 'An  answer.',
  results: [
    { title: 'First', url: 'https://a.example', content: 'a  b\nc' },
    { title: '', url: 'https://b.example', content: '' },
  ],
  images: ['https://img.example/1.png', { url: 'https://img.example/2' }],
}

interface Reply {
  status?: number
  body: unknown
}

// Each request takes the next reply in order and is recorded with the JSON
// body it carried, so a test reads back exactly what tvly sent.
function stubApi(...replies: Reply[]): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = []
  let next = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: unknown, init?: RequestInit) => {
      bodies.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
      )
      const reply = replies[Math.min(next, replies.length - 1)]
      next += 1
      return Promise.resolve(
        new Response(JSON.stringify(reply?.body), {
          status: reply?.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }),
  )
  return bodies
}

async function run(line: string): Promise<[number, string, string]> {
  const ws = new Workspace({ '/work': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.registerCli('tvly', TVLY, { api_key: 'tvly-k' })
  try {
    const io = await ws.shell(line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

// Mirrors python's tests/commands/cli/builtin/tvly/test_search.py.
describe('tvly search', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("prints tvly's piped text", async () => {
    stubApi({ body: ANSWER })
    expect(await run('tvly search q --max-chars 3')).toEqual([
      0,
      'Answer: An  answer.\n\n' +
        '1. First\nhttps://a.example\na b...\n\n' +
        '2. Untitled\nhttps://b.example\n\n' +
        'Image: https://img.example/1.png\n' +
        'Image: https://img.example/2\n',
      '',
    ])
  })

  it("fills the body in the SDK catalog's order", async () => {
    const bodies = stubApi({ body: { results: [] } })
    const [code, out] = await run(
      'tvly search q --time-range week --max-results 2 --depth fast ' +
        '--include-answer --include-domains a.com,,\ufeffb.com',
    )
    expect([code, out]).toEqual([0, 'No results found.\n'])
    const body = bodies[0] ?? {}
    expect(Object.keys(body)).toEqual([
      'query',
      'search_depth',
      'max_results',
      'include_answer',
      'include_domains',
      'time_range',
    ])
    expect(body.include_answer).toBe('basic')
    expect(body.include_domains).toEqual(['a.com', 'b.com'])
  })

  it('prints the answer unchanged under --json', async () => {
    stubApi({ body: { results: [], response_time: 1.0 } })
    expect(await run('tvly search q --json')).toEqual([
      0,
      '{\n  "results": [],\n  "response_time": 1\n}\n',
      '',
    ])
  })

  it('prints several queries under headers from each answer', async () => {
    stubApi(
      { body: { query: 'one', results: [{ title: 'T', url: 'u' }] } },
      { status: 500, body: { detail: { error: 'boom' } } },
    )
    const [code, out] = await run('tvly search one two')
    expect(code).toBe(0)
    expect(out).toBe('=== [1/2] one\n1. T\nu\n\n=== [2/2] two\nerror: boom\n\n')
  })

  it('exits as the last failure when every query fails', async () => {
    stubApi({ status: 500, body: { detail: { error: 'boom' } } })
    const [code, out] = await run('tvly search one two')
    expect(code).toBe(4)
    expect(out.split('error: boom').length - 1).toBe(2)
  })

  it('reads a query from stdin with a dash', async () => {
    const bodies = stubApi({ body: { results: [] } })
    const [code] = await run("echo '  piped query  ' | tvly search -")
    expect(code).toBe(0)
    expect(bodies[0]?.query).toBe('piped query')
  })

  it('saves the JSON with -o and still prints the text', async () => {
    stubApi({ body: { results: [{ title: 'T', url: 'u' }] } })
    const [code, out, err] = await run('cd /work && tvly search q -o r/s.json && cat r/s.json')
    expect(code).toBe(0)
    expect(err).toBe('Output saved to r/s.json\n')
    expect(out.startsWith('1. T\nu\n\n')).toBe(true)
    expect(JSON.parse(out.split('\n\n').slice(1).join('\n\n'))).toEqual({
      results: [{ title: 'T', url: 'u' }],
    })
  })

  it('names a bare -o file under .tavily', async () => {
    stubApi({ body: { results: [] } })
    const [code, out, err] = await run(
      "cd /work && tvly search 'Hello World' -o --json && ls -A .tavily && cat .tavily/.gitignore",
    )
    expect(code).toBe(0)
    expect(err.startsWith('Output saved to .tavily/search-hello-world-')).toBe(true)
    expect(out.startsWith('.gitignore\nsearch-hello-world-')).toBe(true)
    expect(out.endsWith('.json\n*\n')).toBe(true)
  })

  it.each([
    [
      'tvly search',
      "error: QUERY is required. Pass a query string or use '-' to read from stdin.\n",
    ],
    ['tvly search a b c d e f', 'error: At most 5 queries per command, got 6.\n'],
    [
      'tvly search q --depth x',
      "error: option '--depth <value>' argument 'x' is invalid. " +
        'Allowed choices are basic, advanced, fast, ultra-fast.\n',
    ],
    [
      'tvly search q --include-answer maybe',
      "error: option '--include-answer [value]' argument 'maybe' is invalid. " +
        'Allowed choices are basic, advanced, false, true.\n',
    ],
    [
      'tvly search q --max-results 30',
      "error: option '--max-results <n>' argument '30' is invalid. " +
        '30 is above the maximum 20.\n',
    ],
  ])('refuses %s as tvly does', async (line, stderr) => {
    expect(await run(line)).toEqual([2, '', stderr])
  })
})
