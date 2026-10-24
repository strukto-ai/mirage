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

import { describe, expect, it } from 'vitest'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { Context } from '../../config.ts'
import { Files } from '../../../workspace/files.ts'
import { StreamHost } from './stream_host.ts'

const ENC = new TextEncoder()

function spec(path: string): PathSpec {
  return new PathSpec({ vfsPath: stripSlash(path), virtual: path, directory: path, resolved: true })
}

async function* parts(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve()
    yield ENC.encode(chunk)
  }
}

function host(
  files: Record<string, string>,
  stdin: AsyncIterable<Uint8Array> | null = null,
): StreamHost {
  async function* stream(p: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    const content = files[p.virtual]
    if (content === undefined) throw Object.assign(new Error(p.virtual), { code: 'ENOENT' })
    yield ENC.encode(content)
  }
  const ctx = { stdin, flags: {}, cwd: PathSpec.fromStrPath('/') } as unknown as Context
  return new StreamHost([spec('/a.txt')], stream, ctx, () => true)
}

describe('StreamHost', () => {
  it('reads an operand as typed through the mount', async () => {
    const h = host({ '/a.txt': 'one\n' })
    const first = await h.serve({ op: 'read', fd: 1, path: '/a.txt', operand: 1 }, new Uint8Array())
    expect(first).toEqual({ reply: {}, data: ENC.encode('one\n') })
    expect((await h.serve({ op: 'read', fd: 1 }, new Uint8Array())).reply).toEqual({ end: true })
    const missing = await h.serve({ op: 'read', fd: 2, path: '/b.txt' }, new Uint8Array())
    expect(missing.reply).toEqual({ error: 'No such file or directory', errno: 'ENOENT' })
  })

  it('shares one stdin cursor between readers', async () => {
    const h = host({}, parts('p\n', 'q\n'))
    const first = await h.serve({ op: 'read', fd: 1, path: '-' }, new Uint8Array())
    const second = await h.serve({ op: 'read', fd: 2, path: '/dev/stdin' }, new Uint8Array())
    expect([first.data, second.data]).toEqual([ENC.encode('p\n'), ENC.encode('q\n')])
  })

  it('sends a spool to the output once', async () => {
    const h = host({})
    await h.serve({ op: 'spool', fd: 3 }, ENC.encode('held'))
    const served = await h.serve({ op: 'emit', fd: 3 }, new Uint8Array())
    expect(await materialize(served.output ?? null)).toEqual(ENC.encode('held'))
    expect((await h.serve({ op: 'emit', fd: 3 }, new Uint8Array())).output).toBeNull()
  })

  it('lands a replacement whole once flushed', async () => {
    const files = new Map<string, Uint8Array>([['/out', ENC.encode('old')]])
    const dispatch = async (
      op: string,
      p: PathSpec,
      args: readonly unknown[] = [],
    ): Promise<[unknown, IOResult]> => {
      if (p.virtual === '/ro') throw Object.assign(new Error('/ro'), { code: 'EACCES' })
      const body = await materialize((args[0] ?? new Uint8Array()) as ByteSource)
      const kept = op === 'append' ? (files.get(p.virtual) ?? new Uint8Array()) : new Uint8Array()
      files.set(p.virtual, new Uint8Array([...kept, ...body]))
      return [null, new IOResult()]
    }
    const ctx = {
      stdin: null,
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
      vfs: new Files(dispatch, null, null, { ledger: false }),
    } as unknown as Context
    const h = new StreamHost(
      [],
      () => parts(),
      ctx,
      () => true,
    )
    await h.serve({ op: 'write', path: '/out', atomic: true }, ENC.encode('new '))
    await h.serve({ op: 'spool', fd: 4 }, ENC.encode('tail'))
    await h.serve({ op: 'write', path: '/out', append: true, spool: 4 }, new Uint8Array())
    expect(files.get('/out')).toEqual(ENC.encode('old'))
    expect((await h.serve({ op: 'flush', path: '/out' }, new Uint8Array())).reply).toEqual({})
    expect(files.get('/out')).toEqual(ENC.encode('new tail'))
    await h.serve({ op: 'write', path: '/ro', atomic: true }, new Uint8Array())
    const failed = await h.serve({ op: 'flush' }, new Uint8Array())
    expect(failed.reply).toEqual({ error: 'Permission denied', errno: 'EACCES', path: '/ro' })
    await h.close()
  })

  it('reads a file a script names, never stdin', async () => {
    const h = host({}, parts('p\n'))
    const read = await h.serve({ op: 'read', fd: 1, path: '-', file: true }, new Uint8Array())
    expect(read.reply).toEqual({ error: 'No such file or directory', errno: 'ENOENT' })
  })

  it('lets a stalled read lose to the abort', async () => {
    const controller = new AbortController()
    const stalled = (): AsyncIterable<Uint8Array> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      }),
    })
    const ctx = {
      stdin: null,
      flags: {},
      cwd: PathSpec.fromStrPath('/'),
      signal: controller.signal,
    } as unknown as Context
    const h = new StreamHost([spec('/a.txt')], stalled, ctx, () => true)
    const pending = h.serve({ op: 'read', fd: 1, path: '/a.txt', operand: 1 }, new Uint8Array())
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await h.close()
  })

  it('refuses what needs a workspace outside one', async () => {
    const h = host({})
    const write = await h.serve({ op: 'write', path: 'out', append: false }, ENC.encode('x'))
    expect(write.reply).toEqual({ fatal: 'file output requires a workspace' })
    const run = await h.serve({ op: 'run', command: 'ls' }, new Uint8Array())
    expect(run.reply).toEqual({ fatal: 'running a command requires a workspace' })
    await h.close()
  })
})
