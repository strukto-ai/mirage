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

import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { HfBucket } from '../../../tests/fixtures/hf_bucket.ts'
import { rmR } from './rm.ts'

let origin = ''
const buckets: HfBucket[] = []

beforeAll(async () => {
  origin = await serve('hf')
})

afterEach(async () => {
  await Promise.all(buckets.splice(0).map((bucket) => bucket.close()))
})

describe('hf rmR', () => {
  it('deletes every key under the prefix and keeps siblings', async () => {
    const bucket = new HfBucket(origin)
    buckets.push(bucket)
    await bucket.reset()
    await bucket.put({
      'data/a.txt': 'a',
      'data/sub/b.txt': 'b',
      'data/sub/deep/c.txt': 'c',
      'other/keep.txt': 'k',
    })
    await rmR(bucket.accessor(), PathSpec.fromStrPath('/data'))
    expect(Object.keys(await bucket.files())).toEqual(['other/keep.txt'])
  })
})
