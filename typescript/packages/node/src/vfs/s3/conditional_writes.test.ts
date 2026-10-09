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

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { markLost } from '@struktoai/mirage-core/observe/context'
import { MountMode, PathSpec, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MountCore } from '../../fuse/core.ts'
import { MinIOVFS } from '../minio/minio.ts'
import { inFlightConflict, installS3Mock, MUTATIONS, type S3Mock } from './mock.ts'
import { s3Vfs } from '../../test-utils.ts'
import { Workspace } from '../../workspace.ts'

const STALE = 'changed since it was read; read it again before writing'
const ENC = new TextEncoder()
const DEC = new TextDecoder()
const SEED: Record<string, string> = { f: 'one\n', g: 'gee\n', 'd/a': 'a\n', 'd/b': 'b\n' }

function etag(data: string): string {
  return `"${createHash('md5').update(data).digest('hex')}"`
}

const ONE = { IfMatch: etag('one\n') }
const GEE = { IfMatch: etag('gee\n') }
const EMPTY = { IfMatch: etag('') }

function minioVfs(): MinIOVFS {
  return new MinIOVFS({
    bucket: 'b',
    endpoint: 'http://127.0.0.1:9000',
    accessKeyId: 'k',
    secretAccessKey: 's',
  })
}

function minioMount(): Mount {
  return new Mount(minioVfs(), { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL })
}

function ramMount(): Mount {
  return new Mount(new RAMVFS(), { mode: MountMode.WRITE })
}

function buildWorkspace(
  write: WritePolicy = WritePolicy.CONDITIONAL,
  extra: Record<string, Mount> = {},
): Workspace {
  return new Workspace(
    {
      '/s3': new Mount(s3Vfs(), { mode: MountMode.WRITE, write }),
      '/ram': ramMount(),
      ...extra,
    },
    { mode: MountMode.WRITE },
  )
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const r = await ws.shell(line)
  return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr)]
}

