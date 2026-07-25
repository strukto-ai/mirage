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
const RAM_TREE = RAM_COMMANDS.filter((c) => c.name === 'tree' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runTree(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
): Promise<{ lines: string[]; exitCode: number }> {
  const cmd = RAM_TREE[0]
  if (cmd === undefined) throw new Error('tree not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { lines: [], exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const text = DEC.decode(buf)
  const lines = text === '' ? [] : text.trimEnd().split('\n')
  return { lines, exitCode: ioResult.exitCode }
}

describe('tree', () => {
  it('lists direct children with connectors', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('world'))
    const r = await runTree(resource, [PathSpec.fromStrPath('/tmp')])
    expect(r.exitCode).toBe(0)
    const joined = r.lines.join('\n')
    expect(joined.includes('|-- ') || joined.includes('`-- ')).toBe(true)
  })

  it('single file uses last connector', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello'))
    const r = await runTree(resource, [PathSpec.fromStrPath('/tmp')])
    expect(r.lines).toEqual(['/tmp', '`-- a.txt', '', '1 directory, 1 file'])
  })

  it('shows file names in output', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/a.txt', ENC.encode('hello'))
    resource.store.files.set('/tmp/b.txt', ENC.encode('world'))
    const r = await runTree(resource, [PathSpec.fromStrPath('/tmp')])
    const joined = r.lines.join('\n')
    expect(joined).toContain('a.txt')
    expect(joined).toContain('b.txt')
  })

  it('recurses into nested directories', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/d1')
    resource.store.dirs.add('/tmp/d1/d2')
    resource.store.files.set('/tmp/d1/d2/f.txt', ENC.encode('nested'))
    const r = await runTree(resource, [PathSpec.fromStrPath('/tmp')])
    const joined = r.lines.join('\n')
    expect(joined).toContain('d1')
    expect(joined).toContain('d2')
    expect(joined).toContain('f.txt')
  })

  it('empty directory reports zero counts', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    const r = await runTree(resource, [PathSpec.fromStrPath('/tmp')])
    expect(r.lines).toEqual(['/tmp', '', '0 directories, 0 files'])
    expect(r.exitCode).toBe(0)
  })

  it('missing path marks the error and exits 2', async () => {
    const resource = new RAMResource()
    const r = await runTree(resource, [PathSpec.fromStrPath('/nonexistent')])
    expect(r.lines).toEqual(['/nonexistent  [error opening dir]', '', '0 directories, 0 files'])
    expect(r.exitCode).toBe(2)
  })

  it('hides dotfiles by default, shows them with -a', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/visible.txt', ENC.encode('x'))
    resource.store.files.set('/tmp/.hidden', ENC.encode('y'))
    const rDefault = await runTree(resource, [PathSpec.fromStrPath('/tmp')])
    const textDefault = rDefault.lines.join('\n')
    expect(textDefault).toContain('visible.txt')
    expect(textDefault).not.toContain('.hidden')
    const rAll = await runTree(resource, [PathSpec.fromStrPath('/tmp')], { a: true })
    const textAll = rAll.lines.join('\n')
    expect(textAll).toContain('.hidden')
  })

  it('-I ignores matching filenames', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.files.set('/tmp/keep.txt', ENC.encode('k'))
    resource.store.files.set('/tmp/skip.log', ENC.encode('s'))
    const r = await runTree(resource, [PathSpec.fromStrPath('/tmp')], { args_I: '*.log' })
    const text = r.lines.join('\n')
    expect(text).toContain('keep.txt')
    expect(text).not.toContain('skip.log')
  })

  it('-L limits recursion depth', async () => {
    const resource = new RAMResource()
    resource.store.dirs.add('/tmp')
    resource.store.dirs.add('/tmp/a')
    resource.store.dirs.add('/tmp/a/b')
    resource.store.files.set('/tmp/a/b/deep.txt', ENC.encode('deep'))
    resource.store.files.set('/tmp/a/shallow.txt', ENC.encode('shallow'))
    const r = await runTree(resource, [PathSpec.fromStrPath('/tmp')], { L: '1' })
    const text = r.lines.join('\n')
    expect(text).toContain('a')
    expect(text).not.toContain('deep.txt')
  })
})
