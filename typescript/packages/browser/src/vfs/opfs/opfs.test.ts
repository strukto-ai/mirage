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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ops } from '@struktoai/mirage-core/test-utils'
import { FileType, VFSName } from '@struktoai/mirage-core/types'
import { copy as copyCore } from '../../core/opfs/copy.ts'
import { size as duSizeCore } from '../../core/opfs/du/index.ts'
import { exists as existsCore } from '../../core/opfs/exists.ts'
import { find as findCore } from '../../core/opfs/find.ts'
import { rmR as rmRCore } from '../../core/opfs/rm.ts'
import { stream as streamCore } from '../../core/opfs/stream.ts'
import { installFakeNavigator, makeMockRoot, spec } from '../../test-utils.ts'
import { OPFSVFS } from './opfs.ts'

let res: OPFSVFS
let restoreNav: () => void

beforeEach(() => {
  const root = makeMockRoot()
  restoreNav = installFakeNavigator(() => root)
  res = new OPFSVFS()
})

afterEach(() => {
  restoreNav()
})

describe('OPFSVFS — identity', () => {
  it('has kind, prompt, defaults', () => {
    expect(res.name).toBe(VFSName.OPFS)
    expect(typeof res.prompt).toBe('string')
    expect(res.rootName).toBe('')
  })
  it('ops() returns the OPFS_OPS array', () => {
    expect(res.ops().length).toBeGreaterThan(0)
  })
  it('commands() returns OPFS_COMMANDS', () => {
    expect(res.commands().length).toBeGreaterThan(0)
  })
})

describe('OPFSVFS — fs methods', () => {
  it('write + read round-trip', async () => {
    await ops(res).write(spec('/x'), new TextEncoder().encode('hi'))
    expect(new TextDecoder().decode(await ops(res).read(spec('/x')))).toBe('hi')
  })

  it('append concatenates', async () => {
    await ops(res).write(spec('/a'), new TextEncoder().encode('1'))
    await ops(res).append(spec('/a'), new TextEncoder().encode('2'))
    expect(new TextDecoder().decode(await ops(res).read(spec('/a')))).toBe('12')
  })

  it('readdir returns sorted virtual paths', async () => {
    await ops(res).write(spec('/b'), new Uint8Array())
    await ops(res).write(spec('/a'), new Uint8Array())
    expect(await ops(res).readdir(spec('/'))).toEqual(['/a', '/b'])
  })

  it('stat distinguishes files and directories', async () => {
    await ops(res).write(spec('/file'), new TextEncoder().encode('x'))
    await ops(res).mkdir(spec('/dir'))
    const f = await ops(res).stat(spec('/file'))
    expect(f.size).toBe(1)
    expect(f.type).not.toBe(FileType.DIRECTORY)
    const d = await ops(res).stat(spec('/dir'))
    expect(d.type).toBe(FileType.DIRECTORY)
  })

  it('exists / mkdir / rmdir / unlink', async () => {
    await ops(res).mkdir(spec('/d'))
    expect(await existsCore(res.accessor, spec('/d'))).toBe(true)
    await ops(res).rmdir(spec('/d'))
    expect(await existsCore(res.accessor, spec('/d'))).toBe(false)

    await ops(res).write(spec('/f'), new Uint8Array())
    await ops(res).unlink(spec('/f'))
    expect(await existsCore(res.accessor, spec('/f'))).toBe(false)
  })

  it('rename + copy', async () => {
    await ops(res).write(spec('/a'), new TextEncoder().encode('A'))
    await ops(res).rename(spec('/a'), spec('/b'))
    expect(new TextDecoder().decode(await ops(res).read(spec('/b')))).toBe('A')
    await copyCore(res.accessor, spec('/b'), spec('/c'))
    expect(new TextDecoder().decode(await ops(res).read(spec('/c')))).toBe('A')
  })

  it('truncate / stream / du', async () => {
    await ops(res).mkdir(spec('/d'))
    await ops(res).write(spec('/d/a'), new Uint8Array([1, 2, 3]))
    await ops(res).write(spec('/d/b'), new Uint8Array([4, 5]))
    expect(await duSizeCore(res.accessor, spec('/d'))).toBe(5)

    await ops(res).truncate(spec('/d/a'), 1)
    const chunks: Uint8Array[] = []
    for await (const c of streamCore(res.accessor, spec('/d/a'))) chunks.push(c)
    expect(chunks[0]?.byteLength).toBe(1)
  })

  it('rmR removes recursively', async () => {
    await ops(res).mkdir(spec('/d'))
    await ops(res).write(spec('/d/x'), new TextEncoder().encode('x'))
    await rmRCore(res.accessor, spec('/d'))
    expect(await existsCore(res.accessor, spec('/d'))).toBe(false)
  })

  it('find returns matches', async () => {
    await ops(res).write(spec('/a.json'), new Uint8Array())
    await ops(res).write(spec('/b.txt'), new Uint8Array())
    expect(await findCore(res.accessor, spec('/'), { name: '*.json' })).toEqual(['/a.json'])
  })
})

describe('OPFSVFS — getState / loadState round-trip', () => {
  it('snapshots files and dirs', async () => {
    await ops(res).write(spec('/a'), new TextEncoder().encode('A'))
    await ops(res).mkdir(spec('/d'))
    await ops(res).write(spec('/d/b'), new TextEncoder().encode('B'))

    const state = await res.getState()
    expect(Object.keys(state.files).sort()).toEqual(['a', 'd/b'])

    const root2 = makeMockRoot()
    restoreNav()
    restoreNav = installFakeNavigator(() => root2)
    const res2 = new OPFSVFS()
    await res2.loadState(state)
    expect(new TextDecoder().decode(await ops(res2).read(spec('/a')))).toBe('A')
    expect(new TextDecoder().decode(await ops(res2).read(spec('/d/b')))).toBe('B')
  })
})
