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

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'mirage.js')
const SAVED = {
  name: 'ram-only',
  description: 'a RAM disk',
  config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } },
}
const tempDirs: string[] = []
const servers: Server[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const server of servers.splice(0)) server.close()
})

/** A server double: lists SAVED as `{items}`, and keeps every POST body. */
async function fakeServer(): Promise<{ url: string; posted: unknown[] }> {
  const posted: unknown[] = []
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const json = (body: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
      }
      if (req.url === '/v1/health') {
        json({ status: 'ok' })
        return
      }
      if (req.method === 'POST') {
        posted.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        json(SAVED)
        return
      }
      json({ items: [SAVED] })
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${String(port)}`, posted }
}

async function template(
  url: string,
  ...args: string[]
): Promise<{ code: number | null; out: string }> {
  const home = mkdtempSync(join(tmpdir(), 'mirage-template-'))
  tempDirs.push(home)
  const env: NodeJS.ProcessEnv = { ...process.env, MIRAGE_HOME: home, MIRAGE_DAEMON_URL: url }
  const child = spawn(process.execPath, [BIN, 'template', ...args], { env })
  let out = ''
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString()
  })
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  return { code, out }
}

describe('mirage template', () => {
  it('lists the items of the answer', async () => {
    const { url } = await fakeServer()
    const listed = await template(url, 'list', '-o', 'json')
    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.out)).toEqual([SAVED])
  })

  it('reads a hosted template back without the fields the server fills in', async () => {
    const { url, posted } = await fakeServer()
    const dir = mkdtempSync(join(tmpdir(), 'mirage-template-file-'))
    tempDirs.push(dir)
    const file = join(dir, 't.json')
    writeFileSync(
      file,
      JSON.stringify({
        ...SAVED,
        id: 'tpl_1',
        builtin: false,
        secrets: [],
        policies: [],
        created_by: 'usr_1',
        created_at: 1,
        workspace_count: 0,
      }),
    )
    expect((await template(url, 'create', 'copy', '-f', file)).code).toBe(0)
    expect(posted).toEqual([{ ...SAVED, name: 'copy' }])
  })
})
