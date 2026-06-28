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
import { RAMResource } from '../../../resource/ram/ram.ts'
const RAM_PATCH = RAM_COMMANDS.filter((c) => c.name === 'patch' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runPatch(
  resource: RAMResource,
  flags: Record<string, string | boolean | string[]>,
  stdin: Uint8Array | null,
): Promise<void> {
  const cmd = RAM_PATCH[0]
  if (cmd === undefined) throw new Error('patch not registered')
  await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
}

describe('patch', () => {
  it('applies a simple patch from stdin', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/hello.txt', ENC.encode('hello\nworld\n'))
    const diffText =
      '--- a/hello.txt\n' +
      '+++ b/hello.txt\n' +
      '@@ -1,2 +1,2 @@\n' +
      ' hello\n' +
      '-world\n' +
      '+universe\n'
    await runPatch(resource, { p: '1' }, ENC.encode(diffText))
    const out = resource.store.files.get('/hello.txt')
    expect(out).toBeDefined()
    expect(DEC.decode(out)).toContain('universe')
  })

  it('applies a patch from -i file', async () => {
    const resource = new RAMResource()
    const diffText =
      '--- a/hello.txt\n' +
      '+++ b/hello.txt\n' +
      '@@ -1,2 +1,2 @@\n' +
      ' hello\n' +
      '-world\n' +
      '+universe\n'
    resource.store.files.set('/hello.txt', ENC.encode('hello\nworld\n'))
    resource.store.files.set('/fix.patch', ENC.encode(diffText))
    await runPatch(resource, { p: '1', i: '/fix.patch' }, null)
    const out = resource.store.files.get('/hello.txt')
    expect(out).toBeDefined()
    expect(DEC.decode(out)).toContain('universe')
  })

  it('-N skips already-applied hunks', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/hello.txt', ENC.encode('hello\nuniverse\n'))
    const diffText =
      '--- a/hello.txt\n' +
      '+++ b/hello.txt\n' +
      '@@ -1,2 +1,2 @@\n' +
      ' hello\n' +
      '-world\n' +
      '+universe\n'
    await runPatch(resource, { p: '1', N: true }, ENC.encode(diffText))
    const out = resource.store.files.get('/hello.txt')
    expect(out).toBeDefined()
    expect(DEC.decode(out)).toContain('universe')
  })
})
