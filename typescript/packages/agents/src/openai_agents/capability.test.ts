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
import { run } from '@openai/agents'
import { Capabilities, Manifest, SandboxAgent } from '@openai/agents/sandbox'
import { ScriptedModel, assistantMessage } from '@openai/agents/testing'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { MirageCapability, mirageSession } from './capability.ts'
import { MOUNTS_INTRO, NOT_MIRAGE_SESSION } from './constants.ts'
import { MirageSandboxClient } from './sandbox.ts'

function mkWs(): Workspace {
  return new Workspace(
    { '/': new RAMVFS(), '/data': [new RAMVFS(), MountMode.READ] },
    { mode: MountMode.WRITE },
  )
}

describe('MirageCapability', () => {
  it('lists each mount with its mode', async () => {
    const session = await new MirageSandboxClient(mkWs()).create()
    const text = await new MirageCapability()
      .bind(session)
      .instructions(new Manifest({ root: '/' }))
    expect(text.startsWith(MOUNTS_INTRO)).toBe(true)
    expect(text).toContain('## `/data`\n\nBackend: `ram`. Access: read-only.')
  })

  it('refuses a session from another backend', () => {
    const foreign = { state: { manifest: new Manifest() } }
    expect(() => new MirageCapability().bind(foreign)).toThrow(NOT_MIRAGE_SESSION)
  })

  it('finds the mirage session it was bound to', async () => {
    const client = new MirageSandboxClient(mkWs())
    const session = await client.create()
    expect(mirageSession(session).workspace).toBe(client.workspace)
  })

  it('puts the mounts in the agent prompt', async () => {
    const model = new ScriptedModel([[assistantMessage('ok')]])
    const agent = new SandboxAgent({
      name: 'mounts',
      model,
      capabilities: [...Capabilities.default(), new MirageCapability()],
    })
    await run(agent, 'hi', { sandbox: { client: new MirageSandboxClient(mkWs()) } })
    const prompt = model.calls[0]?.request.systemInstructions ?? ''
    expect(prompt).toContain(MOUNTS_INTRO)
    expect(prompt).toContain('/data')
  })
})
