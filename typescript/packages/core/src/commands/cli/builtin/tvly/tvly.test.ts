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
import {
  TavilyAPIError,
  TavilyKeylessLimit,
  TavilyUnanswered,
} from '../../../../core/tavily/client.ts'
import { materialize } from '../../../../io/types.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { cliSpecFor } from '../../specs.ts'
import { apiFailure, formatSeconds, keylessCapHit, keylessCapText } from './failure.ts'
import { TVLY } from './index.ts'
import { Streams } from './output.ts'

const DEC = new TextDecoder()

async function run(
  line: string,
  config: Record<string, unknown>,
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

async function failure(error: Error, json: boolean): Promise<[string, number, string]> {
  const [out, result] = apiFailure(new Streams(), error, json)
  const bytes = out === null ? new Uint8Array() : await materialize(out)
  return [DEC.decode(bytes), result.exitCode, DEC.decode(await materialize(result.stderr))]
}

// Mirrors python's tests/commands/cli/builtin/tvly/test_tree.py.
describe('tvly tree', () => {
  it('resolves by name', () => {
    expect(cliSpecFor('tvly')).toBe(TVLY)
  })

  it.each([
    ['tvly search q --foo', "error: unknown option '--foo'\n"],
    ['tvly search q --dept basic', "error: unknown option '--dept'\n(Did you mean --depth?)\n"],
    ['tvly search q --json=x', "error: unknown option '--json=x'\n(Did you mean --json?)\n"],
    ['tvly --jso search q', "error: unknown option '--jso'\n(Did you mean --json?)\n"],
    ['tvly search q -x', "error: unknown option '-x'\n"],
    ['tvly search q --max-results', "error: option '--max-results <n>' argument missing\n"],
    ['tvly frob a', 'error: too many arguments. Expected 0 arguments but got 2: frob, a.\n'],
  ])("answers %s in commander's words", async (line, stderr) => {
    expect(await run(line, { api_key: 'tvly-k' })).toEqual([2, '', stderr])
  })

  it('abbreviates no long option', async () => {
    const [code, , err] = await run('tvly search q --max-res 2', { api_key: 'tvly-k' })
    expect(code).toBe(2)
    expect(err.startsWith("error: unknown option '--max-res'\n")).toBe(true)
  })

  it('lists every verb in its help', async () => {
    const [code, out] = await run('tvly --help', { api_key: 'tvly-k' })
    expect(code).toBe(0)
    for (const verb of ['auth', 'search', 'extract', 'crawl', 'map', 'research']) {
      expect(out).toContain(`  ${verb}`)
    }
  })
})

// Mirrors python's tests/commands/cli/builtin/tvly/test_auth.py.
describe('tvly auth', () => {
  it('says a keyed install is signed in without any of the key', async () => {
    const [code, out] = await run('tvly auth', { api_key: 'tvly-secret-value' })
    expect(code).toBe(0)
    expect(out).not.toContain('secret')
    expect(out).toBe("\n  > Authenticated via the tvly install's api_key\n    Key: ***\n\n")
  })

  it("says a keyless install's config sets no key", async () => {
    expect(await run('tvly auth', {})).toEqual([
      0,
      "\n  > Not authenticated\n\n  No api_key is set in this tvly install's config.\n\n",
      '',
    ])
  })

  it('answers a keyless install as unauthenticated in JSON', async () => {
    expect(await run('tvly auth --json', {})).toEqual([
      0,
      '{"authenticated":false,"method":null,"source":null}\n',
      '',
    ])
  })
})

// Mirrors python's tests/commands/cli/builtin/tvly/test_failure.py.
describe('tvly failures', () => {
  it.each([
    [45, '45s'],
    [90, '1m 30s'],
    [120, '2m'],
    [3660, '1h 1m'],
    [90000, '1d 1h'],
  ])('reads a %d second retry delay as %s', (seconds, text) => {
    expect(formatSeconds(seconds)).toBe(text)
  })

  it('says a configured key lifts the cap', async () => {
    const streams = new Streams()
    keylessCapHit(streams, new TavilyKeylessLimit('Daily cap reached', 429, {}))
    const [, result] = streams.result(3)
    expect(DEC.decode(await materialize(result.stderr))).toBe(
      '\n  > Tavily rate limit reached.\n    Daily cap reached\n\n' +
        "  Setting api_key in the tvly install's config removes this cap.\n\n",
    )
  })

  it('names the cap, its retry and how to continue', () => {
    const cap = new TavilyKeylessLimit('Daily cap reached', 429, {
      code: 'keyless_daily',
      retry_after_seconds: 90,
      next_actions: [
        { type: 'signup', instruction: 'Create a key' },
        'not an object',
        { type: 'bonus_credits', params: { questions: ['Why?'], credits_on_completion: 5 } },
      ],
    })
    expect(keylessCapText(cap)).toBe(
      'Tavily rate limit reached.\nDaily cap reached\n\n' +
        'Retry after: 1m 30s (90s)\n\nContinuation options:\n' +
        '  - Sign up for a Tavily API key:  https://tavily.com\n' +
        '      Create a key\n' +
        '  - Earn 5 bonus credits by answering 1 question:\n' +
        '      1. Why?\n' +
        '    POST your answers to: /v1/keyless/bonus',
    )
  })

  it.each([
    [
      new TavilyAPIError('Usage limit', 432),
      3,
      '\n  > Usage limit\n\n  Upgrade your plan at tavily.com\n\n',
    ],
    [new TavilyAPIError('Unauthorized', 401), 3, '  > Error: Unauthorized\n'],
    [new TavilyAPIError('Server', 500), 4, '  > Error: Server\n'],
    [
      new TavilyUnanswered('Request timed out after 30 seconds.'),
      4,
      '  > Error: Request timed out after 30 seconds.\n',
    ],
  ])('exits a failure by its class', async (error, code, stderr) => {
    expect(await failure(error, false)).toEqual(['', code, stderr])
  })

  it('prints a failure as an object on stdout under --json', async () => {
    const [out, code] = await failure(new TavilyAPIError('bad', 400), true)
    expect([out, code]).toEqual(['{"error":"bad"}\n', 4])
  })
})
