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

import { readers } from '../../test-utils.ts'
import { DEFAULT_VISIBILITY } from '../../types.ts'
import { classifyPaths } from '../../utils/hidden.ts'

describe('NamespaceReader.hidesUnder', () => {
  it('names a subtree holding a hidden entry', () => {
    const vis = { ...DEFAULT_VISIBILITY, paths: classifyPaths(['/repo/secret.txt']) }
    const reader = readers([], null, vis)('agent')
    expect(reader.hidesUnder('/repo')).toBe(true)
    expect(reader.hidesUnder('/repo/secret.txt')).toBe(true)
    expect(reader.hidesUnder('/other')).toBe(false)
    expect(reader.visible('/repo/secret.txt')).toBe(false)
    expect(reader.visible('/repo/ok.txt')).toBe(true)
  })

  it('is false without hides', () => {
    expect(readers()('agent').hidesUnder('/repo')).toBe(false)
  })
})
