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
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ENV_AUTH_MODE, ENV_AUTH_TOKEN, ENV_DAEMON_PORT, ENV_DAEMON_URL, ENV_TOKEN } from './env.ts'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'mirage.js')
const TOKEN = 'vfs-test-token'
// Bytes that are not UTF-8, split across chunks.
const BINARY = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
  Buffer.from([0xff, 0xfe, 0x00]),
  Buffer.from([0xc3]),
]
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function run(
  args: string[],
): Promise<{ code: number | null; stdout: Buffer; posted: unknown[] }> {
  const posted: unknown[] = []
  const stub = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.url === '/v1/workspaces/demo/vfs/read') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { stream?: boolean }
        posted.push(body)
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' })
          for (const chunk of BINARY) res.write(chunk)
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(Buffer.concat(BINARY).toString('base64')))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = stub.address() as AddressInfo
    const home = mkdtempSync(join(tmpdir(), 'mirage-vfs-'))
    tempDirs.push(home)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
    Object.assign(env, {
      MIRAGE_HOME: home,
      [ENV_DAEMON_URL]: `http://127.0.0.1:${String(port)}`,
      [ENV_DAEMON_PORT]: String(port),
      [ENV_AUTH_MODE]: 'local',
      [ENV_AUTH_TOKEN]: TOKEN,
      [ENV_TOKEN]: TOKEN,
    })
    const child = spawn(process.execPath, [BIN, 'workspace', 'vfs', 'read', ...args], { env })
    const out: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stdin.end()
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    return { code, stdout: Buffer.concat(out), posted }
  } finally {
    await new Promise((resolve) => stub.close(resolve))
  }
}

describe('mirage workspace vfs read', () => {
  it('writes the bytes as they are', async () => {
    const { code, stdout, posted } = await run(['/img.png', '-w', 'demo'])
    expect(code).toBe(0)
    expect(stdout.equals(Buffer.concat(BINARY))).toBe(true)
    expect(posted).toEqual([{ path: '/img.png', stream: true }])
  }, 60_000)

  it('keeps the JSON answer with --json', async () => {
    const { code, stdout, posted } = await run(['/img.png', '--json', '-w', 'demo'])
    expect(code).toBe(0)
    expect(JSON.parse(stdout.toString('utf-8'))).toBe(Buffer.concat(BINARY).toString('base64'))
    expect(posted).toEqual([{ path: '/img.png' }])
  }, 60_000)
})
