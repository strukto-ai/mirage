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

import {
  DEFAULT_READ_TTL,
  MountMode,
  ReadPolicy,
  type ReadSpec,
  WritePolicy,
} from '@struktoai/mirage-core/types'
import type { Deny, VfsResultContext } from '@struktoai/mirage-core/policy/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Workspace } from '../workspace.ts'
import { InlineBox } from '../../tests/vfs/fixtures/box.ts'
import { InlineDropbox } from '../../tests/vfs/fixtures/dropbox.ts'
import { buildVfs } from './registry.ts'

const STALE = 'changed since it was read; read it again before writing'
const ENC = new TextEncoder()
const DEC = new TextDecoder()
const SEED: Record<string, string> = { f: 'one\n', g: 'gee\n', 'd/a': 'a\n', 'd/b': 'b\n' }
const DROPBOX_CONFIG = { client_id: 'i', client_secret: 's', refresh_token: 'r' }

type Kind = 'box' | 'dropbox'

class Drive {
  readonly fake: InlineBox | InlineDropbox
  readonly root: string
  readonly move: string
  readonly download: string

  constructor(readonly kind: Kind) {
    const files = Object.fromEntries(Object.entries(SEED).map(([k, v]) => [k, ENC.encode(v)]))
    const box = kind === 'box'
    this.fake = box ? new InlineBox(files) : new InlineDropbox(files)
    this.root = box ? '/box' : '/dbx'
    this.move = box ? 'update' : 'move'
    this.download = box ? 'content' : 'download'
  }

  get box(): InlineBox {
    if (!(this.fake instanceof InlineBox)) throw new Error('not a Box drive')
    return this.fake
  }

  get dropbox(): InlineDropbox {
    if (!(this.fake instanceof InlineDropbox)) throw new Error('not a Dropbox drive')
    return this.fake
  }

  config(): Record<string, string> {
    return this.kind === 'box'
      ? { access_token: 't', endpoint: this.fake.url }
      : { ...DROPBOX_CONFIG, endpoint: this.fake.url }
  }

  put(key: string, data: string): void {
    if (this.fake instanceof InlineBox && this.fake.read(key) === undefined) {
      this.fake.create(key, ENC.encode(data))
    } else this.fake.write(key, ENC.encode(data))
  }

  drop(key: string): void {
    if (this.fake instanceof InlineBox) this.fake.delete(key, 'purge')
    else this.fake.delete(key)
  }

  text(key: string): string | undefined {
    const data = this.fake.read(key)
    return data === undefined ? undefined : DEC.decode(data)
  }

  hook(route: string, fn: () => void): void {
    this.fake.hooks.set(route, fn)
  }
}

let drive: Drive
const built: Workspace[] = []

async function workspace(
  write: WritePolicy = WritePolicy.CONDITIONAL,
  read?: ReadSpec,
): Promise<Workspace> {
  const vfs = await buildVfs(drive.kind, drive.config())
  const ws = new Workspace({
    [drive.root]: new Mount(vfs, {
      mode: MountMode.WRITE,
      write,
      ...(read === undefined ? {} : { read }),
    }),
  })
  built.push(ws)
  return ws
}

function use(kind: Kind): void {
  beforeEach(() => {
    drive = new Drive(kind)
    vi.stubGlobal('fetch', drive.fake.fetch)
  })
  afterEach(async () => {
    for (const ws of built.splice(0)) await ws.close()
    vi.unstubAllGlobals()
  })
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const r = await ws.shell(line)
  return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr)]
}

function refusal(verb: string): string {
  const r = drive.root
  if (verb === 'cp') return `cp: cannot create regular file '${r}/g': ${STALE}\n`
  return `mv: cannot move '${r}/f' to '${r}/g': '${r}/g' ${STALE}\n`
}

function readGate(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, resolve: release }
}

function fail(): never {
  throw new Error('injected server error')
}

