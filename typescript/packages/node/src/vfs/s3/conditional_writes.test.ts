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
import { constants, readFileSync } from 'node:fs'
import { currentCaller } from '@struktoai/mirage-core/context/session_context'
import { markLost } from '@struktoai/mirage-core/observe/context'
import { MountMode, PathSpec, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScriptSource } from '@struktoai/mirage-core/runtime/types'
import { MountCore } from '@struktoai/mirage-core/mount/core'
import { openMode } from '@struktoai/mirage-core/runtime/handles/index'
import { MinIOVFS } from '../minio/minio.ts'
import {
  inFlightConflict,
  installS3Mock,
  MUTATIONS,
  type S3Mock,
} from '../../../tests/vfs/s3/mock.ts'
import { s3Vfs } from '../../../tests/test-utils.ts'
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
  it.each(
    ['md5sum', 'sha256sum'].flatMap((command) =>
      [false, true].map((warm) => [command, warm] as const),
    ),
  )('live session checksum keeps its observed version: %s warm=%s', async (command, warm) => {
    const ws = workspace()
    ws.createSession('a')
    ws.createSession('b')
    if (warm) await ws.shell('cat /s3/f', { sessionId: 'b' })
    mock.ledger.length = 0
    const read = await ws.shell(`${command} /s3/f`, { sessionId: 'a' })
    expect(read.exitCode, DEC.decode(read.stderr)).toBe(0)
    if (command === 'md5sum' && !warm)
      expect(mock.ledger.some(([op]) => op === 'GetObject')).toBe(false)
    expect((await ws.shell('echo peer > /s3/f', { sessionId: 'b' })).exitCode).toBe(0)
    const refused = await ws.shell('echo mine > /s3/f', { sessionId: 'a' })
    expect(refused.exitCode).toBe(1)
    expect(DEC.decode(refused.stderr)).toContain(STALE)
    expect(object('f')).toBe('peer\n')
  })

  it('live session warm reads keep the exact sampled version', async () => {
    const ws = workspace()
    ws.createSession('a')
    ws.createSession('b')
    await ws.shell('cat /s3/f', { sessionId: 'b' })
    let sampled!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      sampled = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = ws.cache.getVersioned.bind(ws.cache)
    vi.spyOn(ws.cache, 'getVersioned').mockImplementation(async (key) => {
      const held = await original(key)
      if (key === '/s3/f' && currentCaller().session?.sessionId === 'a') {
        sampled()
        await gate
      }
      return held
    })
    const reading = ws.shell('cat /s3/f', { sessionId: 'a' })
    try {
      await ready
      expect((await ws.shell('echo peer > /s3/f', { sessionId: 'b' })).exitCode).toBe(0)
    } finally {
      release()
    }
    expect(DEC.decode((await reading).stdout)).toBe('one\n')
    expect((await ws.shell('rm /s3/f', { sessionId: 'a' })).exitCode).toBe(1)
    expect(DEC.decode(mock.store.get('b', 'f'))).toBe('peer\n')
  })

  it('live session policy reads do not advance the agent', async () => {
    const ws = workspace()
    ws.createSession('a')
    ws.createSession('b')
    await ws.shell('cat /s3/f', { sessionId: 'a' })
    await ws.shell('echo peer > /s3/f', { sessionId: 'b' })
    await ws.setSessionProfile('a', {
      policy: {
        preCommand: [
          {
            script: new ScriptSource("open('/s3/f').read()\nprint('null')\n", 'python'),
            runtime: 'monty',
          },
        ],
      },
    })
    const refused = await ws.shell('rm /s3/f', { sessionId: 'a' })
    expect(refused.exitCode).toBe(1)
    expect(DEC.decode(refused.stderr)).toContain(STALE)
    expect(DEC.decode(mock.store.get('b', 'f'))).toBe('peer\n')
  })

  it.each([
    ['rm /s3/f', 'f'],
    ['rm -f /s3/f', 'f'],
    ['echo mine > /s3/f', 'f'],
    ['cp /s3/g /s3/f', 'f'],
    ['mv /s3/f /s3/new', 'f'],
    ['mv /s3/g /s3/f', 'f'],
    ['rm -r /s3/d', 'd/a'],
  ])('live session refuses peer mutation: %s', async (line, key) => {
    const ws = workspace()
    ws.createSession('a')
    ws.createSession('b')
    const read = await ws.shell(`cat /s3/${key}`, { sessionId: 'a' })
    expect(DEC.decode(read.stdout)).toBe(SEED[key])
    expect((await ws.shell(`echo peer > /s3/${key}`, { sessionId: 'b' })).exitCode).toBe(0)
    for (let i = 0; i < 2; i++) {
      const refused = await ws.shell(line, { sessionId: 'a' })
      expect(refused.exitCode).not.toBe(0)
      expect(DEC.decode(refused.stderr)).toContain(STALE)
      expect(DEC.decode(mock.store.get('b', key))).toBe('peer\n')
    }
    expect(DEC.decode((await ws.shell(`cat /s3/${key}`, { sessionId: 'a' })).stdout)).toBe('peer\n')
    const accepted = await ws.shell(line, { sessionId: 'a' })
    expect(accepted.exitCode, DEC.decode(accepted.stderr)).toBe(0)
  })

  it.each([
    'cat /s3/f',
    'head -n1 /s3/f',
    'grep one /s3/f',
    'x=$(cat /s3/f); echo "$x"',
    '(cat /s3/f)',
  ])('live session read paths survive eviction: %s', async (read) => {
    const ws = workspace()
    ws.createSession('a')
    ws.createSession('b')
    await ws.shell('cat /s3/f', { sessionId: 'b' })
    expect(DEC.decode((await ws.shell(read, { sessionId: 'a' })).stdout)).toBe('one\n')
    await ws.shell('echo peer > /s3/f', { sessionId: 'b' })
    await ws.cache.clear()
    expect((await ws.shell('rm -f /s3/f', { sessionId: 'a' })).exitCode).toBe(1)
    expect(DEC.decode(mock.store.get('b', 'f'))).toBe('peer\n')
    expect((await ws.shell('echo latest > /s3/f', { sessionId: 'b' })).exitCode).toBe(0)
  })

  it('live session direct files and recreation', async () => {
    const ws = workspace()
    const a = await ws.session('a')
    const b = await ws.session('b')
    expect(DEC.decode(await a.vfs.read('/s3/f'))).toBe('one\n')
    await b.vfs.write('/s3/f', ENC.encode('peer\n'))
    await expect(a.vfs.unlink('/s3/f')).rejects.toMatchObject({ code: 'STALE_WRITE' })
    await ws.closeSession('a')
    const fresh = await ws.session('a')
    await fresh.vfs.unlink('/s3/f')
    expect(mock.store.get('b', 'f')).toBeUndefined()
  })

  it('live session symlink read', async () => {
    const ws = workspace()
    ws.createSession('a')
    ws.createSession('b')
    expect((await ws.shell('ln -s /s3/f /ram/alias')).exitCode).toBe(0)
    await ws.shell('cat /ram/alias', { sessionId: 'a' })
    await ws.shell('echo peer > /s3/f', { sessionId: 'b' })
    expect((await ws.shell('rm /s3/f', { sessionId: 'a' })).exitCode).toBe(1)
    expect(DEC.decode(mock.store.get('b', 'f'))).toBe('peer\n')
  })

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
  const refusedUntilRead = async (ws: Workspace, key: string): Promise<void> => {
    let [code, , err] = await run(ws, `echo z > /s3/${key}`)
    expect([code, err.includes(STALE)], err).toEqual([1, true])
    expect(object(key)).toBeUndefined()
    await run(ws, `cat /s3/${key}`)
    mock.ledger.length = 0
    ;[code, , err] = await run(ws, `echo z > /s3/${key}`)
    expect(code, err).toBe(0)
    expect(object(key)).toBe('z\n')
    expect(sent('PutObject')).toEqual([{ IfNoneMatch: '*' }])
  }

  it.each([WritePolicy.CONDITIONAL, WritePolicy.UNCONDITIONAL])(
    'preserves a concurrent append when missing-file creation is delayed: %s',
    async (policy) => {
      const a = workspace(policy)
      const b = workspace(policy)
      let release = (): void => undefined
      const allowed = new Promise<void>((resolve) => {
        release = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        mock.before('PutObject', async () => {
          resolve()
          await allowed
        })
      })
      const pending = run(a, "printf 'line_a\\n' >> /s3/new_f")
      try {
        await waiting
        expect(await run(b, "printf 'line_b\\n' >> /s3/new_f")).toEqual([0, '', ''])
        expect(object('new_f')).toBe('line_b\n')
      } finally {
        release()
      }
      const [code, , error] = await pending
      expect(object('new_f')).toBe('line_b\n')
      expect(code).toBe(1)
      expect(error).toContain(STALE)
    },
  )

  it.each(
    [WritePolicy.CONDITIONAL, WritePolicy.UNCONDITIONAL].flatMap((policy) =>
      (['append', 'pwrite', 'empty-pwrite', 'truncate'] as const).map((operation) => ({
        policy,
        operation,
      })),
    ),
  )(
    'preserves a competing creation during $operation under $policy',
    async ({ policy, operation }) => {
      const ws = workspace(policy)
      mock.before('PutObject', () => {
        theirs('new_f')
      })
      const task =
        operation === 'append'
          ? ws.vfs.append('/s3/new_f', ENC.encode('mine'))
          : operation === 'truncate'
            ? ws.vfs.truncate('/s3/new_f', 3)
            : ws.vfs.pwrite('/s3/new_f', ENC.encode(operation === 'empty-pwrite' ? '' : 'mine'), 0)
      await expect(task).rejects.toMatchObject({ code: 'STALE_WRITE' })
      expect(object('new_f')).toBe('theirs\n')
      expect(sent('PutObject')).toEqual([{ IfNoneMatch: '*' }])
      expect(DEC.decode(await ws.vfs.read('/s3/new_f'))).toBe('theirs\n')
    },
  )

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
    ['removed', ['cat /s3/f', 'rm /s3/f'], 'echo x > /s3/f', 'PutObject', [{ IfNoneMatch: '*' }]],
    ['unread-tee', [], 'echo y | tee /s3/g', 'PutObject', [{}]],
    ['unread-cross-cp', [], 'echo r > /ram/r; cp /ram/r /s3/g', 'PutObject', [{}]],
    ['unread-cp', [], 'cp /s3/f /s3/g', 'CopyObject', [{}]],
    ['rm-on-line', [], 'cat /s3/f; rm /s3/f; echo x > /s3/f', 'PutObject', [{ IfNoneMatch: '*' }]],
    ['mv-on-line', [], 'cat /s3/g; mv /s3/g /s3/h; echo y > /s3/g', 'PutObject', [{}]],
    [
      'rm-r-on-line',
      [],
      'cat /s3/d/a; rm -r /s3/d; echo x > /s3/d/a',
      'PutObject',
      [{ IfNoneMatch: '*' }],
    ],
    ['rm-r', ['cat /s3/d/a; rm -r /s3/d'], 'echo x > /s3/d/a', 'PutObject', [{ IfNoneMatch: '*' }]],
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

  it.each(['cat /s3/f', 'grep one /s3/f'])(
    'refuses a write to a file deleted since it was read until read: %s',
    async (setup) => {
      // A peer may create it again, so the retry is held to what was read.
      const ws = workspace()
      await run(ws, setup)
      mock.store.delete('b', 'f')
      await refusedUntilRead(ws, 'f')
    },
  )

  it.each(['cp /s3/g /s3/f', 'mv /s3/g /s3/f'])(
    'creates a file a copy finds deleted: %s',
    async (line) => {
      // The copy's own look finds no file, which is the session's to see.
      const ws = workspace()
      await run(ws, 'cat /s3/f')
      mock.store.delete('b', 'f')
      const [code, , err] = await run(ws, line)
      expect(code, err).toBe(0)
      expect(object('f')).toBe(SEED.g)
    },
  )

  it('lifts a refusal when a later read on the line finds no file', async () => {
    const ws = workspace()
    await run(ws, 'cat /s3/f')
    mock.store.delete('b', 'f')
    mock.ledger.length = 0
    const [, out, err] = await run(ws, 'echo a > /s3/f; cat /s3/f; echo b > /s3/f; echo $?')
    expect([out, err.split(STALE).length - 1], err).toEqual(['0\n', 1])
    expect(object('f')).toBe('b\n')
    expect(sent('PutObject').at(-1)).toEqual({ IfNoneMatch: '*' })
  })

  it('keeps asking for absence after a refused create', async () => {
    // The append saw no file; a peer's create beats it, and the retry too.
    const ws = workspace()
    mock.before('PutObject', () => {
      theirs('new')
    })
    let [code, , err] = await run(ws, 'echo x >> /s3/new')
    expect([code, err.includes(STALE)], err).toEqual([1, true])
    mock.ledger.length = 0
    ;[code, , err] = await run(ws, 'echo y > /s3/new')
    expect([code, err.includes(STALE)], err).toEqual([1, true])
    expect(sent('PutObject')).toEqual([{ IfNoneMatch: '*' }])
    expect(object('new')).toBe('theirs\n')
  })

  it('lets a move whose copy stayed write its destination', async () => {
    // e was not new, so the rollback leaves the session's own bytes there
    // and it holds no version of e to refuse its next write on.
    const ws = workspace()
    mock.store.set('b', 'e', ENC.encode('old-e\n'))
    await run(ws, 'cat /s3/f /s3/e')
    mock.before('DeleteObject', () => {
      theirs('f')
    })
    expect((await run(ws, 'mv /s3/f /s3/e'))[0]).toBe(1)
    expect(object('e')).toBe(SEED.f)
    const [code, , err] = await run(ws, 'echo z > /s3/e')
    expect(code, err).toBe(0)
    expect(object('e')).toBe('z\n')
  })

  it.each(['cp', 'mv'])(
    'refuses a %s onto a file seen missing that a peer created',
    async (verb) => {
      const ws = workspace()
      await run(ws, 'test -e /s3/new')
      theirs('new')
      mock.ledger.length = 0
      const [code, , err] = await run(ws, `${verb} /s3/f /s3/new`)
      expect(code, err).toBe(1)
      expect(sent('CopyObject')[0]).toMatchObject({ IfNoneMatch: '*' })
      expect(object('new')).toBe('theirs\n')
    },
  )

  it('creates a file a truncate finds gone only if absent', async () => {
    // truncate looks first and sees no file; a restore beats its create.
    const ws = workspace()
    await run(ws, 'cat /s3/f')
    mock.store.delete('b', 'f')
    mock.ledger.length = 0
    mock.before('PutObject', () => {
      mock.store.set('b', 'f', ENC.encode(SEED.f ?? ''))
    })
    const [code, , err] = await run(ws, 'truncate -s 5 /s3/f')
    expect([code, err.includes(STALE)], err).toEqual([1, true])
    expect(mutations()).toEqual([['PutObject', { IfNoneMatch: '*' }]])
    expect(object('f')).toBe(SEED.f)
  })

  it.each([
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
      expect(object('new')).toBeUndefined()
      mock.ledger.length = 0
      expect(await run(ws, `cat /s3/${key}`)).toEqual([0, 'theirs\n', ''])
      expect(mock.ledger.filter(([op]) => op === 'GetObject').length).toBe(1)
    },
  )

  it.each([
    [null, 'DeleteObjects', 'd/b', 'rm -r /s3/d', 'd/a', `rm: cannot remove '/s3/d/b': ${STALE}\n`],
    ['cat /s3/d/a', 'after', 'd/a', 'rm -r /s3/d', 'd/b', null],
    ['cat /s3/d/a', 'after', 'd/a', 'mv /s3/d /s3/e', 'e/a', null],
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

  it.each(
    [WritePolicy.CONDITIONAL, WritePolicy.UNCONDITIONAL].flatMap((write) => [
      [write, 'rm -r /s3/d', 'DeleteObjects', 'd/', "rm: cannot remove '/s3/d'", ['d/late']],
      [write, 'mv /s3/d /s3/e', 'DeleteObjects', 'd/', "mv: cannot remove '/s3/d'", ['d/late']],
      [
        write,
        'rmdir /s3/m',
        'DeleteObject',
        'm/',
        "rmdir: failed to remove '/s3/m'",
        ['m/', 'm/late'],
      ],
    ]),
  )(
    'leaves and reports a child written during a directory op (%s): %s',
    async (write, line, when, dir, prefix, left) => {
      // The walk lists once; a key written under the directory after it
      // stays, and the op is ENOTEMPTY rather than a success.
      mock.store.set('b', 'm/', new Uint8Array())
      const ws = workspace(write)
      mock.before(when, () => {
        mock.store.set('b', `${dir}late`, ENC.encode('new\n'))
      })
      expect(await run(ws, line)).toEqual([1, '', `${prefix}: Directory not empty\n`])
      expect(keysUnder(dir)).toEqual(left)
    },
  )

  it('allows a later source to use a recovered destination', async () => {
    mock.store.set('b', 'x/g', ENC.encode('ex\n'))
    mock.store.set('b', 'y/g', ENC.encode('why\n'))
    mock.store.set('b', 't/k', ENC.encode('k\n'))
    const ws = workspace()
    changeOn('DeleteObject', 'x/g')
    expect(await run(ws, 'mv /s3/x/g /s3/y/g /s3/t/')).toEqual([
      1,
      '',
      `mv: cannot remove '/s3/x/g': ${STALE}\n`,
    ])
    expect(object('t/g')).toBe('why\n')
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
    // A destination key found gone stays held; one never read is replaced plain.
    const ws = workspace()
    mock.store.set('b', 'e/a', ENC.encode('ea\n'))
    if (read) {
      await run(ws, 'cat /s3/e/a')
      mock.store.delete('b', 'e/a')
      await expect(ws.vfs.rename('/s3/d', '/s3/e')).rejects.toMatchObject({
        code: 'STALE_WRITE',
      })
      await refusedUntilRead(ws, 'e/a')
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

  it('keeps its version for a refusal on a file since removed', async () => {
    // Lost on a 412, then found gone: every retry sends what was read.
    const ws = workspace()
    await run(ws, 'cat /s3/f')
    mock.before('PutObject', () => {
      theirs('f')
    })
    mock.before('PutObject', () => {
      mock.store.objects('b').delete('f')
    })
    const [, out, err] = await run(ws, 'echo a > /s3/f; echo b > /s3/f; echo c > /s3/f; echo $?')
    expect([out, err.split(STALE).length - 1], err).toEqual(['1\n', 3])
    expect(object('f')).toBeUndefined()
    expect(sent('PutObject')).toEqual([ONE, ONE, ONE])
  })

  it.each([
    ['file mv', 'cat /s3/f /s3/g', 'mv /s3/g /s3/f', 'g'],
    ['dir mv', 'cat /s3/d/a /s3/d/b', 'mv /s3/d /s3/e', 'd/a'],
  ] as const)(
    'keeps its version for a move source found gone: %s',
    async (_name, setup, line, key) => {
      // A peer may create the source again, so it stays held to the read.
      const ws = workspace()
      await run(ws, setup)
      mock.before('CopyObject', () => {
        mock.store.objects('b').delete(key)
      })
      expect((await run(ws, line))[0]).toBe(1)
      await refusedUntilRead(ws, key)
    },
  )

  it('keeps its version for a walk key found gone beside the named one', async () => {
    // d/a is named; d/b, gone too, stays held to what was read.
    const ws = workspace()
    await run(ws, 'cat /s3/d/a /s3/d/b')
    mock.before('CopyObject', () => {
      theirs('d/a')
      mock.store.objects('b').delete('d/b')
    })
    expect((await run(ws, 'mv /s3/d /s3/e'))[0]).toBe(1)
    await refusedUntilRead(ws, 'd/b')
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
    const fd = await core.open(
      '/s3/d/a',
      openMode(constants.O_WRONLY | constants.O_TRUNC, constants),
    )
    await core.write('/s3/d/a', fd, ENC.encode('A\n'), 0)
    await core.release(fd)
    expect(object('d/a')).toBe('A\n')
    expect(sent('PutObject')).toEqual([{ IfMatch: etag('a\n') }, { IfMatch: etag('') }])
    expect(DEC.decode(await core.read('/s3/f', -1, 0, 100))).toBe('one\n')
    theirs()
    await expect(
      core.open('/s3/f', openMode(constants.O_WRONLY | constants.O_TRUNC, constants)),
    ).rejects.toMatchObject({
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

  it('leaves ordinary unconditional replacements unguarded', async () => {
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
    mock.ledger.length = 0
    expect(await run(ws, 'echo new >> /s3/new')).toEqual([0, '', ''])
    expect(sent('PutObject')).toEqual([{ IfNoneMatch: '*' }, {}])
    // Nor does it keep a version without bytes: a read that keeps none
    // leaves no token behind.
    expect((await run(ws, 'head -c 1 /s3/g'))[0]).toBe(0)
    expect(await ws.cache.exists('/s3/g')).toBe(false)
    expect((await ws.cache.fingerprints(['/s3/g']))[0]).toBeNull()
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

  it.each([
    ['rm -r /s3/d', 'DeleteObjects', 0],
    ['rm -r /s3/d', 'DeleteObjects', 1],
    ['mv /s3/d /s3/e', 'CopyObject', 0],
    ['mv /s3/d /s3/e', 'CopyObject', 1],
    ['rm /s3/d/b', 'DeleteObject', 0],
  ] as const)(
    '%s preserves untouched versions when %s fails after %i requests',
    async (line, operation, completed) => {
      const ws = workspace()
      await run(ws, 'cat /s3/d/b')
      theirs('d/b')
      mock.pageSize = 1
      for (let i = 0; i < completed; i++) mock.before(operation, () => undefined)
      mock.before(operation, () => {
        throw new Error('network down')
      })
      let [code, , err] = await run(ws, line)
      expect(code === 1 && err.includes('network down'), err).toBe(true)
      ;[code, , err] = await run(ws, 'rm /s3/d/b')
      expect(code === 1 && err.includes(STALE), err).toBe(true)
      expect(object('d/b')).toBe('theirs\n')
      await run(ws, 'cat /s3/d/b')
      expect((await run(ws, 'rm /s3/d/b'))[0]).toBe(0)
    },
  )

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

  it.each([false, true])(
    'copies a conditional dir mv whole before deleting (lost: %s)',
    async (lost) => {
      // As GNU mv across devices: a copy failing on a later page leaves the
      // source, and so does one whose source changed since it was listed.
      for (const name of ['c', 'd', 'e']) mock.store.set('b', `d/${name}`, ENC.encode(name))
      const before = keysUnder('d/')
      mock.pageSize = 2
      for (let i = 0; i < 3; i++) mock.before('CopyObject', () => undefined)
      mock.before('CopyObject', () => {
        if (lost) theirs('d/d')
        else throw new Error('network down')
      })
      const ws = workspace()
      expect((await run(ws, 'mv /s3/d /s3/e'))[0]).toBe(1)
      expect(keysUnder('d/')).toEqual(before)
      expect(sent('DeleteObjects')).toEqual([])
    },
  )

  it.each([
    ['rm -r', 'DeleteObjects', 'DeleteObjects', 'rm -r /s3/d'],
    ['dir mv', 'CopyObject', 'CopyObject', 'mv /s3/d /s3/e'],
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

  it.each(
    [WritePolicy.UNCONDITIONAL, WritePolicy.CONDITIONAL].flatMap((write) => [
      [write, 'cat /s3/f; echo x > /s3/f', 'f', 'x\n'],
      [write, 'cat /s3/f; printf x > /s3/f', 'f', 'x'],
      [write, 'cat /s3/f; : > /s3/f', 'f', ''],
      [write, 'echo x > /s3/new', 'new', 'x\n'],
    ]),
  )('lands an output-only redirect in one put (%s): %s', async (write, line, key, after) => {
    // The output's write opens the target: no empty object in between.
    const ws = workspace(write as WritePolicy)
    const [code, , err] = await run(ws, line)
    expect([code, err]).toEqual([0, ''])
    expect([sent('PutObject').length, object(key)]).toEqual([1, after])
  })

  it('never shows a reader the object emptied by a redirect', async () => {
    const seen: (string | undefined)[] = []
    for (let i = 0; i < 2; i++) mock.before('PutObject', () => void seen.push(object('f')))
    const ws = workspace(WritePolicy.UNCONDITIONAL)
    expect(await run(ws, 'echo x > /s3/f')).toEqual([0, '', ''])
    expect([seen, object('f')]).toEqual([[SEED.f], 'x\n'])
  })

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
    ['a move uses its session', 'mv /s3/f /s3/h', 0, 0],
    ['a nested line keeps once', "eval 'echo x > /s3/g'", 0, 1],
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

it('compensates workspace cancellation immediately after a confirmed copy', async () => {
  const isolated = installS3Mock()
  isolated.store.set('b', 'f', ENC.encode('original'))
  const ws = buildWorkspace()
  try {
    isolated.before('CopyObject', () => {
      currentCaller().stop?.abort()
    })
    await expect(ws.shell('mv /s3/f /s3/new')).rejects.toMatchObject({ name: 'AbortError' })
    expect(isolated.store.objects('b').has('new')).toBe(false)
    expect(isolated.store.objects('b').has('f')).toBe(true)
  } finally {
    await ws.close()
    isolated.restore()
  }
})

interface WorkspaceRecoveryCase {
  name: string
  source_code?: string
  replacement?: string
  cleanup_code?: string
  workspace?: {
    command: string
    exit: number
    stdout: string
    stderr: string
    destination: string | null
  }
}

const WORKSPACE_RECOVERY = (
  JSON.parse(
    readFileSync(
      new URL('../../../../../../integ/fixtures/write/move_recovery.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: WorkspaceRecoveryCase[] }
).cases.filter((c) => c.workspace !== undefined)

it.each(WORKSPACE_RECOVERY)('shared workspace move recovery: $name', async (c) => {
  const isolated = installS3Mock()
  isolated.store.set('b', 'f', ENC.encode('one\n'))
  const ws = buildWorkspace()
  try {
    isolated.before('DeleteObject', () => {
      if (c.source_code === 'AccessDenied')
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      isolated.store.set('b', 'f', ENC.encode('theirs\n'))
    })
    if (c.replacement !== undefined)
      isolated.before('DeleteObject', () => {
        isolated.store.set('b', 'new', ENC.encode('external\n'))
      })
    else if (c.cleanup_code !== undefined)
      isolated.before('DeleteObject', () => {
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' })
      })
    const expected = c.workspace
    if (expected === undefined) throw new Error('workspace recovery case is missing its golden')
    expect(await run(ws, expected.command)).toEqual([
      expected.exit,
      expected.stdout,
      expected.stderr,
    ])
    const actual = isolated.store.get('b', 'new')
    expect(actual === undefined ? null : DEC.decode(actual)).toBe(expected.destination)
    expect(DEC.decode(isolated.store.get('b', 'f'))).toBe(
      c.source_code === 'AccessDenied' ? 'one\n' : 'theirs\n',
    )
  } finally {
    await ws.close()
    isolated.restore()
  }
})
