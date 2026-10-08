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
import { MountMode, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MountCore } from '../../fuse/core.ts'
import { MinIOVFS } from '../minio/minio.ts'
import { installS3Mock, MUTATIONS, type S3Mock } from './mock.ts'
import { S3VFS } from './s3.ts'
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

function s3(bucket = 'b'): S3VFS {
  return new S3VFS({ bucket, region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' })
}

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
      '/s3': new Mount(s3(), { mode: MountMode.WRITE, write }),
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
    ['redirect', ['echo a > /s3/new'], 'echo b > /s3/new', 'PutObject', [{ IfMatch: etag('a\n') }]],
    [
      'sed',
      ['sed -i s/one/ONE/ /s3/f'],
      'echo x > /s3/f',
      'PutObject',
      [{ IfMatch: etag('ONE\n') }],
    ],
    ['grep', ['grep o /s3/f'], 'echo z > /s3/f', 'PutObject', [ONE]],
    ['head', ['head -n1 /s3/f'], 'echo z > /s3/f', 'PutObject', [ONE]],
    ['wc', ['wc -l /s3/f'], 'echo z > /s3/f', 'PutObject', [ONE]],
    ['append', ['echo a >> /s3/f'], 'echo z > /s3/f', 'PutObject', [{ IfMatch: etag('one\na\n') }]],
    ['truncate', ['truncate -s 2 /s3/f'], 'echo z > /s3/f', 'PutObject', [{ IfMatch: etag('on') }]],
    [
      'cross-cp',
      ['echo hi > /ram/x; cp /ram/x /s3/y'],
      'echo z > /s3/y',
      'PutObject',
      [{ IfMatch: etag('hi\n') }],
    ],
    ['removed', ['cat /s3/f', 'rm /s3/f'], 'echo x > /s3/f', 'PutObject', [{}]],
    ['unread-tee', [], 'echo y | tee /s3/g', 'PutObject', [{}]],
    ['unread-cross-cp', [], 'echo r > /ram/r; cp /ram/r /s3/g', 'PutObject', [{}]],
    ['unread-cp', [], 'cp /s3/f /s3/g', 'CopyObject', [{}]],
    ['rm-on-line', [], 'cat /s3/f; rm /s3/f; echo x > /s3/f', 'PutObject', [{}]],
    ['mv-on-line', [], 'cat /s3/g; mv /s3/g /s3/h; echo y > /s3/g', 'PutObject', [{}]],
    ['rm-r-on-line', [], 'cat /s3/d/a; rm -r /s3/d; echo x > /s3/d/a', 'PutObject', [{}]],
    ['rm-r', ['cat /s3/d/a; rm -r /s3/d'], 'echo x > /s3/d/a', 'PutObject', [{}]],
    ['dir-mv', ['cat /s3/d/a; mv /s3/d /s3/e'], 'echo x > /s3/d/a', 'PutObject', [{}]],
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
    ['mv-dst', 'cat /s3/f', 'mv /s3/g /s3/f', 'f', 'after', 'mv: ', 1],
    ['append', null, 'echo x >> /s3/f', 'f', 'PutObject', '/s3/f: ', 1],
    ['truncate', null, 'truncate -s 1 /s3/f', 'f', 'PutObject', 'truncate: ', 1],
    ['truncate-0', 'cat /s3/f', 'truncate -s 0 /s3/f', 'f', 'after', 'truncate: ', 1],
    ['rm-unread', null, 'rm /s3/f', 'f', 'DeleteObject', 'rm: ', 1],
    ['mv-src-copy', null, 'mv /s3/g /s3/new', 'g', 'CopyObject', 'mv: ', 1],
    ['mv-src-read', 'cat /s3/g', 'mv /s3/g /s3/new', 'g', 'after', 'mv: ', 1],
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
    ['same line', '', 'PutObject', ['f'], 'f', 'cat /s3/f; echo x > /s3/f', 'echo z > /s3/f'],
    [
      'rm -r, every lost key',
      'cat /s3/d/a /s3/d/b',
      'DeleteObjects',
      ['d/a', 'd/b'],
      'd/b',
      'rm -r /s3/d',
      'echo z > /s3/d/b',
    ],
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

  it('holds each destination key a directory rename read', async () => {
    // Every changed destination key is refused and keeps its version.
    const ws = workspace()
    mock.store.set('b', 'e/a', ENC.encode('ea\n'))
    mock.store.set('b', 'e/b', ENC.encode('eb\n'))
    await run(ws, 'cat /s3/e/a /s3/e/b')
    theirs('e/a')
    theirs('e/b')
    await expect(ws.vfs.rename('/s3/d', '/s3/e')).rejects.toMatchObject({ code: 'STALE_WRITE' })
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

  it('reports a key the store refuses under a recursive remove', async () => {
    // DeleteObjects answers 200 and names a refused key in its body.
    const ws = workspace()
    mock.undeletable.add('d/a')
    const [code, , err] = await run(ws, 'rm -r /s3/d')
    expect([code, err.includes('Permission denied')]).toEqual([1, true])
    expect(object('d/a')).toBe('a\n')
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
    // Nor does it keep a version without bytes.
    expect((await run(ws, 'grep x /s3/g'))[0]).toBe(1)
    expect(await ws.cache.fingerprint('/s3/g')).toBeNull()
  })

  it('conditions only the writes to the conditional mount', async () => {
    const ws = workspace(WritePolicy.CONDITIONAL, {
      '/u': new Mount(s3('u'), { mode: MountMode.WRITE }),
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
    'cat /s3/f; echo x > /s3/f',
    'echo x >> /s3/g',
    'truncate -s 1 /s3/g',
    'cp /s3/g /s3/h',
    'mv /s3/g /s3/i',
    'rm /s3/f',
    'rm -r /s3/d',
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
})
