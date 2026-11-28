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
import { type FileStat, MountMode, type PathSpec } from '../types.ts'
import { ManualClock } from '../utils/clock.ts'
import type { Action } from '../policy/types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import { RecentChanges, SERVED_BY } from './changes.ts'
import {
  FSPROTO_FRAME_BYTES,
  FSPROTO_READ_CONCURRENCY,
  FSPROTO_VERSION,
  FSPROTO_WHOLE_BYTES,
} from './constants.ts'
import { type Frame, FrameReader, FsprotoServer, bounded, encodeFrame } from './fsproto.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/**
 * A mirage-fuse end: requests go in, replies come back by id, pushes queue apart.
 * Between `hold` and `release` its pipe takes nothing more, as a pipe a slow
 * transport carries does.
 */
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
    drain: () => room,
    end: () => undefined,
  }
  let room: Promise<void> = Promise.resolve()
  let release: () => void = () => undefined
  let next = 0
  async function until(test: () => boolean): Promise<void> {
    while (!test()) await new Promise<void>((resolve) => waiting.push(resolve))
  }
  return {
    reader,
    writer,
    replies,
    pushes,
    until,
    hold() {
      room = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    release() {
      release()
      room = Promise.resolve()
    },
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

/**
 * A RAM store whose stat of `slow.txt` waits between `hold` and `go`, as a
 * backend that answers over the network keeps a request out.
 */
class SlowStat extends RAMVFS {
  private gate: Promise<void> = Promise.resolve()
  private opened: () => void = () => undefined

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.opened = resolve
    })
  }

  go(): void {
    this.opened()
    this.gate = Promise.resolve()
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    if (path.virtual.endsWith('/slow.txt')) await this.gate
    return super.stat(path)
  }
}

async function served(
  changes: RecentChanges | null = null,
  vfs: RAMVFS = new RAMVFS(),
  readAhead: [number | null, number | null] = [null, null],
) {
  const ws = new Workspace({ '/notes': vfs }, { mode: MountMode.WRITE })
  await ws.vfs.write('/notes/plan.txt', 'plan')
  await ws.session('agent')
  const server = new FsprotoServer(ws.vfs, ws.getSession('agent'), undefined, {
    prefix: '/notes',
    machine: 'dev',
    changes,
    readAhead: readAhead[0],
    readAheadTotal: readAhead[1],
  })
  const end = client()
  const serving = server.serve(end.reader, end.writer)
  return { ws, server, end, serving }
}

class HeldRAM extends RAMVFS {
  override readonly soleWriter: boolean = false
}

