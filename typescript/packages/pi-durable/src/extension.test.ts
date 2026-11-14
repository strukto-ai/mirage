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

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { Message } from '@earendil-works/pi-ai'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-node'
import { describe, expect, it } from 'vitest'
import { MirageExecutionEnv } from './env.ts'
import { mirageExtension } from './extension.ts'

const context = BACKGROUND_CONTEXT

function text(message: Message | undefined): string {
  if (message === undefined || message.role === 'system') return ''
  const content = message.content
  if (typeof content === 'string') return content
  return content.map((part) => ('text' in part ? part.text : '')).join('')
}

describe('a Harness on a Mirage workspace', () => {
  it('runs the coding tools against the mounts and describes them in the prompt', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS(), '/': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    let seen: Message[] = []
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'report.md', content: '# Q3\n' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxToolCall('bash', { command: 'ls /data && wc -l report.md' }), {
        stopReason: 'toolUse',
      }),
      (transcript) => {
        seen = transcript.messages
        return fauxAssistantMessage('done')
      },
    ])
    const registry = createRegistry()
    registry.install(CodingTools)
    registry.install(mirageExtension(ws))
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry, env: ({ cwd }) => new MirageExecutionEnv(ws, { cwd: cwd ?? '/data' }) },
      context,
    )
    try {
      const model = faux.getModel()
      const root = await harness.root(context, {
        agent: { model: { provider: model.provider, modelId: model.id } },
      })
      const submission = await root.submit({ type: 'input', content: 'write the report' }, context)
      const settled = await submission.wait(context)
      expect(settled.status).toBe('done')
    } finally {
      await harness.close(context)
    }

    expect(new TextDecoder().decode(await ws.vfs.read('/data/report.md'))).toBe('# Q3\n')
    const system = seen.find((message) => message.role === 'system')
    expect(system?.role === 'system' ? system.sections?.mirage : undefined).toContain(
      'Mounted data sources',
    )
    const results = seen.filter((message) => message.role === 'toolResult')
    expect(text(results.at(-1))).toContain('report.md')
    expect(text(results.at(-1))).toContain('1 report.md')
  })
})
