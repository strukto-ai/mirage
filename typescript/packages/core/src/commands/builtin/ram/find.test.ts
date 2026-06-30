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
const RAM_FIND = RAM_COMMANDS.filter((c) => c.name === 'find' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runFind(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  texts: string[] = [],
): Promise<{ lines: string[]; exitCode: number }> {
  const cmd = RAM_FIND[0]
  if (cmd === undefined) throw new Error('find not registered')
  const result = await cmd.fn(
    (resource as { accessor?: unknown }).accessor as never,
    paths,
    texts,
    {
      stdin: null,
      flags,
      filetypeFns: null,
      cwd: '/',
      resource,
    },
  )
  if (result === null) return { lines: [], exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  return { lines, exitCode: ioResult.exitCode }
}

describe('find', () => {
  it('lists all files recursively', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('world'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')])
    expect(r.exitCode).toBe(0)
    expect(r.lines).toContain('/tmp/a.txt')
    expect(r.lines).toContain('/tmp/b.txt')
  })

  it('includes subdirectories', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/sub')
    resource.store.files.set('/tmp/sub/c.txt', ENC.encode('nested'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')])
    expect(r.lines).toContain('/tmp/sub')
    expect(r.lines).toContain('/tmp/sub/c.txt')
  })

  it('-name glob pattern', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/a.txt', ENC.encode('aaa'))
    resource.store.files.set('/tmp/b.py', ENC.encode('bbb'))
    resource.store.files.set('/tmp/c.txt', ENC.encode('ccc'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], { name: '*.txt' })
    const sorted = r.lines.slice().sort()
    expect(sorted).toEqual(['/tmp/a.txt', '/tmp/c.txt'])
  })

  it('-type d finds only directories', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/sub')
    resource.store.files.set('/tmp/file.txt', ENC.encode('data'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], { type: 'd' })
    expect(r.lines).toEqual(['/tmp', '/tmp/sub'])
  })

  it('-type f finds only files', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/sub')
    resource.store.files.set('/tmp/file.txt', ENC.encode('data'))
    resource.store.files.set('/tmp/sub/nested.py', ENC.encode('code'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], { type: 'f' })
    const sorted = r.lines.slice().sort()
    expect(sorted).toEqual(['/tmp/file.txt', '/tmp/sub/nested.py'])
  })

  it('-size +N filters by min size', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/small.txt', ENC.encode('hi'))
    resource.store.files.set('/tmp/big.txt', ENC.encode('a'.repeat(100)))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], { size: '+50c' })
    expect(r.lines).toEqual(['/tmp', '/tmp/big.txt'])
  })

  it('-size -N filters by max size', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/small.txt', ENC.encode('hi'))
    resource.store.files.set('/tmp/big.txt', ENC.encode('a'.repeat(100)))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], { size: '-50c' })
    expect(r.lines).toEqual(['/tmp', '/tmp/small.txt'])
  })

  it('-maxdepth limits recursion', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/d1')
    resource.store.dirs.add('/tmp/d1/d2')
    resource.store.files.set('/tmp/a.txt', ENC.encode('a'))
    resource.store.files.set('/tmp/d1/b.txt', ENC.encode('b'))
    resource.store.files.set('/tmp/d1/d2/c.txt', ENC.encode('c'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], { maxdepth: '1' })
    expect(r.lines).toContain('/tmp/a.txt')
    expect(r.lines).toContain('/tmp/d1')
    expect(r.lines).not.toContain('/tmp/d1/d2/c.txt')
  })

  it('-not -name excludes matching', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/a.txt', ENC.encode('aaa'))
    resource.store.files.set('/tmp/b.pyc', ENC.encode('bbb'))
    resource.store.files.set('/tmp/c.txt', ENC.encode('ccc'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], {}, [
      '-not',
      '-name',
      '*.pyc',
    ])
    const sorted = r.lines.slice().sort()
    expect(sorted).toEqual(['/tmp', '/tmp/a.txt', '/tmp/c.txt'])
  })

  it('-empty matches empty files and dirs', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/sub')
    resource.store.dirs.add('/tmp/emptydir')
    resource.store.files.set('/tmp/empty.txt', new Uint8Array())
    resource.store.files.set('/tmp/sub/full.txt', ENC.encode('x'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], { empty: true })
    expect(r.lines.slice().sort()).toEqual(['/tmp/empty.txt', '/tmp/emptydir'])
  })

  it('-empty with -type d', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/emptydir')
    resource.store.files.set('/tmp/a.txt', ENC.encode('x'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], { empty: true, type: 'd' })
    expect(r.lines.slice().sort()).toEqual(['/tmp/emptydir'])
  })

  it('-not -name excludes (B3 grammar)', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/a.txt', ENC.encode('a'))
    resource.store.files.set('/tmp/b.md', ENC.encode('b'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], {}, [
      '-not',
      '-name',
      '*.txt',
    ])
    expect(r.lines.slice().sort()).toEqual(['/tmp', '/tmp/b.md'])
  })

  it('-name a -o -name b (B3 grammar)', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/a.txt', ENC.encode('a'))
    resource.store.files.set('/tmp/b.md', ENC.encode('b'))
    resource.store.files.set('/tmp/c.rst', ENC.encode('c'))
    const r = await runFind(resource, [PathSpec.fromStrPath('/tmp')], {}, [
      '-name',
      '*.txt',
      '-o',
      '-name',
      '*.md',
    ])
    expect(r.lines.slice().sort()).toEqual(['/tmp/a.txt', '/tmp/b.md'])
  })

  it('missing path yields no results', async () => {
    const resource = new RAMResource()
    const r = await runFind(resource, [PathSpec.fromStrPath('/nonexistent')])
    expect(r.lines).toEqual([])
  })
})
