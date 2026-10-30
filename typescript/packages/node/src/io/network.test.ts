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
import { connect as netConnect } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { NetworkSetting } from '@struktoai/mirage-core/io/network'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import type {
  Deny,
  NetworkContext,
  NetworkResultContext,
} from '@struktoai/mirage-core/policy/types'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { CLI, CLIHandler } from '@struktoai/mirage-core/commands/cli/types'
import { CommandSpec } from '@struktoai/mirage-core/commands/spec/types'
import { IOResult } from '@struktoai/mirage-core/io/types'
import { type FileStat, Limit, MountMode, type PathSpec } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Workspace } from '../workspace.ts'
import { rulePool } from './network.ts'

describe('a workspace network rule', () => {
  let server: Server
  let port = 0

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' })
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

  // Refuses the addresses it is given, counts what is open, keeps what each
  // method saw.
  class Watch implements Policy {
    open = 0
    readonly asked: NetworkContext[] = []
    readonly ended: NetworkResultContext[] = []
    constructor(
      private readonly refused: readonly string[] = [],
      private readonly limit: Limit | null = null,
    ) {}

    preNetwork(ctx: NetworkContext): Deny | Limit | null {
      this.asked.push(ctx)
      if (this.refused.includes(ctx.address)) {
        return { kind: 'deny', reason: `${ctx.address} is not for this tenant` }
      }
      this.open += 1
      return this.limit
    }

    postNetwork(ctx: NetworkResultContext): null {
      this.ended.push(ctx)
      this.open -= 1
      return null
    }
  }

  async function held(
    line: string,
    policies: Policy[],
    network: NetworkSetting = true,
  ): Promise<number> {
    const ws = new Workspace({ '/data': [new RAMVFS(), MountMode.WRITE] as const }, { network })
    for (const policy of policies) ws.policies.add(policy)
    try {
      return (await ws.shell(line)).exitCode
    } finally {
      await ws.close()
    }
  }

  // Waits for the gateway to hand a connection's end to postNetwork.
  async function settled(watch: Watch, count: number): Promise<void> {
    for (let i = 0; i < 100 && watch.ended.length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('refuses a connection preNetwork denies as a closed port', async () => {
    const watch = new Watch(['127.0.0.1'])
    const url = `http://127.0.0.1:${String(port)}/a`
    expect(await held(`curl -sS ${url}`, [watch])).toBe(7)
    expect(await held(`wget -q -O - ${url}`, [watch])).toBe(4)
    const [asked] = watch.asked
    expect([asked?.address, asked?.port, asked?.command, asked?.program]).toEqual([
      '127.0.0.1',
      port,
      'curl',
      ['curl'],
    ])
    expect(asked?.line).toBe(`curl -sS ${url}`)
    expect(asked?.words?.map((word) => word.text)).toEqual(['curl', '-sS', url])
    expect(watch.asked.map((ctx) => ctx.command)).toEqual(['curl', 'wget'])
    expect(watch.ended).toEqual([])
  })

  it('hands a name to the hooks as its host', async () => {
    const watch = new Watch()
    expect(await held(`curl -sS http://localhost:${String(port)}/`, [watch])).toBe(0)
    expect([watch.asked[0]?.host, watch.asked[0]?.port]).toEqual(['localhost', port])
  })

  it('shows postNetwork how each connection went', async () => {
    const watch = new Watch()
    const url = `http://127.0.0.1:${String(port)}/`
    expect(await held(`curl -sS ${url} > /data/a; curl -sS -o /data/b ${url}`, [watch])).toBe(0)
    await settled(watch, 2)
    expect(watch.ended.map((ctx) => ctx.ended)).toEqual(['closed', 'closed'])
    expect(watch.ended.every((ctx) => ctx.bytesSent > 0 && ctx.bytesReceived > 0)).toBe(true)
    expect(watch.open).toBe(0)
  })

  it('refuses through the lists before any hook', async () => {
    const watch = new Watch()
    expect(await held(`curl -sS http://127.0.0.1:${String(port)}/`, [watch], false)).toBe(7)
    expect([watch.asked, watch.ended]).toEqual([[], []])
  })

  it('shows postNetwork to each policy that let a connection through', async () => {
    const counted = new Watch()
    const refusing = new Watch(['127.0.0.1'])
    expect(await held(`curl -sS http://127.0.0.1:${String(port)}/`, [counted, refusing])).toBe(7)
    expect(counted.ended.map((ctx) => ctx.ended)).toEqual(['refused'])
    expect([counted.open, refusing.open, refusing.ended]).toEqual([0, 0, []])
  })

  it('cuts a connection past its Limit with a reset', async () => {
    const watch = new Watch([], new Limit({ maxBytes: 40 }))
    expect(await held(`curl -sS http://127.0.0.1:${String(port)}/`, [watch])).not.toBe(0)
    await settled(watch, 1)
    expect(watch.ended.map((ctx) => ctx.ended)).toEqual(['limit'])
    expect((watch.ended[0]?.bytesSent ?? 0) + (watch.ended[0]?.bytesReceived ?? 0)).toBe(40)
  })

  it('ends a connection a timeout cuts short', async () => {
    const silent = createServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const counted = new Watch()
    try {
      const at = (silent.address() as AddressInfo).port
      expect(await held(`timeout 0.3 curl -sS http://127.0.0.1:${String(at)}/`, [counted])).toBe(
        124,
      )
      silent.closeAllConnections()
      await settled(counted, 1)
    } finally {
      await new Promise((resolve) => silent.close(resolve))
    }
    expect(counted.ended).toHaveLength(1)
    expect(counted.open).toBe(0)
  })

  // Asks the server once, as a remote client would before it answers.
  async function ask(at: number): Promise<void> {
    const socket = netConnect({ host: '127.0.0.1', port: at })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        socket.end('GET / HTTP/1.1\r\nHost: remote\r\n\r\n')
      })
      socket.on('data', () => undefined)
      socket.once('close', () => {
        resolve()
      })
      socket.once('error', reject)
    })
  }

  // A RAM mount whose listing first asks a server, as a remote VFS's client
  // would.
  class Remote extends RAMVFS {
    override async readdir(path: PathSpec): Promise<FileStat[]> {
      await ask(port)
      return super.readdir(path)
    }
  }

  it('names the mount and the command a mount connection opens for', async () => {
    const watch = new Watch()
    const ws = new Workspace({ '/remote': new Remote() })
    ws.policies.add(watch)
    try {
      expect((await ws.shell('ls /remote')).exitCode).toBe(0)
      await settled(watch, 1)
    } finally {
      await ws.close()
    }
    expect(watch.asked.map((ctx) => [ctx.mount, ctx.command, ctx.port])).toEqual([
      ['/remote', 'ls', port],
    ])
    expect(watch.ended.map((ctx) => ctx.ended)).toEqual(['closed'])
  })

  it("names a CLI's program and words for a connection it opens", async () => {
    const watch = new Watch()
    const ws = new Workspace({ '/data': new RAMVFS() })
    ws.registerCli(
      'acme',
      new CLI({
        spec: new CommandSpec({ name: 'acme', subcommands: [new CommandSpec({ name: 'deploy' })] }),
        handlers: {
          deploy: new CLIHandler({
            fn: async () => {
              await ask(port)
              return [null, new IOResult()]
            },
          }),
        },
      }),
    )
    ws.policies.add(watch)
    try {
      expect((await ws.shell('acme deploy')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
    const [asked] = watch.asked
    expect([asked?.command, asked?.program, asked?.line]).toEqual([
      'acme',
      ['acme', 'deploy'],
      'acme deploy',
    ])
    expect(asked?.words?.map((word) => word.text)).toEqual(['acme', 'deploy'])
  })

  it('holds each session to its profile network besides the workspace one', async () => {
    const held = { allowed_domains: [`127.0.0.1:${String(port)}`] }
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        network: { denied_domains: ['10.0.0.0/8'] },
        profiles: {
          agent: parseSessionProfile({ network: held }),
          review: parseSessionProfile({ network: false }),
          wide: parseSessionProfile({ network: true }),
        },
      },
    )
    ws.createSession('a', { profile: 'agent' })
    ws.createSession('r', { profile: 'review' })
    ws.createSession('w', { profile: 'wide' })
    const line = `curl -sS http://127.0.0.1:${String(port)}/`
    try {
      for (const [sessionId, exitCode] of [
        ['a', 0],
        ['r', 7],
        ['w', 0],
      ] as const) {
        expect((await ws.shell(line, { sessionId })).exitCode, sessionId).toBe(exitCode)
      }
      expect(ws.registry.networkOf(held)).toBe(ws.registry.networkOf(held))
      expect(ws.registry.networkOf(null)).toBe(ws.registry.network)
      expect(ws.registry.narrowedNetworks()).toHaveLength(2)
    } finally {
      await ws.close()
    }
  })

  it('refuses a profile network that is not a setting', () => {
    expect(() => parseSessionProfile({ network: { allow: ['a.com'] } })).toThrow(
      /network is true, false or/,
    )
    expect(() => parseSessionProfile({ network: { denied_domains: ['10.0.0.0/33'] } })).toThrow(
      /is not an address, a range/,
    )
  })
})
