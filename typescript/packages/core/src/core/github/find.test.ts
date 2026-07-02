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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import type { GitHubAccessor } from '../../accessor/github.ts'
import { PathSpec } from '../../types.ts'
import type { TreeEntry } from './tree_entry.ts'
import { find } from './find.ts'

const TREE: Record<string, TreeEntry> = {
  'README.md': { path: 'README.md', type: 'blob', sha: 's1', size: 50 },
  src: { path: 'src', type: 'tree', sha: 's2', size: null },
  'src/main.py': { path: 'src/main.py', type: 'blob', sha: 's3', size: 120 },
  'src/utils': { path: 'src/utils', type: 'tree', sha: 's4', size: null },
  'src/utils/helpers.py': { path: 'src/utils/helpers.py', type: 'blob', sha: 's5', size: 80 },
}

function accessor(): GitHubAccessor {
  return { tree: TREE } as unknown as GitHubAccessor
}

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('github find', () => {
  it('emits the mount root then all entries', async () => {
    expect(await find(accessor(), spec('/github', '/github'))).toEqual([
      '/',
      '/README.md',
      '/src',
      '/src/main.py',
      '/src/utils',
      '/src/utils/helpers.py',
    ])
  })

  it('matches the mount root by its own basename', async () => {
    expect(await find(accessor(), spec('/github', '/github'), { name: 'github' })).toEqual(['/'])
  })

  it('scopes to a subdirectory and emits its root', async () => {
    expect(await find(accessor(), spec('/src'), { type: 'f' })).toEqual([
      '/src/main.py',
      '/src/utils/helpers.py',
    ])
    expect(await find(accessor(), spec('/src'), { type: 'd' })).toEqual(['/src', '/src/utils'])
  })

  it('emits a file start path', async () => {
    expect(await find(accessor(), spec('/src/main.py'))).toEqual(['/src/main.py'])
  })

  it('filters a file start path by size', async () => {
    expect(await find(accessor(), spec('/src/main.py'), { maxSize: 50 })).toEqual([])
    expect(await find(accessor(), spec('/src/main.py'), { minSize: 100 })).toEqual(['/src/main.py'])
  })
})
