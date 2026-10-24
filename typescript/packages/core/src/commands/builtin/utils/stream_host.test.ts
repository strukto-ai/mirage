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
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { stripSlash } from '../../../utils/slash.ts'
import type { Context } from '../../config.ts'
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
    expect(missing.reply).toEqual({ error: 'No such file or directory' })
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

  it('refuses what needs a workspace outside one', async () => {
    const h = host({})
    const write = await h.serve({ op: 'write', path: 'out', append: false }, ENC.encode('x'))
    expect(write.reply).toEqual({ fatal: 'file output requires a workspace' })
    const run = await h.serve({ op: 'run', command: 'ls' }, new Uint8Array())
    expect(run.reply).toEqual({ fatal: 'running a command requires a workspace' })
    await h.close()
  })
})
