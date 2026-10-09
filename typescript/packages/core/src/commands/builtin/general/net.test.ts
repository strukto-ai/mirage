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

import { invoke } from '../../../io/stdio.ts'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import type { PathSpec } from '../../../types.ts'
import { materialize, type IOResult } from '../../../io/types.ts'
import type { CommandOpts } from '../../config.ts'
import { GENERAL_CURL } from './curl.ts'
import { GENERAL_WGET } from './wget.ts'

const DEC = new TextDecoder()
const HTML = '<html><body><h1>Local Test Page</h1></body></html>'

function opts(overrides: Partial<CommandOpts> = {}): CommandOpts {
  return {
    stdin: null,
    flags: {},
    cwd: '/',
    ...overrides,
  }
}

async function runCurl(
  url: string,
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ out: Uint8Array; io: IOResult }> {
  const vfs = new RAMVFS()
  const cmd = GENERAL_CURL[0]
  if (cmd === undefined) throw new Error('curl not registered')
  const result = await invoke(() => cmd.fn(vfs.accessor, [] as PathSpec[], [url], opts({ flags })))
  if (result === null) throw new Error('null result')
  const [out, io] = result
  return { out: await materialize(out), io }
}

async function runWget(
  url: string,
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ out: Uint8Array; io: IOResult }> {
  const vfs = new RAMVFS()
  const cmd = GENERAL_WGET[0]
  if (cmd === undefined) throw new Error('wget not registered')
  const result = await invoke(() => cmd.fn(vfs.accessor, [] as PathSpec[], [url], opts({ flags })))
  if (result === null) throw new Error('null result')
  const [out, io] = result
  return { out: await materialize(out), io }
}

describe.concurrent('net over local HTTP', () => {
  let base: string
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/post') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            form:
              request.headers['content-type'] === 'application/x-www-form-urlencoded'
                ? Object.fromEntries(new URLSearchParams(body))
                : null,
          }),
        )
      })
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(HTML)
  })

  beforeAll(async () => {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no HTTP port')
    base = `http://127.0.0.1:${String(address.port)}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  })

  it('curl raw returns HTML', async () => {
    const { out, io } = await runCurl(base)
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(out)).toBe(HTML)
  })

  it('wget downloads the response body', async () => {
    const { io } = await runWget(base)
    expect(io.exitCode).toBe(0)
    const writes = Object.values(io.writes)
    expect(writes).toHaveLength(1)
    expect(DEC.decode(await materialize(writes[0]))).toBe(HTML)
  })

  it('curl -X POST sends form data', async () => {
    const { out, io } = await runCurl(`${base}/post`, {
      request: 'POST',
      data: 'hello=world',
    })
    expect(io.exitCode).toBe(0)
    expect(DEC.decode(out)).toBe('{"form":{"hello":"world"}}')
  })
})
