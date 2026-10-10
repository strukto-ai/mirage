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
import { makeFilename } from './slide_entry.ts'

describe('gslides presentation filenames', () => {
  it('leads with the date when there is one', () => {
    expect(makeFilename('My Presentation', 'abc123', '2026-03-15T10:00:00Z')).toBe(
      '2026-03-15_My_Presentation__abc123.gslide.json',
    )
    expect(makeFilename('My Presentation', 'abc123')).toBe('My_Presentation__abc123.gslide.json')
  })
})
