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
const RAM_STRINGS = RAM_COMMANDS.filter((c) => c.name === 'strings' && c.filetype == null)

const DEC = new TextDecoder()

async function runStrings(
  resource: RAMResource,
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_STRINGS[0]
  if (cmd === undefined) throw new Error('strings not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, paths, [], {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), exitCode: ioResult.exitCode }
}

describe('strings', () => {
  it('extracts printable strings from binary data', async () => {
    const resource = new RAMResource()
    const data = new Uint8Array([
      0x00,
      0x00,
      ...'hello world'.split('').map((c) => c.charCodeAt(0)),
      0x00,
      0x00,
      ...'test'.split('').map((c) => c.charCodeAt(0)),
      0x00,
    ])
    resource.store.files.set('/bin', data)
    const r = await runStrings(resource, [PathSpec.fromStrPath('/bin')])
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain('hello world')
  })

  it('respects -n minimum length flag', async () => {
    const resource = new RAMResource()
    const data = new Uint8Array([
      ...'hi'.split('').map((c) => c.charCodeAt(0)),
      0x00,
      ...'longenough'.split('').map((c) => c.charCodeAt(0)),
      0x00,
    ])
    resource.store.files.set('/bin', data)
    const r = await runStrings(resource, [PathSpec.fromStrPath('/bin')], { n: '4' })
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain('longenough')
    expect(r.out).not.toContain('hi\n')
  })

  it('reads from stdin when no path', async () => {
    const resource = new RAMResource()
    const data = new Uint8Array([0x00, ...'findme'.split('').map((c) => c.charCodeAt(0)), 0x00])
    const r = await runStrings(resource, [], {}, data)
    expect(r.exitCode).toBe(0)
    expect(r.out).toContain('findme')
  })
})
