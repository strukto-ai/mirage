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
import { RAMResource } from '../../../resource/ram/ram.ts'
import type { PathSpec } from '../../../types.ts'
import type { IOResult } from '../../../io/types.ts'
import type { CommandOpts } from '../../config.ts'
import { GENERAL_CURL } from './curl.ts'
import { GENERAL_WGET } from './wget.ts'

const DEC = new TextDecoder()

function opts(overrides: Partial<CommandOpts> = {}): CommandOpts {
  return {
    stdin: null,
    flags: {},
    filetypeFns: null,
    cwd: '/',
    ...overrides,
  }
}

async function runCurl(
  url: string,
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ out: Uint8Array; io: IOResult }> {
  const resource = new RAMResource()
  const cmd = GENERAL_CURL[0]
  if (cmd === undefined) throw new Error('curl not registered')
  const result = await cmd.fn(resource.accessor, [] as PathSpec[], [url], opts({ flags }))
  if (result === null) throw new Error('null result')
  const [out, io] = result
  if (out === null) return { out: new Uint8Array(), io }
  const buf = out instanceof Uint8Array ? out : new Uint8Array()
  return { out: buf, io }
}

async function runWget(
  url: string,
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ out: Uint8Array; io: IOResult }> {
  const resource = new RAMResource()
  const cmd = GENERAL_WGET[0]
  if (cmd === undefined) throw new Error('wget not registered')
  const result = await cmd.fn(resource.accessor, [] as PathSpec[], [url], opts({ flags }))
  if (result === null) throw new Error('null result')
  const [out, io] = result
  if (out === null) return { out: new Uint8Array(), io }
  const buf = out instanceof Uint8Array ? out : new Uint8Array()
  return { out: buf, io }
}

describe.concurrent('net (live network, port of test_net.py)', () => {
  // Use example.com (IANA reserved, rock-solid) rather than httpbin.org,
  // which returns 502 intermittently and breaks CI.
  it('curl raw returns html', async () => {
    const { out } = await runCurl('https://example.com')
    const body = DEC.decode(out).toLowerCase()
    expect(body.includes('<html') || body.includes('<h1')).toBe(true)
  }, 30_000)

  it('curl on example.com contains Example Domain', async () => {
    const { out } = await runCurl('https://example.com')
    const body = DEC.decode(out)
    expect(body).toContain('Example Domain')
  }, 30_000)

  it('wget on example.com downloads body containing Example Domain', async () => {
    const { io } = await runWget('https://example.com')
    const writes = Object.values(io.writes)
    expect(writes.length).toBe(1)
    const body = DEC.decode(writes[0] as Uint8Array)
    expect(body).toContain('Example Domain')
  }, 30_000)

  it('curl -X POST to postman-echo echoes the data', async () => {
    // postman-echo.com is more reliable than httpbin.org for POST echoing.
    const { out } = await runCurl('https://postman-echo.com/post', {
      X: 'POST',
      d: 'hello=world',
    })
    const body = DEC.decode(out)
    expect(body).toContain('hello=world')
  }, 30_000)
})