describe.each(['box', 'dropbox'] as const)('conditional writes on %s', (kind) => {
  use(kind)

  it('refuses a changed file before any upload', async () => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/f`)
    drive.put('f', 'theirs\n')
    const uploads = drive.fake.count('upload')
    expect(await run(ws, `echo mine > ${r}/f`)).toEqual([1, '', `${r}/f: ${STALE}\n`])
    expect(drive.fake.count('upload')).toBe(uploads)
    expect(drive.text('f')).toBe('theirs\n')
  })

  it('refuses a write landing after the lookup', async () => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/f`)
    drive.hook('upload', () => {
      drive.put('f', 'theirs\n')
    })
    expect(await run(ws, `echo mine > ${r}/f`)).toEqual([1, '', `${r}/f: ${STALE}\n`])
    expect(drive.text('f')).toBe('theirs\n')
  })

  it.each(['echo x >> {r}/f', 'truncate -s 2 {r}/f'])(
    'carries the version of its own read: %s',
    async (line) => {
      const ws = await workspace()
      drive.hook('upload', () => {
        drive.put('f', 'theirs\n')
      })
      const [code, , err] = await run(ws, line.replace('{r}', drive.root))
      expect(code).toBe(1)
      expect(err).toContain(STALE)
      expect(drive.text('f')).toBe('theirs\n')
    },
  )

  it.each([
    ['unconditional', WritePolicy.UNCONDITIONAL],
    ['conditional', WritePolicy.CONDITIONAL],
  ])('an empty resize reads nothing: %s', async (_name, policy) => {
    const ws = await workspace(policy)
    expect(await run(ws, `truncate -s 0 ${drive.root}/f`)).toEqual([0, '', ''])
    expect(drive.fake.count(drive.download)).toBe(0)
    expect(drive.text('f')).toBe('')
  })

  it('a streamed ops read through an outdated listing holds its bytes', async () => {
    const r = drive.root
    const ws = await workspace()
    await ws.vfs.readdir(r)
    drive.put('f', 'B\n')
    const chunks: Uint8Array[] = []
    for await (const chunk of await ws.vfs.read(`${r}/f`, { stream: true })) chunks.push(chunk)
    expect(chunks.map((c) => DEC.decode(c)).join('')).toBe('B\n')
    drive.put('f', 'C\n')
    await expect(ws.vfs.write(`${r}/f`, ENC.encode('mine\n'))).rejects.toMatchObject({
      code: 'STALE_WRITE',
    })
    expect(drive.text('f')).toBe('C\n')
  })

  it.each(['peer\n', ''])(
    'failed stream rereads keep the refused session version (%j)',
    async (peer) => {
      const ws = await workspace()
      const a = await ws.session('a')
      const b = await ws.session('b')
      const path = `${drive.root}/f`
      await a.vfs.read(path)
      await b.vfs.write(path, ENC.encode(peer))
      await expect(a.vfs.write(path, ENC.encode('mine\n'))).rejects.toMatchObject({
        code: 'STALE_WRITE',
      })
      for (let i = 0; i < 2; i++) {
        await ws.cache.clear()
        drive.hook(drive.download, fail)
        let bytes = 0
        await expect(
          (async () => {
            const stream = await a.vfs.read(path, { stream: true })
            for await (const chunk of stream) bytes += chunk.byteLength
          })(),
        ).rejects.toThrow(/500|injected server error/)
        expect(bytes).toBe(0)
        await expect(a.vfs.write(path, ENC.encode('mine\n'))).rejects.toMatchObject({
          code: 'STALE_WRITE',
        })
        expect(drive.text('f')).toBe(peer)
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of await a.vfs.read(path, { stream: true })) chunks.push(chunk)
      expect(chunks.map((c) => DEC.decode(c)).join('')).toBe(peer)
      await a.vfs.write(path, ENC.encode('mine\n'))
      expect(drive.text('f')).toBe('mine\n')
    },
  )

  it.each([false, true])(
    'a denied reread cannot advance its session version (stream: %s)',
    async (streamed) => {
      const ws = await workspace(WritePolicy.CONDITIONAL, {
        policy: ReadPolicy.FRESH,
        ttl: DEFAULT_READ_TTL,
      })
      const a = await ws.session('a'),
        b = await ws.session('b')
      const path = `${drive.root}/f`
      await a.vfs.read(path)
      await b.vfs.write(path, ENC.encode('peer\n'))
      await ws.cache.clear()
      let enabled = true
      ws.policies.add({
        postVfs: (ctx: VfsResultContext) =>
          enabled && ctx.call.name === 'read'
            ? ({ kind: 'deny', reason: 'read blocked' } as Deny)
            : null,
      })
      await expect(a.vfs.read(path, { stream: streamed })).rejects.toMatchObject({ code: 'EACCES' })
      await expect(a.vfs.write(path, ENC.encode('mine\n'))).rejects.toMatchObject({
        code: 'STALE_WRITE',
      })
      expect(drive.text('f')).toBe('peer\n')
      enabled = false
      expect(await a.vfs.read(path)).toEqual(ENC.encode('peer\n'))
      await a.vfs.write(path, ENC.encode('mine\n'))
    },
  )

  it('a completed write keeps its version when its result is denied', async () => {
    const ws = await workspace()
    const a = await ws.session('a')
    const path = `${drive.root}/f`
    await a.vfs.read(path)
    let enabled = true
    ws.policies.add({
      postVfs: (ctx: VfsResultContext): Deny | null =>
        enabled && ctx.call.name === 'write' ? { kind: 'deny', reason: 'result blocked' } : null,
    })
    await expect(a.vfs.write(path, ENC.encode('first\n'))).rejects.toMatchObject({ code: 'EACCES' })
    expect(drive.text('f')).toBe('first\n')
    enabled = false
    await a.vfs.write(path, ENC.encode('second\n'))
    expect(drive.text('f')).toBe('second\n')
  })

  it('pins rm of an unread file to its lookup', async () => {
    const r = drive.root
    const ws = await workspace()
    drive.hook('delete', () => {
      drive.put('f', 'theirs\n')
    })
    expect(await run(ws, `rm ${r}/f`)).toEqual([1, '', `rm: cannot remove '${r}/f': ${STALE}\n`])
    expect(drive.text('f')).toBe('theirs\n')
  })

  it('rm -r removes an unchanged folder', async () => {
    drive.put('d/s/x', 'x\n')
    const ws = await workspace()
    expect(await run(ws, `rm -r ${drive.root}/d; ls ${drive.root}`)).toEqual([0, 'f\ng\n', ''])
  })

  it('lets the line write after rm -r', async () => {
    const r = drive.root
    const ws = await workspace()
    const mkdir = drive.kind === 'box' ? ` mkdir ${r}/d;` : ''
    const line = `cat ${r}/d/a > /dev/null; rm -r ${r}/d;${mkdir} echo x > ${r}/d/a`
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(drive.text('d/a')).toBe('x\n')
  })

  it('rm -r keeps a file changed during the walk', async () => {
    const r = drive.root
    const ws = await workspace()
    drive.hook('delete', () => {
      drive.put('d/b', 'theirs\n')
    })
    expect(await run(ws, `rm -r ${r}/d`)).toEqual([
      1,
      '',
      `rm: cannot remove '${r}/d/b': ${STALE}\n`,
    ])
    expect([drive.text('d/a'), drive.text('d/b')]).toEqual([undefined, 'theirs\n'])
  })

  it('rm -r names the first changed file and keeps both', async () => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/d/a ${r}/d/b`)
    drive.put('d/a', 'theirs\n')
    drive.put('d/b', 'theirs\n')
    expect(await run(ws, `rm -r ${r}/d`)).toEqual([
      1,
      '',
      `rm: cannot remove '${r}/d/a': ${STALE}\n`,
    ])
    expect(await run(ws, `echo x > ${r}/d/b`)).toEqual([1, '', `${r}/d/b: ${STALE}\n`])
  })

  it("rm -r stopped partway keeps the changed file's version", async () => {
    const r = drive.root
    for (const key of ['d/a', 'd/b']) drive.drop(key)
    drive.put('d/s/x', 'x\n')
    drive.put('d/t/y', 'y\n')
    const ws = await workspace()
    await run(ws, `cat ${r}/d/s/x`)
    drive.put('d/s/x', 'theirs\n')
    drive.hook('delete', () => {
      drive.put('d/t/late', 'late\n')
    })
    const [code, , err] = await run(ws, `rm -r ${r}/d`)
    expect(code).toBe(1)
    expect(err).toContain('Directory not empty')
    expect(await run(ws, `echo z > ${r}/d/s/x`)).toEqual([1, '', `${r}/d/s/x: ${STALE}\n`])
    expect(drive.text('d/s/x')).toBe('theirs\n')
  })

  it.each(['cp', 'mv'])('refuses %s onto a destination changed during its clear', async (verb) => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/g`)
    drive.hook('delete', () => {
      drive.put('g', 'theirs\n')
    })
    expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([1, '', refusal(verb)])
    expect([drive.text('f'), drive.text('g')]).toEqual(['one\n', 'theirs\n'])
  })

  it.each(['cp', 'mv'])(
    '%s stays refused on a destination recreated after its clear',
    async (verb) => {
      const r = drive.root
      const ws = await workspace()
      await run(ws, `cat ${r}/g`)
      const route = verb === 'cp' ? 'copy' : drive.move
      drive.hook('delete', () => {
        drive.hook(route, () => {
          drive.put('g', 'new\n')
        })
      })
      for (let i = 0; i < 2; i++) {
        expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([1, '', refusal(verb)])
        expect(drive.fake.count('delete')).toBe(1)
      }
      expect(drive.text('g')).toBe('new\n')
      expect(await run(ws, `echo x > ${r}/f`)).toEqual([0, '', ''])
    },
  )

  it.each(['cp', 'mv'])(
    "keeps no version when a folder retakes %s's destination after its clear",
    async (verb) => {
      const r = drive.root
      const ws = await workspace()
      await run(ws, `cat ${r}/g`)
      const route = verb === 'cp' ? 'copy' : drive.move
      drive.hook('delete', () => {
        drive.hook(route, () => {
          drive.put('g/x', 'x\n')
        })
      })
      expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([1, '', refusal(verb)])
      drive.drop('g')
      expect(await run(ws, `echo y > ${r}/g`)).toEqual([0, '', ''])
    },
  )

  it.each(['cp', 'mv'])('refuses once %s onto a destination gone since its read', async (verb) => {
    const r = drive.root
    const ws = await workspace()
    await run(ws, `cat ${r}/g`)
    drive.drop('g')
    expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([1, '', refusal(verb)])
    expect([drive.text('f'), drive.text('g')]).toEqual(['one\n', undefined])
    expect(await run(ws, `${verb} ${r}/f ${r}/g`)).toEqual([0, '', ''])
    expect(drive.text('g')).toBe('one\n')
  })

  it.each(['cp', 'mv'])('lets the line write after %s onto a read file', async (verb) => {
    const r = drive.root
    const ws = await workspace()
    const line = `cat ${r}/g > /dev/null; ${verb} ${r}/f ${r}/g; echo x > ${r}/g`
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(drive.text('g')).toBe('x\n')
  })

  it.each([
    ['file', false],
    ['ancestor', true],
  ])('a move lifts a kept version: %s', async (_name, ancestor) => {
    const r = drive.root
    let key = 'g'
    let move = `mv ${r}/g ${r}/h`
    if (ancestor) {
      key = 'd/a'
      move = `mv ${r}/d ${r}/e` + (drive.kind === 'box' ? `; mkdir ${r}/d` : '')
    }
    const ws = await workspace()
    await run(ws, `cat ${r}/${key}`)
    drive.put(key, 'theirs\n')
    const line = `echo x > ${r}/${key}; ${move}; echo new > ${r}/${key}`
    expect(await run(ws, line)).toEqual([0, '', `${r}/${key}: ${STALE}\n`])
    expect(drive.text(key)).toBe('new\n')
  })

  it('a copy onto a refused file lifts its refusal', async () => {
    const r = drive.root
    drive.hook('upload', () => {
      drive.put('g', 'theirs\n')
      drive.hook('upload', () => {
        drive.put('g', 'gee\n')
      })
    })
    const ws = await workspace()
    const line =
      `cat ${r}/g > /dev/null; echo x > ${r}/g; echo y > ${r}/y; ` +
      `cp ${r}/f ${r}/g && echo mine > ${r}/g`
    expect(await run(ws, line)).toEqual([0, '', `${r}/g: ${STALE}\n`])
    expect(drive.text('g')).toBe('mine\n')
  })
})

