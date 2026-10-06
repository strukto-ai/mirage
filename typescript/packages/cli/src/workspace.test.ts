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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'


const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'mirage.js')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('mirage workspace create', () => {
  it('refuses a config naming an unset variable with exit 2, before any request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-workspace-'))
    tempDirs.push(dir)
    const config = join(dir, 'missing.yaml')
    writeFileSync(config, 'mounts:\n  /:\n    vfs: ram\n    mode: ${MIRAGE_TEST_UNSET_VARIABLE}\n')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MIRAGE_HOME: dir,
      MIRAGE_DAEMON_URL: 'http://127.0.0.1:9',
    }
    delete env.MIRAGE_TEST_UNSET_VARIABLE
    const child = spawn(process.execPath, [BIN, 'workspace', 'create', config], { env })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(code).toBe(2)
    expect(stderr).toContain('MIRAGE_TEST_UNSET_VARIABLE')
  })
})

interface Seen {
  method: string
  url: string
  type: string
  body: string
}

/** A server double: answers health, a snapshot and a load, and keeps every other request. */
async function fakeServer(): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = req.url ?? ''
      if (url === '/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')
        return
      }
      seen.push({
        method: req.method ?? '',
        url,
        type: req.headers['content-type'] ?? '',
        body: Buffer.concat(chunks).toString('latin1'),
      })
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/x-tar' }).end('TAR')
        return
      }
      const answer = url.endsWith('/snapshot')
        ? { id: 'w', key: 'a.tar', size: 3 }
        : { id: 'w2', mounts: [], sessions: [], created_at: 0 }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${String(port)}`, seen, server }
}

async function mirage(url: string, home: string, ...args: string[]): Promise<number | null> {
  const env: NodeJS.ProcessEnv = { ...process.env, MIRAGE_HOME: home, MIRAGE_DAEMON_URL: url }
  const child = spawn(process.execPath, [BIN, 'workspace', ...args], { env })
  return new Promise<number | null>((resolve) => child.on('close', resolve))
}

describe('mirage workspace snapshot and load', () => {
  it('write the tar here, put a key in the store, and upload a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-snapshot-'))
    tempDirs.push(dir)
    const { url, seen, server } = await fakeServer()
    try {
      const out = join(dir, 'w.tar')
      expect(await mirage(url, dir, 'snapshot', 'w', out)).toBe(0)
      expect(readFileSync(out, 'utf8')).toBe('TAR')
      expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/workspaces/w/snapshot' })

      expect(await mirage(url, dir, 'snapshot', 'w', '--key', 'a.tar')).toBe(0)
      expect(seen[1]).toMatchObject({ method: 'POST', url: '/v1/workspaces/w/snapshot' })
      expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ key: 'a.tar' })

      expect(await mirage(url, dir, 'load', out, '--id', 'w2')).toBe(0)
      expect(seen[2]?.type).toContain('multipart/form-data')
      expect(seen[2]?.body).toContain('{"id":"w2"}')
      expect(seen[2]?.body).toContain('name="snapshot"')
      expect(seen[2]?.body).toContain('TAR')

      const config = join(dir, 'c.yaml')
      writeFileSync(config, 'mounts:\n  /ram:\n    vfs: ram\n')
      expect(await mirage(url, dir, 'load', '--key', 'a.tar', config)).toBe(0)
      const body = JSON.parse(seen[3]?.body ?? '') as { key: string; override: unknown }
      expect(body.key).toBe('a.tar')
      expect(body.override).toMatchObject({ mounts: { '/ram': { vfs: 'ram' } } })
    } finally {
      server.close()
    }
  })

  it('refuse a file and a key together, or neither, with exit 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-snapshot-'))
    tempDirs.push(dir)
    const { url, seen, server } = await fakeServer()
    try {
      expect(await mirage(url, dir, 'snapshot', 'w')).toBe(2)
      expect(await mirage(url, dir, 'snapshot', 'w', join(dir, 'x.tar'), '--key', 'k')).toBe(2)
      const config = join(dir, 'c.yaml')
      writeFileSync(config, 'mounts: {}\n')
      expect(await mirage(url, dir, 'load', '--key', 'a.tar', config, config)).toBe(2)
      expect(seen).toEqual([])
    } finally {
      server.close()
    }
  })
})
