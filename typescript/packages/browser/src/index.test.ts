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
import * as browserPkg from './index.ts'

describe('@struktoai/mirage-browser barrel exports', () => {
  it('re-exports core symbols', () => {
    expect(browserPkg.MountMode).toBeDefined()
    expect(browserPkg.RAMVFS).toBeDefined()
    expect(browserPkg.BaseVFS).toBeDefined()
    expect(browserPkg.PathSpec).toBeDefined()
  })

  it('exports browser-specific Workspace', () => {
    expect(browserPkg.Workspace).toBeDefined()
    expect(typeof browserPkg.Workspace).toBe('function')
  })

  it('registers E2B only after importing its core subpath', async () => {
    const options = { machines: { box: { provider: 'e2b', sandboxId: 'test' } } }
    expect(browserPkg).not.toHaveProperty('E2BMachine')
    expect(() => new browserPkg.Workspace({}, options)).toThrow(/unknown machine provider: 'e2b'/)
    const { E2BMachine } = await import('@struktoai/mirage-core/machine/e2b/handle')
    const workspace = new browserPkg.Workspace({}, options)
    expect(workspace).toBeInstanceOf(browserPkg.Workspace)
    expect(workspace.machineTable.get('box')).toBeInstanceOf(E2BMachine)
    await workspace.close()
  })

  it('exports OPFSVFS', () => {
    expect(browserPkg.OPFSVFS).toBeDefined()
    expect(typeof browserPkg.OPFSVFS).toBe('function')
  })
})
