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

import { describe, expect, it, vi } from 'vitest'
import { currentCaller, runWithCaller } from '../context/session_context.ts'
import { strerrorOf } from '../errors/fs.ts'
import { MountMode } from '../types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { OPEN, STATUS } from './constants.ts'
import type { MountCore } from './core.ts'
import { PipeServer, longname, toAttrs, workspacePath } from './sftp.ts'

// SFTP v3 packet types the pipe tests speak.
const FXP_INIT = 1
const FXP_OPEN = 3
const FXP_CLOSE = 4
const FXP_WRITE = 6
const FXP_STAT = 17
const FXP_SYMLINK = 20
const FXP_VERSION = 2
const FXP_STATUS = 101
const FXP_HANDLE = 102
const FXP_ATTRS = 105

function packet(kind: number, body: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(body.length + 1)
  head.writeUInt8(kind, 4)
  return Buffer.concat([head, body])
}

function sftpString(data: Buffer): Buffer {
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  return Buffer.concat([size, data])
}

function uint32(n: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(n)
  return out
}

function stat(ident: number, path: string): Buffer {
  const name = Buffer.from(path)
  const body = Buffer.alloc(8)
  body.writeUInt32BE(ident)
  body.writeUInt32BE(name.length, 4)
  return packet(FXP_STAT, Buffer.concat([body, name]))
}

async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 1000 && !ready(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(ready()).toBe(true)
}

/**
 * Create `path` and write `data` to it, as sshfs would, leaving the handle
 * open; returns the handle as the requests that name it carry it.
 */
async function writeNew(
  end: ReturnType<typeof client>,
  path: string,
  data: string,
): Promise<Buffer> {
  const flags = OPEN.WRITE | OPEN.CREAT | OPEN.TRUNC
  end.send(
    packet(
      FXP_OPEN,
      Buffer.concat([uint32(1), sftpString(Buffer.from(path)), uint32(flags), uint32(0)]),
    ),
  )
  const [kind, body] = await end.answer()
  expect(kind).toBe(FXP_HANDLE)
  const handle = body.subarray(4)
  end.send(
    packet(
      FXP_WRITE,
      Buffer.concat([uint32(2), handle, Buffer.alloc(8), sftpString(Buffer.from(data))]),
    ),
  )
  expect((await end.answer())[1].subarray(0, 8)).toEqual(
    Buffer.concat([uint32(2), uint32(STATUS.OK)]),
  )
  return handle
}

/** A pipe server over a 20-byte `/notes`, past its init. */
async function cappedPipe(run?: (op: () => Promise<void>) => Promise<void>): Promise<{
  ws: Workspace
  server: PipeServer
  end: ReturnType<typeof client>
  served: Promise<void>
}> {
  const ws = new Workspace({ '/notes': new RAMVFS({ capacity: 20 }) }, { mode: MountMode.WRITE })
  await ws.session('agent')
  const server = new PipeServer(ws.vfs, ws.getSession('agent'), run)
  const end = client()
  const served = server.serve(end.reader, end.writer)
  end.send(packet(FXP_INIT, uint32(3)))
  await end.answer()
  return { ws, server, end, served }
}

function said(lost: [string, unknown][]): [string, string][] {
  return lost.map(([path, err]) => [path, strerrorOf(err)])
}

/** A client end: requests go in, answers come back one packet at a time. */
function client() {
  let feed: ReadableStreamDefaultController<Uint8Array> | null = null
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      feed = controller
    },
  })
  let got = Buffer.alloc(0)
  const waiting: (() => void)[] = []
  const writer = {
    write(data: Uint8Array) {
      got = Buffer.concat([got, data])
      waiting.splice(0).forEach((wake) => {
        wake()
      })
    },
    end() {
      return undefined
    },
  }
  return {
    reader,
    writer,
    send(data: Buffer) {
      feed?.enqueue(new Uint8Array(data))
    },
    close() {
      feed?.close()
    },
    async answer(): Promise<[number, Buffer]> {
      while (got.length < 4 || got.length < 4 + got.readUInt32BE(0)) {
        await new Promise<void>((resolve) => waiting.push(resolve))
      }
      const size = got.readUInt32BE(0)
      const data = got.subarray(4, 4 + size)
      got = got.subarray(4 + size)
      return [data.readUInt8(0), data.subarray(1)]
    },
  }
}