describe('conditional writes only Box has', () => {
  use('box')

  // A plain write uploads to the id the listing named; a held version is
  // checked live first, by that id, so a changed file is refused before its
  // body goes out. The redirect's write is its open: one upload.
  it('a conditional write asks by id before each upload', async () => {
    // Every write first asks, by the id the listing named, that the file is
    // still at the path; a held version is checked against that answer. The
    // redirect's write is its open: one upload.
    const logs: string[][] = []
    const fid = drive.box.idOf('f')
    for (const policy of [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL]) {
      const ws = await workspace(policy)
      await run(ws, 'cat /box/f')
      const before = drive.box.log.length
      await run(ws, 'echo mine > /box/f')
      logs.push(drive.box.log.slice(before))
      drive.put('f', SEED.f ?? '')
    }
    const upload = `upload:${fid}`
    const asked = [`info:${fid}`, upload]
    expect(logs).toEqual([asked, asked])
  })

  it('resizing holds the bytes it downloaded', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/f')
    drive.hook('content', () => {
      drive.put('f', 'theirs\n')
    })
    expect(await run(ws, 'truncate -s 3 /box/f')).toEqual([0, '', ''])
    expect(drive.text('f')).toBe('the')
  })

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ] as const)(
    'completed empty Box reread without sha1 releases the old version (stream %s, buffered %s)',
    async (streamed, buffered) => {
      const ws = await workspace(WritePolicy.CONDITIONAL, {
        policy: ReadPolicy.FRESH,
        ttl: DEFAULT_READ_TTL,
      })
      const a = await ws.session('a')
      const path = '/box/f'
      await a.vfs.read(path)
      drive.put('f', '')
      drive.box.unhashed.add(drive.box.idOf('f'))
      await expect(a.vfs.write(path, ENC.encode('mine\n'))).rejects.toMatchObject({
        code: 'STALE_WRITE',
      })
      if (buffered) ws.policies.add({ postVfs: () => Promise.resolve(null) })
      if (streamed) {
        const chunks: Uint8Array[] = []
        for await (const chunk of await a.vfs.read(path, { stream: true })) chunks.push(chunk)
        expect(chunks.reduce((n, c) => n + c.byteLength, 0)).toBe(0)
      } else expect(await a.vfs.read(path)).toEqual(new Uint8Array(0))
      await a.vfs.write(path, ENC.encode('mine\n'))
      expect(drive.text('f')).toBe('mine\n')
    },
  )

  it.each(
    [false, true].flatMap((warm) =>
      (['unpulled', 'closed', 'drained'] as const).map((finish) => [warm, finish] as const),
    ),
  )('a partial Box stream keeps its previous basis (warm %s, %s)', async (warm, finish) => {
    const ws = await workspace()
    const a = await ws.session('a'),
      b = await ws.session('b')
    const path = '/box/f',
      peer = 'prefix\nunread peer tail\n'
    await a.vfs.read(path)
    await b.vfs.write(path, ENC.encode(peer))
    if (!warm) await ws.cache.clear()
    const fetch = drive.fake.fetch
    vi.stubGlobal('fetch', async (...args: Parameters<typeof globalThis.fetch>) => {
      const response = await fetch(...args)
      const url = args[0] instanceof Request ? args[0].url : String(args[0])
      const method = args[0] instanceof Request ? args[0].method : (args[1]?.method ?? 'GET')
      if (method !== 'GET' || !new URL(url).pathname.endsWith('/content')) return response
      const data = new Uint8Array(await response.arrayBuffer())
      let offset = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === data.byteLength) controller.close()
            else {
              const end = offset === 0 ? Math.min(7, data.byteLength) : data.byteLength
              controller.enqueue(data.slice(offset, end))
              offset = end
            }
          },
        }),
        { status: response.status, headers: response.headers },
      )
    })
    const before = drive.fake.count(drive.download)
    const source = await a.vfs.read(path, { stream: true })
    expect(drive.fake.count(drive.download) - before).toBe(warm ? 0 : 1)
    const iterator = source[Symbol.asyncIterator]()
    try {
      if (finish === 'drained' || (warm && finish === 'closed')) {
        if (finish === 'drained') {
          const chunks: Uint8Array[] = []
          for await (const chunk of source) chunks.push(chunk)
          expect(chunks.map((c) => DEC.decode(c)).join('')).toBe(peer)
        } else {
          expect(await iterator.next()).toMatchObject({ done: false, value: ENC.encode(peer) })
          await iterator.return?.()
        }
        await a.vfs.write(path, ENC.encode('mine\n'))
        expect(drive.text('f')).toBe('mine\n')
      } else {
        if (finish === 'closed')
          expect(await iterator.next()).toMatchObject({
            done: false,
            value: ENC.encode('prefix\n'),
          })
        await iterator.return?.()
        await expect(a.vfs.write(path, ENC.encode('mine\n'))).rejects.toMatchObject({
          code: 'STALE_WRITE',
        })
        expect(drive.text('f')).toBe(peer)
      }
    } finally {
      await iterator.return?.()
    }
  })

  it.each(
    [false, true].flatMap((warm) =>
      [false, true].flatMap((known) =>
        (
          [
            [0, 7],
            [7, null],
            [0, 0],
            [999, null],
          ] as const
        )
          .filter(([offset]) => warm || offset !== 999)
          .map(([offset, size]) => [warm, known, offset, size] as const),
      ),
    ),
  )(
    'partial Box range observes a basis (warm %s, known %s, offset %s, size %s)',
    async (warm, known, offset, size) => {
      const ws = await workspace()
      const a = await ws.session('a'),
        b = await ws.session('b')
      const path = '/box/f',
        peer = 'prefix\nunread peer tail\n'
      drive.box.unhashed.delete(drive.box.idOf('f'))
      drive.put('f', SEED.f ?? '')
      await a.vfs.read(path)
      if (!known) drive.box.unhashed.add(drive.box.idOf('f'))
      await b.vfs.write(path, ENC.encode(peer))
      if (!warm) await ws.cache.clear()
      const before = drive.fake.count(drive.download)
      const got = await a.vfs.read(path, { offset, ...(size === null ? {} : { size }) })
      expect(DEC.decode(got)).toBe(peer.slice(offset, size === null ? undefined : offset + size))
      expect(drive.fake.count(drive.download) - before).toBe(warm || size === 0 ? 0 : 1)
      if (warm && known && got.byteLength > 0) {
        await a.vfs.write(path, ENC.encode('mine\n'))
        await b.vfs.read(path)
        await b.vfs.write(path, ENC.encode('new peer\n'))
        await expect(a.vfs.write(path, ENC.encode('again\n'))).rejects.toMatchObject({
          code: 'STALE_WRITE',
        })
        expect(drive.text('f')).toBe('new peer\n')
      } else {
        await expect(a.vfs.write(path, ENC.encode('mine\n'))).rejects.toMatchObject({
          code: 'STALE_WRITE',
        })
        expect(drive.text('f')).toBe(peer)
        expect(DEC.decode(await a.vfs.read(path))).toBe(peer)
        await a.vfs.write(path, ENC.encode('mine\n'))
        expect(drive.text('f')).toBe('mine\n')
      }
    },
  )

  it('a pending parallel read cannot hide a completed observation', async () => {
    const ws = await workspace(WritePolicy.CONDITIONAL, {
      policy: ReadPolicy.FRESH,
      ttl: DEFAULT_READ_TTL,
    })
    const a = await ws.session('a'),
      b = await ws.session('b')
    const ready = [readGate(), readGate()] as const
    const release = [readGate(), readGate()] as const
    const fetch = drive.fake.fetch
    let started = 0
    vi.stubGlobal('fetch', async (...args: Parameters<typeof globalThis.fetch>) => {
      const url = args[0] instanceof Request ? args[0].url : String(args[0])
      const method = args[0] instanceof Request ? args[0].method : (args[1]?.method ?? 'GET')
      if (method === 'GET' && new URL(url).pathname.endsWith('/content')) {
        const index = started++
        if (index !== 0 && index !== 1) throw new Error('unexpected extra download')
        ready[index].resolve()
        await release[index].promise
      }
      return fetch(...args)
    })
    const first = a.vfs.read('/box/f', { stream: true })
    await ready[0].promise
    const second = a.vfs.read('/box/f', { stream: true })
    await ready[1].promise
    try {
      release[0].resolve()
      const chunks: Uint8Array[] = []
      for await (const chunk of await first) chunks.push(chunk)
      expect(chunks.map((c) => DEC.decode(c)).join('')).toBe(SEED.f)
      await b.vfs.write('/box/f', ENC.encode('peer\n'))
      await expect(a.vfs.write('/box/f', ENC.encode('mine\n'))).rejects.toMatchObject({
        code: 'STALE_WRITE',
      })
      expect(drive.text('f')).toBe('peer\n')
    } finally {
      release.forEach((gate) => {
        gate.resolve()
      })
      for (const task of [first, second]) {
        const source = await task
        await source[Symbol.asyncIterator]().return?.()
      }
    }
  })

  it.each(['append', 'resize'] as const)(
    'uses a completed tokenless read for a Box %s',
    async (operation) => {
      const ws = await workspace()
      const a = await ws.session('a')
      await a.vfs.read('/box/f')
      drive.put('f', 'peer\n')
      drive.box.unhashed.add(drive.box.idOf('f'))
      await ws.cache.clear()
      const line = operation === 'append' ? 'echo extra >> /box/f' : 'truncate -s 2 /box/f'
      const result = await a.shell(line)
      expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([0, ''])
      const want = operation === 'append' ? 'peer\nextra\n' : 'pe'
      expect(drive.text('f')).toBe(want)
    },
  )

  it('resizing a file Box keeps no sha1 for goes out plain', async () => {
    drive.box.unhashed.add(drive.box.idOf('f'))
    const ws = await workspace()
    expect(await run(ws, 'truncate -s 2 /box/f')).toEqual([0, '', ''])
    expect(drive.text('f')).toBe('on')
  })

  it('lets the next write through after a folder merge', async () => {
    drive.put('e/d/a', 'old\n')
    const ws = await workspace()
    const line = 'cat /box/e/d/a >/dev/null; cp -r /box/d /box/e; echo y > /box/e/d/a'
    expect(await run(ws, line)).toEqual([0, '', ''])
    expect(await run(ws, 'echo z > /box/e/d/a')).toEqual([0, '', ''])
    expect(drive.text('e/d/a')).toBe('z\n')
  })

  it('a folder merge keeps the versions of files it left', async () => {
    drive.put('e/d/a', 'new\n')
    const ws = await workspace()
    await run(ws, 'cat /box/d/b')
    expect(await run(ws, 'cp -r /box/e/d /box')).toEqual([0, '', ''])
    drive.put('d/b', 'theirs\n')
    expect(await run(ws, 'echo mine > /box/d/b')).toEqual([1, '', `/box/d/b: ${STALE}\n`])
    expect(drive.text('d/b')).toBe('theirs\n')
  })

  it('a folder copied whole lifts the lost marks beneath it', async () => {
    drive.put('s/a', 'new\n')
    drive.hook('upload', () => {
      drive.put('d/a', 'theirs\n')
      drive.hook('upload', () => {
        drive.drop('d')
      })
    })
    // Only a fresh mount lists again to see d gone: a write keeps its own row
    // in its folder's listing rather than dropping the listing.
    const ws = await workspace(WritePolicy.CONDITIONAL, {
      policy: ReadPolicy.FRESH,
      ttl: DEFAULT_READ_TTL,
    })
    const line =
      'cat /box/d/a > /dev/null; echo x > /box/d/a; echo y > /box/y; ' +
      'cp -r /box/s /box/d && echo mine > /box/d/a'
    expect(await run(ws, line)).toEqual([0, '', `/box/d/a: ${STALE}\n`])
    expect(drive.text('d/a')).toBe('mine\n')
  })

  it('a folder copy that failed keeps the versions beneath it', async () => {
    drive.put('s/a', 'new\n')
    drive.hook('upload', () => {
      drive.drop('d')
    })
    drive.hook('copy', () => {
      drive.put('d/a', 'theirs\n')
      fail()
    })
    const ws = await workspace()
    const line =
      'cat /box/d/a > /dev/null; echo z > /box/z; ' +
      'cp -r /box/s /box/d; ls /box/d; echo mine > /box/d/a'
    const [code, out, err] = await run(ws, line)
    expect([code, out]).toEqual([1, 'a\n'])
    expect(err.endsWith(`/box/d/a: ${STALE}\n`)).toBe(true)
    expect(drive.text('d/a')).toBe('theirs\n')
  })

  it.each([
    ['link gone', true],
    ['link kept', false],
  ])('rm -r deletes a web link plainly: %s', async (_name, gone) => {
    drive.box.createLink('d/bookmark')
    if (gone)
      drive.hook('delete', () => {
        drive.drop('d/bookmark')
      })
    const ws = await workspace()
    expect(await run(ws, 'rm -r /box/d; ls /box')).toEqual([0, 'f\ng\n', ''])
  })

  it('rm -r reports a web link it may not delete', async () => {
    const link = drive.box.createLink('d/bookmark')
    drive.box.forbidden.add(link)
    const ws = await workspace()
    const denied = `${drive.box.url}/2.0/web_links/${link} → 403 {"code":"forbidden"}`
    expect(await run(ws, 'rm -r /box/d')).toEqual([1, '', `rm: Box DELETE ${denied}\n`])
    expect(await run(ws, 'ls /box')).toEqual([0, 'd\nf\ng\n', ''])
  })

  it.each(['cp', 'mv'])(
    "keeps no version when a web link retakes %s's destination",
    async (verb) => {
      const ws = await workspace()
      await run(ws, 'cat /box/g')
      const route = verb === 'cp' ? 'copy' : 'update'
      drive.hook('delete', () => {
        drive.hook(route, () => drive.box.createLink('g'))
      })
      expect(await run(ws, `${verb} /box/f /box/g`)).toEqual([1, '', refusal(verb)])
      drive.drop('g')
      expect(await run(ws, 'echo y > /box/g')).toEqual([0, '', ''])
    },
  )

  it.each([
    ['line', true],
    ['next line', false],
  ])('a cp that changed nothing keeps the held version: %s', async (_name, sameLine) => {
    const ws = await workspace()
    drive.hook('delete', () => {
      drive.put('g', 'theirs\n')
      fail()
    })
    let code: number
    let err: string
    if (sameLine) {
      ;[code, , err] = await run(ws, 'cat /box/g >/dev/null; cp /box/f /box/g; echo mine > /box/g')
    } else {
      await run(ws, 'cat /box/g')
      await run(ws, 'cp /box/f /box/g')
      ;[code, , err] = await run(ws, 'echo mine > /box/g')
    }
    expect(code).toBe(1)
    expect(err.endsWith(`/box/g: ${STALE}\n`)).toBe(true)
    expect(drive.text('g')).toBe('theirs\n')
  })

  it('a cp whose delete landed but failed serves no stale bytes', async () => {
    const ws = await workspace()
    await run(ws, 'cat /box/g')
    drive.hook('delete', () => {
      drive.drop('g')
      fail()
    })
    const [code] = await run(ws, 'cp /box/f /box/g')
    expect(code).toBe(1)
    const [catCode, out] = await run(ws, 'cat /box/g')
    expect([catCode, out]).toEqual([1, ''])
  })
})

