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

import { FileType, PathSpec } from '@struktoai/mirage-core/types'
import { describe, expect, it, vi } from 'vitest'
import { Files } from '@struktoai/mirage-core/workspace/files'
import { materialize } from '@struktoai/mirage-core/io/types'
import { HfAccountAccessor } from '@struktoai/mirage-core/accessor/hf_hub'
import type * as ClientModule from '@struktoai/mirage-core/core/hf_hub/client'
import { parseEntry } from '@struktoai/mirage-core/core/hf_hub/tree'
import type * as TreeModule from '@struktoai/mirage-core/core/hf_hub/tree'
import { downloadCmd } from '@struktoai/mirage-core/commands/cli/builtin/hf/download'
import { ensureDir } from '@struktoai/mirage-core/commands/cli/operand'

const hubBytesMock = vi.hoisted(() => vi.fn())
const fetchTreeMock = vi.hoisted(() => vi.fn())

vi.mock('@struktoai/mirage-core/core/hf_hub/client', async (orig) => ({
  ...(await orig<typeof ClientModule>()),
  hubBytes: hubBytesMock,
}))

vi.mock('@struktoai/mirage-core/core/hf_hub/tree', async (orig) => ({
  ...(await orig<typeof TreeModule>()),
  fetchTree: fetchTreeMock,
}))

function exists(code: string, path: string): Error {
  return Object.assign(new Error(path), { code })
}

describe('ensureDir', () => {
  it('tolerates a parent another worker just made', async () => {
    // A parallel download fans out over files that share parents, so two
    // workers can read the same parent as missing and then both create it.
    // The loser's EEXIST must not reject the whole Promise.all.
    const dirs = new Set<string>()
    const dispatch = async (op: string, spec: PathSpec) => {
      const path = spec.virtual
      if (op === 'stat') {
        // Yield here, so the second walk probes before the first has
        // created anything. Without it the two run to completion in turn
        // and the race the fix exists for never happens.
        await Promise.resolve()
        if (dirs.has(path)) return [{ name: path, type: FileType.DIRECTORY }, null]
        throw exists('ENOENT', path)
      }
      if (op === 'mkdir') {
        if (dirs.has(path)) throw exists('EEXIST', path)
        dirs.add(path)
        return [null, null]
      }
      throw new Error(`unexpected op ${op}`)
    }
    await Promise.all([
      ensureDir(new Files(dispatch as never), PathSpec.fromStrPath('/work/out')),
      ensureDir(new Files(dispatch as never), PathSpec.fromStrPath('/work/out')),
    ])
    expect([...dirs].sort()).toEqual(['/work', '/work/out'])
  })

  it('still reports a mkdir that failed for any other reason', async () => {
    const dispatch = (op: string, spec: PathSpec) => {
      if (op === 'stat') return Promise.reject(exists('ENOENT', spec.virtual))
      return Promise.reject(exists('EACCES', spec.virtual))
    }
    await expect(
      ensureDir(new Files(dispatch as never), PathSpec.fromStrPath('/work/out')),
    ).rejects.toThrow(/work/)
  })
})

describe('downloadCmd', () => {
  it('hands back the files it wrote as records with their paths', async () => {
    const written = new Map<string, Uint8Array>()
    const dirs = new Set(['/work'])
    const dispatch = (op: string, spec: PathSpec, kwargs: { data?: Uint8Array } = {}) => {
      const path = spec.virtual
      if (op === 'stat') {
        if (dirs.has(path)) return Promise.resolve([{ name: path, type: FileType.DIRECTORY }, null])
        return Promise.reject(exists('ENOENT', path))
      }
      if (op === 'mkdir') {
        dirs.add(path)
        return Promise.resolve([null, null])
      }
      if (op === 'write') {
        written.set(path, kwargs.data ?? new Uint8Array())
        return Promise.resolve([null, null])
      }
      return Promise.reject(new Error(`unexpected op ${op}`))
    }
    fetchTreeMock.mockResolvedValue(
      new Map([['a.txt', parseEntry({ type: 'file', oid: 'oid-a', size: 7, path: 'a.txt' })]]),
    )
    hubBytesMock.mockResolvedValue(new TextEncoder().encode('payload'))
    const [out, io] = (await downloadCmd(
      new HfAccountAccessor({ token: 'hf_test', endpoint: 'https://huggingface.co' }),
      [],
      ['acme/widget', 'a.txt'],
      {
        argv: ['acme/widget', 'a.txt'],
        flags: { local_dir: PathSpec.fromStrPath('/work/out') },
        stdin: null,
        cwd: PathSpec.fromStrPath('/'),
        env: {},
        vfs: new Files(dispatch as never),
      },
    )) ?? [null, null]
    expect([...written.keys()]).toEqual(['/work/out/a.txt'])
    expect(io?.records?.map((r) => r.path.virtual)).toEqual(['/work/out/a.txt'])
    expect(new TextDecoder().decode(await materialize(out))).toBe('/work/out/a.txt\n/work/out\n')
  })
})
