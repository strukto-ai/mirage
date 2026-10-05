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

import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT } from 'jose'
import ssh2, { type Client } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { createWebSocketStream } from 'ws'
import { buildApp, type MirageApp } from '../app.ts'

const SECRET = 's'.repeat(32)
const RAM = { config: { mounts: { '/': { vfs: 'ram', mode: 'WRITE' } } } }

const apps: MirageApp[] = []
const clients: Client[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.end()
  for (const app of apps.splice(0)) await app.close()
})

async function serving(jwt = false): Promise<{ app: MirageApp; address: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-route-'))
  const app = buildApp({
    ...(jwt
      ? {
          authConfig: {
            mode: 'jwt' as const,
            jwt: {
              algorithm: 'HS256',
              key: SECRET,
              audiences: [],
              authorizedParties: [],
              clockSkewSeconds: 5,
            },
          },
        }
      : {}),
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
  return { app, address: `127.0.0.1:${String((app.server.address() as AddressInfo).port)}` }
}

async function token(sub: string): Promise<Record<string, string>> {
  const signed = await new SignJWT({ sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
    .sign(new TextEncoder().encode(SECRET))
  return { authorization: `Bearer ${signed}` }
}

/** The upgrade's status when the server refuses it, else an open socket. */
function open(
  address: string,
  workspace: string,
  headers: Record<string, string>,
): Promise<WebSocket | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${address}/v1/workspaces/${workspace}/ssh`, { headers })
    ws.once('open', () => {
      resolve(ws)
    })
    ws.once('unexpected-response', (req, res) => {
      resolve(res.statusCode ?? 0)
      req.destroy()
    })
    ws.once('error', reject)
  })
}

function login(ws: WebSocket, username: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client()
    clients.push(client)
    client.on('ready', () => {
      resolve(client)
    })
    client.on('error', reject)
    client.connect({ sock: createWebSocketStream(ws), username, hostVerifier: () => true })
  })
}

function run(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err !== undefined) {
        reject(err)
        return
      }
      let out = ''
      stream.on('data', (d: Buffer) => {
        out += d.toString()
      })
      stream.on('close', () => {
        resolve(out)
      })
    })
  })
}

describe('the SSH route', () => {
  it('runs a line over HTTPS', async () => {
    const { app, address } = await serving()
    expect(
      (await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { ...RAM, id: 'w' } }))
        .statusCode,
    ).toBe(201)
    const ws = await open(address, 'w', {})
    if (typeof ws === 'number') throw new Error(`refused ${String(ws)}`)
    expect(await run(await login(ws, 'w'), 'echo over https')).toBe('over https\n')
  })

  it('lets the login name only the route workspace', async () => {
    const { app, address } = await serving()
    for (const id of ['w', 'other']) {
      await app.inject({ method: 'POST', url: '/v1/workspaces', payload: { ...RAM, id } })
    }
    const ws = await open(address, 'w', {})
    if (typeof ws === 'number') throw new Error(`refused ${String(ws)}`)
    await expect(login(ws, 'other')).rejects.toThrow(/authentication/i)
  })

  it('reaches only the workspace of the token account', async () => {
    const { app, address } = await serving(true)
    const alice = await token('alice')
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/workspaces',
          headers: alice,
          payload: { ...RAM, id: 'w' },
        })
      ).statusCode,
    ).toBe(201)
    expect(await open(address, 'w', await token('bob'))).toBe(404)
    expect(await open(address, 'w', {})).toBe(401)
    const ws = await open(address, 'w', alice)
    if (typeof ws === 'number') throw new Error(`refused ${String(ws)}`)
    expect(await run(await login(ws, 'w'), 'echo mine')).toBe('mine\n')
  })
})
