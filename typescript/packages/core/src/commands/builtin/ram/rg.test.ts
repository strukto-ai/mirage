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

import { RAM_COMMANDS } from './index.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { PathSpec } from '../../../types.ts'
const RAM_RG = RAM_COMMANDS.filter((c) => c.name === 'rg' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runRg(
  resource: RAMResource,
  texts: string[],
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ lines: string[]; out: string; exitCode: number }> {
  const cmd = RAM_RG[0]
  if (cmd === undefined) throw new Error('rg not registered')
  const result = await cmd.fn(
    (resource as { accessor?: unknown }).accessor as never,
    paths,
    texts,
    {
      stdin,
      flags,
      filetypeFns: null,
      cwd: '/',
      resource,
    },
  )
  if (result === null) return { lines: [], out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  const lines = stripped === '' ? [] : stripped.split('\n')
  return { lines, out: text, exitCode: ioResult.exitCode }
}

describe('rg', () => {
  it('matches basic pattern in single file', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello world\nfoo bar\nhello again\n'))
    const r = await runRg(resource, ['hello'], [PathSpec.fromStrPath('/tmp/a.txt')])
    expect(r.lines).toContain('hello world')
    expect(r.lines).toContain('hello again')
    expect(r.lines).not.toContain('foo bar')
  })

  it('no match returns exit code 1', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello world\nfoo bar\n'))
    const r = await runRg(resource, ['xyz'], [PathSpec.fromStrPath('/tmp/a.txt')])
    expect(r.exitCode).toBe(1)
  })

  it('-i ignores case', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('Hello World\nhello world\nHELLO\n'))
    const r = await runRg(resource, ['hello'], [PathSpec.fromStrPath('/tmp/a.txt')], {
      i: true,
    })
    expect(r.lines.length).toBe(3)
  })

  it('-v inverts match', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello\nworld\nhello again\n'))
    const r = await runRg(resource, ['hello'], [PathSpec.fromStrPath('/tmp/a.txt')], {
      v: true,
    })
    expect(r.lines).toEqual(['world'])
  })

  it('-c gives count only', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/tmp/a.txt', ENC.encode('foo\nbar\nfoo baz\n'))
    const r = await runRg(resource, ['foo'], [PathSpec.fromStrPath('/tmp/a.txt')], {
      c: true,
    })
    expect(r.lines).toEqual(['2'])
  })

  it('-n prepends line numbers in stdin mode', async () => {
    const resource = new RAMResource()
    const r = await runRg(resource, ['foo'], [], { n: true }, ENC.encode('foo\nbar\nfoo baz\n'))
    expect(r.lines).toContain('1:foo')
    expect(r.lines).toContain('3:foo baz')
  })

  it('reads from stdin when no path', async () => {
    const resource = new RAMResource()
    const r = await runRg(resource, ['foo'], [], {}, ENC.encode('foo\nbar\nfoo baz\n'))
    expect(r.lines).toContain('foo')
    expect(r.lines).toContain('foo baz')
  })

  it('-l files-only mode (via args_l)', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/sub')
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello\n'))
    resource.store.files.set('/tmp/sub/b.txt', ENC.encode('world\n'))
    const r = await runRg(resource, ['hello'], [PathSpec.fromStrPath('/tmp')], {
      args_l: true,
    })
    expect(r.lines.some((l) => l.includes('/tmp/a.txt'))).toBe(true)
    expect(r.lines.some((l) => l.includes('/tmp/sub/b.txt'))).toBe(false)
  })

  it('missing pattern returns exit code 2', async () => {
    const resource = new RAMResource()
    const r = await runRg(resource, [], [])
    expect(r.exitCode).toBe(2)
  })
})
