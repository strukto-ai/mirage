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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { afterEach, describe, expect, it } from 'vitest'
import plugin, { MirageOpenCodePlugin } from './server.ts'

const tempDirs: string[] = []

function mkTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-opencode-'))
  tempDirs.push(dir)
  return dir
}

function pluginInput(directory: string): PluginInput {
  return { directory } as PluginInput
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('MirageOpenCodePlugin', () => {
  it('loads a workspace config and registers native tools', async () => {
    const dir = mkTempDir()
    writeFileSync(join(dir, 'mirage.yaml'), 'mounts:\n  /:\n    resource: ram\n')

    const hooks = await MirageOpenCodePlugin(pluginInput(dir))

    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      'bash',
      'edit',
      'glob',
      'grep',
      'ls',
      'read',
      'write',
    ])
    await hooks.dispose?.()
  })

  it('exports an OpenCode server plugin module', () => {
    expect(plugin.id).toBe('@struktoai/mirage-opencode')
    expect(plugin.server).toBe(MirageOpenCodePlugin)
  })
})
