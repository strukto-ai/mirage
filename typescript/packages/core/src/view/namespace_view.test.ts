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
import { DEFAULT_VISIBILITY, type Visibility } from '../types.ts'
import { namespaceFolders, namespaceStat } from './namespace_view.ts'
import type { NamespaceLinks } from './types.ts'

const PREFIXES = ['/base/', '/base/inner/', '/base/inner/deep/', '/other/', '/']

function links(targets: Record<string, string>): NamespaceLinks {
  return { symlinkTargets: () => new Map(Object.entries(targets)) } as unknown as NamespaceLinks
}

describe('namespaceFolders', () => {
  it('names the mounts and the folders above links, which stat counts as links', () => {
    const table = links({ '/base/lnk': '/other', '/base/up/deep/l': '/other' })
    expect(namespaceFolders(null, PREFIXES, table, '/base')).toEqual(new Set(['inner', 'up']))
    const scoped: Visibility = {
      ...DEFAULT_VISIBILITY,
      paths: { paths: ['/other', '/top/secret'] },
    }
    expect(namespaceFolders(scoped, PREFIXES, null, '/')).toEqual(new Set(['base']))
    expect(namespaceStat(null, PREFIXES, table, '/base')?.nlink).toBe(4)
  })
})