async function watched(
  watch: (sessionId: string) => Promise<boolean>,
  vfs: () => RAMVFS = () => new RAMVFS(),
) {
  const ws = new Workspace({ '/notes': vfs() }, { mode: MountMode.WRITE })
  await ws.vfs.write('/notes/plan.txt', 'plan')
  await ws.session('agent')
  const server = new FsprotoServer(ws.vfs, ws.getSession('agent'), undefined, {
    prefix: '/notes',
    machine: 'dev',
    changes: new RecentChanges(new ManualClock(0), 1),
    watched: watch,
  })
  const end = client()
  const serving = server.serve(end.reader, end.writer)
  return { server, end, serving }
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
  it('refuses a reply past the frame limit', () => {
    const head = (frame: Uint8Array): unknown => {
      const length = new DataView(frame.buffer, frame.byteOffset).getUint32(4)
      return JSON.parse(DEC.decode(frame.subarray(8, 8 + length)))
    }
    const small = { id: 1, e: [], k: true }
    expect(head(bounded(small, new Uint8Array(), 64))).toEqual(small)
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

  it('answers a listing for only the folder asked for', async () => {
    const { ws, end, serving } = await served()
    await ws.vfs.mkdir('/notes/sub')
    await ws.vfs.write('/notes/sub/a.txt', 'a')
    const listed = await end.call({ op: 'list', path: '/notes', deep: true })
    expect((listed.head.e as [string, unknown][]).map(([name]) => name)).toEqual([
      'plan.txt',
      'sub',
    ])
    expect(listed.head.d).toBeUndefined()
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

  it('carries the first bytes a read-only open asks for', async () => {
    const { end, serving } = await served()
    const path = '/notes/plan.txt'
    const some = await end.call({ op: 'open', path, first: 3 })
    const whole = await end.call({ op: 'open', path, first: 100 })
    const plain = await end.call({ op: 'open', path })
    const writes = await end.call({ op: 'open', path, write: true, first: 100 })
    expect([some, whole, plain, writes].map((r) => [r.head.first, DEC.decode(r.body)])).toEqual([
      [true, 'pla'],
      [true, 'plan'],
      [undefined, ''],
      [undefined, ''],
    ])
    for (const r of [some, whole, plain, writes]) await end.call({ op: 'release', fh: r.head.fh })
    end.close()
    await serving
  })

  it('holds back reads past those at once while the pipe has not taken their replies', async () => {
    const { end, serving } = await served()
    const opened = await end.call({ op: 'open', path: '/notes/plan.txt' })
    const fh = opened.head.fh
    end.hold()
    const ids = Array.from({ length: FSPROTO_READ_CONCURRENCY + 2 }, (_, i) => 101 + i)
    for (const id of ids) end.send({ op: 'read', fh, offset: 0, size: 2, id })
    const answered = (): number => ids.filter((id) => end.replies.has(id)).length
    await end.until(() => answered() === FSPROTO_READ_CONCURRENCY)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(answered()).toBe(FSPROTO_READ_CONCURRENCY)
    end.release()
    await end.until(() => answered() === ids.length)
    expect(new Set(ids.map((id) => DEC.decode(end.replies.get(id)?.body)))).toEqual(new Set(['pl']))
    await end.call({ op: 'release', fh })
    end.close()
    await serving
  })

  it('answers a read without waiting for a slow read before it', async () => {
    const vfs = new SlowStat()
    const { ws, end, serving } = await served(null, vfs)
    await ws.vfs.write('/notes/slow.txt', 'slow')
    vfs.hold()
    end.send({ op: 'getattr', path: '/notes/slow.txt', id: 101 })
    end.send({ op: 'getattr', path: '/notes/plan.txt', id: 102 })
    await end.until(() => end.replies.has(102))
    expect(end.replies.has(101)).toBe(false)
    vfs.go()
    await end.until(() => end.replies.has(101))
    end.close()
    await serving
  })

  it('has a change wait for the reads before it and hold back those after', async () => {
    const vfs = new SlowStat()
    const { ws, end, serving } = await served(null, vfs)
    await ws.vfs.write('/notes/slow.txt', 'slow')
    vfs.hold()
    end.send({ op: 'getattr', path: '/notes/slow.txt', id: 101 })
    end.send({ op: 'mkdir', path: '/notes/made', mode: 0o755, id: 102 })
    end.send({ op: 'getattr', path: '/notes/made', id: 103 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(end.replies.size).toBe(0)
    vfs.go()
    await end.until(() => end.replies.has(103))
    expect([...end.replies.keys()]).toEqual([101, 102, 103])
    expect(end.replies.get(103)?.head.errno).toBeUndefined()
    end.close()
    await serving
  })

  it("has a read-only release wait for no other file's reads", async () => {
    const vfs = new SlowStat()
    const { ws, end, serving } = await served(null, vfs)
    await ws.vfs.write('/notes/slow.txt', 'slow')
    const opened = await end.call({ op: 'open', path: '/notes/plan.txt' })
    vfs.hold()
    end.send({ op: 'getattr', path: '/notes/slow.txt', id: 101 })
    end.send({ op: 'release', fh: opened.head.fh, id: 102 })
    await end.until(() => end.replies.has(102))
    expect(end.replies.has(101)).toBe(false)
    vfs.go()
    await end.until(() => end.replies.has(101))
    end.close()
    await serving
  })

  it('says in hello that attributes mark attributes, with the read-ahead set', async () => {
    const { end, serving } = await served(null, new RAMVFS(), [1 << 20, 8 << 20])
    const hello = await end.call({ op: 'hello', proto: FSPROTO_VERSION })
    expect(hello.head).toEqual({
      id: hello.head.id,
      proto: FSPROTO_VERSION,
      xattrs: true,
      read_ahead: 1 << 20,
      read_ahead_total: 8 << 20,
    })
    const plain = await served()
    const bare = await plain.end.call({ op: 'hello', proto: FSPROTO_VERSION })
    expect([bare.head.read_ahead, bare.head.read_ahead_total]).toEqual([undefined, undefined])
    end.close()
    plain.end.close()
    await Promise.all([serving, plain.serving])
  })

  it('marks the attributes of an entry that carries extended attributes', async () => {
    const { ws, end, serving } = await served()
    await ws.vfs.write('/notes/bare.txt', 'bare')
    await ws.vfs.setxattr('/notes/plan.txt', 'user.k', ENC.encode('v'))
    const listed = await end.call({ op: 'list', path: '/notes' })
    const rows = new Map(listed.head.e as [string, Record<string, unknown>][])
    expect([rows.get('plan.txt')?.x, rows.get('bare.txt')?.x]).toEqual([true, undefined])
    const marked = await end.call({ op: 'getattr', path: '/notes/plan.txt' })
    const bare = await end.call({ op: 'getattr', path: '/notes/bare.txt' })
    const attrs = (frame: Frame) => frame.head.a as Record<string, unknown>
    expect([attrs(marked).x, attrs(bare).x]).toEqual([true, undefined])
    end.close()
    await serving
  })

  it('marks attributes as the served session sees them', async () => {
    const ws = new Workspace(
      { '/notes': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: { hidden: { paths: { hide: ['/notes/plan.txt'] } }, open: {} },
        profile: 'hidden',
      },
    )
    const agent = await ws.session('agent', { profile: 'open' })
    await agent.vfs.write('/notes/plan.txt', 'plan')
    await agent.vfs.setxattr('/notes/plan.txt', 'user.k', ENC.encode('v'))
    const server = new FsprotoServer(ws.vfs, ws.getSession('agent'), undefined, {
      prefix: '/notes',
      machine: 'dev',
      changes: null,
    })
    const end = client()
    const serving = server.serve(end.reader, end.writer)
    const plan = await end.call({ op: 'getattr', path: '/notes/plan.txt' })
    expect((plan.head.a as Record<string, unknown>).x).toBe(true)
    end.close()
    await serving
  })

  it('lists a link that leads back to itself and asks of its attributes', async () => {
    const { end, serving } = await served()
    const made = await end.call({ op: 'symlink', path: '/notes/loop', target: 'loop' })
    expect(made.head.errno).toBeUndefined()
    const listed = await end.call({ op: 'list', path: '/notes' })
    const rows = new Map(listed.head.e as [string, Record<string, unknown>][])
    expect(rows.get('loop')?.x).toBe(true)
    end.close()
    await serving
  })

  it('carries no more first bytes than a whole read', async () => {
    const { ws, end, serving } = await served()
    const path = '/notes/big.bin'
    await ws.vfs.write(path, new Uint8Array(FSPROTO_WHOLE_BYTES + 1).fill(120))
    const opened = await end.call({ op: 'open', path, first: FSPROTO_FRAME_BYTES })
    expect([opened.head.first, opened.body.byteLength]).toEqual([true, FSPROTO_WHOLE_BYTES])
    const released = await end.call({ op: 'release', fh: opened.head.fh })
    expect(released.head.errno).toBeUndefined()
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

  it('reads nothing ahead of the program', async () => {
    const { end, serving } = await served()
    const fetched = await end.call({ op: 'fetchdir', path: '/notes' })
    expect(fetched.head.errno).toBeDefined()
    expect(fetched.body.byteLength).toBe(0)
    end.close()
    await serving
  })

  it('keeps nothing while a policy judges file calls', async () => {
    const asked: string[] = []
    const { end, serving } = await watched((sessionId) => {
      asked.push(sessionId)
      return Promise.resolve(true)
    })
    const stat = await end.call({ op: 'getattr', path: '/notes/plan.txt' })
    const listed = await end.call({ op: 'list', path: '/notes' })
    const whole = await end.call({ op: 'readall', path: '/notes/plan.txt' })
    expect([stat, listed, whole].map((r) => [r.head.k, r.head.w])).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ])
    expect(asked).toEqual(['agent', 'agent', 'agent'])
    end.close()
    await serving
  })

  it('reads nothing with an open while a policy judges file calls', async () => {
    const { end, serving } = await watched(() => Promise.resolve(true))
    const opened = await end.call({ op: 'open', path: '/notes/plan.txt', first: 100 })
    expect([opened.head.first, opened.head.w, opened.body.byteLength]).toEqual([undefined, true, 0])
    end.close()
    await serving
  })

  it('drops all the client kept before a barrier once a policy comes', async () => {
    let on = false
    const { server, end, serving } = await watched(() => Promise.resolve(on))
    const stat = await end.call({ op: 'getattr', path: '/notes/plan.txt' })
    expect([stat.head.k, stat.head.w]).toEqual([true, undefined])
    on = true
    const barrier = server.begin()
    await end.until(() => end.pushes.some((f) => f.head.op === 'begin'))
    expect(end.pushes[0]?.head).toEqual({ push: 'watch' })
    end.send({ hid: end.pushes.find((f) => f.head.op === 'begin')?.head.hid })
    expect(await barrier).toBe(true)
    end.pushes.splice(0)
    const again = server.begin()
    await end.until(() => end.pushes.length > 0)
    expect(end.pushes[0]?.head.op).toBe('begin')
    end.send({ hid: end.pushes[0]?.head.hid })
    expect(await again).toBe(true)
    end.close()
    await serving
  })

  it('drops answers held for a second too once a policy comes', async () => {
    let on = false
    const { server, end, serving } = await watched(
      () => Promise.resolve(on),
      () => new HeldRAM(),
    )
    expect((await end.call({ op: 'getattr', path: '/notes/plan.txt' })).head.k).toBe(false)
    on = true
    const barrier = server.begin()
    await end.until(() => end.pushes.some((f) => f.head.op === 'begin'))
    expect(end.pushes[0]?.head).toEqual({ push: 'watch' })
    end.send({ hid: end.pushes.find((f) => f.head.op === 'begin')?.head.hid })
    expect(await barrier).toBe(true)
    end.close()
    await serving
  })

  it('tells whether a policy judges file calls', async () => {
    const plain = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
    const judged = new Workspace({ '/notes': new RAMVFS() }, { mode: MountMode.WRITE })
    judged.policies.add({ preVfs: (): Action | null => null })
    interface Watching {
      watched(sessionId: string): Promise<boolean>
    }
    expect(await (plain as unknown as Watching).watched('')).toBe(false)
    expect(await (judged as unknown as Watching).watched('')).toBe(true)
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
