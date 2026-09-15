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
    expect(browserPkg.RAMResource).toBeDefined()
    expect(browserPkg.OpsRegistry).toBeDefined()
    expect(browserPkg.PathSpec).toBeDefined()
  })

  it('exports browser-specific Workspace', () => {
    expect(browserPkg.Workspace).toBeDefined()
    expect(typeof browserPkg.Workspace).toBe('function')
  })

  it('registers E2B only after importing its core subpath', async () => {
    expect(browserPkg).not.toHaveProperty('E2BRuntime')
    expect(browserPkg.knownRuntimes()).not.toContain('e2b')
    const { E2BRuntime } = await import('@struktoai/mirage-core/runtime/sandbox/e2b/runtime')
    expect(browserPkg.knownRuntimes()).toContain('e2b')
    const workspace = new browserPkg.Workspace(
      {},
      {
        runtimes: [new E2BRuntime({ captures: ['python3'], config: { sandboxId: 'test' } }), 'vfs'],
      },
    )
    expect(workspace).toBeInstanceOf(browserPkg.Workspace)
    await workspace.close()
  })

  it('exports OPFSResource', () => {
    expect(browserPkg.OPFSResource).toBeDefined()
    expect(typeof browserPkg.OPFSResource).toBe('function')
  })

  it('exports OPFS_OPS array', () => {
    expect(Array.isArray(browserPkg.OPFS_OPS)).toBe(true)
    expect(browserPkg.OPFS_OPS.length).toBeGreaterThan(0)
  })

  it('exports OPFS_PROMPT string', () => {
    expect(typeof browserPkg.OPFS_PROMPT).toBe('string')
  })
})
