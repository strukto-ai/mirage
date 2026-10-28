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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CONDITION_SUPPORT as S3_SUPPORT,
  CUSTOM_CONDITION_SUPPORT,
} from '../../core/s3/constants.ts'
import { CONDITION_SUPPORT as BOX_SUPPORT } from '../../core/box/constants.ts'
import { CONDITION_SUPPORT as DROPBOX_SUPPORT } from '../../core/dropbox/constants.ts'
import type { ConditionSupport } from '../../cache/types.ts'

const FIXTURES = new URL('../../../../../../integ/fixtures/write/', import.meta.url)
const CONDITIONS = JSON.parse(readFileSync(new URL('conditions.json', FIXTURES), 'utf-8')) as {
  condition_modes: { vfs: Record<string, ConditionSupport>; 's3+endpoint': ConditionSupport }
}

describe('backend condition declarations', () => {
  it.each([
    ['s3', S3_SUPPORT],
    ['box', BOX_SUPPORT],
    ['dropbox', DROPBOX_SUPPORT],
  ] as const)('matches shared condition modes for %s', (name, support) => {
    expect(support).toEqual(CONDITIONS.condition_modes.vfs[name])
  })
  it('matches custom endpoint condition modes', () => {
    expect(CUSTOM_CONDITION_SUPPORT).toEqual(CONDITIONS.condition_modes['s3+endpoint'])
  })
})
