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
import { VFS_MD } from './gslides.ts'

describe('VFS_MD', () => {
  it('renders prefix and includes buckets, structure, jq paths', () => {
    const rendered = VFS_MD.replace(/\{prefix\}/g, '/gslides')
    expect(rendered).toContain('owned/')
    expect(rendered).toContain('shared/')
    expect(rendered).toContain('shared with you by others')
    expect(rendered).toContain('still in owned/')
    expect(rendered).toContain('gslide.json structure')
    expect(rendered).toContain('.slides[].pageElements[].shape.text.textElements[].textRun.content')
  })
})

describe('VFS_MD file commands', () => {
  it('documents rm and mv for a write path', () => {
    expect(VFS_MD).toContain('rm {prefix}/owned/<file>.gslide.json')
    expect(VFS_MD).toContain('mv {prefix}/owned/<date>_<old>__<id>.gslide.json')
    expect(VFS_MD).toContain('Delete, on a `write` path:')
    expect(VFS_MD).toContain('Rename to a new title, on a `write` path:')
  })
})
