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
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Seen {
  method: string
  url: string
  auth: string
  body: string
}

const TAR = Buffer.from([0, 0xff, 0x54, 0x41, 0x52, 0x80])
const NDJSON = '{"stream": "stdout", "data": "aGkK"}\n{"status": "done"}\n'

/**
 * A server double: answers health, a 204 for a DELETE, a 404 under /missing,
 * a tar under /snapshot, NDJSON under /stream, and every other request with
 * what it got, as JSON.
 */
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
      const got = {
        method: req.method ?? '',
        url,
        auth: req.headers.authorization ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      }
      seen.push(got)
      if (req.method === 'DELETE') res.writeHead(204).end()
      else if (url.startsWith('/missing'))
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"detail":"not found"}')
      else if (url.startsWith('/invalid'))
        res.writeHead(422, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            detail: [{ type: 'missing', loc: ['body', 'config', 'mounts'], msg: 'Field required' }],
          }),
        )
      else if (url.endsWith('/snapshot'))
        res.writeHead(200, { 'content-type': 'application/x-tar' }).end(TAR)
      else if (url.endsWith('/stream'))
        res.writeHead(200, { 'content-type': 'application/x-ndjson' }).end(NDJSON)
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(got))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${String(port)}`, seen, server }
}

async function api(
  url: string,
  home: string,
  ...args: string[]
): Promise<{ code: number | null; stdout: string; bytes: Buffer; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MIRAGE_HOME: home,
    MIRAGE_DAEMON_URL: url,
    MIRAGE_TOKEN: 'tk',
  }
  const child = spawn(process.execPath, [BIN, 'api', ...args], { env })
  const out: Buffer[] = []
  let stderr = ''
  child.stdout.on('data', (c: Buffer) => out.push(c))
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
  const bytes = Buffer.concat(out)
  return { code, stdout: bytes.toString(), bytes, stderr }
}

async function withServer(
  run: (url: string, dir: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-api-'))
  tempDirs.push(dir)
  const { url, seen, server } = await fakeServer()
  try {
    await run(url, dir, seen)
  } finally {
    server.close()
  }
}

describe('mirage api', () => {
  it('posts long options as a JSON body, with the CLI token', async () => {
    await withServer(async (url, dir, seen) => {
      const source = join(dir, 'guard.py')
      writeFileSync(source, 'def pre_command(ctx):\n    return None\n')
      const r = await api(
        url,
        dir,
        '/v1/policies',
        '--name',
        'guard.py',
        `--source=@${source}`,
        '--fields',
        '{"token": "ghp_1", "port": 22}',
        '--tags',
        '["a"]',
        '--note=a=b',
        '--live',
        '--empty=',
      )
      expect(r.code).toBe(0)
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/policies', auth: 'Bearer tk' })
      expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
        name: 'guard.py',
        source: 'def pre_command(ctx):\n    return None\n',
        fields: { token: 'ghp_1', port: 22 },
        tags: ['a'],
        note: 'a=b',
        live: true,
        empty: '',
      })
      expect(JSON.parse(r.stdout)).toMatchObject({ method: 'POST', url: '/v1/policies' })
    })
  })

  it('sends a YAML file as the body, and a GET with no body', async () => {
    await withServer(async (url, dir, seen) => {
      const input = join(dir, 'template.yaml')
      writeFileSync(input, 'name: t\nconfig:\n  mounts:\n    /data: {vfs: ram}\n')
      expect((await api(url, dir, 'v1/templates', '--input', input)).code).toBe(0)
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/templates' })
      expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
        name: 't',
        config: { mounts: { '/data': { vfs: 'ram' } } },
      })
      expect((await api(url, dir, '/v1/workspaces')).code).toBe(0)
      expect(seen[1]).toMatchObject({ method: 'GET', url: '/v1/workspaces', body: '' })
    })
  })

  it("keeps a file's byte-order mark, as Python does", async () => {
    await withServer(async (url, dir, seen) => {
      const marked = join(dir, 'marked.txt')
      writeFileSync(marked, Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))
      expect((await api(url, dir, '/v1/x', '--source', `@${marked}`)).code).toBe(0)
      expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ source: '\ufeffhi' })
    })
  })

  it('keeps YAML timestamps as text', async () => {
    await withServer(async (url, dir, seen) => {
      const input = join(dir, 'workspace.yaml')
      writeFileSync(input, 'config:\n  system_time: 2026-03-02T09:00:00Z\n')
      expect((await api(url, dir, '/v1/workspaces', '--input', input)).code).toBe(0)
      expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
        config: { system_time: '2026-03-02T09:00:00Z' },
      })
    })
  })

  it('prints any other answer byte for byte', async () => {
    await withServer(async (url, dir) => {
      const tar = await api(url, dir, '/v1/workspaces/w/snapshot')
      expect(tar.code).toBe(0)
      expect(tar.bytes.equals(TAR)).toBe(true)
      const lines = await api(url, dir, '/v1/workspaces/w/shell/stream', '--command', 'echo hi')
      expect(lines).toMatchObject({ code: 0, stdout: NDJSON })
    })
  })

  it("puts a GET's fields in its query, and prints nothing for a 204", async () => {
    await withServer(async (url, dir, seen) => {
      expect(
        (await api(url, dir, '/v1/vfs', '--q', 'gh', '-X', 'get', '--type=github', '--live')).code,
      ).toBe(0)
      expect(seen[0]?.url).toBe('/v1/vfs?q=gh&type=github&live=true')
      const kept = await api(url, dir, '/v1/w/logs?session=s1', '--limit=1', '-X', 'GET')
      expect(kept.code).toBe(0)
      expect(seen.at(-1)?.url).toBe('/v1/w/logs?session=s1&limit=1')
      const gone = await api(url, dir, '/v1/vfs/gh', '-X', 'DELETE')
      expect(gone).toMatchObject({ code: 0, stdout: '' })
      expect(seen.at(-1)).toMatchObject({ method: 'DELETE', url: '/v1/vfs/gh' })
    })
  })

  it('exits 2 with the detail of an error answer, and on a bad call before sending it', async () => {
    await withServer(async (url, dir, seen) => {
      const missing = await api(url, dir, '/missing')
      expect(missing.code).toBe(2)
      expect(missing.stderr).toContain('404: not found')
      const input = join(dir, 'b.json')
      writeFileSync(input, '{}')
      const latin1 = join(dir, 'latin1.txt')
      writeFileSync(latin1, Buffer.from([0x63, 0x61, 0x66, 0xe9]))
      for (const args of [
        ['https://elsewhere.example/v1/x'],
        ['--name', 'x', '/v1/x'],
        ['/v1/x', 'stray'],
        ['/v1/x', '-n', 'x'],
        ['/v1/x', '--=x'],
        ['/v1/x', '--fields', '{token: 1}'],
        ['/v1/x', '--a', '1', '--input', input],
        ['/v1/x', '-X', 'GET', '--input', input],
        ['/v1/x', '--source', `@${latin1}`],
        ['/v1/x', '--input', latin1],
      ]) {
        const r = await api(url, dir, ...args)
        expect(r.code, args.join(' ')).toBe(2)
        expect(r.stderr, args.join(' ')).not.toContain('    at ')
      }
      expect(seen).toHaveLength(1)
    })
  })

  it('exits 2 and preserves structured validation details', async () => {
    await withServer(async (url, dir) => {
      const answer = await api(url, dir, '/invalid')
      expect(answer.code).toBe(2)
      expect(answer.stderr).toMatch(/^error 422: /)
      expect(JSON.parse(answer.stderr.replace(/^error 422: /, ''))).toEqual([
        { type: 'missing', loc: ['body', 'config', 'mounts'], msg: 'Field required' },
      ])
    })
  })
})
