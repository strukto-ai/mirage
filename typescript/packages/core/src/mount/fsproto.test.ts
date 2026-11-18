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
import { MountMode } from '../types.ts'
import { ManualClock } from '../utils/clock.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { RecentChanges, SERVED_BY } from './changes.ts'
import { FSPROTO_VERSION } from './constants.ts'
import { type Frame, FrameReader, FsprotoServer, bounded, encodeFrame } from './fsproto.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** A mirage-fuse end: requests go in, replies come back by id, pushes queue apart. */
function client() {
  let feed: ReadableStreamDefaultController<Uint8Array> | null = null
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      feed = controller
    },
  })
  const frames = new FrameReader()
  const replies = new Map<number, Frame>()
  const pushes: Frame[] = []
  const waiting: (() => void)[] = []
  const writer = {
    write(data: Uint8Array) {
      for (const frame of frames.push(data)) {
        const id = frame.head.id
        if (typeof id === 'number') replies.set(id, frame)
        else pushes.push(frame)
      }
      for (const wake of waiting.splice(0)) wake()
    },
    end: () => undefined,
  }
  let next = 0
  async function until(test: () => boolean): Promise<void> {
    while (!test()) await new Promise<void>((resolve) => waiting.push(resolve))
  }
  return {
    reader,
    writer,
    pushes,
    until,
    send(head: Record<string, unknown>, body?: Uint8Array) {
      feed?.enqueue(encodeFrame(head, body))
    },
    async call(head: Record<string, unknown>, body?: Uint8Array): Promise<Frame> {
      next += 1
      const id = next
      feed?.enqueue(encodeFrame({ ...head, id }, body))
      await until(() => replies.has(id))
      const reply = replies.get(id)
      replies.delete(id)
      if (reply === undefined) throw new Error('no reply')
      return reply
    },
    close() {
      feed?.close()
    },
  }
}

async function served(changes: RecentChanges | null = null) {
  const ws = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/notes/plan.txt', 'plan')
  await ws.session('agent')
  const server = new FsprotoServer(ws.vfs, ws.getSession('agent'), undefined, {
    prefix: '/notes',
    machine: 'dev',
    changes,
  })
  const end = client()
  const serving = server.serve(end.reader, end.writer)
  return { ws, server, end, serving }
}

describe('encodeFrame', () => {
  // The bytes mirage-fuse's and Python's tests check too.
  it('has the shared layout', () => {
    expect(encodeFrame({ id: 1 }, ENC.encode('xy'))).toEqual(
      new Uint8Array([0, 0, 0, 14, 0, 0, 0, 8, ...ENC.encode('{"id":1}xy')]),
    )
  })
})

describe('bounded', () => {
  it('drops a tree past the frame limit, then refuses the reply', () => {
    const head = (frame: Uint8Array): unknown => {
      const length = new DataView(frame.buffer, frame.byteOffset).getUint32(4)
      return JSON.parse(DEC.decode(frame.subarray(8, 8 + length)))
    }
    const tree = { id: 1, e: [], k: true, d: [['/w/a', [['x'.repeat(80), {}]]]] }
    expect(head(bounded(tree, new Uint8Array(), 64))).toEqual({ id: 1, e: [], k: true })
    const big = { id: 2, e: [['x'.repeat(80), {}]], k: true }
    expect(head(bounded(big, new Uint8Array(), 64))).toEqual({ id: 2, errno: 'EFBIG' })
  })
})

describe('FrameReader', () => {
  it('reads frames split across chunks', () => {
    const bytes = new Uint8Array([
      ...encodeFrame({ id: 1, op: 'getattr' }),
      ...encodeFrame({ id: 2 }, ENC.encode('body')),
    ])
    const reader = new FrameReader()
    const frames = [...reader.push(bytes.subarray(0, 7)), ...reader.push(bytes.subarray(7))]
    expect(frames.map((f) => [f.head.id, DEC.decode(f.body)])).toEqual([
      [1, ''],
      [2, 'body'],
    ])
  })

  it('refuses a header past its frame', () => {
    expect(() =>
      new FrameReader().push(new Uint8Array([0, 0, 0, 6, 0, 0, 0, 9, 123, 125])),
    ).toThrow('a header past its frame')
  })
})

