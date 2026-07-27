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

import { describe, expect, it } from 'vitest'
import { LinearAccessor } from '../../accessor/linear.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { mountKey } from '../../utils/key_prefix.ts'
import type { LinearTransport } from './_client.ts'
import { readdir } from './readdir.ts'

class NoopTransport implements LinearTransport {
  graphql(): Promise<Record<string, unknown>> {
    throw new Error('should not be called')
  }
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('linear readdir unrecognized paths', () => {
  it('throws ENOENT rather than reporting an empty directory', async () => {
    // Returning [] made `ls` and `tree` report a bogus path as real-but-empty,
    // and left `rg` without a message.
    await expect(
      readdir(
        new LinearAccessor(new NoopTransport()),
        spec('/__nf_missing__'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for an unrecognized nested path', async () => {
    await expect(
      readdir(
        new LinearAccessor(new NoopTransport()),
        spec('/teams/x/nope/deeper'),
        new RAMIndexCacheStore(),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('lists the virtual root without calling the api', async () => {
    const out = await readdir(
      new LinearAccessor(new NoopTransport()),
      spec('/'),
      new RAMIndexCacheStore(),
    )
    expect(out).toEqual(['/teams'])
  })
})
