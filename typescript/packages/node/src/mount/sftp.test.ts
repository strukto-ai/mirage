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

import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { describe, expect, it } from 'vitest'
import { Workspace } from '../workspace.ts'
import { STATUS } from './constants.ts'
import { longname, servePipe, toAttrs, workspacePath } from './sftp.ts'

// SFTP v3 packet types the pipe tests speak.
const FXP_INIT = 1
const FXP_STAT = 17
const FXP_VERSION = 2
const FXP_STATUS = 101
const FXP_ATTRS = 105

function packet(kind: number, body: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head.writeUInt32BE(body.length + 1)
  head.writeUInt8(kind, 4)
  return Buffer.concat([head, body])
}

function stat(ident: number, path: string): Buffer {
  const name = Buffer.from(path)
  const body = Buffer.alloc(8)
  body.writeUInt32BE(ident)
  body.writeUInt32BE(name.length, 4)
  return packet(FXP_STAT, Buffer.concat([body, name]))
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

describe('servePipe', () => {
  it('answers as its session', async () => {
    const ws = new Workspace(
      { '/notes': new RAMVFS() },
      { mode: MountMode.WRITE, profiles: { agent: { paths: { hide: ['/notes/secret.txt'] } } } },
    )
    await ws.vfs.write('/notes/plan.txt', 'plan')
    await ws.vfs.write('/notes/secret.txt', 'salaries')
    await ws.session('agent', { profile: 'agent' })
    const end = client()
    const served = servePipe(ws.vfs, ws.getSession('agent'), end.reader, end.writer)
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

  it('ends quietly when the pipe closes before it speaks', async () => {
    const ws = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
    await ws.session('agent')
    const end = client()
    end.close()
    await servePipe(ws.vfs, ws.getSession('agent'), end.reader, end.writer)
    await ws.close()
  })
})
