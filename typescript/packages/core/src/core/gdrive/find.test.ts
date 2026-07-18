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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DriveModule from '../google/drive.ts'

vi.mock('../google/drive.ts', async () => {
  const actual = await vi.importActual<typeof DriveModule>('../google/drive.ts')
  const { driveModuleMock } = await import('./_test_util.ts')
  return driveModuleMock(actual)
})

import { PathSpec } from '../../types.ts'
import type { FakeDrive } from './_test_util.ts'
import { DOC_MIME, makeGDriveAccessor, resetFakeDrive } from './_test_util.ts'

const ENC = new TextEncoder()
let fake: FakeDrive
const accessor = makeGDriveAccessor()

beforeEach(() => {
  fake = resetFakeDrive()
})

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

function seedTree(): void {
  const sub = fake.folder('sub')
  fake.add('a.txt', 'root', undefined, ENC.encode('aaaa'))
  fake.add('big.bin', sub, undefined, ENC.encode('x'.repeat(2048)))
  fake.add('small.bin', sub, undefined, ENC.encode('x'.repeat(16)))
  fake.add('Report', 'root', DOC_MIME)
}

import { find } from './find.ts'

describe('gdrive core find', () => {
  it('lists the subtree sorted, root first', async () => {
    seedTree()
    const out = await find(accessor, spec('/sub'))
    expect(out).toEqual(['/sub', '/sub/big.bin', '/sub/small.bin'])
  })

  it('filters by name and renders native suffixes', async () => {
    seedTree()
    expect(await find(accessor, spec('/'), { name: '*.gdoc.json' })).toEqual(['/Report.gdoc.json'])
  })

  it('type d keeps directories only', async () => {
    seedTree()
    expect(await find(accessor, spec('/'), { type: 'd' })).toEqual(['/', '/sub'])
  })

  it('maxDepth bounds the walk', async () => {
    seedTree()
    const out = await find(accessor, spec('/'), { maxDepth: 1 })
    expect(out).toEqual(['/', '/Report.gdoc.json', '/a.txt', '/sub'])
  })

  it('size bounds treat directories as zero', async () => {
    seedTree()
    expect(await find(accessor, spec('/sub'), { minSize: 1024 })).toEqual(['/sub/big.bin'])
    expect(await find(accessor, spec('/sub'), { maxSize: 100 })).toEqual(['/sub', '/sub/small.bin'])
  })

  it('a missing root returns nothing', async () => {
    expect(await find(accessor, spec('/missing'))).toEqual([])
  })
})
