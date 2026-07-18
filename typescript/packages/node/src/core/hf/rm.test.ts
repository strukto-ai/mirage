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

import { PathSpec } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { HfBucketsAccessor } from '../../accessor/hf.ts'
import { fakeHfOperator, installFakeOperator } from './mock.ts'
import { rmR } from './rm.ts'

function accessorWith(files: Record<string, string | Buffer>) {
  const accessor = new HfBucketsAccessor({ bucket: 'ns/bucket' })
  const fake = fakeHfOperator(files)
  installFakeOperator(accessor, fake)
  return { accessor, fake }
}

describe('hf rmR', () => {
  it('deletes every key under the prefix and keeps siblings', async () => {
    const { accessor, fake } = accessorWith({
      'data/a.txt': 'a',
      'data/sub/b.txt': 'b',
      'data/sub/deep/c.txt': 'c',
      'other/keep.txt': 'k',
    })
    await rmR(accessor, PathSpec.fromStrPath('/data'))
    expect([...fake.files.keys()]).toEqual(['other/keep.txt'])
  })
})
