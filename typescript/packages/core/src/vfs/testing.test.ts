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

import { describe, expect, it, vi } from 'vitest'
import { RAMAccessor } from '../accessor/ram.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { read as ramRead } from '../core/ram/read.ts'
import { readdir as ramReaddir } from '../core/ram/readdir.ts'
import { stat as ramStat } from '../core/ram/stat.ts'
import { write as ramWrite } from '../core/ram/write.ts'
import { eacces } from '../errors/fs.ts'
import { FileStat, FileType, PathSpec } from '../types.ts'
import { sliceWindow } from '../utils/ranges.ts'
import { BaseVFS } from './base.ts'
import { RAMVFS } from './ram/ram.ts'
import { RAMStore } from './ram/store.ts'
import { checkReadContract, type ReadFixture } from './testing.ts'

const FILE = new PathSpec({ virtual: '/data/a.txt', directory: '/data', vfsPath: 'a.txt' })
const DIRECTORY = new PathSpec({ virtual: '/data', directory: '/', vfsPath: '' })
const MISSING = new PathSpec({ virtual: '/data/missing', directory: '/data', vfsPath: 'missing' })
const CONTENT = new TextEncoder().encode('é: hello\n')
const FIXTURE: ReadFixture = {
  file: FILE,
  directory: DIRECTORY,
  missing: MISSING,
  content: CONTENT,
}

/** The three required reads over a RAM store, whole reads sliced. */
class Minimal extends BaseVFS<RAMAccessor> {
  override readdir(path: PathSpec): Promise<string[]> {
    return ramReaddir(this.accessor, path)
  }

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    return sliceWindow(await ramRead(this.accessor, path, index), offset, size)
  }

  override stat(path: PathSpec): Promise<FileStat> {
    return ramStat(this.accessor, path)
  }
}

class EndForSize extends Minimal {
  override readonly readsRanges: boolean = true

  override async read(
    path: PathSpec,
    index?: IndexCacheStore,
    offset = 0,
    size: number | null = null,
  ): Promise<Uint8Array> {
    const data = await ramRead(this.accessor, path, index)
    return data.slice(offset, size ?? undefined)
  }
}

class LenientStat extends Minimal {
  override stat(path: PathSpec): Promise<FileStat> {
    if (path.vfsPath === MISSING.vfsPath) {
      return Promise.resolve(new FileStat({ name: 'missing', type: FileType.FILE, size: 0 }))
    }
    return super.stat(path)
  }
}

async function seeded<V extends BaseVFS<RAMAccessor>>(
  cls: new (options: { name: string; accessor: RAMAccessor }) => V,
  content: Uint8Array,
): Promise<V> {
  const accessor = new RAMAccessor(new RAMStore())
  await ramWrite(accessor, FILE, content)
  return new cls({ name: 'custom', accessor })
}

describe('the read contract', () => {
  it.each([[''], ['a'], ['ab'], ['é: hello\n']])('a minimal VFS meets it (%j)', async (text) => {
    const content = new TextEncoder().encode(text)
    await checkReadContract(await seeded(Minimal, content), { ...FIXTURE, content })
  })

  it('a builtin meets it', async () => {
    const ram = new RAMVFS()
    await ramWrite(ram.accessor, FILE, CONTENT)
    await checkReadContract(ram, FIXTURE)
  })

  it('catches a range that uses the end instead of the size', async () => {
    await expect(checkReadContract(await seeded(EndForSize, CONTENT), FIXTURE)).rejects.toThrow(
      'offset and byte count',
    )
  })

  it('catches a stat that answers for a missing path', async () => {
    await expect(checkReadContract(await seeded(LenientStat, CONTENT), FIXTURE)).rejects.toThrow(
      'must raise ENOENT',
    )
  })

  it('propagates a permission failure', async () => {
    const vfs = await seeded(Minimal, CONTENT)
    vi.spyOn(vfs, 'read').mockRejectedValue(eacces(FILE.virtual))
    await expect(checkReadContract(vfs, FIXTURE)).rejects.toMatchObject({ code: 'EACCES' })
  })
})
