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
import { route, streamEvents } from './research.ts'

const DEC = new TextDecoder()

const DONE = {
  status: 'completed',
  content: 'The report.',
  sources: [{ title: 'Src', url: 'https://s' }],
}

interface Sent {
  method: string
  url: string
  body: unknown
}

// Each request takes the next reply in order; a string reply is sent as
// the raw body, as an event stream arrives.
function stubApi(...replies: unknown[]): Sent[] {
  const sent: Sent[] = []
  let next = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      sent.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      })
      const reply = replies[Math.min(next, replies.length - 1)]
      next += 1
      return Promise.resolve(
        new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }),
  )
  return sent
}

async function run(
  line: string,
  config: Record<string, unknown> = { api_key: 'tvly-k' },
): Promise<[number, string, string]> {
  const ws = new Workspace({})
  ws.registerCli('tvly', TVLY, config)
  try {
    const io = await ws.shell(line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

// Mirrors python's tests/commands/cli/builtin/tvly/test_research.py.
describe('tvly research', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    [['topic'], 'run', ['topic']],
    [['status'], 'run', ['status']],
    [['status', 'id'], 'status', ['id']],
    [['poll', 'id'], 'poll', ['id']],
    [['run', 'run'], 'run', ['run']],
  ])('routes %j to the verb tvly rewrites it to', (words, verb, rest) => {
    expect(route(words)).toEqual([verb, rest])
  })

  it('keeps each JSON payload of an event stream', () => {
    const text = 'data: {"a": 1}\r\n\ndata:[DONE]\ndata: \nevent: x\ndata:{"b":2}'
    expect(streamEvents(text)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('prints a finished report and its sources', async () => {
    const sent = stubApi(DONE)
    expect(await run("tvly research 'a topic'")).toEqual([
      0,
      'The report.\n\nSources:\n1. Src https://s\n',
      '',
    ])
    expect(sent[0]?.body).toEqual({ stream: false, citation_format: 'numbered', input: 'a topic' })
  })

  it('hands back the request id with --no-wait', async () => {
    stubApi({ request_id: 'r1' })
    const [code, out] = await run('tvly research topic --no-wait')
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual({ request_id: 'r1', status: 'pending' })
  })

  it('polls a pending task until it finishes', async () => {
    const sent = stubApi({ request_id: 'r1', status: 'pending' }, DONE)
    const [code, out] = await run('tvly research topic --poll-interval 1')
    expect(code).toBe(0)
    expect(out.startsWith('The report.\n')).toBe(true)
    expect(sent.map((one) => `${one.method} ${one.url}`)).toEqual([
      'POST https://api.tavily.com/research',
      'GET https://api.tavily.com/research/r1',
    ])
  })

  it('prints the request and its state for status', async () => {
    stubApi({ status: 'failed', error: 'bad' })
    expect(await run('tvly research status r1')).toEqual([
      0,
      '  Request:  r1\n  Status:   failed\n  Error: bad\n',
      '',
    ])
  })

  it('shows the steps of a stream, then the report', async () => {
    const events = [
      {
        choices: [{ delta: { tool_calls: { type: 'tool_call', tool_call: [{ name: 'Plan' }] } } }],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: {
                type: 'tool_response',
                tool_response: [{ name: 'WebSearch', sources: [1, 2] }],
              },
            },
          },
        ],
      },
      { choices: [{ delta: { content: 'Re' } }] },
      { choices: [{ delta: { content: 'port', sources: [{ title: 'T', url: 'u' }] } }] },
    ]
    stubApi(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n')
    expect(await run('tvly research topic --stream')).toEqual([
      0,
      'Report\n\nSources:\n1. T u\n',
      '  Plan\n  Found 2 sources\n',
    ])
  })

  it('hands on each event of a JSON stream as it arrives', async () => {
    const enc = new TextEncoder()
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode('data: {"n": 1}\n\n'))
        await held
        controller.enqueue(enc.encode('data: {"n": 2}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body))),
    )
    const ws = new Workspace({})
    ws.registerCli('tvly', TVLY, { api_key: 'tvly-k' })
    try {
      const execution = await ws.shell('tvly research topic --stream --json', { stream: true })
      const events = execution.events[Symbol.asyncIterator]()
      const first = await events.next()
      release()
      const rest: string[] = []
      for (;;) {
        const next = await events.next()
        if (next.done === true) break
        rest.push(DEC.decode(next.value.data))
      }
      const result = await execution.wait()
      expect(first.done === true ? '' : DEC.decode(first.value.data)).toBe('{"n":1}\n')
      expect(rest.join('')).toBe('{"n":2}\n')
      expect(result.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['--json', '{"n":1}\n', ''],
    ['', '', '  Plan\n'],
  ])('keeps what came before a stream cut short (%j)', async (flags, stdout, steps) => {
    const enc = new TextEncoder()
    const plan = {
      choices: [{ delta: { tool_calls: { type: 'tool_call', tool_call: [{ name: 'Plan' }] } } }],
    }
    const event = flags === '' ? plan : { n: 1 }
    // The first read hands the event over and the next one fails: an error
    // in the same call would drop the queued chunk before it was read.
    let reads = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1
          if (reads === 1) controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
          else controller.error(new TypeError('terminated'))
        },
      },
      { highWaterMark: 0 },
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body))),
    )
    const [code, out, err] = await run(`tvly research topic --stream ${flags}`.trim())
    if (flags === '') {
      expect(out).toBe(stdout)
      expect(
        err.startsWith(`${steps}  > Error: An unexpected error occurred while making the request.`),
      ).toBe(true)
    } else {
      expect(out.startsWith(stdout)).toBe(true)
      expect(out).toContain('{"error":"An unexpected error occurred')
    }
    expect(code).toBe(4)
  })

  it('refuses the options only run takes', async () => {
    expect(await run('tvly research status r1 --model pro')).toEqual([
      2,
      '',
      "error: unknown option '--model'\n",
    ])
  })

  it('needs a key', async () => {
    const [code, , err] = await run('tvly research topic', {})
    expect(code).toBe(3)
    expect(err).toContain('  > The research command requires a Tavily API key.\n')
  })

  it('prints the page --help prints when bare', async () => {
    const bare = await run('tvly research')
    expect(bare).toEqual(await run('tvly research --help'))
    expect(bare[0]).toBe(0)
    expect(bare[1].startsWith('usage: tvly research ')).toBe(true)
  })
})
