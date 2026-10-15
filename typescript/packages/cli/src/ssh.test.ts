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
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type * as Server from '@struktoai/mirage-server'
import type { MirageApp } from '@struktoai/mirage-server'
import ssh2 from 'ssh2'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin', 'mirage.js')
const RAM = { config: { mounts: { '/': { vfs: 'ram', mode: 'WRITE' } } } }
const dirs: string[] = []
let server: typeof Server

beforeAll(async () => {
  server = await import('@struktoai/mirage-server')
}, 60_000)
const apps: MirageApp[] = []

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function serving(): Promise<{ app: MirageApp; url: string; home: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-proxy-'))
  dirs.push(dir)
  const app = server.buildApp({
    authConfig: { mode: 'local' },
    stateRoot: join(dir, 'state'),
    sshConfig: {
      port: null,
      host: '127.0.0.1',
      hostKeyFile: join(dir, 'host_key'),
      authorizedKeysFile: join(dir, 'authorized_keys'),
    },
  })
  apps.push(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  return { app, url: `http://127.0.0.1:${String(port)}`, home: join(dir, 'home') }
}

function proxy(url: string, home: string, workspace: string): ReturnType<typeof spawn> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('MIRAGE_')),
  )
  return spawn(process.execPath, [BIN, 'ssh-proxy', workspace], {
    env: { ...env, MIRAGE_HOME: home, MIRAGE_DAEMON_URL: url },
  })
}

describe('mirage ssh-proxy', () => {
  it('carries an SSH session over the HTTPS route', async () => {
    const { app, url, home } = await serving()
    await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { ...RAM, id: 'w' } })
    const child = proxy(url, home, 'w')
    const sock = Duplex.from({ readable: child.stdout, writable: child.stdin })
    const client = new ssh2.Client()
    try {
      await new Promise<void>((resolve, reject) => {
        client.on('ready', resolve).on('error', reject)
        client.connect({ sock, username: 'w', hostVerifier: () => true })
      })
      const out = await new Promise<string>((resolve, reject) => {
        client.exec('echo through the cli', (err, stream) => {
          if (err !== undefined) {
            reject(err)
            return
          }
          let text = ''
          stream.on('data', (d: Buffer) => (text += d.toString()))
          stream.on('close', () => {
            resolve(text)
          })
        })
      })
      expect(out).toBe('through the cli\n')
    } finally {
      client.end()
      child.kill()
    }
  })

  it('reports a refused tunnel and exits 1', async () => {
    const { url, home } = await serving()
    const child = proxy(url, home, 'missing')
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(code).toBe(1)
    expect(stderr).toContain('404')
  })
})

describe('mirage codex-exec', () => {
  it('relays codex exec-server forward to the route', async () => {
    const { app, url, home } = await serving()
    await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { ...RAM, id: 'w' } })
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MIRAGE_')),
    )
    const child = spawn(process.execPath, [BIN, 'codex-exec', 'w', '--listen', '127.0.0.1:0'], {
      env: { ...env, MIRAGE_HOME: home, MIRAGE_DAEMON_URL: url },
    })
    try {
      const listening = await new Promise<string>((resolve) => {
        let text = ''
        child.stderr.on('data', (d: Buffer) => {
          text += d.toString()
          const line = /listening on (ws:\/\/\S+)/.exec(text)
          if (line?.[1] !== undefined) resolve(line[1])
        })
      })
      const ws = new WebSocket(listening)
      const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
        ws.addEventListener('open', () => {
          ws.send(
            new TextEncoder().encode(
              JSON.stringify({ id: 1, method: 'initialize', params: { clientName: 'f' } }),
            ),
          )
        })
        ws.addEventListener('message', (event) => {
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>)
        })
        ws.addEventListener('error', reject)
      })
      ws.close()
      const browser = await new Promise<number>((resolve, reject) => {
        const req = request(listening.replace('ws://', 'http://'), {
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            Origin: 'http://evil.example',
          },
        })
        req.on('response', (res) => {
          resolve(res.statusCode ?? 0)
          res.resume()
        })
        req.on('upgrade', (_res, socket) => {
          socket.destroy()
          resolve(101)
        })
        req.on('error', reject)
        req.end()
      })
      expect(listening).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
      expect(answer.result).toHaveProperty('sessionId')
      expect(browser).toBe(403)
    } finally {
      child.kill()
    }
  })
})
