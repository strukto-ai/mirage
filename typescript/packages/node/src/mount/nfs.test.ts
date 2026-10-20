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

import { type Socket, connect } from 'node:net'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../workspace.ts'
import type * as ConstantsModule from './constants.ts'
import { MountCore } from './core.ts'
import { MirageNFSServer, mountArgs, unmountArgs } from './nfs.ts'

vi.mock('./constants.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof ConstantsModule>()),
  OPEN_HANDLES: 2,
}))

const NFS = 100003
const MOUNT = 100005
const FATTR = 84

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value))
  return out
}

function opaque(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  return concat([u32(bytes.length), bytes, new Uint8Array((4 - (bytes.length % 4)) % 4)])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

class Reply {
  private at = 0
  private readonly view: DataView

  constructor(private readonly body: Uint8Array) {
    this.view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  }

  u32(): number {
    const value = this.view.getUint32(this.at)
    this.at += 4
    return value
  }

  u64(): number {
    const value = Number(this.view.getBigUint64(this.at))
    this.at += 8
    return value
  }

  opaque(): Uint8Array {
    const size = this.u32()
    const data = this.body.slice(this.at, this.at + size)
    this.at += size + ((4 - (size % 4)) % 4)
    return data
  }

  fattr(): [number, number, number] {
    const found: [number, number, number] = [
      this.view.getUint32(this.at),
      this.view.getUint32(this.at + 4),
      Number(this.view.getBigUint64(this.at + 20)),
    ]
    this.at += FATTR
    return found
  }

  postOpAttr(): [number, number, number] | null {
    return this.u32() === 1 ? this.fattr() : null
  }
}

class Client {
  private xid = 0
  private buffer: Uint8Array = new Uint8Array()
  private waiting: (() => void) | null = null

  constructor(private readonly socket: Socket) {
    socket.on('data', (data: Buffer) => {
      this.buffer = concat([this.buffer, data])
      this.waiting?.()
    })
  }

  async call(prog: number, proc: number, args: Uint8Array = new Uint8Array()): Promise<Reply> {
    this.xid += 1
    const body = concat([...[this.xid, 0, 2, prog, 3, proc, 0, 0, 0, 0].map(u32), args])
    this.socket.write(concat([u32((body.length | 0x80000000) >>> 0), body]))
    const record = await this.record()
    const reply = new Reply(record)
    expect([0, 1, 2, 3, 4, 5].map(() => reply.u32())).toEqual([this.xid, 1, 0, 0, 0, 0])
    return reply
  }

  async root(): Promise<Uint8Array> {
    const reply = await this.call(MOUNT, 1, opaque('/'))
    expect(reply.u32()).toBe(0)
    return reply.opaque()
  }

  async lookup(dir: Uint8Array, name: string): Promise<[number, Uint8Array]> {
    const reply = await this.call(NFS, 3, concat([opaque(dir), opaque(name)]))
    const status = reply.u32()
    return [status, status === 0 ? reply.opaque() : new Uint8Array()]
  }

  async handle(...names: string[]): Promise<Uint8Array> {
    let handle = await this.root()
    for (const name of names) [, handle] = await this.lookup(handle, name)
    return handle
  }

  async read(handle: Uint8Array, offset: number, count: number): Promise<string> {
    const reply = await this.call(NFS, 6, concat([opaque(handle), u64(offset), u32(count)]))
    expect(reply.u32()).toBe(0)
    reply.postOpAttr()
    reply.u32()
    reply.u32()
    return new TextDecoder().decode(reply.opaque())
  }

  async readdir(
    handle: Uint8Array,
    cookie: number,
    count: number,
  ): Promise<[[string, number][], boolean]> {
    const reply = await this.call(
      NFS,
      16,
      concat([opaque(handle), u64(cookie), new Uint8Array(8), u32(count)]),
    )
    expect(reply.u32()).toBe(0)
    reply.postOpAttr()
    reply.u64()
    const entries: [string, number][] = []
    while (reply.u32() === 1) {
      reply.u64()
      const name = new TextDecoder().decode(reply.opaque())
      entries.push([name, reply.u64()])
    }
    return [entries, reply.u32() === 1]
  }

  private async record(): Promise<Uint8Array> {
    for (;;) {
      if (this.buffer.length >= 4) {
        const len =
          new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint32(0) & 0x7fffffff
        if (this.buffer.length >= 4 + len) {
          const record = this.buffer.slice(4, 4 + len)
          this.buffer = this.buffer.slice(4 + len)
          return record
        }
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve
      })
    }
  }
}

