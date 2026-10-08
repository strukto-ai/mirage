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
import { MountMode, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

function s3(bucket = 'b'): S3VFS {
  return new S3VFS({ bucket, region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' })
}

function workspace(
  write: WritePolicy = WritePolicy.CONDITIONAL,
  extra: Record<string, Mount> = {},
): Workspace {
  return new Workspace(
    {
      '/s3': new Mount(s3(), { mode: MountMode.WRITE, write }),
      '/ram': new Mount(new RAMVFS(), { mode: MountMode.WRITE }),
      ...extra,
    },
    { mode: MountMode.WRITE },
  )
}

function minioWorkspace(): Workspace {
  const minio = new MinIOVFS({
    bucket: 'b',
    endpoint: 'http://127.0.0.1:9000',
    accessKeyId: 'k',
    secretAccessKey: 's',
  })
  return workspace(WritePolicy.CONDITIONAL, {
    '/m': new Mount(minio, { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL }),
  })
}

async function run(ws: Workspace, line: string): Promise<[number, string, string]> {
  const r = await ws.shell(line)
  return [r.exitCode, DEC.decode(r.stdout), DEC.decode(r.stderr)]
}

describe('conditional writes on an S3 mount', () => {
  let mock: S3Mock

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
    mock.clearHooks()
  })

  const mutations = (): [string, Record<string, string>][] =>
    mock.ledger.filter(([op]) => MUTATIONS.has(op))
  const theirs = (key = 'f'): void => {
    mock.store.set('b', key, ENC.encode('theirs\n'))
  }
  const keysUnder = (prefix: string): string[] =>
    [...mock.store.objects('b').keys()].filter((k) => k.startsWith(prefix)).sort()
  const object = (key: string): string | undefined => {
    const data = mock.store.get('b', key)
    return data === undefined ? undefined : DEC.decode(data)
  }

  it('gives the next write the version a read saw', async () => {
    const ws = workspace()
    try {
      await run(ws, 'cat /s3/f')
      mock.ledger.length = 0
      expect(await run(ws, 'echo x > /s3/f')).toEqual([0, '', ''])
      expect(mutations()).toEqual([['PutObject', { IfMatch: etag('one\n') }]])
    } finally {
      await ws.close()
    }
  })

  it("gives the next write a redirect's own version", async () => {
    // The redirect keeps the PUT's ETag as a version without bytes, so
    // rewriting a file the agent itself wrote is not refused for want of a
    // read.
    const ws = workspace()
    try {
      await run(ws, 'echo a > /s3/new')
      mock.ledger.length = 0
      expect(await run(ws, 'echo b > /s3/new')).toEqual([0, '', ''])
      expect(mutations()).toEqual([['PutObject', { IfMatch: etag('a\n') }]])
    } finally {
      await ws.close()
    }
  })

  it('leaves the new version after an in-place edit', async () => {
    const ws = workspace()
    try {
      await run(ws, 'sed -i s/one/ONE/ /s3/f')
      mock.ledger.length = 0
      expect((await run(ws, 'echo x > /s3/f'))[0]).toBe(0)
      expect(mutations()).toEqual([['PutObject', { IfMatch: etag('ONE\n') }]])
    } finally {
      await ws.close()
    }
  })

  it('recreates a removed file only if it is still absent', async () => {
    const ws = workspace()
    try {
      await run(ws, 'cat /s3/f')
      await run(ws, 'rm /s3/f')
      mock.ledger.length = 0
      await run(ws, 'echo x > /s3/f')
      expect(mutations()).toEqual([['PutObject', { IfNoneMatch: '*' }]])
    } finally {
      await ws.close()
    }
  })

  it.each(['cat /s3/f; echo x > /s3/f', 'cat /s3/f; cat /s3/f; echo x > /s3/f'])(
    'fetches the new file on the read a refusal asks for: %s',
    async (line) => {
      const ws = workspace()
      try {
        await run(ws, 'cat /s3/f')
        theirs()
        const [code, , err] = await run(ws, line)
        expect([code, err.includes(STALE)]).toEqual([1, true])
        expect(await run(ws, 'cat /s3/f')).toEqual([0, 'theirs\n', ''])
        expect((await run(ws, 'echo y > /s3/f'))[0]).toBe(0)
        expect(object('f')).toBe('y\n')
      } finally {
        await ws.close()
      }
    },
  )

  it.each([
    ['grep o /s3/f', 'f', 'one\n'],
    ['head -n1 /s3/f', 'f', 'one\n'],
    ['wc -l /s3/f', 'f', 'one\n'],
    ['echo a >> /s3/f', 'f', 'one\na\n'],
    ['truncate -s 2 /s3/f', 'f', 'on'],
    ['echo hi > /ram/x; cp /ram/x /s3/y', 'y', 'hi\n'],
  ])('leaves its version from a line that keeps no bytes: %s', async (setup, key, seen) => {
    const ws = workspace()
    try {
      expect((await run(ws, setup))[0]).toBe(0)
      mock.ledger.length = 0
      expect(await run(ws, `echo z > /s3/${key}`)).toEqual([0, '', ''])
      expect(mutations()).toEqual([['PutObject', { IfMatch: etag(seen) }]])
    } finally {
      await ws.close()
    }
  })

  it.each(['echo x > /s3/f', 'cp /s3/g /s3/f'])(
    'refuses a write to a file deleted since it was read, then frees it: %s',
    async (line) => {
      const ws = workspace()
      try {
        await run(ws, 'cat /s3/f')
        mock.store.delete('b', 'f')
        const [code, , err] = await run(ws, line)
        expect([code, err.includes(STALE)]).toEqual([1, true])
        expect(object('f')).toBeUndefined()
        expect((await run(ws, line))[0]).toBe(0)
      } finally {
        await ws.close()
      }
    },
  )

  it.each(['truncate -s 5 /s3/f', 'echo x >> /s3/f'])(
    'refuses an op finding a read file gone, before writing: %s',
    async (line) => {
      // Its own read found nothing, but the agent read the file: that view
      // is stale, as for a plain `>`. Sending the old version instead would
      // let a restore of those bytes be overwritten from an empty file.
      const ws = workspace()
      try {
        await run(ws, 'cat /s3/f')
        mock.store.delete('b', 'f')
        mock.ledger.length = 0
        // A restore of the old bytes between this op's read and its write.
        mock.before('PutObject', () => {
          mock.store.set('b', 'f', ENC.encode(SEED.f ?? ''))
        })
        const [code, , err] = await run(ws, line)
        expect([code, err.includes(STALE)], err).toEqual([1, true])
        expect(mutations()).toEqual([])
        expect(object('f')).toBeUndefined()
      } finally {
        await ws.close()
      }
    },
  )

  it.each([
    ['append', 'x\n'],
    ['append', ''],
    ['pwrite', 'G'],
    ['pwrite', ''],
  ] as const)(
    'refuses an ops call finding a read file gone, before writing: %s %j',
    async (call, data) => {
      // The same rule through the ops API, which runs the generic append
      // and pwrite; an empty one stats instead of reading.
      const ws = workspace()
      try {
        await ws.vfs.read('/s3/f')
        mock.store.delete('b', 'f')
        mock.ledger.length = 0
        mock.before('PutObject', () => {
          mock.store.set('b', 'f', ENC.encode(SEED.f ?? ''))
        })
        const op =
          call === 'append'
            ? ws.vfs.append('/s3/f', ENC.encode(data))
            : ws.vfs.pwrite('/s3/f', ENC.encode(data), 0)
        await expect(op).rejects.toMatchObject({ code: 'STALE_WRITE' })
        expect(mutations()).toEqual([])
        expect(object('f')).toBeUndefined()
      } finally {
        await ws.close()
      }
    },
  )

  it.each([
    [['cat /s3/d/a; rm -r /s3/d; echo x > /s3/d/a']],
    [['cat /s3/d/a; rm -r /s3/d', 'echo x > /s3/d/a']],
    [['cat /s3/d/a; mv /s3/d /s3/e', 'echo x > /s3/d/a']],
  ])('creates again a file gone with its directory: %j', async (lines) => {
    const ws = workspace()
    try {
      for (const line of lines) {
        const [code, , err] = await run(ws, line)
        expect([code, err], line).toEqual([0, ''])
      }
      expect(object('d/a')).toBe('x\n')
    } finally {
      await ws.close()
    }
  })

  it('reads and writes with a version through the ops API', async () => {
    const ws = workspace()
    try {
      await ws.vfs.read('/s3/f')
      mock.ledger.length = 0
      await ws.vfs.write('/s3/f', ENC.encode('x\n'))
      expect(mutations()).toEqual([['PutObject', { IfMatch: etag('one\n') }]])
      // An existing file never read through mirage has no version, so the
      // write asks for create-only and the store refuses it.
      await expect(ws.vfs.write('/s3/g', ENC.encode('y\n'))).rejects.toMatchObject({
        code: 'STALE_WRITE',
      })
      expect(object('g')).toBe('gee\n')
    } finally {
      await ws.close()
    }
  })

  const LOSS: [string, string | null, string, string, string, string, number][] = [
    ['redirect', 'cat /s3/f', 'echo x > /s3/f', 'f', 'after', '', 1],
    ['tee', 'cat /s3/f', 'echo x | tee /s3/f', 'f', 'after', 'tee: ', 1],
    ['sort', 'cat /s3/f', 'sort -o /s3/f /s3/f', 'f', 'after', 'sort: ', 2],
    ['sed', null, 'sed -i s/one/ONE/ /s3/f', 'f', 'PutObject', "sed: couldn't edit /s3/f: ", 4],
    ['cp', 'cat /s3/f', 'cp /s3/g /s3/f', 'f', 'after', 'cp: ', 1],
    ['mv-dst', 'cat /s3/f', 'mv /s3/g /s3/f', 'f', 'after', 'mv: ', 1],
    ['rm', 'cat /s3/f', 'rm /s3/f', 'f', 'after', 'rm: ', 1],
    ['cross-cp', 'cat /s3/f; echo r > /ram/r', 'cp /ram/r /s3/f', 'f', 'after', 'cp: ', 1],
    ['append', null, 'echo x >> /s3/f', 'f', 'PutObject', '', 1],
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
      try {
        if (setup !== null) await run(ws, setup)
        if (when === 'after') theirs(key)
        else
          // Another writer lands between the op's own read and its write.
          mock.before(when, () => {
            theirs(key)
          })
        const [code, , err] = await run(ws, line)
        expect(code, err).toBe(exit)
        expect(err.includes(STALE) && err.startsWith(prefix), err).toBe(true)
        expect(object(key)).toBe('theirs\n')
        if (name === 'mv-src-copy' || name === 'mv-src-read') {
          expect(object('new')).toBeUndefined()
        }
        // The refusal dropped the cached copy, so the next read fetches.
        mock.ledger.length = 0
        expect(await run(ws, `cat /s3/${key}`)).toEqual([0, 'theirs\n', ''])
        expect(mock.ledger.filter(([op]) => op === 'GetObject').length).toBe(1)
      } finally {
        await ws.close()
      }
    },
  )

  it('keeps and reports a file changed under a recursive remove', async () => {
    const ws = workspace()
    try {
      mock.before('DeleteObjects', () => {
        theirs('d/b')
      })
      const [code, , err] = await run(ws, 'rm -r /s3/d')
      expect(code).toBe(1)
      // mirage's rm names the operand it was given; GNU names the file
      // inside it. The changed file is kept either way.
      expect(err).toBe(`rm: cannot remove '/s3/d': ${STALE}\n`)
      expect(object('d/a')).toBeUndefined()
      expect(object('d/b')).toBe('theirs\n')
    } finally {
      await ws.close()
    }
  })

  it.each(['rm -r /s3/d', 'mv /s3/d /s3/e'])(
    'keeps a file changed since it was read under a directory op: %s',
    async (line) => {
      // The listing's ETag is the file as changed; the version the agent
      // read is what the change is measured against.
      const ws = workspace()
      try {
        await run(ws, 'cat /s3/d/a')
        theirs('d/a')
        const [code, , err] = await run(ws, line)
        expect([code, err.includes(STALE)]).toEqual([1, true])
        expect(object('d/a')).toBe('theirs\n')
        expect(object('d/b')).toBeUndefined()
      } finally {
        await ws.close()
      }
    },
  )

  it('still guards the file a landed move made', async () => {
    // The copy of the first source landed though its delete lost, so the
    // target is a file this mv made; GNU's mv will not overwrite it with the
    // second source.
    mock.store.set('b', 'x/g', ENC.encode('ex\n'))
    mock.store.set('b', 'y/g', ENC.encode('why\n'))
    mock.store.set('b', 't/k', ENC.encode('k\n'))
    const ws = workspace()
    try {
      mock.before('DeleteObject', () => {
        theirs('x/g')
      })
      expect(await run(ws, 'mv /s3/x/g /s3/y/g /s3/t/')).toEqual([
        1,
        '',
        `mv: cannot remove '/s3/x/g': ${STALE}\n` +
          "mv: will not overwrite just-created '/s3/t/g' with '/s3/y/g'\n",
      ])
      expect(object('t/g')).toBe('ex\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps no version from a write that lost', async () => {
    // grep saw a version; the write after it lost to a delete. Kept, that
    // version would make the next write's If-Match miss a file now gone.
    const ws = workspace()
    try {
      mock.before('PutObject', () => {
        mock.store.objects('b').delete('f')
      })
      const [code, , err] = await run(ws, 'grep one /s3/f; echo x > /s3/f')
      expect(code === 1 && err.includes(STALE), err).toBe(true)
      expect(await ws.cache.fingerprint('/s3/f')).toBeNull()
      expect(await run(ws, 'echo y > /s3/f')).toEqual([0, '', ''])
      expect(object('f')).toBe('y\n')
    } finally {
      await ws.close()
    }
  })

  it('lifts a refusal once the line reads the file again', async () => {
    // The refusal says to read the file again; doing so on the same line
    // gives the next write that read's version.
    const ws = workspace()
    try {
      await run(ws, 'cat /s3/f')
      theirs()
      expect(await run(ws, 'echo x > /s3/f; cat /s3/f; echo y > /s3/f')).toEqual([
        0,
        'theirs\n',
        expect.stringContaining(STALE) as unknown as string,
      ])
      expect(object('f')).toBe('y\n')
    } finally {
      await ws.close()
    }
  })

  it('says cannot remove when a moved source changed after its copy', async () => {
    // The copy landed; only the source's delete lost. GNU's mv across
    // devices (coreutils 9.7) reports a failed unlink as "cannot remove" and
    // keeps the copy.
    const ws = workspace()
    try {
      mock.before('DeleteObject', () => {
        theirs('g')
      })
      expect(await run(ws, 'mv /s3/g /s3/new')).toEqual([
        1,
        '',
        `mv: cannot remove '/s3/g': ${STALE}\n`,
      ])
      expect(object('new')).toBe('gee\n')
      expect(object('g')).toBe('theirs\n')
    } finally {
      await ws.close()
    }
  })

  it('never overwrites a file made at a directory move target', async () => {
    const ws = workspace()
    try {
      mock.before('CopyObject', () => {
        mock.store.set('b', 'e/a', ENC.encode('theirs\n'))
      })
      const [code, , err] = await run(ws, 'mv /s3/d /s3/e')
      expect([code, err.includes(STALE)]).toEqual([1, true])
      expect(object('e/a')).toBe('theirs\n')
    } finally {
      await ws.close()
    }
  })

  it('reports a directory move source changed before its delete', async () => {
    const ws = workspace()
    try {
      mock.before('DeleteObjects', () => {
        theirs('d/b')
      })
      const [code, , err] = await run(ws, 'mv /s3/d /s3/e')
      expect([code, err.includes(STALE)]).toEqual([1, true])
      expect(object('d/b')).toBe('theirs\n')
    } finally {
      await ws.close()
    }
  })

  it.each(['cat /s3/f; rm /s3/f; echo x > /s3/f', 'cat /s3/g; mv /s3/g /s3/h; echo y > /s3/g'])(
    'creates again a file removed earlier on the line: %s',
    async (line) => {
      const ws = workspace()
      try {
        const [code, , err] = await run(ws, line)
        expect([code, err]).toEqual([0, ''])
      } finally {
        await ws.close()
      }
    },
  )

  it.each(['append', 'pwrite'] as const)(
    'writes back with its own read through the ops API: %s',
    async (call) => {
      // An append or a write at an offset reads the file itself first, so a
      // file never read through mirage still has the version it writes on.
      const ws = workspace()
      try {
        mock.ledger.length = 0
        if (call === 'append') await ws.vfs.append('/s3/g', ENC.encode('x\n'))
        else await ws.vfs.pwrite('/s3/g', ENC.encode('G'), 0)
        expect(mutations()).toEqual([['PutObject', { IfMatch: etag('gee\n') }]])
      } finally {
        await ws.close()
      }
    },
  )

  it.each([WritePolicy.CONDITIONAL, WritePolicy.UNCONDITIONAL])(
    'reports a key the store refuses under a recursive remove: %s',
    async (write) => {
      // DeleteObjects answers 200 and names a refused key in its body.
      const ws = workspace(write)
      try {
        mock.undeletable.add('d/a')
        const [code, , err] = await run(ws, 'rm -r /s3/d')
        expect([code, err.includes('Permission denied')]).toEqual([1, true])
        expect(object('d/a')).toBe('a\n')
      } finally {
        mock.undeletable.clear()
        await ws.close()
      }
    },
  )

  it('keeps a file changed under a directory move where it was', async () => {
    const ws = workspace()
    try {
      mock.before('CopyObject', () => {
        theirs('d/a')
      })
      const [code, , err] = await run(ws, 'mv /s3/d /s3/e')
      expect(code === 1 && err.includes(STALE), err).toBe(true)
      expect(object('d/a')).toBe('theirs\n')
      expect(object('e/a')).toBeUndefined()
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['cat /s3/f', 'echo x > /s3/f'],
    ['cat /s3/f', 'echo x | tee /s3/f'],
    ['cat /s3/f', 'cp /s3/g /s3/f'],
    ['cat /s3/f', 'rm /s3/f'],
    [null, 'echo x >> /s3/f'],
    [null, 'truncate -s 1 /s3/f'],
    [null, 'rm /s3/f'],
    [null, 'mv /s3/g /s3/new'],
    [null, 'rm -r /s3/d'],
    [null, 'echo x > /s3/new'],
    [null, 'mkdir /s3/e'],
  ] as const)('lands a current write with its condition (%s; %s)', async (setup, line) => {
    // Including files never read: the ops that read for themselves (>>,
    // truncate) or look first (rm, mv) do not need a prior cat. The tripwire
    // fails any mutation sent without a condition.
    const ws = workspace()
    try {
      mock.tripwire = true
      if (setup !== null) await run(ws, setup)
      const [code, , err] = await run(ws, line)
      expect(err).toBe('')
      expect(code).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it.each(['echo y > /s3/g', 'echo y | tee /s3/g', 'cp /s3/f /s3/g', 'truncate -s 0 /s3/g'])(
    'never overwrites an existing file that was never read: %s',
    async (line) => {
      const ws = workspace()
      try {
        const [code, , err] = await run(ws, line)
        expect(code === 1 && err.includes(STALE), err).toBe(true)
        expect(object('g')).toBe('gee\n')
      } finally {
        await ws.close()
      }
    },
  )

  it('sends no condition from an unconditional mount', async () => {
    const ws = workspace(WritePolicy.UNCONDITIONAL)
    try {
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
      // Nor does it keep a version without bytes, which only a conditional
      // write would send.
      expect((await run(ws, 'grep x /s3/g'))[0]).toBe(1)
      expect(await ws.cache.fingerprint('/s3/g')).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('conditions only the writes to the conditional mount', async () => {
    const ws = workspace(WritePolicy.CONDITIONAL, {
      '/u': new Mount(s3('u'), { mode: MountMode.WRITE }),
    })
    try {
      await run(ws, 'cat /s3/f')
      mock.ledger.length = 0
      expect((await run(ws, 'cp /s3/f /u/f'))[0]).toBe(0)
      expect((await run(ws, 'sort -o /u/g /s3/f'))[0]).toBe(0)
      expect(mutations().every(([, params]) => Object.keys(params).length === 0)).toBe(true)
      mock.ledger.length = 0
      expect((await run(ws, 'cat /u/f; cp /u/f /s3/f'))[0]).toBe(0)
      expect(mutations()).toEqual([['PutObject', { IfMatch: etag('one\n') }]])
    } finally {
      await ws.close()
    }
  })

  it('never sends a namespace write to the store', async () => {
    const ws = workspace()
    try {
      for (const line of ['chmod 600 /s3/f', 'ln -s /s3/f /s3/link']) {
        expect((await run(ws, line))[0], line).toBe(0)
      }
      expect(mutations()).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('keeps an auth failure in its own words', async () => {
    const ws = workspace()
    try {
      await run(ws, 'cat /s3/f')
      mock.before('PutObject', () => {
        throw Object.assign(new Error('AccessDenied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        })
      })
      const [code, , err] = await run(ws, 'echo x > /s3/f')
      expect(code === 1 && !err.includes(STALE), err).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('carries a condition on a write route nobody listed', async () => {
    // The tripwire fails any unconditioned mutation, so a command writing
    // through a path the policy never reached is caught here.
    const ws = workspace()
    try {
      mock.tripwire = true
      for (const line of [
        'cat /s3/f; sed -i s/one/two/ /s3/f',
        'echo a > /ram/x; cp /ram/x /s3/new1',
        "printf 'a\\nb\\n' | split -l 1 - /s3/part.",
        'cd /ram && tar -cf /ram/t.tar x && tar -xf /ram/t.tar -C /s3',
        'echo p > /ram/p; cp -r /ram/p /s3/cpr',
        'echo /s3/new2 | xargs touch',
      ]) {
        const [code, , err] = await run(ws, line)
        expect(code, `${line}: ${err}`).toBe(0)
      }
    } finally {
      await ws.close()
    }
  })

  it.each([
    'cp /m/g /m/f',
    'mv /m/g /m/h',
    'rm /m/g',
    'rm -r /m/d',
    'mv /m/g /ram/g',
    'find /m -name g -delete',
  ])('refuses on minio what it cannot condition, before sending: %s', async (line) => {
    const ws = minioWorkspace()
    try {
      await run(ws, 'cat /m/f; cat /m/g')
      mock.ledger.length = 0
      const [code, , err] = await run(ws, line)
      expect(code === 1 && err.includes('Operation not supported'), err).toBe(true)
      expect(mutations()).toEqual([])
      expect(object('g')).toBe('gee\n')
      // Refused before anything moved: a mv out copies nothing either.
      expect((await run(ws, 'cat /ram/g'))[0]).toBe(1)
      // A plain overwrite is protected, so it is allowed.
      expect((await run(ws, 'echo x > /m/f'))[0]).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it.each(['-b', '--backup=numbered', '-S .bak -b'])(
    'leaves the destination in place when a move out is refused: %s',
    async (flags) => {
      // Refused before anything moves: no backup renames the destination
      // aside first.
      const ws = minioWorkspace()
      try {
        await run(ws, 'echo mine > /ram/f')
        const [code, , err] = await run(ws, `mv ${flags} /m/f /ram/f`)
        expect(code === 1 && err.includes('Operation not supported'), err).toBe(true)
        expect((await run(ws, 'cat /ram/f'))[1]).toBe('mine\n')
        expect((await run(ws, 'ls /ram'))[1]).toBe('f\n')
        expect(mutations()).toEqual([])
      } finally {
        await ws.close()
      }
    },
  )

  it('refuses up front a move holding a nested minio mount', async () => {
    // The walk would copy the nested mount too and then find its deletes
    // refused, leaving the tree half moved.
    const minio = new MinIOVFS({
      bucket: 'b',
      endpoint: 'http://127.0.0.1:9000',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })
    const ws = workspace(WritePolicy.CONDITIONAL, {
      '/other': new Mount(new RAMVFS(), { mode: MountMode.WRITE }),
      '/ram/d/m': new Mount(minio, { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL }),
    })
    try {
      await run(ws, 'mkdir -p /ram/d; echo a > /ram/d/a')
      const [code, , err] = await run(ws, 'mv /ram/d /other/d')
      expect(code === 1 && err.includes('Operation not supported'), err).toBe(true)
      expect((await run(ws, 'cat /ram/d/a'))[1]).toBe('a\n')
      expect((await run(ws, 'ls /other'))[1]).toBe('')
      expect(mutations()).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('moves a file out of a mount nested in a minio mount', async () => {
    // The source's own mount deletes it; the minio mount above is untouched.
    const minio = new MinIOVFS({
      bucket: 'b',
      endpoint: 'http://127.0.0.1:9000',
      accessKeyId: 'k',
      secretAccessKey: 's',
    })
    const ws = workspace(WritePolicy.CONDITIONAL, {
      '/data': new Mount(minio, { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL }),
      '/data/scratch': new Mount(new RAMVFS(), { mode: MountMode.WRITE }),
      '/other': new Mount(new RAMVFS(), { mode: MountMode.WRITE }),
    })
    try {
      await run(ws, 'echo a > /data/scratch/a')
      const [code, , err] = await run(ws, 'mv /data/scratch/a /other/a')
      expect(code, err).toBe(0)
      expect((await run(ws, 'cat /other/a'))[1]).toBe('a\n')
      expect(mutations()).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('deletes a conditional rm -r page by page', async () => {
    // As the unconditional rm -r does: memory stays one page, not the
    // whole prefix.
    for (const name of ['c', 'd', 'e']) mock.store.set('b', `d/${name}`, ENC.encode(name))
    mock.pageSize = 2
    const ws = workspace()
    try {
      expect((await run(ws, 'rm -r /s3/d'))[0]).toBe(0)
      expect([...mock.store.objects('b').keys()].filter((k) => k.startsWith('d/'))).toEqual([])
      expect(mutations().filter(([op]) => op === 'DeleteObjects').length).toBe(3)
    } finally {
      mock.pageSize = null
      await ws.close()
    }
  })

  it('copies a conditional dir mv whole before deleting', async () => {
    // As GNU mv across devices: a copy failing on a later page leaves the
    // source whole.
    for (const name of ['c', 'd', 'e']) mock.store.set('b', `d/${name}`, ENC.encode(name))
    const before = keysUnder('d/')
    mock.pageSize = 2
    for (let i = 0; i < 3; i++) mock.before('CopyObject', () => undefined)
    mock.before('CopyObject', () => {
      throw new Error('network down')
    })
    const ws = workspace()
    try {
      expect((await run(ws, 'mv /s3/d /s3/e'))[0]).toBe(1)
      expect(keysUnder('d/')).toEqual(before)
      expect(mutations().filter(([op]) => op === 'DeleteObjects')).toEqual([])
    } finally {
      mock.pageSize = null
      await ws.close()
    }
  })

  it.each(['cp', 'mv'])('lets minio take a file from another mount: %s', async (verb) => {
    // Into MinIO from elsewhere is a write, which MinIO does condition.
    const ws = minioWorkspace()
    try {
      expect(await run(ws, `echo r > /ram/r; ${verb} /ram/r /m/new`)).toEqual([0, '', ''])
      expect(object('new')).toBe('r\n')
    } finally {
      await ws.close()
    }
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
      const ws = workspace(policy)
      try {
        const [code, , err] = await run(ws, line)
        expect(code, `${policy}: ${err}`).toBe(0)
        ops[policy] = mock.ledger.map(([op]) => op)
      } finally {
        await ws.close()
      }
    }
    expect(ops[WritePolicy.CONDITIONAL]).toEqual(ops[WritePolicy.UNCONDITIONAL])
  })

  it('keeps no bytes a redirect wrote on an unconditional mount', async () => {
    // As on main: a `>` write keeps no bytes, so the next read fetches them.
    const ws = workspace(WritePolicy.UNCONDITIONAL)
    try {
      await run(ws, 'echo updated > /s3/n')
      mock.ledger.length = 0
      expect((await run(ws, 'cat /s3/n'))[1]).toBe('updated\n')
      expect(mock.ledger.filter(([op]) => op === 'GetObject').length).toBe(1)
    } finally {
      await ws.close()
    }
  })

  it('does not cache the bytes of a refused tee', async () => {
    const ws = workspace()
    try {
      await run(ws, 'cat /s3/f')
      theirs()
      await run(ws, 'echo mine | tee /s3/f')
      mock.ledger.length = 0
      expect((await run(ws, 'cat /s3/f'))[1]).toBe('theirs\n')
      expect(mock.ledger.filter(([op]) => op === 'GetObject').length).toBe(1)
    } finally {
      await ws.close()
    }
  })
})
