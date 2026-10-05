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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.ts'
import { AuthMode, type AuthConfig } from '../auth/config.ts'
import { relayStdio } from './relay.ts'

const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const app of apps.splice(0)) await app.close()
})

async function daemon(
  authConfig?: AuthConfig,
): Promise<{ base: string; id: string; headers: Record<string, string> }> {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-rpc-relay-'))
  const app = buildApp({
    allowedHosts: ['*'],
    pidFile: join(dir, 'daemon.pid'),
    ...(authConfig !== undefined ? { authConfig } : {}),
  })
  apps.push(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  const base = `http://127.0.0.1:${String(address.port)}`
  const headers: Record<string, string> =
    authConfig?.bearerToken !== undefined
      ? { Authorization: `Bearer ${authConfig.bearerToken}` }
      : {}
  const created = await fetch(`${base}/v1/workspaces`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } }),
  })
  const { id } = (await created.json()) as { id: string }
  return { base, id, headers }
}

describe('relayStdio', () => {
  it('relays each line to the endpoint', async () => {
    const { base, id } = await daemon()
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'shell', params: { command: 'echo hi' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      'oops',
    ]
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from(lines.map((line) => `${line}\n`)) as unknown as typeof process.stdin,
    )
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    await relayStdio(`${base}/v1/workspaces/${id}/rpc`, () => Promise.resolve(''))
    const answers = written
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map(
        (line) =>
          JSON.parse(line) as {
            id?: number | null
            result?: { stdout: string }
            error?: { code: number }
          },
      )
    const byId = new Map(answers.map((answer) => [answer.id ?? null, answer]))
    expect(byId.get(1)?.result?.stdout).toBe('hi\n')
    expect(byId.get(null)?.error?.code).toBe(-32700)
    expect(answers).toHaveLength(2)
  })

  it('asks for the token on every request', async () => {
    const { base, id } = await daemon({ mode: AuthMode.Token, bearerToken: 'secret' })
    const lines = [1, 2, 3].map((n) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: n,
        method: 'shell',
        params: { command: `echo ${String(n)}` },
      }),
    )
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from(lines.map((line) => `${line}\n`)) as unknown as typeof process.stdin,
    )
    const written: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    let asked = 0
    await relayStdio(`${base}/v1/workspaces/${id}/rpc`, () => {
      asked += 1
      return Promise.resolve('secret')
    })
    const outputs = written
      .join('')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => (JSON.parse(line) as { result: { stdout: string } }).result.stdout)
    expect(outputs.sort()).toEqual(['1\n', '2\n', '3\n'])
    expect(asked).toBe(3)
  })
})
