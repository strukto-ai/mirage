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
const RAM_REALPATH = RAM_COMMANDS.filter((c) => c.name === 'realpath' && c.filetype == null)

const DEC = new TextDecoder()

async function runRealpath(
  resource: RAMResource,
  paths: PathSpec[],
  cwd = '/',
  texts: string[] = [],
): Promise<{ out: string; exitCode: number }> {
  const cmd = RAM_REALPATH[0]
  if (cmd === undefined) throw new Error('realpath not registered')
  const result = await cmd.fn(
    (resource as { accessor?: unknown }).accessor as never,
    paths,
    texts,
    {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd,
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

describe('realpath', () => {
  it('resolves parent traversal in absolute path', async () => {
    const resource = new RAMResource()
    const r = await runRealpath(resource, [PathSpec.fromStrPath('/data/bar/../baz')])
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('/data/baz')
  })

  it('resolves multiple paths', async () => {
    const resource = new RAMResource()
    const r = await runRealpath(resource, [
      PathSpec.fromStrPath('/a/./b'),
      PathSpec.fromStrPath('/x/y/../z'),
    ])
    expect(r.exitCode).toBe(0)
    expect(r.out.trim().split('\n')).toEqual(['/a/b', '/x/z'])
  })

  it('resolves relative path against cwd', async () => {
    const resource = new RAMResource()
    const r = await runRealpath(resource, [], '/data', ['bar'])
    expect(r.exitCode).toBe(0)
    expect(r.out.trim()).toBe('/data/bar')
  })
})