describe('conditional writes on an S3 mount', () => {
  let mock: S3Mock
  const built: Workspace[] = []

  beforeAll(() => {
    mock = installS3Mock()
  })
  afterAll(() => {
    mock.restore()
  })
  beforeEach(() => {
    for (const b of mock.store.allBuckets()) mock.store.objects(b).clear()
    for (const [k, v] of Object.entries(SEED)) mock.store.set('b', k, ENC.encode(v))
    mock.ledger.length = 0
    mock.tripwire = false
    mock.pageSize = null
    mock.undeletable.clear()
    mock.clearHooks()
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const ws of built.splice(0)) await ws.close()
  })

  const workspace = (
    write: WritePolicy = WritePolicy.CONDITIONAL,
    extra: Record<string, Mount> = {},
  ): Workspace => {
    const ws = buildWorkspace(write, extra)
    built.push(ws)
    return ws
  }
  const mutations = (): [string, Record<string, string>][] =>
    mock.ledger.filter(([op]) => MUTATIONS.has(op))
  const sent = (op: string): Record<string, string>[] =>
    mutations()
      .filter(([name]) => name === op)
      .map(([, params]) => params)
  const theirs = (key = 'f'): void => {
    mock.store.set('b', key, ENC.encode('theirs\n'))
  }
  const changeOn = (when: string, key: string): void => {
    if (when === 'after') theirs(key)
    else
      mock.before(when, () => {
        theirs(key)
      })
  }
  const keysUnder = (prefix: string): string[] =>
    [...mock.store.objects('b').keys()].filter((k) => k.startsWith(prefix)).sort()
  const object = (key: string): string | undefined => {
    const data = mock.store.get('b', key)
    return data === undefined ? undefined : DEC.decode(data)
  }

  it.each([
    [
      'redirect',
      ['echo a > /s3/new'],
      '({ printf b; printf c; printf E >&2; printf d; printf e; } >/s3/new) 2>/ram/err',
      'PutObject',
      [{ IfMatch: etag('a\n') }, EMPTY, { IfMatch: etag('bc') }],
    ],
    [
      'sed',
      ['sed -i s/one/ONE/ /s3/f'],
      'echo x > /s3/f',
      'PutObject',
      [{ IfMatch: etag('ONE\n') }, EMPTY],
    ],
    ['grep', ['grep o /s3/f'], 'echo z > /s3/f', 'PutObject', [ONE, EMPTY]],
    ['head', ['head -n1 /s3/f'], 'echo z > /s3/f', 'PutObject', [ONE, EMPTY]],
    ['wc', ['wc -l /s3/f'], 'echo z > /s3/f', 'PutObject', [ONE, EMPTY]],
    [
      'append',
      ['echo a >> /s3/f'],
      'echo z > /s3/f',
      'PutObject',
      [{ IfMatch: etag('one\na\n') }, EMPTY],
    ],
    [
      'truncate',
      ['truncate -s 2 /s3/f'],
      'echo z > /s3/f',
      'PutObject',
      [{ IfMatch: etag('on') }, EMPTY],
    ],
    [
      'cross-cp',
      ['echo hi > /ram/x; cp /ram/x /s3/y'],
      'echo z > /s3/y',
      'PutObject',
      [{ IfMatch: etag('hi\n') }, EMPTY],
    ],
    ['removed', ['cat /s3/f', 'rm /s3/f'], 'echo x > /s3/f', 'PutObject', [{}, EMPTY]],
    ['unread-tee', [], 'echo y | tee /s3/g', 'PutObject', [{}]],
    ['unread-cross-cp', [], 'echo r > /ram/r; cp /ram/r /s3/g', 'PutObject', [{}]],
    ['unread-cp', [], 'cp /s3/f /s3/g', 'CopyObject', [{}]],
    ['rm-on-line', [], 'cat /s3/f; rm /s3/f; echo x > /s3/f', 'PutObject', [{}, EMPTY]],
    ['mv-on-line', [], 'cat /s3/g; mv /s3/g /s3/h; echo y > /s3/g', 'PutObject', [{}, EMPTY]],
    ['rm-r-on-line', [], 'cat /s3/d/a; rm -r /s3/d; echo x > /s3/d/a', 'PutObject', [{}, EMPTY]],
    ['rm-r', ['cat /s3/d/a; rm -r /s3/d'], 'echo x > /s3/d/a', 'PutObject', [{}, EMPTY]],
    ['dir-mv', ['cat /s3/d/a; mv /s3/d /s3/e'], 'echo x > /s3/d/a', 'PutObject', [{}, EMPTY]],
    [
      'dir-mv-copies',
      [],
      'mv /s3/d /s3/e',
      'CopyObject',
      [{ CopySourceIfMatch: etag('a\n') }, { CopySourceIfMatch: etag('b\n') }],
    ],
  ] as [string, string[], string, string, Record<string, string>[]][])(
    'carries the version mirage holds: %s',
    async (_name, setup, line, op, expected) => {
      const ws = workspace()
      for (const prior of setup) expect((await run(ws, prior))[0], prior).toBe(0)
      mock.ledger.length = 0
      const [code, , err] = await run(ws, line)
      expect([code, err]).toEqual([0, ''])
      expect(sent(op)).toEqual(expected)
    },
  )

  it.each([
    [true, 'write', 'f', 'x\n', [ONE]],
    [false, 'write', 'g', 'y\n', [{}]],
    [false, 'append', 'g', 'x\n', [GEE]],
    [false, 'pwrite', 'g', 'G', [GEE]],
  ] as const)(
    'writes with the version it holds through the ops API: read=%s %s',
    async (read, call, key, data, expected) => {
      const ws = workspace()
      if (read) await ws.vfs.read(`/s3/${key}`)
      mock.ledger.length = 0
      if (call === 'pwrite') await ws.vfs.pwrite(`/s3/${key}`, ENC.encode(data), 0)
      else await ws.vfs[call](`/s3/${key}`, ENC.encode(data))
      expect(sent('PutObject')).toEqual(expected)
    },
  )

  it.each([
    ['cat /s3/f', 'cp /s3/g /s3/f'],
    ['cat /s3/f', 'mv /s3/g /s3/f'],
    ['grep one /s3/f', 'echo x > /s3/f'],
  ])(
    'refuses a write to a file deleted since it was read, then frees it: %s; %s',
    async (setup, line) => {
      // Gone, so no newer bytes to protect: no version is kept, the retry goes plain.
      const ws = workspace()
      await run(ws, setup)
      mock.store.delete('b', 'f')
      const [code, , err] = await run(ws, line)
      expect([code, err.includes(STALE)]).toEqual([1, true])
      expect(object('f')).toBeUndefined()
      expect((await run(ws, line))[0]).toBe(0)
    },
  )

  it.each([
    ['shell', 'truncate -s 5 /s3/f'],
    ['shell', 'echo x >> /s3/f'],
    ['append', 'x\n'],
    ['append', ''],
    ['pwrite', 'G'],
    ['pwrite', ''],
  ] as const)(
    'refuses an op finding a read file gone, before writing: %s %j',
    async (call, arg) => {
      // A restore of the old bytes lands between the op's own read and its write.
      const ws = workspace()
      if (call === 'shell') await run(ws, 'cat /s3/f')
      else await ws.vfs.read('/s3/f')
      mock.store.delete('b', 'f')
      mock.ledger.length = 0
      mock.before('PutObject', () => {
        mock.store.set('b', 'f', ENC.encode(SEED.f ?? ''))
      })
      if (call === 'shell') {
        const [code, , err] = await run(ws, arg)
        expect([code, err.includes(STALE)], err).toEqual([1, true])
      } else {
        const op =
          call === 'append'
            ? ws.vfs.append('/s3/f', ENC.encode(arg))
            : ws.vfs.pwrite('/s3/f', ENC.encode(arg), 0)
        await expect(op).rejects.toMatchObject({ code: 'STALE_WRITE' })
      }
      expect(mutations()).toEqual([])
      expect(object('f')).toBeUndefined()
    },
  )

  const LOSS: [string, string | null, string, string, string, string, number][] = [
    ['sort', 'cat /s3/f', 'sort -o /s3/f /s3/f', 'f', 'after', 'sort: ', 2],
    ['sed', null, 'sed -i s/one/ONE/ /s3/f', 'f', 'PutObject', "sed: couldn't edit /s3/f: ", 4],
    ['cp', 'cat /s3/f', 'cp /s3/g /s3/f', 'f', 'after', 'cp: ', 1],
    [
      'mv-dst',
      'cat /s3/f',
      'mv /s3/g /s3/f',
      'f',
      'after',
      "mv: cannot move '/s3/g' to '/s3/f': '/s3/f' ",
      1,
    ],
    ['append', null, 'echo x >> /s3/f', 'f', 'PutObject', '/s3/f: ', 1],
    ['truncate', null, 'truncate -s 1 /s3/f', 'f', 'PutObject', 'truncate: ', 1],
    ['truncate-0', 'cat /s3/f', 'truncate -s 0 /s3/f', 'f', 'after', 'truncate: ', 1],
    ['rm-unread', null, 'rm /s3/f', 'f', 'DeleteObject', 'rm: ', 1],
    [
      'mv-dst-relative',
      'cat /s3/f',
      'cd /s3; mv g f',
      'f',
      'after',
      "mv: cannot move 'g' to 'f': 'f' ",
      1,
    ],
    [
      'mv-src-copy',
      null,
      'mv /s3/g /s3/new',
      'g',
      'CopyObject',
      "mv: cannot move '/s3/g' to '/s3/new': '/s3/g' ",
      1,
    ],
    [
      'mv-src-read',
      'cat /s3/g',
      'mv /s3/g /s3/new',
      'g',
      'after',
      "mv: cannot move '/s3/g' to '/s3/new': '/s3/g' ",
      1,
    ],
    [
      'mv-src-delete',
      null,
      'mv /s3/g /s3/new',
      'g',
      'DeleteObject',
      "mv: cannot remove '/s3/g': ",
      1,
    ],
  ]

  it.each(LOSS)(
    'refuses a stale write and leaves the object: %s',
    async (name, setup, line, key, when, prefix, exit) => {
      const ws = workspace()
      if (setup !== null) await run(ws, setup)
      changeOn(when, key)
      const [code, , err] = await run(ws, line)
      expect(code, err).toBe(exit)
      expect(err.includes(STALE) && err.startsWith(prefix), err).toBe(true)
      expect(object(key)).toBe('theirs\n')
      // Only a move whose copy landed before its delete lost keeps the copy.
      expect(object('new')).toBe(name === 'mv-src-delete' ? 'gee\n' : undefined)
      mock.ledger.length = 0
      expect(await run(ws, `cat /s3/${key}`)).toEqual([0, 'theirs\n', ''])
      expect(mock.ledger.filter(([op]) => op === 'GetObject').length).toBe(1)
    },
  )

  it.each([
    [null, 'DeleteObjects', 'd/b', 'rm -r /s3/d', 'd/a', `rm: cannot remove '/s3/d/b': ${STALE}\n`],
    ['cat /s3/d/a', 'after', 'd/a', 'rm -r /s3/d', 'd/b', null],
    ['cat /s3/d/a', 'after', 'd/a', 'mv /s3/d /s3/e', 'd/b', null],
    [null, 'DeleteObjects', 'd/b', 'mv /s3/d /s3/e', 'd/a', null],
    [null, 'CopyObject', 'd/a', 'mv /s3/d /s3/e', 'e/a', null],
  ] as const)(
    'keeps and names a file changed under a directory op: %s; %s on %s; %s',
    async (setup, when, changed, line, gone, stderr) => {
      const ws = workspace()
      if (setup !== null) await run(ws, setup)
      changeOn(when, changed)
      const [code, , err] = await run(ws, line)
      expect([code, err.includes(STALE), err.includes(`'/s3/${changed}'`)], err).toEqual([
        1,
        true,
        true,
      ])
      if (stderr !== null) expect(err).toBe(stderr)
      expect(object(changed)).toBe('theirs\n')
      expect(object(gone)).toBeUndefined()
    },
  )

  it('still guards the file a landed move made', async () => {
    // GNU's mv will not overwrite a target this mv made with its second source.
    mock.store.set('b', 'x/g', ENC.encode('ex\n'))
    mock.store.set('b', 'y/g', ENC.encode('why\n'))
    mock.store.set('b', 't/k', ENC.encode('k\n'))
    const ws = workspace()
    changeOn('DeleteObject', 'x/g')
    expect(await run(ws, 'mv /s3/x/g /s3/y/g /s3/t/')).toEqual([
      1,
      '',
      `mv: cannot remove '/s3/x/g': ${STALE}\n` +
        "mv: will not overwrite just-created '/s3/t/g' with '/s3/y/g'\n",
    ])
    expect(object('t/g')).toBe('ex\n')
  })

  it.each([
    [
      'reread from cache',
      ['cat /s3/f; cat /s3/f; echo x > /s3/f'],
      'PutObject',
      'cat /s3/f; echo y > /s3/f',
      'y\n',
    ],
    [
      'mv onto',
      ['mv /s3/g /s3/f', 'mv /s3/g /s3/f'],
      'CopyObject',
      'cat /s3/f > /dev/null; mv /s3/g /s3/f',
      'gee\n',
    ],
    [
      'cp onto',
      ['cp /s3/g /s3/f', 'cp /s3/g /s3/f'],
      'CopyObject',
      'cat /s3/f > /dev/null; cp /s3/g /s3/f',
      'gee\n',
    ],
    ['rm', ['rm /s3/f', 'rm /s3/f'], 'DeleteObject', 'cat /s3/f > /dev/null; rm /s3/f', undefined],
  ] as const)(
    'keeps a refused write refused until a read: %s',
    async (_name, lines, op, final, after) => {
      // The refusal keeps the version it lost on; a retry sends it again.
      const ws = workspace()
      await run(ws, 'cat /s3/f')
      theirs()
      mock.ledger.length = 0
      for (const line of lines) {
        const [code, , err] = await run(ws, line)
        expect(code === 1 && err.includes(STALE), `${line}: ${err}`).toBe(true)
      }
      expect(object('f')).toBe('theirs\n')
      expect(object('g')).toBe('gee\n')
      const params = sent(op)
      expect(params.length).toBeGreaterThan(0)
      expect(
        params.every((p) => p.IfMatch === ONE.IfMatch),
        JSON.stringify(params),
      ).toBe(true)
      expect((await run(ws, final))[0]).toBe(0)
      expect(object('f')).toBe(after)
    },
  )

  it.each([
    [
      'mv source, untouched destination',
      'cat /s3/f',
      'CopyObject',
      ['g'],
      'f',
      'mv /s3/g /s3/f',
      'echo z > /s3/f',
    ],
    [
      'mv source, the changed source',
      'cat /s3/f',
      'CopyObject',
      ['g'],
      'g',
      'mv /s3/g /s3/f',
      'echo z > /s3/g',
    ],
    ['same line', '', 'PutObject', ['f'], 'f', 'cat /s3/f; echo x > /s3/f', 'echo z > /s3/f'],
    [
      'same line, warm',
      'cat /s3/f',
      'PutObject',
      ['f'],
      'f',
      'cat /s3/f; echo x > /s3/f',
      'echo z > /s3/f',
    ],
    [
      'rm -r, every lost key',
      'cat /s3/d/a /s3/d/b',
      'DeleteObjects',
      ['d/a', 'd/b'],
      'd/b',
      'rm -r /s3/d',
      'echo z > /s3/d/b',
    ],
    ['rm -r, an unread key', '', 'DeleteObjects', ['d/b'], 'd/b', 'rm -r /s3/d', 'rm -r /s3/d'],
    [
      'dir mv, every lost key',
      'cat /s3/d/a /s3/d/b',
      'CopyObject',
      ['d/a', 'd/b'],
      'd/b',
      'mv /s3/d /s3/e',
      'echo z > /s3/d/b',
    ],
    [
      'mv unread source, removal lost',
      '',
      'DeleteObject',
      ['f'],
      'f',
      'mv /s3/f /s3/g',
      'echo z > /s3/f',
    ],
    [
      'mv destination, untouched source',
      'cat /s3/f /s3/g',
      'CopyObject',
      ['g'],
      'f',
      'mv /s3/f /s3/g',
      'echo z > /s3/f',
    ],
  ] as const)(
    'keeps every version a refusal was measured on: %s',
    async (_name, setup, op, changed, key, refused, line) => {
      // Every changed path keeps its version, so a write over newer bytes is refused.
      const ws = workspace()
      if (setup !== '') await run(ws, setup)
      mock.before(op, () => {
        for (const k of changed) theirs(k)
      })
      let [code, , err] = await run(ws, refused)
      expect(code === 1 && err.includes(STALE), err).toBe(true)
      mock.store.set('b', key, ENC.encode('newest\n'))
      ;[code, , err] = await run(ws, line)
      expect(code === 1 && err.includes(STALE), err).toBe(true)
      expect(object(key)).toBe('newest\n')
    },
  )

  it.each([
    ['rm', 'cat /s3/f /s3/g', 'f', 'mv /s3/f /s3/g; rm /s3/g', 'g'],
    ['rm -r of an ancestor', 'cat /s3/g /s3/d/a', 'g', 'mv /s3/g /s3/d/a; rm -r /s3/d', 'd/a'],
    ['mv away', 'cat /s3/f /s3/g', 'f', 'mv /s3/f /s3/g; mv /s3/g /s3/h', 'g'],
    ['mv onto', 'cat /s3/f /s3/g', 'f', 'mv /s3/f /s3/g; mv /s3/d/a /s3/g', 'g'],
    ['mv of an ancestor', 'cat /s3/g /s3/d/a', 'g', 'mv /s3/g /s3/d/a; mv /s3/d /s3/e', 'd/a'],
  ] as const)(
    'lifts a kept version once the file is gone: %s',
    async (_name, setup, changed, line, key) => {
      // The refused mv keeps the untouched end's version; once that file is
      // removed or moved away, a new one goes out plain.
      const ws = workspace()
      await run(ws, setup)
      theirs(changed)
      const [code, , err] = await run(ws, `${line}; echo new > /s3/${key}`)
      expect(code, err).toBe(0)
      expect(object(key)).toBe('new\n')
    },
  )

  it.each([
    ['rm', 'DeleteObject', 'rm /s3/g', 'g', 'gee\n'],
    ['rm -r', 'DeleteObjects', 'rm -r /s3/d', 'd/a', 'a\n'],
    ['mv', 'CopyObject', 'mv /s3/g /s3/h', 'g', 'gee\n'],
  ] as const)(
    'lifts no mark a refusal made while a removal ran: %s',
    async (_name, op, line, key, bytes) => {
      // A refusal another command of the line makes during the op stays.
      const ws = workspace()
      await run(ws, `cat /s3/${key}`)
      mock.before(op, () => {
        markLost(PathSpec.fromStrPath(`/s3/${key}`, `/${key}`), etag(bytes))
      })
      const [code, , err] = await run(ws, `${line}; echo z > /s3/${key}`)
      expect(code === 1 && err.includes(STALE), err).toBe(true)
      expect(mock.store.get('b', key)).toBeUndefined()
    },
  )

  it('refuses a write racing another, then lands it on retry', async () => {
    // A 409 is a refusal; the file did not change, so the kept version lands.
    const ws = workspace()
    await run(ws, 'cat /s3/f')
    mock.before('PutObject', () => {
      throw inFlightConflict()
    })
    const [code, , err] = await run(ws, 'echo mine > /s3/f')
    expect([code, err.includes(STALE), object('f')], err).toEqual([1, true, 'one\n'])
    const [again, , againErr] = await run(ws, 'echo mine > /s3/f')
    expect([again, object('f')], againErr).toEqual([0, 'mine\n'])
  })

  it('names a refused destination file of a directory mv', async () => {
    const ws = workspace()
    mock.store.set('b', 'e/a', ENC.encode('ea\n'))
    await run(ws, 'cat /s3/e/a')
    mock.store.delete('b', 'e/a')
    const [code, , err] = await run(ws, 'mv -T /s3/d /s3/e')
    expect(code).toBe(1)
    expect(err.startsWith("mv: cannot move '/s3/d/a' to '/s3/e/a': '/s3/e/a' "), err).toBe(true)
  })

  it.each([
    ['destination gone', null, 'd/a'],
    ['destination changed', 'dst', 'd/a'],
    ['source changed', 'src', 'e/a'],
  ] as const)(
    'keeps the untouched end of a refused directory mv: %s',
    async (_n, beforeCopy, untouched) => {
      // The end a refused copy left alone keeps its version, as a file mv's does.
      const ws = workspace()
      mock.store.set('b', 'e/a', ENC.encode('ea\n'))
      await run(ws, 'cat /s3/d/a /s3/e/a')
      mock.store.delete('b', 'e/a')
      if (beforeCopy === 'dst') {
        mock.before('CopyObject', () => {
          theirs('e/a')
        })
      } else if (beforeCopy === 'src') {
        mock.before('CopyObject', () => {
          mock.store.set('b', 'e/a', ENC.encode('ea\n'))
          theirs('d/a')
        })
      }
      const [code, , err] = await run(ws, 'mv -T /s3/d /s3/e')
      expect([code, err.includes(STALE)], err).toEqual([1, true])
      mock.store.set('b', untouched, ENC.encode('newest\n'))
      const [again, , againErr] = await run(ws, `echo z > /s3/${untouched}`)
      expect([again, againErr.includes(STALE)], againErr).toEqual([1, true])
      expect(object(untouched)).toBe('newest\n')
    },
  )

  it('holds each destination key a directory rename read', async () => {
    // Every changed destination key is refused and keeps its version.
    const ws = workspace()
    mock.store.set('b', 'e/a', ENC.encode('ea\n'))
    mock.store.set('b', 'e/b', ENC.encode('eb\n'))
    await run(ws, 'cat /s3/e/a /s3/e/b')
    theirs('e/a')
    theirs('e/b')
    await expect(ws.vfs.rename('/s3/d', '/s3/e')).rejects.toMatchObject({
      code: 'STALE_WRITE',
      virtualPath: '/s3/e/a',
    })
    expect(object('d/a')).toBe('a\n')
    for (const key of ['e/a', 'e/b']) {
      expect(object(key)).toBe('theirs\n')
      mock.store.set('b', key, ENC.encode('newest\n'))
      const [code, , err] = await run(ws, `echo z > /s3/${key}`)
      expect(code === 1 && err.includes(STALE), err).toBe(true)
      expect(object(key)).toBe('newest\n')
    }
  })

  it.each([
    ['gone', true],
    ['never read', false],
  ] as const)('renames a directory onto a key it holds no version of: %s', async (_name, read) => {
    // A destination key found gone keeps no version; one never read is replaced plain.
    const ws = workspace()
    mock.store.set('b', 'e/a', ENC.encode('ea\n'))
    if (read) {
      await run(ws, 'cat /s3/e/a')
      mock.store.delete('b', 'e/a')
      await expect(ws.vfs.rename('/s3/d', '/s3/e')).rejects.toMatchObject({
        code: 'STALE_WRITE',
      })
      const [code, , err] = await run(ws, 'echo z > /s3/e/a')
      expect(code, err).toBe(0)
      expect(object('e/a')).toBe('z\n')
    } else {
      await ws.vfs.rename('/s3/d', '/s3/e')
      expect(object('e/a')).toBe('a\n')
    }
  })

  it('refuses an ops call again after a refusal', async () => {
    // Outside a line the kept version lives only in the cache.
    const ws = workspace()
    await ws.vfs.read('/s3/f')
    theirs()
    for (let i = 0; i < 2; i++) {
      await expect(ws.vfs.write('/s3/f', ENC.encode('x\n'))).rejects.toMatchObject({
        code: 'STALE_WRITE',
      })
    }
    expect(object('f')).toBe('theirs\n')
  })

  it.each([WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL])(
    'reports a key the store refuses under a recursive remove (%s)',
    async (write) => {
      // DeleteObjects answers 200 and names a refused key in its body.
      const ws = workspace(write)
      mock.undeletable.add('d/a')
      const [code, , err] = await run(ws, 'rm -r /s3/d')
      expect([code, err.includes('Permission denied')]).toEqual([1, true])
      expect(object('d/a')).toBe('a\n')
    },
  )

  it('lifts a refusal on a reread in the same line', async () => {
    // The read refetches theirs, so the write after it carries its version.
    const ws = workspace()
    await run(ws, 'cat /s3/f')
    mock.before('PutObject', () => {
      theirs('f')
    })
    const [code, out, err] = await run(ws, 'echo x > /s3/f; cat /s3/f; echo y > /s3/f')
    expect([code, out, err.split(STALE).length - 1], err).toEqual([0, 'theirs\n', 1])
    expect(object('f')).toBe('y\n')
    expect((await run(ws, 'cat /s3/f'))[1]).toBe('y\n')
  })

  it.each([
    [WritePolicy.CONDITIONAL, true, 'theirs\n'],
    [WritePolicy.UNCONDITIONAL, false, 'mine'],
  ] as const)(
    'judges a script opening a read file to write it: %s',
    async (write, refused, after) => {
      // The runtime's truncating open carries the version the agent read.
      const ws = new Workspace(
        { '/s3': new Mount(s3Vfs(), { mode: MountMode.WRITE, write }) },
        { mode: MountMode.EXEC },
      )
      built.push(ws)
      await run(ws, 'cat /s3/f')
      theirs('f')
      const [code, out, err] = await run(
        ws,
        "node -e \"const e = {}; const f = std.open('/s3/f', 'w', e); if (f === null) { print(e.errno); std.exit(3) } f.puts('mine'); f.close()\"",
      )
      expect([code, out, object('f')], err).toEqual(refused ? [3, '72\n', after] : [0, '', after])
    },
    120_000,
  )

  it('serves a lost file fresh, not from the line read', async () => {
    // The line read the old bytes; once its write lost, they are not the file.
    const ws = workspace()
    mock.before('PutObject', () => {
      theirs('f')
    })
    expect((await run(ws, 'cat /s3/f; echo x > /s3/f'))[0]).toBe(1)
    expect((await run(ws, 'cat /s3/f'))[1]).toBe('theirs\n')
  })

  it('keeps no version for a refusal on a file since removed', async () => {
    // Lost on a 412, then found gone: the gone refusal keeps no version.
    const ws = workspace()
    await run(ws, 'cat /s3/f')
    mock.before('PutObject', () => {
      theirs('f')
    })
    mock.before('PutObject', () => {
      mock.store.objects('b').delete('f')
    })
    const [, out, err] = await run(ws, 'echo a > /s3/f; echo b > /s3/f; echo c > /s3/f; echo $?')
    expect([out, err.split(STALE).length - 1], err).toEqual(['0\n', 2])
    expect(object('f')).toBe('c\n')
  })

  it.each([
    ['file mv', 'cat /s3/f /s3/g', 'mv /s3/g /s3/f', 'g'],
    ['dir mv', 'cat /s3/d/a /s3/d/b', 'mv /s3/d /s3/e', 'd/a'],
  ] as const)(
    'keeps no version for a move source found gone: %s',
    async (_name, setup, line, key) => {
      // Nothing newer is there to guard, so the path is written plain again.
      const ws = workspace()
      await run(ws, setup)
      mock.before('CopyObject', () => {
        mock.store.objects('b').delete(key)
      })
      expect((await run(ws, line))[0]).toBe(1)
      const [code, , err] = await run(ws, `echo z > /s3/${key}`)
      expect(code, err).toBe(0)
      expect(object(key)).toBe('z\n')
    },
  )

  it('keeps no version for a walk key found gone beside the named one', async () => {
    // d/a is named; d/b, gone too, is kept by the walk and keeps nothing.
    const ws = workspace()
    await run(ws, 'cat /s3/d/a /s3/d/b')
    mock.before('CopyObject', () => {
      theirs('d/a')
      mock.store.objects('b').delete('d/b')
    })
    expect((await run(ws, 'mv /s3/d /s3/e'))[0]).toBe(1)
    const [code, , err] = await run(ws, 'echo z > /s3/d/b')
    expect(code, err).toBe(0)
    expect(object('d/b')).toBe('z\n')
  })

  it('reports a refused key in a page and keeps the lost one', async () => {
    // The refusal is reported; the changed key stays refused until read.
    const ws = workspace()
    await run(ws, 'cat /s3/d/a /s3/d/b')
    mock.undeletable.add('d/b')
    mock.before('DeleteObjects', () => {
      theirs('d/a')
    })
    let [code, , err] = await run(ws, 'rm -r /s3/d')
    expect([code, err]).toEqual([1, "rm: cannot remove '/s3/d': Permission denied\n"])
    mock.store.set('b', 'd/a', ENC.encode('newest\n'))
    ;[code, , err] = await run(ws, 'echo z > /s3/d/a')
    expect(code === 1 && err.includes(STALE), err).toBe(true)
    expect(object('d/a')).toBe('newest\n')
  })

  it('names the operand for a refused key under a root mount', async () => {
    // The refused key is a backend key, not a path; the operand is named.
    const ws = workspace(WritePolicy.CONDITIONAL, {
      '/': new Mount(s3Vfs(), { mode: MountMode.WRITE }),
    })
    mock.undeletable.add('d/a')
    const [code, , err] = await run(ws, 'rm -r /d')
    expect([code, err]).toEqual([1, "rm: cannot remove '/d': Permission denied\n"])
  })

  it('carries the version on a kernel mount write', async () => {
    // FUSE writes through MountCore; a stale truncating open is refused.
    const ws = workspace()
    const core = new MountCore(ws.vfs)
    expect(DEC.decode(await core.read('/s3/d/a', -1, 0, 100))).toBe('a\n')
    mock.ledger.length = 0
    const fd = await core.open('/s3/d/a', constants.O_WRONLY | constants.O_TRUNC)
    await core.write('/s3/d/a', fd, ENC.encode('A\n'), 0)
    await core.release(fd)
    expect(object('d/a')).toBe('A\n')
    expect(sent('PutObject')).toEqual([{ IfMatch: etag('a\n') }, { IfMatch: etag('') }])
    expect(DEC.decode(await core.read('/s3/f', -1, 0, 100))).toBe('one\n')
    theirs()
    await expect(core.open('/s3/f', constants.O_WRONLY | constants.O_TRUNC)).rejects.toMatchObject({
      code: 'STALE_WRITE',
    })
    expect(object('f')).toBe('theirs\n')
  })

  it.each([
    ['cat /s3/f', 'echo x | tee /s3/f'],
    ['cat /s3/f', 'cp /s3/g /s3/f'],
    ['cat /s3/f', 'rm /s3/f'],
    [null, 'echo x >> /s3/f'],
    [null, 'truncate -s 1 /s3/f'],
    [null, 'rm /s3/f'],
    [null, 'mv /s3/g /s3/new'],
    [null, 'rm -r /s3/d'],
    ['cat /s3/f', 'sed -i s/one/two/ /s3/f'],
    ['cat /s3/g', 'echo a > /ram/x; cp /ram/x /s3/g'],
    ['cat /s3/x; echo a > /ram/x', 'cd /ram && tar -cf /ram/t.tar x && tar -xf /ram/t.tar -C /s3'],
    ['cat /s3/cpr', 'echo p > /ram/p; cp -r /ram/p /s3/cpr'],
    ['cat /s3/part.aa /s3/part.ab', "printf 'a\\nb\\n' | split -l 1 - /s3/part."],
  ] as const)('lands a current write with its condition (%s; %s)', async (setup, line) => {
    // The tripwire fails any mutation sent without a condition.
    for (const key of ['x', 'part.aa', 'part.ab', 'cpr'])
      mock.store.set('b', key, ENC.encode('seed\n'))
    const ws = workspace()
    mock.tripwire = true
    if (setup !== null) await run(ws, setup)
    const [code, , err] = await run(ws, line)
    expect([code, err]).toEqual([0, ''])
  })

  it('sends no condition from an unconditional mount', async () => {
    const ws = workspace(WritePolicy.UNCONDITIONAL)
    for (const line of [
      'cat /s3/f',
      'echo x > /s3/f',
      'echo x >> /s3/f',
      'cp /s3/g /s3/h',
      'mv /s3/h /s3/i',
      'rm /s3/i',
      'rm -r /s3/d',
    ]) {
      expect((await run(ws, line))[0], line).toBe(0)
    }
    expect(mutations().every(([, params]) => Object.keys(params).length === 0)).toBe(true)
    // Nor does it keep a version without bytes: a read that keeps none
    // leaves no token behind.
    expect((await run(ws, 'head -c 1 /s3/g'))[0]).toBe(0)
    expect(await ws.cache.exists('/s3/g')).toBe(false)
    expect(await ws.cache.fingerprint('/s3/g')).toBeNull()
  })

  it('conditions only the writes to the conditional mount', async () => {
    const ws = workspace(WritePolicy.CONDITIONAL, {
      '/u': new Mount(s3Vfs('u'), { mode: MountMode.WRITE }),
    })
    await run(ws, 'cat /s3/f')
    mock.ledger.length = 0
    expect((await run(ws, 'cp /s3/f /u/f'))[0]).toBe(0)
    expect((await run(ws, 'sort -o /u/g /s3/f'))[0]).toBe(0)
    expect(mutations().every(([, params]) => Object.keys(params).length === 0)).toBe(true)
    mock.ledger.length = 0
    expect((await run(ws, 'cat /u/f; cp /u/f /s3/f'))[0]).toBe(0)
    expect(mutations()).toEqual([['PutObject', ONE]])
  })

  it.each(['rm /s3/f', 'cp /s3/g /s3/f'])(
    'judges an endpoint set after the mount is built: %s',
    async (line) => {
      // A server set by the environment later may ignore a delete's condition.
      for (const name of [
        'AWS_ENDPOINT_URL',
        'AWS_ENDPOINT_URL_S3',
        'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
      ]) {
        vi.stubEnv(name, undefined)
      }
      const ws = workspace()
      expect((await run(ws, 'echo x > /s3/h'))[0]).toBe(0)
      vi.stubEnv('AWS_ENDPOINT_URL', 'http://minio.local:9000')
      const [code, , err] = await run(ws, line)
      expect(code === 1 && err.includes('Operation not supported'), err).toBe(true)
      expect(object('f')).toBe(SEED.f)
    },
  )

  it('leaves the destination in place when a move out is refused', async () => {
    // Refused before anything moves: no backup renames the destination aside.
    const ws = workspace(WritePolicy.CONDITIONAL, { '/m': minioMount() })
    await run(ws, 'echo mine > /ram/f')
    const [code, , err] = await run(ws, 'mv -b /m/f /ram/f')
    expect(code === 1 && err.includes('Operation not supported'), err).toBe(true)
    expect((await run(ws, 'cat /ram/f'))[1]).toBe('mine\n')
    expect((await run(ws, 'ls /ram'))[1]).toBe('f\n')
    expect(mutations()).toEqual([])
  })

  it('refuses up front a move holding a nested minio mount', async () => {
    // Else the walk copies the nested mount, its deletes are refused, half moved.
    const ws = workspace(WritePolicy.CONDITIONAL, {
      '/other': ramMount(),
      '/ram/d/m': minioMount(),
    })
    await run(ws, 'mkdir -p /ram/d; echo a > /ram/d/a')
    const [code, , err] = await run(ws, 'mv /ram/d /other/d')
    expect(code === 1 && err.includes('Operation not supported'), err).toBe(true)
    expect((await run(ws, 'cat /ram/d/a'))[1]).toBe('a\n')
    expect((await run(ws, 'ls /other'))[1]).toBe('')
    expect(mutations()).toEqual([])
  })

  it('moves a file out of a mount nested in a minio mount', async () => {
    // The source's own mount deletes it; the minio mount above is untouched.
    const ws = workspace(WritePolicy.CONDITIONAL, {
      '/data': minioMount(),
      '/data/scratch': ramMount(),
      '/other': ramMount(),
    })
    await run(ws, 'echo a > /data/scratch/a')
    const [code, , err] = await run(ws, 'mv /data/scratch/a /other/a')
    expect(code, err).toBe(0)
    expect((await run(ws, 'cat /other/a'))[1]).toBe('a\n')
    expect(mutations()).toEqual([])
  })

  it('deletes a conditional rm -r page by page', async () => {
    // As the unconditional rm -r: memory stays one page, not the whole prefix.
    for (const name of ['c', 'd', 'e']) mock.store.set('b', `d/${name}`, ENC.encode(name))
    mock.pageSize = 2
    const ws = workspace()
    expect((await run(ws, 'rm -r /s3/d'))[0]).toBe(0)
    expect(keysUnder('d/')).toEqual([])
    expect(sent('DeleteObjects').length).toBe(3)
  })

  it('reads an unconditional sed write failure as before', async () => {
    // Only a stale-write refusal is sed's couldn't edit (exit 4).
    const ws = workspace(WritePolicy.UNCONDITIONAL)
    mock.before('PutObject', () => {
      throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
    })
    const [code, , err] = await run(ws, 'sed -i s/o/O/ /s3/f /s3/g')
    expect([code, err.includes("couldn't edit")], err).toEqual([1, false])
  })

  it('copies a conditional dir mv whole before deleting', async () => {
    // As GNU mv across devices: a copy failing on a later page leaves the source.
    for (const name of ['c', 'd', 'e']) mock.store.set('b', `d/${name}`, ENC.encode(name))
    const before = keysUnder('d/')
    mock.pageSize = 2
    for (let i = 0; i < 3; i++) mock.before('CopyObject', () => undefined)
    mock.before('CopyObject', () => {
      throw new Error('network down')
    })
    const ws = workspace()
    expect((await run(ws, 'mv /s3/d /s3/e'))[0]).toBe(1)
    expect(keysUnder('d/')).toEqual(before)
    expect(sent('DeleteObjects')).toEqual([])
  })

  it.each([
    ['rm -r', 'DeleteObjects', 'DeleteObjects', 'rm -r /s3/d'],
    ['dir mv', 'CopyObject', 'CopyObject', 'mv /s3/d /s3/e'],
    ['dir mv, failed removal', 'CopyObject', 'DeleteObjects', 'mv /s3/d /s3/e'],
  ] as const)(
    'keeps the versions an earlier page lost when a later one fails: %s',
    async (_name, changedOn, failedOn, line) => {
      // d/a is refused first; a later request fails. d/a keeps its version.
      mock.pageSize = 1
      const ws = workspace()
      await run(ws, 'cat /s3/d/a /s3/d/b')
      mock.before(changedOn, () => {
        theirs('d/a')
      })
      mock.before(failedOn, () => {
        throw new Error('network down')
      })
      let [code, , err] = await run(ws, line)
      expect(code === 1 && err.includes('network down'), err).toBe(true)
      mock.store.set('b', 'd/a', ENC.encode('newest\n'))
      ;[code, , err] = await run(ws, 'rm /s3/d/a')
      expect(code === 1 && err.includes(STALE), err).toBe(true)
      expect(object('d/a')).toBe('newest\n')
    },
  )

  it.each([
    'cat /s3/f; echo x > /s3/f',
    'echo x >> /s3/g',
    'truncate -s 1 /s3/g',
    'cp /s3/g /s3/h',
    'mv /s3/g /s3/i',
    'rm /s3/f',
    'rm -r /s3/d',
    'echo c > /s3/d/c; mv /s3/d /s3/e',
  ])('sends the same requests conditionally: %s', async (line) => {
    const ops: Record<string, string[]> = {}
    for (const policy of [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL]) {
      for (const b of mock.store.allBuckets()) mock.store.objects(b).clear()
      for (const [k, v] of Object.entries(SEED)) mock.store.set('b', k, ENC.encode(v))
      mock.ledger.length = 0
      const [code, , err] = await run(workspace(policy), line)
      expect(code, `${policy}: ${err}`).toBe(0)
      ops[policy] = mock.ledger.map(([op]) => op)
    }
    expect(ops[WritePolicy.CONDITIONAL]).toEqual(ops[WritePolicy.UNCONDITIONAL])
  })

  it.each([
    ['a move asks once', 'mv /s3/f /s3/h', 1, 0],
    ['a nested line keeps once', "eval 'echo x > /s3/g'", 1, 1],
  ] as const)('asks the store once: %s', async (_name, line, lookups, keeps) => {
    const ws = workspace()
    await run(ws, 'cat /s3/f /s3/g')
    const fingerprints = vi.spyOn(ws.cache, 'fingerprints')
    const keepFingerprints = vi.spyOn(ws.cache, 'keepFingerprints')
    const [code, , err] = await run(ws, line)
    expect(code, err).toBe(0)
    expect([fingerprints.mock.calls.length, keepFingerprints.mock.calls.length]).toEqual([
      lookups,
      keeps,
    ])
  })
})