describe('helpers', () => {
  it('normalize client paths without ever leaving /', () => {
    expect(workspacePath('.')).toBe('/')
    expect(workspacePath('/d/../d/./sub/')).toBe('/d/sub')
    expect(workspacePath('/../../etc')).toBe('/etc')
    expect(workspacePath('//abs')).toBe('/abs')
  })

  it('carry mode, size and whole-second times', () => {
    const when = new Date(1_700_000_001_500)
    const attrs = toAttrs({
      mtime: when,
      atime: when,
      ctime: when,
      nlink: 1,
      size: 12,
      mode: 0o100640,
      uid: 501,
      gid: 20,
      rdev: 0,
    })
    expect(attrs).toEqual({
      mode: 0o100640,
      uid: 501,
      gid: 20,
      size: 12,
      atime: 1_700_000_001,
      mtime: 1_700_000_001,
    })
    expect(longname('f', attrs).startsWith('-rw-r-----')).toBe(true)
    expect(longname('f', attrs).endsWith(' f')).toBe(true)
  })
})

describe('PipeServer', () => {
  it.each(['real', 'missing'])('accepts sshfs symlink wire order (target=%s)', async (target) => {
    const ws = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/notes/real', 'target')
    await ws.session('agent')
    const end = client()
    const served = new PipeServer(ws.vfs, ws.getSession('agent')).serve(end.reader, end.writer)
    try {
      end.send(packet(FXP_INIT, uint32(3)))
      await end.answer()
      end.send(
        packet(
          FXP_SYMLINK,
          Buffer.concat([
            uint32(1),
            sftpString(Buffer.from(target)),
            sftpString(Buffer.from('/notes/link')),
          ]),
        ),
      )
      const [kind, body] = await end.answer()
      expect([kind, body.readUInt32BE(0), body.readUInt32BE(4)]).toEqual([FXP_STATUS, 1, STATUS.OK])
      expect((await ws.shell('readlink /notes/link')).stdoutText).toBe(target + '\n')
      if (target === 'real') {
        expect(new TextDecoder().decode(await ws.vfs.read('/notes/link'))).toBe('target')
      }
    } finally {
      end.close()
      await served
      await ws.close()
    }
  })

  it('answers as its session', async () => {
    const ws = new Workspace(
      { '/notes': new RAMVFS() },
      { mode: MountMode.WRITE, profiles: { agent: { paths: { hide: ['/notes/secret.txt'] } } } },
    )
    await ws.vfs.write('/notes/plan.txt', 'plan')
    await ws.vfs.write('/notes/secret.txt', 'salaries')
    await ws.session('agent', { profile: 'agent' })
    const end = client()
    const served = new PipeServer(ws.vfs, ws.getSession('agent')).serve(end.reader, end.writer)
    const version = Buffer.alloc(4)
    version.writeUInt32BE(3)
    end.send(packet(FXP_INIT, version))
    const [kind, body] = await end.answer()
    expect([kind, body.readUInt32BE(0)]).toEqual([FXP_VERSION, 3])
    end.send(stat(1, '/notes/plan.txt'))
    expect((await end.answer())[0]).toBe(FXP_ATTRS)
    end.send(stat(2, '/notes/secret.txt'))
    const [refused, status] = await end.answer()
    expect([refused, status.readUInt32BE(0), status.readUInt32BE(4)]).toEqual([
      FXP_STATUS,
      2,
      STATUS.NO_SUCH_FILE,
    ])
    end.close()
    await served
    await ws.close()
  })

  it.each([
    [undefined, 0, 0],
    [{ uid: 501, gid: 20 }, 501, 20],
  ])('answers as the owner it is given (%o)', async (owner, uid, gid) => {
    const ws = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.vfs.write('/notes/plan.txt', 'plan')
    await ws.session('agent')
    const end = client()
    const served = new PipeServer(ws.vfs, ws.getSession('agent'), undefined, owner).serve(
      end.reader,
      end.writer,
    )
    try {
      end.send(packet(FXP_INIT, uint32(3)))
      await end.answer()
      end.send(stat(1, '/notes/plan.txt'))
      const [kind, body] = await end.answer()
      // id, flags, size (8 bytes), then uid and gid.
      expect([kind, body.readUInt32BE(16), body.readUInt32BE(20)]).toEqual([FXP_ATTRS, uid, gid])
    } finally {
      end.close()
      await served
      await ws.close()
    }
  })

  it.each([
    ['NoSuchKey: object not found', STATUS.NO_SUCH_FILE],
    ['permission denied by the bucket', STATUS.PERMISSION_DENIED],
    ['bucket on fire', STATUS.FAILURE],
  ])('names an untyped failure by its message: %s', async (said, status) => {
    // A third-party client's error carries nothing else, as FUSE reads it.
    const notes = new RAMVFS()
    vi.spyOn(notes, 'stat').mockRejectedValue(new Error(said))
    const ws = new Workspace({ '/notes': notes }, { mode: MountMode.WRITE })
    await ws.session('agent')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const end = client()
    const served = new PipeServer(ws.vfs, ws.getSession('agent')).serve(end.reader, end.writer)
    try {
      end.send(packet(FXP_INIT, uint32(3)))
      await end.answer()
      end.send(stat(1, '/notes/plan.txt'))
      const [kind, body] = await end.answer()
      expect([kind, body.readUInt32BE(4)]).toEqual([FXP_STATUS, status])
    } finally {
      warn.mockRestore()
      end.close()
      await served
      await ws.close()
    }
  })

  it('loads ssh2 only once it serves', async () => {
    // A host without the optional peer still loads the module.
    let loaded = false
    vi.resetModules()
    vi.doMock('ssh2/lib/protocol/SFTP.js', async (importOriginal) => {
      loaded = true
      return importOriginal()
    })
    try {
      const { PipeServer: Fresh } = await import('./sftp.ts')
      expect(loaded).toBe(false)
      const ws = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
      await ws.session('agent')
      const end = client()
      end.close()
      await new Fresh(ws.vfs, ws.getSession('agent')).serve(end.reader, end.writer)
      expect(loaded).toBe(true)
      await ws.close()
    } finally {
      vi.doUnmock('ssh2/lib/protocol/SFTP.js')
      vi.resetModules()
    }
  })

  it('ends quietly when the pipe closes before it speaks', async () => {
    const ws = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.session('agent')
    const end = client()
    end.close()
    await new PipeServer(ws.vfs, ws.getSession('agent')).serve(end.reader, end.writer)
    await ws.close()
  })

  it('lands the writes in flight before it returns', async () => {
    const ws = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.session('agent')
    const end = client()
    const served = new PipeServer(ws.vfs, ws.getSession('agent')).serve(end.reader, end.writer)
    end.send(packet(FXP_INIT, uint32(3)))
    await end.answer()
    const flags = OPEN.WRITE | OPEN.CREAT | OPEN.TRUNC
    end.send(
      packet(
        FXP_OPEN,
        Buffer.concat([
          uint32(1),
          sftpString(Buffer.from('/notes/out.txt')),
          uint32(flags),
          uint32(0),
        ]),
      ),
    )
    const [kind, body] = await end.answer()
    expect(kind).toBe(FXP_HANDLE)
    const offset = Buffer.alloc(8)
    end.send(
      packet(
        FXP_WRITE,
        Buffer.concat([uint32(2), body.subarray(4), offset, sftpString(Buffer.from('landed'))]),
      ),
    )
    end.close()
    await served
    expect(new TextDecoder().decode(await ws.vfs.read('/notes/out.txt'))).toBe('landed')
    await ws.close()
  })

  it('lands on sync what it acknowledged before its close', async () => {
    // sshfs answers close(2) once the write is acknowledged and sends the
    // close that lands it later, on its own: the sync between them lands it.
    const ws = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.session('agent')
    const server = new PipeServer(ws.vfs, ws.getSession('agent'))
    const end = client()
    const served = server.serve(end.reader, end.writer)
    const read = async () => new TextDecoder().decode(await ws.vfs.read('/notes/new.txt'))
    try {
      end.send(packet(FXP_INIT, uint32(3)))
      await end.answer()
      const handle = await writeNew(end, '/notes/new.txt', 'made\n')
      expect(await read()).toBe('')
      await server.sync()
      expect(await read()).toBe('made\n')
      end.send(packet(FXP_CLOSE, Buffer.concat([uint32(3), handle])))
      expect((await end.answer())[1].subarray(0, 8)).toEqual(
        Buffer.concat([uint32(3), uint32(STATUS.OK)]),
      )
      expect(await read()).toBe('made\n')
    } finally {
      end.close()
      await served
      await ws.close()
    }
  })

  it('hands back a landing its sync could not make, once', async () => {
    // sshfs answers close(2) before the landing, so the sync's failure is
    // the program's only report; the close sshfs sends later fails the
    // same way, and no later sync reports it again.
    const { ws, server, end, served } = await cappedPipe()
    try {
      const handle = await writeNew(end, '/notes/big.bin', 'x'.repeat(50))
      expect(said(await server.sync())).toEqual([['/notes/big.bin', 'Disk quota exceeded']])
      expect(await server.sync()).toEqual([])
      end.send(packet(FXP_CLOSE, Buffer.concat([uint32(3), handle])))
      expect((await end.answer())[1].subarray(0, 8)).not.toEqual(
        Buffer.concat([uint32(3), uint32(STATUS.OK)]),
      )
      expect(await server.sync()).toEqual([])
    } finally {
      end.close()
      await served
      await ws.close()
    }
  })

  it('hands a close that could not land to the next sync', async () => {
    // The close lands the writes after close(2) returned: its failure,
    // with the error the store raised, waits for the line's sync.
    const { ws, server, end, served } = await cappedPipe()
    try {
      const handle = await writeNew(end, '/notes/big.bin', 'x'.repeat(50))
      end.send(packet(FXP_CLOSE, Buffer.concat([uint32(3), handle])))
      await end.answer()
      expect(said(await server.sync())).toEqual([['/notes/big.bin', 'Disk quota exceeded']])
      expect(await server.sync()).toEqual([])
    } finally {
      end.close()
      await served
      await ws.close()
    }
  })

  it('reports a close racing a sync once', async () => {
    // sshfs may send the close while the line's sync is still landing:
    // both fail on the one handle, and the line hears of it once.
    const { ws, server, end, served } = await cappedPipe()
    const core = (server as unknown as { core: MountCore }).core
    const coreSync = core.sync.bind(core)
    try {
      const handle = await writeNew(end, '/notes/big.bin', 'x'.repeat(50))
      core.sync = async () => {
        const failed = await coreSync()
        end.send(packet(FXP_CLOSE, Buffer.concat([uint32(3), handle])))
        await end.answer()
        return failed
      }
      expect(said(await server.sync())).toEqual([['/notes/big.bin', 'Disk quota exceeded']])
    } finally {
      end.close()
      await served
      await ws.close()
    }
  })

  it('lands every handle a closed pipe left open, past one that fails', async () => {
    // Each through its run as any request, so it keeps a line's admission.
    let ran = 0
    const { ws, server, end, served } = await cappedPipe((op) => {
      ran += 1
      return op()
    })
    try {
      await writeNew(end, '/notes/big.bin', 'x'.repeat(50))
      await writeNew(end, '/notes/small.txt', 'ok')
      const before = ran
      end.close()
      await expect(served).rejects.toThrow()
      expect(ran - before).toBe(2)
      expect(new TextDecoder().decode(await ws.vfs.read('/notes/small.txt'))).toBe('ok')
      expect(said(await server.sync())).toEqual([['/notes/big.bin', 'Disk quota exceeded']])
    } finally {
      await ws.close()
    }
  })

  it('waits on sync for a close still letting its handle go', async () => {
    // The close has let the handle go and is still closing its spool: the
    // sync waits for it, so its failure is not missed.
    const { ws, server, end, served } = await cappedPipe()
    const core = (server as unknown as { core: MountCore }).core
    try {
      const handle = await writeNew(end, '/notes/big.bin', 'x'.repeat(50))
      const [[fd, ctx] = [0, undefined]] = [...core.handles.items()]
      let closed = (): void => undefined
      const closing = new Promise<void>((resolve) => {
        closed = resolve
      })
      if (ctx !== undefined)
        ctx.spool = { close: () => closing } as unknown as NonNullable<typeof ctx.spool>
      end.send(packet(FXP_CLOSE, Buffer.concat([uint32(3), handle])))
      await until(() => core.handles.get(fd) === undefined)
      const syncing = server.sync()
      await new Promise((resolve) => setTimeout(resolve, 50))
      closed()
      expect(said(await syncing)).toEqual([['/notes/big.bin', 'Disk quota exceeded']])
      await end.answer()
    } finally {
      end.close()
      await served
      await ws.close()
    }
  })

  it('reports nothing again on a sync that took a handle before its close', async () => {
    // A later sync took the handle before its close let it go: the close
    // fails as the first sync did, and neither reports it again.
    const { ws, server, end, served } = await cappedPipe()
    const core = (server as unknown as { core: MountCore }).core
    const coreSync = core.sync.bind(core)
    try {
      const handle = await writeNew(end, '/notes/big.bin', 'x'.repeat(50))
      expect(said(await server.sync())).toEqual([['/notes/big.bin', 'Disk quota exceeded']])
      core.sync = async () => {
        const failed = await coreSync()
        end.send(packet(FXP_CLOSE, Buffer.concat([uint32(3), handle])))
        await end.answer()
        return failed
      }
      expect(await server.sync()).toEqual([])
    } finally {
      end.close()
      await served
      await ws.close()
    }
  })

  it("lands a running line's request past a capture waiting for it", async () => {
    // A request run with the running line's write admission lands while a
    // capture waits for that line, rather than wait on the capture the
    // line is holding up.
    const ws = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.session('agent')
    const internals = ws as unknown as { admitted: Set<AbortController>; capturing: boolean }
    const abort = new AbortController()
    const line = ws.shell('sleep 30', { signal: abort.signal }).catch(() => undefined)
    await until(() => internals.admitted.size === 1)
    const [stop = null] = internals.admitted
    const server = new PipeServer(ws.vfs, ws.getSession('agent'), (op) =>
      runWithCaller({ ...currentCaller(), stop }, op),
    )
    const end = client()
    const served = server.serve(end.reader, end.writer)
    const capture = ws.snapshot()
    try {
      await until(() => internals.capturing)
      end.send(packet(FXP_INIT, uint32(3)))
      await end.answer()
      const handle = await writeNew(end, '/notes/new.txt', 'made\n')
      end.send(packet(FXP_CLOSE, Buffer.concat([uint32(3), handle])))
      await end.answer()
      expect(new TextDecoder().decode(await ws.vfs.read('/notes/new.txt'))).toBe('made\n')
    } finally {
      abort.abort()
      await line
      await capture
      end.close()
      await served
      await ws.close()
    }
  })
})
