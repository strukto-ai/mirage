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
import { IOResult } from '../../../io/types.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { PathSpec } from '../../../types.ts'
import { UsageError } from '../../errors.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { searchResources, semanticOptions } from './search.ts'

const path = new PathSpec({ virtual: '/data', directory: '/', vfsPath: '' })

describe('semanticOptions', () => {
  it('defaults the method only when it is absent', () => {
    expect(semanticOptions(new FlagView({}))).toEqual({ method: 'semantic', threshold: 0 })
    expect(() => semanticOptions(new FlagView({ method: '' }))).toThrow(UsageError)
  })
})

describe('searchResources', () => {
  it('ranks every scope in one call and preserves options', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve([
        [
          ['/data/a', 'highest'],
          ['/data/b', 'second'],
        ],
        new IOResult(),
      ]),
    )
    const query = { query: 'question', options: { top_k: 2 } }
    const out = await searchResources(dispatch, [path, path], query)
    expect(new TextDecoder().decode(out)).toBe('highest\nsecond\n')
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith('search', path, [query], { scopes: [path] })
  })

  it('reports a declined query instead of treating it as no matches', async () => {
    await expect(
      searchResources(() => Promise.resolve([null, new IOResult()]), [path], { query: 'query' }),
    ).rejects.toThrow('declined')
  })
})