describe.each(['box', 'dropbox'] as const)('an append on %s', (kind) => {
  use(kind)

  it('keeps a file created after the listing', async () => {
    const ws = await workspace(WritePolicy.UNCONDITIONAL)
    await run(ws, `ls ${drive.root}`)
    drive.put('n', 'v1\n')
    const [code, , err] = await run(ws, `echo x >> ${drive.root}/n`)
    expect([code, err]).toEqual([0, ''])
    expect(drive.text('n')).toBe('v1\nx\n')
  })
})

describe('conditional writes only Dropbox has', () => {
  use('dropbox')

  it('keeps the version a read past an outdated listing took', async () => {
    const ws = await workspace()
    await run(ws, 'ls /dbx')
    drive.put('n', 'v1\n')
    expect(await run(ws, 'cat /dbx/n')).toEqual([0, 'v1\n', ''])
    drive.put('n', 'theirs\n')
    expect(await run(ws, 'echo mine > /dbx/n')).toEqual([1, '', `/dbx/n: ${STALE}\n`])
    expect(drive.text('n')).toBe('theirs\n')
  })

  it('costs a held write one lookup more than a plain one', async () => {
    const routes: string[][] = []
    for (const policy of [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL]) {
      const ws = await workspace(policy)
      await run(ws, 'cat /dbx/f')
      const before = drive.dropbox.log.length
      await run(ws, 'echo mine > /dbx/f')
      routes.push(drive.dropbox.log.slice(before).filter((r) => r !== 'token'))
      drive.put('f', SEED.f ?? '')
    }
    expect(routes).toEqual([
      ['get_metadata', 'upload'],
      ['get_metadata', 'get_metadata', 'upload'],
    ])
  })

  it.each([
    ['mv', 'move'],
    ['cp', 'copy'],
  ])('%s of a vanished source costs a read destination nothing', async (verb, route) => {
    const ws = await workspace()
    await run(ws, 'ls /dbx; cat /dbx/g')
    drive.drop('f')
    const [code, , err] = await run(ws, `${verb} /dbx/f /dbx/g`)
    expect(code).toBe(1)
    expect(err).toContain('No such file or directory')
    expect(drive.fake.count(route)).toBe(1)
    expect(drive.fake.count('delete')).toBe(0)
    expect(drive.text('g')).toBe('gee\n')
  })

  it.each([
    ['cp', 'copy'],
    ['mv', 'move'],
  ])('refuses %s onto a destination a folder took, deleting nothing', async (verb, route) => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    drive.hook(route, () => {
      drive.drop('g')
      drive.put('g/x', 'x\n')
    })
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect(drive.fake.count('delete')).toBe(0)
    expect([drive.text('f'), drive.text('g/x')]).toEqual(['one\n', 'x\n'])
    drive.drop('g')
    expect(await run(ws, 'echo y > /dbx/g')).toEqual([0, '', ''])
  })

  it.each(['cp', 'mv'])('names a source gone before the retry for %s', async (verb) => {
    const ws = await workspace()
    await run(ws, 'cat /dbx/g')
    drive.hook('delete', () => {
      drive.drop('f')
    })
    const missing =
      verb === 'cp'
        ? "cp: cannot open '/dbx/f' for reading"
        : "mv: cannot move '/dbx/f' to '/dbx/g'"
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([
      1,
      '',
      `${missing}: No such file or directory\n`,
    ])
    expect(drive.fake.count('delete')).toBe(1)
  })

  it.each([
    ['cp', 'copy'],
    ['mv', 'move'],
  ])('refuses once %s onto an unread destination retaken after its clear', async (verb, route) => {
    const ws = await workspace()
    drive.hook('delete', () => {
      drive.hook(route, () => {
        drive.put('g', 'new\n')
      })
    })
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([1, '', refusal(verb)])
    expect(drive.text('g')).toBe('new\n')
    expect(await run(ws, `${verb} /dbx/f /dbx/g`)).toEqual([0, '', ''])
    expect(drive.text('g')).toBe('one\n')
  })
})

describe('partial Dropbox stream observations', () => {
  use('dropbox')

  it.each([false, true])(
    'observes the response token only after delivering bytes (warm %s)',
    async (warm) => {
      const ws = await workspace()
      const a = await ws.session('a'),
        b = await ws.session('b')
      const path = '/dbx/f',
        peer = 'peer\n'
      await a.vfs.read(path)
      await b.vfs.write(path, ENC.encode(peer))
      if (!warm) await ws.cache.clear()
      const source = await a.vfs.read(path, { stream: true })
      const iterator = source[Symbol.asyncIterator]()
      try {
        await expect(a.vfs.write(path, ENC.encode('not seen\n'))).rejects.toMatchObject({
          code: 'STALE_WRITE',
        })
        expect(drive.text('f')).toBe(peer)
        expect(await iterator.next()).toMatchObject({ done: false, value: ENC.encode(peer) })
        await iterator.return?.()
        await a.vfs.write(path, ENC.encode('mine\n'))
        expect(drive.text('f')).toBe('mine\n')
      } finally {
        await iterator.return?.()
      }
    },
  )
})
