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

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { NetworkSetting } from '@struktoai/mirage-core/io/network'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import type {
  Deny,
  NetworkContext,
  NetworkResultContext,
} from '@struktoai/mirage-core/policy/types'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Workspace } from '../workspace.ts'
import { rulePool } from './network.ts'

describe('a workspace network rule', () => {
  let server: Server
  let port = 0

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  async function curl(network: NetworkSetting | undefined, host = '127.0.0.1'): Promise<number> {
    const ws = new Workspace({ '/data': new RAMVFS() }, network === undefined ? {} : { network })
    try {
      return (await ws.shell(`curl -sS http://${host}:${String(port)}/`)).exitCode
    } finally {
      await ws.close()
    }
  }

  it.each<[string, NetworkSetting | undefined, number]>([
    ['unset', undefined, 0],
    ['true', true, 0],
    ['an allowed range', { allowed_domains: ['127.0.0.0/8'] }, 0],
    ['false', false, 7],
    ['another host only', { allowed_domains: ['example.com'] }, 7],
    ['a denied range', { denied_domains: ['127.0.0.0/8'] }, 7],
    ['every host but a denied one', { allowed_domains: ['*'], denied_domains: ['127.0.0.1'] }, 7],
  ])('%s', async (_name, network, exitCode) => {
    expect(await curl(network)).toBe(exitCode)
  })

  it('judges a name by the host it was asked for', async () => {
    expect(await curl({ allowed_domains: ['localhost'] }, 'localhost')).toBe(0)
    expect(await curl({ allowed_domains: ['example.com'] }, 'localhost')).toBe(7)
  })

  it('holds an entry to the one port it names', async () => {
    expect(await curl({ allowed_domains: [`127.0.0.1:${String(port)}`] })).toBe(0)
    expect(await curl({ allowed_domains: ['127.0.0.1:1'] })).toBe(7)
    expect(await curl({ denied_domains: [`*:${String(port)}`] })).toBe(7)
    expect(await curl({ allowed_domains: [`localhost:${String(port)}`] }, 'localhost')).toBe(0)
    expect(await curl({ allowed_domains: ['localhost:1'] }, 'localhost')).toBe(7)
  })

  it('never lends one workspace a socket another opened', async () => {
    const open = new Workspace(
      { '/data': new RAMVFS() },
      { network: { allowed_domains: ['127.0.0.1'] } },
    )
    const shut = new Workspace({ '/data': new RAMVFS() }, { network: false })
    try {
      const url = `http://127.0.0.1:${String(port)}/`
      expect((await open.shell(`curl -sS ${url}`)).exitCode).toBe(0)
      expect((await shut.shell(`curl -sS ${url}`)).exitCode).toBe(7)
      expect((await open.shell(`curl -sS ${url}`)).exitCode).toBe(0)
    } finally {
      await open.close()
      await shut.close()
    }
  })

  it('closes the pools a workspace opened as it closes', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { network: { allowed_domains: ['127.0.0.1'] } },
    )
    const rule = ws.registry.network
    expect(rule).not.toBeNull()
    if (rule === null) return
    const url = `http://127.0.0.1:${String(port)}/`
    expect((await ws.shell(`curl -sS ${url}`)).exitCode).toBe(0)
    const pool = rulePool(rule)
    await ws.close()
    expect(pool.closed).toBe(true)
    expect(rulePool(rule)).not.toBe(pool)
  })

  // Refuses the hosts it is given, counts what is in flight, keeps what each
  // method saw.
  class Watch implements Policy {
    open = 0
    most = 0
    readonly asked: NetworkContext[] = []
    readonly ended: NetworkResultContext[] = []
    constructor(private readonly refused: readonly string[] = []) {}

    preNetwork(ctx: NetworkContext): Deny | null {
      this.asked.push(ctx)
      if (this.refused.includes(ctx.host)) {
        return { kind: 'deny', reason: `${ctx.host} is not for this tenant` }
      }
      this.open += 1
      this.most = Math.max(this.most, this.open)
      return null
    }

    postNetwork(ctx: NetworkResultContext): null {
      this.ended.push(ctx)
      this.open -= 1
      return null
    }
  }

  async function watched(watch: Watch, line: string): Promise<number> {
    const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] as const })
    ws.policies.add(watch)
    try {
      return (await ws.shell(line)).exitCode
    } finally {
      await ws.close()
    }
  }

  it('refuses a request preNetwork denies as a closed port', async () => {
    const watch = new Watch(['127.0.0.1'])
    const url = `http://127.0.0.1:${String(port)}/`
    expect(await watched(watch, `curl -sS ${url}`)).toBe(7)
    expect(await watched(watch, `wget -q -O - ${url}`)).toBe(4)
    const [asked] = watch.asked
    expect([asked?.url, asked?.method, asked?.host, asked?.port]).toEqual([
      url,
      'GET',
      '127.0.0.1',
      port,
    ])
    expect(watch.asked.map((ctx) => ctx.command)).toEqual(['curl', 'wget'])
    expect(watch.ended).toEqual([])
  })

  it('shows postNetwork how each request ended', async () => {
    const watch = new Watch()
    const url = `http://127.0.0.1:${String(port)}/`
    const line = `curl -sS ${url} > /data/a; curl -sS -o /data/b ${url}; curl -sS -o /missing/c ${url}`
    expect(await watched(watch, line)).toBe(23)
    expect(watch.ended.map((ctx) => [ctx.status, ctx.size, ctx.failed])).toEqual([
      [200, 3, false],
      [200, 3, false],
      [200, 3, true],
    ])
    expect([watch.open, watch.most]).toEqual([0, 1])
  })

  it('shows postNetwork a refused connection fail', async () => {
    const watch = new Watch()
    const ws = new Workspace({ '/data': new RAMVFS() }, { network: false })
    ws.policies.add(watch)
    try {
      expect((await ws.shell(`curl -sS http://127.0.0.1:${String(port)}/`)).exitCode).toBe(7)
    } finally {
      await ws.close()
    }
    expect(watch.ended.map((ctx) => [ctx.status, ctx.failed])).toEqual([[0, true]])
  })
})
