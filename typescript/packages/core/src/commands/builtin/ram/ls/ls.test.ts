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
import { materialize } from '../../../../io/types.ts'
import { RAMResource } from '../../../../resource/ram/ram.ts'
import { PathSpec } from '../../../../types.ts'
import { RAM_LS } from './ls.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runLs(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean> = {},
): Promise<string> {
  const cmd = RAM_LS[0]
  if (cmd === undefined) throw new Error('ls not registered')
  const result = await cmd.fn(resource.accessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

function seed(resource: RAMResource, dirs: string[], files: Record<string, string>): void {
  for (const d of dirs) resource.store.dirs.add(d)
  for (const [p, content] of Object.entries(files)) {
    resource.store.files.set(p, ENC.encode(content))
  }
}

describe('ls', () => {
  it('lists files in directory', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], { '/tmp/a.txt': 'hello' })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')])
    expect(out.split('\n')).toEqual(['a.txt'])
  })

  it('empty directory', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], {})
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')])
    expect(out).toBe('')
  })

  it('multiple files sorted alphabetically', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], {
      '/tmp/cherry.txt': 'c',
      '/tmp/apple.txt': 'a',
      '/tmp/banana.txt': 'b',
    })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')])
    expect(out.split('\n')).toEqual(['apple.txt', 'banana.txt', 'cherry.txt'])
  })

  it('-l long format includes size and standard mode string', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], { '/tmp/file.txt': 'hello' })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')], { args_l: true })
    const line = out.split('\n')[0] ?? ''
    const parts = line.split(/\s+/)
    expect(parts[0]).toBe('-rw-r--r--')
    expect(parts).toContain('5')
    expect(parts[parts.length - 1]).toBe('file.txt')
  })

  it('hides dotfiles by default', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], {
      '/tmp/.hidden': 'secret',
      '/tmp/visible.txt': 'hi',
    })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')])
    expect(out.split('\n')).toEqual(['visible.txt'])
  })

  it('-a shows dotfiles', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], {
      '/tmp/.hidden': 'secret',
      '/tmp/visible.txt': 'hi',
    })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')], { a: true })
    expect(out.split('\n').sort()).toEqual(['.hidden', 'visible.txt'])
  })

  it('-r reverses name sort', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], {
      '/tmp/a.txt': 'a',
      '/tmp/b.txt': 'b',
      '/tmp/c.txt': 'c',
    })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')], { r: true })
    expect(out.split('\n')).toEqual(['c.txt', 'b.txt', 'a.txt'])
  })

  it('-S sorts by size descending', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], {
      '/tmp/big.txt': 'x'.repeat(100),
      '/tmp/small.txt': 'x',
      '/tmp/medium.txt': 'x'.repeat(50),
    })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')], { S: true })
    expect(out.split('\n')).toEqual(['big.txt', 'medium.txt', 'small.txt'])
  })

  it('-S -r sorts by size ascending', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], {
      '/tmp/big.txt': 'x'.repeat(100),
      '/tmp/small.txt': 'x',
      '/tmp/medium.txt': 'x'.repeat(50),
    })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')], { S: true, r: true })
    expect(out.split('\n')).toEqual(['small.txt', 'medium.txt', 'big.txt'])
  })

  it('-a with -r reverses all entries', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], {
      '/tmp/.z_hidden': 'z',
      '/tmp/a.txt': 'a',
      '/tmp/m.txt': 'm',
    })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')], { a: true, r: true })
    expect(out.split('\n')).toEqual(['m.txt', 'a.txt', '.z_hidden'])
  })

  it('recursive listing (-R) walks subdirectories with headers', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp', '/tmp/sub'], {
      '/tmp/a.txt': 'a',
      '/tmp/sub/b.txt': 'b',
    })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')], { R: true })
    expect(out).toContain('a.txt')
    expect(out).toContain('sub')
    expect(out).toContain('/tmp/sub:')
    expect(out).toContain('b.txt')
  })

  it('list-dir mode (-d) lists directory entries themselves, not contents', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], { '/tmp/a.txt': 'a' })
    const out = await runLs(resource, [PathSpec.fromStrPath('/tmp')], { d: true })
    expect(out).toBe('tmp')
  })

  it('-1 overrides -l: forces short (one-per-line) format', async () => {
    const resource = new RAMResource()
    seed(resource, ['/tmp'], { '/tmp/a.txt': 'a', '/tmp/b.txt': 'b' })
    const short = await runLs(resource, [PathSpec.fromStrPath('/tmp')], { args_1: true })
    const overridden = await runLs(resource, [PathSpec.fromStrPath('/tmp')], {
      args_l: true,
      args_1: true,
    })
    expect(overridden).toBe(short)
  })
})
