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
import { VFS_MD } from './linear.ts'

describe('VFS_MD', () => {
  it('renders prefix and includes path anatomy + normalized shapes', () => {
    const rendered = VFS_MD.replace(/\{prefix\}/g, '/linear')
    expect(rendered).toContain('`team.json`:')
    expect(rendered).toContain('`issue.json`:')
    expect(rendered).toContain('`comments.jsonl`, one')
    expect(rendered).toContain('A project (`projects/')
    expect(rendered).toContain('A cycle (`cycles/')
    expect(rendered).toContain('A member (`members/')
    expect(rendered).toContain('A document (`documents/')
    expect(rendered).toContain('normalized by Mirage')
    expect(rendered).toContain('.issue_key')
    expect(rendered).toContain('.label_names[]')
    expect(rendered).toContain('linear --help')
  })
})
