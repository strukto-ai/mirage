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
import * as nodePkg from './index.ts'

describe('@struktoai/mirage-node barrel exports', () => {
  it('re-exports core symbols (Workspace, MountMode, RAMVFS, …)', () => {
    expect(nodePkg.MountMode).toBeDefined()
    expect(nodePkg.RAMVFS).toBeDefined()
    expect(nodePkg.OpsRegistry).toBeDefined()
    expect(nodePkg.PathSpec).toBeDefined()
  })

  it('exports Node-specific Workspace (subclass with lazy parser)', () => {
    expect(nodePkg.Workspace).toBeDefined()
    expect(typeof nodePkg.Workspace).toBe('function')
  })

  it('exports DiskVFS', () => {
    expect(nodePkg.DiskVFS).toBeDefined()
    expect(typeof nodePkg.DiskVFS).toBe('function')
  })

  it('exports DISK_OPS array', () => {
    expect(Array.isArray(nodePkg.DISK_OPS)).toBe(true)
    expect(nodePkg.DISK_OPS.length).toBeGreaterThan(0)
  })

  it('exports DISK_PROMPT string', () => {
    expect(typeof nodePkg.DISK_PROMPT).toBe('string')
  })

  it('exports patchNodeFs function', () => {
    expect(typeof nodePkg.patchNodeFs).toBe('function')
  })

  it('exports Redis VFS and cache stores', () => {
    expect(typeof nodePkg.RedisVFS).toBe('function')
    expect(typeof nodePkg.RedisFileCacheStore).toBe('function')
    expect(typeof nodePkg.RedisIndexCacheStore).toBe('function')
    expect(typeof nodePkg.REDIS_PROMPT).toBe('string')
  })
})
