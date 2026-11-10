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

import { connect as tcp } from 'node:net'
import { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import { MountMode, PathSpec } from '@struktoai/mirage-core/types'
import { checkMutationContract } from '@struktoai/mirage-core/vfs/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { buildVfs } from '../registry.ts'
import { RedisVFS } from './redis.ts'
import { RespClient, type Connect } from './resp.ts'

const REDIS_URL = process.env.REDIS_URL
const url = REDIS_URL ?? ''
const DIRECTORY = new PathSpec({ virtual: '/r/scratch', directory: '/r', vfsPath: 'scratch' })
const dec = new TextDecoder()

// Node's sockets as the web streams the Workers TCP API hands back.
const nodeConnect: Connect = (hostname, port, tls) =>
  new Promise((resolve, reject) => {
    const socket = tls ? tlsConnect({ host: hostname, port }) : tcp({ host: hostname, port })
    socket.once(tls ? 'secureConnect' : 'connect', () => {
      const { readable, writable } = Duplex.toWeb(socket) as {
        readable: ReadableStream<Uint8Array>
        writable: WritableStream<Uint8Array>
      }
      resolve({
        readable,
        writable,
        close: () => {
          socket.destroy()
          return Promise.resolve()
        },
      })
    })
    socket.once('error', reject)
  })

describe('cloudflare redis over the host TCP API', () => {
  it('is in the registry under the name and options node and python use', async () => {
    const vfs = await buildVfs('redis', { url: 'redis://cache.example:6380/1', key_prefix: 'ws:' })
    expect(vfs).toBeInstanceOf(RedisVFS)
    expect(vfs.storageLocation()).toBe('redis:cache.example:6380/1:ws%3A')
    await expect(buildVfs('redis', { token: 'x' })).rejects.toThrow('token')
  })
})

describe.skipIf(REDIS_URL === undefined)('cloudflare redis against a live server', () => {
  let prefix: string

  beforeEach(() => {
    prefix = `mirage:cloudflare-test:${crypto.randomUUID()}:`
  })
  afterEach(async () => {
    const vfs = new RedisVFS({ url, keyPrefix: prefix, connect: nodeConnect })
    await vfs.store.clear()
    await vfs.close()
  })

  it('passes the mutation contract', async () => {
    const vfs = new RedisVFS({ url, keyPrefix: prefix, connect: nodeConnect })
    const ws = new Workspace({ '/r/': vfs }, { mode: MountMode.WRITE })
    try {
      expect((await ws.shell('mkdir /r/scratch')).exitCode).toBe(0)
      await checkMutationContract(vfs, { directory: DIRECTORY })
    } finally {
      await ws.close()
    }
  })

  it('serves the shell over the keys node and python read', async () => {
    const vfs = new RedisVFS({ url, keyPrefix: prefix, connect: nodeConnect })
    const ws = new Workspace({ '/r/': vfs }, { mode: MountMode.WRITE })
    try {
      const r = await ws.shell(
        "mkdir -p /r/out && printf 'b\\na\\n' > /r/out/x.txt && mv /r/out/x.txt /r/out/y.txt && sort /r/out/y.txt && ls /r/out",
      )
      expect(r.exitCode).toBe(0)
      expect(r.stdoutText).toBe('a\nb\ny.txt\n')
      expect((await ws.shell('df /r')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
    const raw = new RespClient(url, nodeConnect)
    try {
      expect(dec.decode((await raw.call('GET', `${prefix}file:/out/y.txt`)) as Uint8Array)).toBe(
        'b\na\n',
      )
      expect(await raw.call('SISMEMBER', `${prefix}dir`, '/out')).toBe(1)
    } finally {
      await raw.close()
    }
  })

  it('carries a snapshot into a fresh prefix', async () => {
    const source = new RedisVFS({ url, keyPrefix: prefix, connect: nodeConnect })
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251)
    await source.store.addDir('/d')
    await source.store.setFile('/d/big', big)
    await source.store.setAttrs('/d/big', { mode: '644' })
    const state = await source.getState()
    await source.close()
    const copy = new RedisVFS({ url, keyPrefix: `${prefix}copy:`, connect: nodeConnect })
    try {
      await copy.loadState(state)
      expect(await copy.store.getFile('/d/big')).toEqual(big)
      expect(await copy.store.getAttrs('/d/big')).toEqual({ mode: '644' })
      expect(await copy.store.listDirs()).toEqual(new Set(['/', '/d']))
    } finally {
      await copy.store.clear()
      await copy.close()
    }
  })
})