describe('MirageNFSServer', () => {
  let server: MirageNFSServer
  let socket: Socket
  let client: Client

  beforeEach(async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("mkdir -p /docs/sub && printf 'hello\\n' > /docs/a.txt")
    server = new MirageNFSServer(new MountCore(ws.vfs), '/', false)
    const port = await server.start()
    socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    client = new Client(socket)
  })

  afterEach(async () => {
    socket.destroy()
    await server.close()
  })

  it('answers getattr of the mounted root as a directory', async () => {
    const root = await client.root()
    const reply = await client.call(NFS, 1, opaque(root))
    expect(reply.u32()).toBe(0)
    expect(reply.fattr()[0]).toBe(2)
  })

  it('looks a file up and reads its bytes', async () => {
    const root = await client.root()
    const [, docs] = await client.lookup(root, 'docs')
    const [status, handle] = await client.lookup(docs, 'a.txt')
    expect(status).toBe(0)
    const reply = await client.call(NFS, 6, concat([opaque(handle), u64(0), u32(4096)]))
    expect(reply.u32()).toBe(0)
    expect(reply.postOpAttr()).toEqual([1, 0o644, 6])
    expect([reply.u32(), reply.u32()]).toEqual([6, 1])
    expect(new TextDecoder().decode(reply.opaque())).toBe('hello\n')
  })

  it('lists a directory with readdirplus', async () => {
    const root = await client.root()
    const [, docs] = await client.lookup(root, 'docs')
    const args = concat([opaque(docs), u64(0), new Uint8Array(8), u32(4096), u32(32768)])
    const reply = await client.call(NFS, 17, args)
    expect(reply.u32()).toBe(0)
    reply.postOpAttr()
    reply.u64()
    const names: string[] = []
    while (reply.u32() === 1) {
      reply.u64()
      names.push(new TextDecoder().decode(reply.opaque()))
      reply.u64()
      reply.postOpAttr()
      if (reply.u32() === 1) reply.opaque()
    }
    expect(names).toEqual(['a.txt', 'sub'])
    expect(reply.u32()).toBe(1)
  })

  it('answers a lookup of a missing name with NOENT', async () => {
    const root = await client.root()
    const [status] = await client.lookup(root, 'nope')
    expect(status).toBe(2)
  })

  it('refuses a write as a read-only filesystem', async () => {
    const root = await client.root()
    const reply = await client.call(
      NFS,
      9,
      concat([opaque(root), opaque('new'), new Uint8Array(24)]),
    )
    expect(reply.u32()).toBe(30)
  })
})

