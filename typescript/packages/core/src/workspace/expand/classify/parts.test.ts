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
import { OperandKind } from '../../../commands/spec/types.ts'
import type { Resource } from '../../../resource/base.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { MountRegistry } from '../../mount/registry.ts'
import { classifyParts } from './parts.ts'

class StubResource implements Resource {
  readonly kind = 'stub'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

function setup(): MountRegistry {
  return new MountRegistry({ '/ram': new StubResource() }, MountMode.WRITE)
}

describe('classifyParts', () => {
  it('first arg (command name) is never classified', () => {
    const reg = setup()
    const out = classifyParts(['cat', '/ram/x'], reg, '/')
    expect(out[0]).toBe('cat')
    expect(out[1]).toBeInstanceOf(PathSpec)
  })

  it('TEXT kind forces plain-text classification', () => {
    const reg = setup()
    const out = classifyParts(['cat', '/ram/x'], reg, '/', [OperandKind.TEXT])
    expect(out[1]).toBe('/ram/x')
  })

  it('PATH kind forces bare-path classification', () => {
    const reg = setup()
    const out = classifyParts(['cat', 'file.txt'], reg, '/ram', [OperandKind.PATH])
    expect(out[1]).toBeInstanceOf(PathSpec)
  })

  it('duplicate word classifies per slot', () => {
    const reg = setup()
    const out = classifyParts(['grep', '*.txt', '*.txt'], reg, '/ram', [
      OperandKind.TEXT,
      OperandKind.PATH,
    ])
    expect(out[1]).toBe('*.txt')
    expect(out[2]).toBeInstanceOf(PathSpec)
  })

  it('empty parts', () => {
    const reg = setup()
    expect(classifyParts([], reg, '/')).toEqual([])
  })
})
