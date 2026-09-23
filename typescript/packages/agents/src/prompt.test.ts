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
import { OpsRegistry } from '@struktoai/mirage-core/ops/registry'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { MIRAGE_SYSTEM_PROMPT, buildSystemPrompt } from './prompt.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

describe('buildSystemPrompt', () => {
  it('returns base prompt when no options provided', () => {
    expect(buildSystemPrompt()).toBe(MIRAGE_SYSTEM_PROMPT)
  })

  it('appends extraInstructions', () => {
    const out = buildSystemPrompt({ extraInstructions: 'be terse.' })
    expect(out).toContain(MIRAGE_SYSTEM_PROMPT)
    expect(out.endsWith('be terse.')).toBe(true)
  })

  it('formats mountInfo entries', () => {
    const out = buildSystemPrompt({
      mountInfo: { '/': 'In-memory FS', '/s3': 'AWS S3 bucket' },
    })
    expect(out).toContain('Mounted data sources:')
    expect(out).toContain('- / — In-memory FS')
    expect(out).toContain('- /s3 — AWS S3 bucket')
  })

  it('uses workspace.filePrompt when workspace given', () => {
    const ws = mkWs()
    const out = buildSystemPrompt({ workspace: ws })
    expect(out).toContain('Mounted data sources:\n' + ws.filePrompt)
  })

  it('workspace takes precedence over mountInfo', () => {
    const ws = mkWs()
    const out = buildSystemPrompt({
      workspace: ws,
      mountInfo: { '/foo': 'should not appear' },
    })
    expect(out).not.toContain('/foo')
  })

  it('omits mount header when mountInfo is empty', () => {
    expect(buildSystemPrompt({ mountInfo: {} })).toBe(MIRAGE_SYSTEM_PROMPT)
  })

  it('omits empty extraInstructions', () => {
    expect(buildSystemPrompt({ extraInstructions: '' })).toBe(MIRAGE_SYSTEM_PROMPT)
  })
})