describe('FsprotoServer', () => {
  it('greets with its protocol and keeps answers about a RAM mount', async () => {
    const { end, serving } = await served()
    expect((await end.call({ op: 'hello', proto: FSPROTO_VERSION })).head.proto).toBe(
      FSPROTO_VERSION,
    )
    const stat = await end.call({ op: 'getattr', path: '/notes/plan.txt' })
    expect([stat.head.k, (stat.head.a as { s: number }).s]).toEqual([true, 4])
    const listed = await end.call({ op: 'list', path: '/notes' })
    expect((listed.head.e as [string, unknown][]).map(([name]) => name)).toEqual(['plan.txt'])
    end.close()
    await serving
  })

  it('carries the folders under a folder in its deep listing', async () => {
    const { ws, end, serving } = await served()
    await ws.vfs.mkdir('/notes/sub')
    await ws.vfs.mkdir('/notes/sub/deeper')
    await ws.vfs.write('/notes/sub/a.txt', 'a')
    await ws.vfs.write('/notes/sub/deeper/b.txt', 'b')
    const deep = await end.call({ op: 'list', path: '/notes', deep: true })
    expect((deep.head.e as [string, unknown][]).map(([name]) => name)).toEqual(['plan.txt', 'sub'])
    expect(
      (deep.head.d as [string, [string, unknown][]][]).map(([folder, rows]) => [
        folder,
        rows.map(([name]) => name),
      ]),
    ).toEqual([
      ['/notes/sub', ['a.txt', 'deeper']],
      ['/notes/sub/deeper', ['b.txt']],
    ])
    expect((await end.call({ op: 'list', path: '/notes' })).head.d).toBeUndefined()
    end.close()
    await serving
  })

  it('reads a file whole and lands a write by its release', async () => {
    const { ws, server, end, serving } = await served()
    const whole = await end.call({ op: 'readall', path: '/notes/plan.txt' })
    expect(DEC.decode(whole.body)).toBe('plan')
    const opened = await end.call({
      op: 'open',
      path: '/notes/plan.txt',
      write: true,
      truncate: true,
    })
    await end.call({ op: 'write', fh: opened.head.fh, offset: 0 }, ENC.encode('done'))
    await end.call({ op: 'release', fh: opened.head.fh })
    expect(await server.sync()).toEqual([])
    expect(DEC.decode(await ws.vfs.read('/notes/plan.txt'))).toBe('done')
    end.close()
    await serving
  })

  it('creates a file and refuses a rename over one with noreplace', async () => {
    const { ws, end, serving } = await served()
    const made = await end.call({ op: 'create', path: '/notes/new.txt', mode: 0o644 })
    expect(typeof made.head.fh).toBe('number')
    await end.call({ op: 'release', fh: made.head.fh })
    const refused = await end.call({
      op: 'rename',
      from: '/notes/new.txt',
      to: '/notes/plan.txt',
      noreplace: true,
    })
    expect(refused.head.errno).toBe('EEXIST')
    await end.call({ op: 'rename', from: '/notes/new.txt', to: '/notes/plan.txt' })
    expect(DEC.decode(await ws.vfs.read('/notes/plan.txt'))).toBe('')
    end.close()
    await serving
  })

  it('points a link where it was made to', async () => {
    const { end, serving } = await served()
    const made = await end.call({ op: 'symlink', path: '/notes/link', target: 'plan.txt' })
    expect((made.head.a as { m: number }).m & 0o170000).toBe(0o120000)
    expect((await end.call({ op: 'readlink', path: '/notes/link' })).head.target).toBe('plan.txt')
    expect(DEC.decode((await end.call({ op: 'readall', path: '/notes/link' })).body)).toBe('plan')
    end.close()
    await serving
  })

  it('names a failure by its errno', async () => {
    const { end, serving } = await served()
    expect((await end.call({ op: 'getattr', path: '/notes/missing' })).head.errno).toBe('ENOENT')
    end.close()
    await serving
  })

  it('truncates by setattr and answers the new size', async () => {
    const { end, serving } = await served()
    const set = await end.call({ op: 'setattr', path: '/notes/plan.txt', size: 2 })
    expect((set.head.a as { s: number }).s).toBe(2)
    end.close()
    await serving
  })

  it('prefetches a folder of small files in one reply', async () => {
    const { ws, end, serving } = await served()
    await ws.vfs.write('/notes/b.txt', 'bee')
    const fetched = await end.call({ op: 'fetchdir', path: '/notes' })
    const files = fetched.head.f as [string, { s: number }][]
    expect(files.map(([name, a]) => [name, a.s])).toEqual([
      ['b.txt', 3],
      ['plan.txt', 4],
    ])
    expect(DEC.decode(fetched.body)).toBe('beeplan')
    end.close()
    await serving
  })

  it("pushes another's change and passes a barrier once the client answers", async () => {
    const changes = new RecentChanges(new ManualClock(0), 1)
    const { server, end, serving } = await served(changes)
    await end.call({ op: 'hello', proto: FSPROTO_VERSION })
    await SERVED_BY.run('dev', () => {
      changes.note('/notes/own.txt')
    })
    changes.note('/notes/plan.txt')
    changes.note('/elsewhere/x')
    let passed = false
    const barrier = server.begin().then((confirmed) => {
      passed = confirmed
    })
    await end.until(() => end.pushes.some((f) => f.head.op === 'begin'))
    expect(end.pushes[0]?.head).toEqual({ push: 'inval', paths: ['/notes/plan.txt'] })
    expect(passed).toBe(false)
    const begin = end.pushes.find((f) => f.head.op === 'begin')
    end.send({ hid: begin?.head.hid })
    await barrier
    expect(passed).toBe(true)
    end.close()
    await serving
  })

  it('never pushes a change to a name the session hides', async () => {
    const changes = new RecentChanges(new ManualClock(0), 1)
    const ws = new Workspace(
      { '/notes': new RAMVFS() },
      { mode: MountMode.WRITE, profiles: { hidden: { paths: { hide: ['/notes/secret.txt'] } } } },
    )
    await ws.session('agent', { profile: 'hidden' })
    const server = new FsprotoServer(ws.vfs, ws.getSession('agent'), undefined, {
      prefix: '/notes',
      machine: 'dev',
      changes,
    })
    const end = client()
    const serving = server.serve(end.reader, end.writer)
    await end.call({ op: 'hello', proto: FSPROTO_VERSION })
    changes.note('/notes/secret.txt')
    changes.note('/notes/plan.txt')
    const barrier = server.begin()
    await end.until(() => end.pushes.some((f) => f.head.op === 'begin'))
    expect(end.pushes[0]?.head).toEqual({ push: 'inval', paths: ['/notes/plan.txt'] })
    const begin = end.pushes.find((f) => f.head.op === 'begin')
    end.send({ hid: begin?.head.hid })
    expect(await barrier).toBe(true)
    end.close()
    await serving
  })

  it('gives a folder another mount serves its own cache choice', async () => {
    class SharedRAM extends RAMVFS {
      override readonly soleWriter: boolean = false
    }
    const ws = new Workspace(
      { '/notes': new RAMVFS(), '/notes/shared': new SharedRAM() },
      { mode: MountMode.WRITE },
    )
    await ws.session('agent')
    const server = new FsprotoServer(ws.vfs, ws.getSession('agent'), undefined, {
      prefix: '/notes',
      machine: 'dev',
      changes: null,
    })
    const end = client()
    const serving = server.serve(end.reader, end.writer)
    await ws.vfs.write('/notes/plan.txt', 'plan')
    const listed = await end.call({ op: 'list', path: '/notes' })
    const rows = new Map(listed.head.e as [string, Record<string, unknown>][])
    expect(listed.head.k).toBe(true)
    expect(rows.get('shared')?.k).toBe(false)
    expect(rows.get('plan.txt')?.k).toBeUndefined()
    end.close()
    await serving
  })

  it('refuses a request outside the served prefix', async () => {
    const { end, serving } = await served()
    expect((await end.call({ op: 'getattr', path: '/elsewhere' })).head.errno).toBe('EACCES')
    const moved = await end.call({ op: 'rename', from: '/notes/plan.txt', to: '/elsewhere' })
    expect(moved.head.errno).toBe('EACCES')
    end.close()
    await serving
  })

  it('refuses a barrier the pipe ends under', async () => {
    const { server, end, serving } = await served(new RecentChanges(new ManualClock(0), 1))
    await end.call({ op: 'hello', proto: FSPROTO_VERSION })
    const barrier = server.begin()
    await end.until(() => end.pushes.some((f) => f.head.op === 'begin'))
    end.close()
    await serving
    expect(await barrier).toBe(false)
  })

  it('refuses a barrier the client never answers', async () => {
    const { server, end, serving } = await served(new RecentChanges(new ManualClock(0), 1))
    await end.call({ op: 'hello', proto: FSPROTO_VERSION })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const barrier = server.begin()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await barrier).toBe(false)
    } finally {
      vi.useRealTimers()
    }
    end.close()
    await serving
  })

  it('stats, truncates and flushes through the handle a file is open on', async () => {
    const { ws, end, serving } = await served()
    const opened = await end.call({ op: 'open', path: '/notes/plan.txt', write: true })
    const fh = opened.head.fh
    await end.call({ op: 'write', fh, offset: 4 }, ENC.encode('!'))
    const seen = await end.call({ op: 'getattr', path: '/notes/plan.txt', fh })
    expect((seen.head.a as { s: number }).s).toBe(5)
    const flushed = await end.call({ op: 'flush', fh })
    expect(flushed.head.errno).toBeUndefined()
    expect(DEC.decode(await ws.vfs.read('/notes/plan.txt'))).toBe('plan!')
    await end.call({ op: 'unlink', path: '/notes/plan.txt' })
    await ws.vfs.write('/notes/plan.txt', 'fresh')
    const cut = await end.call({ op: 'setattr', path: '/notes/plan.txt', fh, size: 2 })
    expect((cut.head.a as { s: number }).s).toBe(2)
    await end.call({ op: 'release', fh })
    expect(DEC.decode(await ws.vfs.read('/notes/plan.txt'))).toBe('fresh')
    end.close()
    await serving
  })
})
