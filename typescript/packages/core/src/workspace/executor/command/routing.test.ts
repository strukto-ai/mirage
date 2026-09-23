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

import { cliSpecFor } from '../../../commands/cli/specs.ts'
import { OpsRegistry } from '../../../ops/registry.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { programTokens } from './routing.ts'

describe('programTokens', () => {
  it('walks a CLI verb path and keeps the rest raw', async () => {
    const ram = new RAMVFS()
    const ops = new OpsRegistry()
    ops.registerVfs(ram)
    const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE, ops })
    try {
      ws.registerCli('git', cliSpecFor('git'))
      const reg = ws.registry
      // Options before the verb are not the verb; an alias reads as its
      // canonical name; the leaf's own words follow untouched.
      expect(programTokens(reg, 'git', ['-C', '/r', 'reset', '--hard', 'HEAD'], '/')).toEqual([
        ['git', 'reset', '--hard', 'HEAD'],
        ['git', 'reset'],
      ])
      expect(programTokens(reg, 'git', ['log', '-1'], '/')).toEqual([
        ['git', 'log', '-1'],
        ['git', 'log'],
      ])
      // A walk the tree refuses (unknown verb, bare head) reads raw.
      expect(programTokens(reg, 'git', ['frobnicate', 'x'], '/')).toEqual([
        ['git', 'frobnicate', 'x'],
        ['git'],
      ])
      expect(programTokens(reg, 'git', [], '/')).toEqual([['git'], ['git']])
      // Anything else is the name and the raw argv.
      expect(programTokens(reg, 'rm', ['-rf', '/x'], '/')).toEqual([['rm', '-rf', '/x'], ['rm']])
    } finally {
      await ws.close()
    }
  })
})