describe('MirageNFSServer handles and shutdown', () => {
  async function serve(
    ws: Workspace,
    secure = false,
  ): Promise<[MirageNFSServer, MountCore, Socket, Client]> {
    const core = new MountCore(ws.vfs)
    const server = new MirageNFSServer(core, '/', secure)
    const port = await server.start()
    const socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    return [server, core, socket, new Client(socket)]
  }

  it('refuses a client on an unreserved port when secure', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const [server, , socket] = await serve(ws, true)
    await new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve()
      })
    })
    await server.close()
  })

  it('shares one open between reads until the file changes', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("printf 'hello world\\n' > /a.txt")
    const [server, core, socket, client] = await serve(ws)
    const open = vi.spyOn(core, 'open')
    const release = vi.spyOn(core, 'release')
    try {
      const handle = await client.handle('a.txt')
      expect(await client.read(handle, 0, 5)).toBe('hello')
      expect(await client.read(handle, 6, 100)).toBe('world\n')
      expect(open).toHaveBeenCalledTimes(1)
      await ws.shell("printf 'bye\\n' > /a.txt")
      await client.call(NFS, 1, opaque(handle))
      expect(await client.read(handle, 0, 100)).toBe('bye\n')
      expect(open).toHaveBeenCalledTimes(2)
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      socket.destroy()
      await server.close()
    }
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('releases the least recently read file past the cap', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('for f in a b c; do echo $f > /$f; done')
    const [server, core, socket, client] = await serve(ws)
    const release = vi.spyOn(core, 'release')
    try {
      for (const name of ['a', 'b', 'c']) {
        expect(await client.read(await client.handle(name), 0, 10)).toBe(`${name}\n`)
      }
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      socket.destroy()
      await server.close()
    }
  })

  it('answers a failed open while an older file is still being released', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('for f in a b c; do echo $f > /$f; done')
    const [server, core, socket, client] = await serve(ws)
    try {
      for (const name of ['a', 'b']) await client.read(await client.handle(name), 0, 10)
      const handle = await client.handle('c')
      let finish = (): void => undefined
      const real = core.release.bind(core)
      vi.spyOn(core, 'release').mockImplementation(async (fd: number) => {
        await new Promise<void>((done) => {
          finish = done
        })
        await real(fd)
      })
      vi.spyOn(core, 'open').mockRejectedValue(new Error('gone'))
      vi.spyOn(console, 'debug').mockImplementation(() => undefined)
      const reply = client.call(NFS, 6, concat([opaque(handle), u64(0), u32(10)]))
      await new Promise((resolve) => setTimeout(resolve, 20))
      finish()
      expect((await reply).u32()).not.toBe(0)
    } finally {
      vi.restoreAllMocks()
      socket.destroy()
      await server.close()
    }
  })

  it('drops a request that finishes after the server closed', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    const [server, core, socket, client] = await serve(ws)
    const root = await client.root()
    let finish = (): void => undefined
    const asked = new Promise<void>((resolve) => {
      vi.spyOn(core, 'getattr').mockImplementation(async () => {
        resolve()
        await new Promise<void>((done) => {
          finish = done
        })
        throw new Error('gone')
      })
    })
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    void client.call(NFS, 1, opaque(root))
    await asked
    socket.destroy()
    await server.close()
    finish()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(debug.mock.calls.flat().join('\n')).not.toContain('failed')
  })
})

