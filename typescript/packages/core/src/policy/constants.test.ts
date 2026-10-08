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
import { BaseVFS } from '../vfs/base.ts'
import { callNames, declaredCalls } from '../vfs/call.ts'
import { Effect, Target } from '../vfs/types.ts'
import { METADATA_OPS, SUBTREE_OPS } from './constants.ts'

const CALLS = declaredCalls(BaseVFS)
const sorted = (names: Iterable<string>): string[] => [...names].sort()

describe('policy op tables', () => {
  it('holds the subtree ops the functions declare', () => {
    // A rename and a directory removal take everything under them along;
    // rm_r is the command tier's, which no VFS function declares.
    const declared = [
      ...callNames(CALLS, { effects: [Effect.RENAME] }),
      ...callNames(CALLS, { effects: [Effect.REMOVE], targets: [Target.DIR] }),
    ]
    expect(sorted(SUBTREE_OPS)).toEqual(sorted([...declared, 'rm_r']))
  })

  it('holds the metadata ops the functions declare', () => {
    const declared = callNames(CALLS, { effects: [Effect.METADATA] })
    expect(sorted(METADATA_OPS)).toEqual(sorted([...declared, 'exists']))
  })
})
