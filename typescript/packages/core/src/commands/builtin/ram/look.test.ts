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
const RAM_LOOK = RAM_COMMANDS.filter((c) => c.name === 'look' && c.filetype == null)

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runLook(
  resource: RAMResource,
  texts: string[],
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]> = {},
  stdin: Uint8Array | null = null,
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_LOOK[0]
  if (cmd === undefined) throw new Error('look not registered')
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

describe('look', () => {
  it('returns lines starting with the prefix', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/dict.txt', ENC.encode('apple\nbanana\ncherry\n'))
    const r = await runLook(resource, ['ban'], [PathSpec.fromStrPath('/dict.txt')])
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('banana')
  })

  it('no match returns exit code 1', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/dict.txt', ENC.encode('apple\nbanana\n'))
    const r = await runLook(resource, ['xyz'], [PathSpec.fromStrPath('/dict.txt')])
    expect(r.exitCode).toBe(1)
  })

  it('missing prefix returns exit code 1', async () => {
    const resource = new RAMResource()
    const r = await runLook(resource, [], [])
    expect(r.exitCode).toBe(1)
  })

  it('-f is case insensitive', async () => {
    const resource = new RAMResource()
    resource.store.files.set('/dict.txt', ENC.encode('Apple\nBanana\nCherry\n'))
    const r = await runLook(resource, ['ban'], [PathSpec.fromStrPath('/dict.txt')], { f: true })
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('Banana')
  })

  it('reads from stdin when no path', async () => {
    const resource = new RAMResource()
    const r = await runLook(resource, ['ch'], [], {}, ENC.encode('apple\nbanana\ncherry\n'))
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('cherry')
  })
})