describe('MirageNFSServer and session changes', () => {
  async function serveAs(ws: Workspace): Promise<[MirageNFSServer, Socket, Client]> {
    const core = new MountCore(ws.vfs, { session: ws.createSession('reader') })
    const server = new MirageNFSServer(core, '/', false)
    const port = await server.start()
    const socket = connect(port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('connect', resolve))
    return [server, socket, new Client(socket)]
  }

  it('keeps handles opened after a session change out of the older reset', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('echo x > /x; echo y > /y')
    const core = new MountCore(ws.vfs, { session: ws.createSession('reader') })
    const server = new MirageNFSServer(core, '/', false)
    const port = await server.start()
    const first = connect(port, '127.0.0.1')
    const second = connect(port, '127.0.0.1')
    for (const socket of [first, second]) {
      await new Promise<void>((resolve) => socket.once('connect', resolve))
    }
    const a = new Client(first)
    const b = new Client(second)
    try {
      const x = await a.handle('x')
      const y = await b.handle('y')
      expect(await a.read(x, 0, 10)).toBe('x\n')
      expect(await b.read(y, 0, 10)).toBe('y\n')
      const fds: number[] = []
      const opening: string[] = []
      const releasing: number[] = []
      let holdOpen: Promise<void> | null = null
      let holdRelease: Promise<void> | null = null
      let openGate = (): void => undefined
      let releaseGate = (): void => undefined
      const realOpen = core.open.bind(core)
      const realRelease = core.release.bind(core)
      vi.spyOn(core, 'open').mockImplementation(async (path: string, flags?: number) => {
        opening.push(path)
        if (holdOpen !== null) await holdOpen
        const fd = await realOpen(path, flags)
        fds.push(fd)
        return fd
      })
      vi.spyOn(core, 'release').mockImplementation(async (fd: number) => {
        releasing.push(fd)
        const hold = holdRelease
        holdRelease = null
        if (hold !== null) await hold
        await realRelease(fd)
      })
      await ws.setSessionProfile('reader', {})
      holdRelease = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      const readX = a.read(x, 0, 10)
      await until(() => releasing.length === 1)
      holdOpen = new Promise<void>((resolve) => {
        openGate = resolve
      })
      const opened = opening.length
      const readY = b.read(y, 0, 10)
      await until(() => opening.length > opened)
      releaseGate()
      await new Promise((resolve) => setTimeout(resolve, 20))
      openGate()
      expect(await readX).toBe('x\n')
      expect(await readY).toBe('y\n')
      expect(fds.filter((fd) => releasing.includes(fd))).toEqual([])
    } finally {
      vi.restoreAllMocks()
      first.destroy()
      second.destroy()
      await server.close()
    }
  })

  it('stops later reads once a hide covers the file', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell("printf 'secret\\n' > /a.txt")
    const [server, socket, client] = await serveAs(ws)
    try {
      const handle = await client.handle('a.txt')
      expect(await client.read(handle, 0, 100)).toBe('secret\n')
      await ws.setSessionProfile('reader', { paths: { hide: ['/a.txt'] } })
      const reply = await client.call(NFS, 6, concat([opaque(handle), u64(0), u32(100)]))
      expect(reply.u32()).toBe(2)
    } finally {
      socket.destroy()
      await server.close()
    }
  })

  it('pages a listing by name and a later page sees a new hide', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.shell('mkdir /d && for i in $(seq 10 39); do echo > /d/f$i; done')
    const [server, socket, client] = await serveAs(ws)
    try {
      const dir = await client.handle('d')
      let [listed, eof] = await client.readdir(dir, 0, 512)
      expect(eof).toBe(false)
      await ws.setSessionProfile('reader', { paths: { hide: ['/d/f39'] } })
      let cookie = listed.at(-1)?.[1] ?? 0
      while (!eof) {
        const [page, end] = await client.readdir(dir, cookie, 512)
        listed = [...listed, ...page]
        cookie = page.at(-1)?.[1] ?? cookie
        eof = end
      }
      expect(listed.map(([name]) => name)).toEqual(
        Array.from({ length: 29 }, (_, i) => `f${String(i + 10)}`),
      )
    } finally {
      socket.destroy()
      await server.close()
    }
  })
})

describe('mountArgs / unmountArgs', () => {
  it('mounts read-only and soft on the server port on Linux', () => {
    const args = mountArgs(2049, '/mnt/x', 'linux')
    expect(args.slice(0, 3)).toEqual(['mount', '-t', 'nfs'])
    expect(args.slice(-2)).toEqual(['127.0.0.1:/', '/mnt/x'])
    const options = new Set((args[4] ?? '').split(','))
    for (const option of ['vers=3', 'soft', 'ro', 'nolock', 'port=2049', 'mountport=2049']) {
      expect(options.has(option)).toBe(true)
    }
  })

  it('mounts with mount_nfs and no reserved port on macOS', () => {
    const args = mountArgs(2049, '/mnt/x', 'darwin')
    expect(args[0]).toBe('/sbin/mount_nfs')
    const options = new Set((args[2] ?? '').split(','))
    for (const option of ['vers=3', 'soft', 'rdonly', 'noresvport', 'port=2049']) {
      expect(options.has(option)).toBe(true)
    }
  })

  it('refuses other platforms', () => {
    expect(() => mountArgs(2049, '/mnt/x', 'win32')).toThrow('Linux and macOS')
  })

  it('falls back to a forced unmount', () => {
    expect(unmountArgs('/mnt/x', 'linux')).toEqual([
      ['umount', '/mnt/x'],
      ['umount', '-l', '/mnt/x'],
    ])
    expect(unmountArgs('/mnt/x', 'darwin').at(-1)).toEqual([
      'diskutil',
      'unmount',
      'force',
      '/mnt/x',
    ])
  })
})
