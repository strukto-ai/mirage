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
import { patchGeneric } from '../generic/patch.ts'
import { PathSpec } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
const RAM_PATCH = RAM_COMMANDS.filter((c) => c.name === 'patch' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runPatch(
  vfs: RAMVFS,
  flags: Record<string, string | boolean | number | string[]>,
  stdin: Uint8Array | null,
): Promise<void> {
  const cmd = RAM_PATCH[0]
  if (cmd === undefined) throw new Error('patch not registered')
  await cmd.fn((vfs as { accessor?: unknown }).accessor as never, [], [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
}

describe('patch', () => {
  it('applies a simple patch from stdin', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/hello.txt', ENC.encode('hello\nworld\n'))
    const diffText =
      '--- a/hello.txt\n' +
      '+++ b/hello.txt\n' +
      '@@ -1,2 +1,2 @@\n' +
      ' hello\n' +
      '-world\n' +
      '+universe\n'
    await runPatch(vfs, { p: '1' }, ENC.encode(diffText))
    const out = vfs.store.files.get('/hello.txt')
    expect(out).toBeDefined()
    expect(DEC.decode(out)).toContain('universe')
  })

  it('applies a patch from -i file', async () => {
    const vfs = new RAMVFS()
    const diffText =
      '--- a/hello.txt\n' +
      '+++ b/hello.txt\n' +
      '@@ -1,2 +1,2 @@\n' +
      ' hello\n' +
      '-world\n' +
      '+universe\n'
    vfs.store.files.set('/hello.txt', ENC.encode('hello\nworld\n'))
    vfs.store.files.set('/fix.patch', ENC.encode(diffText))
    await runPatch(vfs, { p: '1', i: '/fix.patch' }, null)
    const out = vfs.store.files.get('/hello.txt')
    expect(out).toBeDefined()
    expect(DEC.decode(out)).toContain('universe')
  })

  it('-N skips already-applied hunks', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/hello.txt', ENC.encode('hello\nuniverse\n'))
    const diffText =
      '--- a/hello.txt\n' +
      '+++ b/hello.txt\n' +
      '@@ -1,2 +1,2 @@\n' +
      ' hello\n' +
      '-world\n' +
      '+universe\n'
    await runPatch(vfs, { p: '1', N: true }, ENC.encode(diffText))
    const out = vfs.store.files.get('/hello.txt')
    expect(out).toBeDefined()
    expect(DEC.decode(out)).toContain('universe')
  })
})

it.each(['', '/data', '/nested/data'])(
  'preserves virtual paths under %s for patch I/O',
  async (prefix) => {
    for (const source of ['stdin', 'operand', 'input']) {
      const diff = ENC.encode(
        '--- a/hello.txt\n+++ b/hello.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+universe\n',
      )
      const files = new Map<string, Uint8Array>([
        ['hello.txt', ENC.encode('hello\nworld\n')],
        ['fix.diff', diff],
      ])
      const seen: string[] = []
      const stream = async function* (path: PathSpec): AsyncIterable<Uint8Array> {
        expect(path.virtual).toBe(prefix + '/' + path.vfsPath)
        seen.push(path.vfsPath)
        const bytes = files.get(path.vfsPath)
        if (bytes === undefined) throw new Error('missing fixture')
        yield Promise.resolve(bytes)
      }
      const write = (path: PathSpec, data: Uint8Array): Promise<void> => {
        expect(path.virtual).toBe(prefix + '/' + path.vfsPath)
        files.set(path.vfsPath, data)
        return Promise.resolve()
      }
      const input = PathSpec.fromStrPath(prefix + '/fix.diff', 'fix.diff')
      await patchGeneric(
        source === 'operand' ? [input] : [],
        {
          mountPrefix: prefix,
          filetypeFns: null,
          cwd: prefix || '/',
          flags: { p: '1', ...(source === 'input' ? { i: input.virtual } : {}) },
          stdin: source === 'stdin' ? diff : null,
        },
        stream,
        write,
      )
      expect(seen).toContain('hello.txt')
      expect(DEC.decode(files.get('hello.txt'))).toBe('hello\nuniverse\n')
    }
  },
)
