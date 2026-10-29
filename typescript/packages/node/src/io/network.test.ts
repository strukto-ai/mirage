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
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Workspace } from '../workspace.ts'

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
    ['an allowed range', { allow: ['127.0.0.0/8'] }, 0],
    ['false', false, 7],
    ['another host only', { allow: ['example.com'] }, 7],
  ])('%s', async (_name, network, exitCode) => {
    expect(await curl(network)).toBe(exitCode)
  })

  it('judges a name by the host it was asked for', async () => {
    expect(await curl({ allow: ['localhost'] }, 'localhost')).toBe(0)
    expect(await curl({ allow: ['example.com'] }, 'localhost')).toBe(7)
  })

  it('never lends one workspace a socket another opened', async () => {
    const open = new Workspace({ '/data': new RAMVFS() }, { network: { allow: ['127.0.0.1'] } })
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
})
