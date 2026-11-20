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
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { MachineHandle } from '@struktoai/mirage-core/machine/handle'
import type { OutputFn, RunResult } from '@struktoai/mirage-core/runtime/types'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import { runProgram } from '@struktoai/mirage-node/machine/program'
import ssh2, { type Client, type ClientChannel } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceRegistry } from '../registry.ts'
import { closeHarnesses, connect, startHarness } from './harness.ts'
import { serveTunnel } from './server.ts'

afterEach(closeHarnesses)

/** A machine whose exec runs each argv on this host, as a provider's exec runs it on its own. */
class Here extends MachineHandle {
  static override readonly provider = 'box'

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected override execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    _cwd: string,
    output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const [program = '/bin/sh', ...args] = argv
    const base = Object.fromEntries(
      Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined),
    )
    return runProgram(program, null, args, stdin, {
      env: { ...base, ...env },
      ...(signal === undefined ? {} : { signal }),
      output,
      errors,
    })
  }
}

function openForward(client: Client, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (err, stream) => {
      if (err !== undefined) {
        reject(err)
        return
      }
      resolve(stream)
    })
  })
}

describe('forwards', () => {
  it('reach the port on the machine the lines run on', async () => {
    const echo = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const port = (echo.address() as AddressInfo).port
    try {
      const ws = new Workspace(
        { '/': new RAMVFS() },
        { mode: MountMode.EXEC, machines: { here: new Here('here', { captures: ['@line'] }) } },
      )
      const client = await connect(await startHarness(ws))
      const stream = await openForward(client, port)
      const got = new Promise<string>((resolve) => {
        let text = ''
        stream.on('data', (d: Buffer) => {
          text += d.toString()
          if (text.includes('\n')) resolve(text)
        })
      })
      stream.write('ping\n')
      expect(await got).toBe('ping\n')
      stream.end()
    } finally {
      echo.close()
    }
  }, 30_000)

  it('carry the answer to a request that ends with end of input', async () => {
    const upper = createServer((socket) => {
      let text = ''
      socket.on('data', (d: Buffer) => {
        text += d.toString()
      })
      socket.on('end', () => {
        socket.end(text.toUpperCase())
      })
    })
    await new Promise<void>((resolve) => upper.listen(0, '127.0.0.1', resolve))
    const port = (upper.address() as AddressInfo).port
    try {
      const ws = new Workspace(
        { '/': new RAMVFS() },
        { mode: MountMode.EXEC, machines: { here: new Here('here', { captures: ['@line'] }) } },
      )
      const client = await connect(await startHarness(ws))
      const stream = await openForward(client, port)
      const got = new Promise<string>((resolve) => {
        let text = ''
        stream.on('data', (d: Buffer) => {
          text += d.toString()
        })
        stream.on('close', () => {
          resolve(text)
        })
      })
      stream.end('ping\n')
      expect(await got).toBe('PING\n')
    } finally {
      upper.close()
    }
  }, 30_000)

  it('to another host are refused', async () => {
    const client = await connect(await startHarness())
    await expect(
      new Promise((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, 'example.com', 80, (err, stream) => {
          if (err !== undefined) reject(err)
          else resolve(stream)
        })
      }),
    ).rejects.toThrow(/Channel open failure/)
  })
})

describe('forwards over the HTTPS tunnel', () => {
  it('reach the port on the machine the lines run on', async () => {
    const echo = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    const port = (echo.address() as AddressInfo).port
    const registry = new WorkspaceRegistry({ idleGraceSeconds: 0 })
    registry.add(
      new Workspace(
        { '/': new RAMVFS() },
        { mode: MountMode.EXEC, machines: { here: new Here('here', { captures: ['@line'] }) } },
      ),
      'demo',
    )
    const dir = mkdtempSync(join(tmpdir(), 'mirage-ssh-tunnel-'))
    const config = {
      port: null,
      host: '127.0.0.1',
      hostKeyFile: join(dir, 'host_key'),
      authorizedKeysFile: join(dir, 'authorized_keys'),
    }
    const endpoint = { address: '127.0.0.1', port: 0 }
    const route: Server = createServer((socket) => {
      void serveTunnel(registry, config, socket, 'demo', null, endpoint, endpoint)
    })
    await new Promise<void>((resolve) => route.listen(0, '127.0.0.1', resolve))
    const client = new ssh2.Client()
    try {
      await new Promise<void>((resolve, reject) => {
        client.on('ready', resolve)
        client.on('error', reject)
        client.connect({
          host: '127.0.0.1',
          port: (route.address() as AddressInfo).port,
          username: 'demo',
        })
      })
      const stream = await openForward(client, port)
      const got = new Promise<string>((resolve) => {
        let text = ''
        stream.on('data', (d: Buffer) => {
          text += d.toString()
          if (text.includes('\n')) resolve(text)
        })
      })
      stream.write('ping\n')
      expect(await got).toBe('ping\n')
      stream.end()
    } finally {
      client.end()
      route.close()
      echo.close()
      await registry.closeAll()
    }
  }, 30_000)
})
