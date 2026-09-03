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
import { NTN } from '../commands/cli/builtin/ntn/index.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'

function ramWs(): Workspace {
  const r = new RAMResource()
  r.store.dirs.add('/')
  const registry = new OpsRegistry()
  registry.registerResource(r)
  return new Workspace({ '/': r }, { mode: MountMode.WRITE, ops: registry })
}

describe('filePrompt', () => {
  it('includes mounted resources', () => {
    const prompt = ramWs().filePrompt
    expect(prompt).toContain('/')
    expect(prompt).toContain('In-memory')
  })

  it('lists installed CLIs by their skill description with a man pointer', () => {
    const ws = ramWs()
    ws.registerCli('ntn', NTN, { apiKey: 'secret_fake' })
    const prompt = ws.filePrompt
    expect(prompt).toContain('Installed CLIs')
    expect(prompt).toContain('- ntn — ')
    expect(prompt).toContain('Guide: man ntn')
  })

  it('omits the CLI section when nothing is installed', () => {
    expect(ramWs().filePrompt).not.toContain('Installed CLIs')
  })

  it('lists each install of a shared spec separately with the same description', () => {
    const ws = ramWs()
    ws.registerCli('ntn', NTN, { apiKey: 'secret_fake' })
    ws.registerCli('ntn2', NTN, { apiKey: 'secret_other' })
    const lines = ws.filePrompt.split('\n')
    const descriptionOf = (head: string): string => {
      const line = lines.find((l) => l.startsWith(`- ${head} — `)) ?? ''
      expect(line).not.toBe('')
      const afterDash = line.slice(line.indexOf('—') + 1)
      return afterDash.slice(0, afterDash.indexOf('Guide:'))
    }
    expect(descriptionOf('ntn')).toBe(descriptionOf('ntn2'))
    expect(ws.filePrompt).toContain('Guide: man ntn2')
  })
})
