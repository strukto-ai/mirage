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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Message } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { getOrThrow } from '@earendil-works/pi-durable/env'
import { registerEnvConformance } from '@earendil-works/pi-durable/testing'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import type { MirageRemote } from '@struktoai/mirage-core/remote/client'
import { MirageClient } from '@struktoai/mirage-core/remote/client'
import { AuthMode, buildApp } from '@struktoai/mirage-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MirageExecutionEnv as RootEnv } from '../execution_env.ts'
import { MirageExecutionEnv, mirageExtension } from './index.ts'

const context = BACKGROUND_CONTEXT
const TOKEN = 'pi-remote-env'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const RAM = { mounts: { '/': { vfs: 'ram', mode: 'write' } } }

let root: string
let app: ReturnType<typeof buildApp>
let url: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'pi-remote-env-'))
  app = buildApp({
    stateRoot: join(root, 'state'),
    authConfig: { mode: AuthMode.Local, localToken: TOKEN },
  })
  url = await app.listen({ port: 0, host: '127.0.0.1' })
})

afterAll(async () => {
  await app.close()
  rmSync(root, { recursive: true, force: true })
})

async function workspace(config: Record<string, unknown> = RAM): Promise<MirageRemote> {
  const made = await app.inject({
    method: 'POST',
    url: '/v1/workspaces',
    payload: { config },
    headers: AUTH,
  })
  return { url, workspace: made.json<{ id: string }>().id, token: TOKEN }
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

function text(message: Message | undefined): string {
  if (message === undefined || message.role === 'system') return ''
  const content = message.content
  if (typeof content === 'string') return content
  return content.map((part) => ('text' in part ? part.text : '')).join('')
}

let cases = 0

registerEnvConformance(
  { describe, expect, it },
  'MirageExecutionEnv on a Mirage server',
  async (use) => {
    const remote = await workspace()
    cases += 1
    const cwd = `/case-${String(cases)}`
    await new MirageClient(remote).mkdir(cwd)
    const env = new MirageExecutionEnv(remote, { cwd, watch: { pollIntervalMs: 50 } })
    try {
      await use(env)
    } finally {
      await env.cleanup(context)
    }
  },
)

describe('MirageExecutionEnv on a Mirage server', () => {
  it('writes and runs in the server workspace', async () => {
    const remote = await workspace()
    const env = new MirageExecutionEnv(remote)
    getOrThrow(await env.writeFile('/notes/a.txt', 'hello', context))
    expect(decode(await new MirageClient(remote).read('/notes/a.txt'))).toBe('hello')
    const out: string[] = []
    const result = getOrThrow(
      await env.exec(
        'cat a.txt | wc -c; echo "$GREETING" >&2',
        {
          cwd: '/notes',
          env: { GREETING: "it's here" },
          onOutput: (text) => out.push(text),
        },
        context,
      ),
    )
    expect(result.exitCode).toBe(0)
    expect(out.join('')).toContain('5')
    expect(out.join('')).toContain("it's here")
  })

  it('takes the server config through the root MirageExecutionEnv too', async () => {
    const remote = await workspace()
    const env = new RootEnv(remote)
    getOrThrow(await env.writeFile('/r.txt', 'root', context))
    expect(getOrThrow(await env.readTextFile('/r.txt', context))).toBe('root')
  })

  it('shares one id across environments over one server workspace', async () => {
    const remote = await workspace()
    expect(new MirageExecutionEnv(remote).id).toBe(new MirageExecutionEnv({ ...remote }).id)
  })

  it('streams a file past one read window line by line', async () => {
    const remote = await workspace()
    const env = new MirageExecutionEnv(remote)
    const line = `${'x'.repeat(1023)}\n`
    getOrThrow(await env.writeFile('/big.txt', line.repeat(1500), context))
    const lines = getOrThrow(await env.readTextLines('/big.txt', undefined, context))
    expect(lines).toHaveLength(1500)
    expect(lines[1499]).toBe('x'.repeat(1023))
  })

  it('spills output past its bounds to a file it can read back', async () => {
    const remote = await workspace({ mounts: { '/': { vfs: 'ram', mode: 'write' } } })
    const env = new MirageExecutionEnv(remote)
    const result = getOrThrow(
      await env.exec('seq 1 5000', { spill: { afterBytes: 100, afterLines: 10 } }, context),
    )
    expect(result.spillPath).toBeDefined()
    const spilled = getOrThrow(await env.readTextFile(result.spillPath ?? '', context))
    expect(spilled.split('\n')[4999]).toBe('5000')
  })

  it('refuses to remove or rename a mount root, leaving its files', async () => {
    const remote = await workspace({
      mounts: { '/': { vfs: 'ram', mode: 'write' }, '/data': { vfs: 'ram', mode: 'write' } },
    })
    const env = new MirageExecutionEnv(remote)
    getOrThrow(await env.writeFile('/data/keep.txt', 'k', context))
    const removed = await env.remove('/data', { recursive: true }, context)
    expect(removed.ok).toBe(false)
    const renamed = await env.renameFile('/data', '/moved', context)
    expect(renamed.ok).toBe(false)
    expect(getOrThrow(await env.readTextFile('/data/keep.txt', context))).toBe('k')
  })

  it('acts as a named session, created on first use', async () => {
    const remote = await workspace()
    const env = new MirageExecutionEnv(remote, { sessionId: 'agent' })
    getOrThrow(await env.writeFile('/s.txt', 's', context))
    const sessions = await new MirageClient(remote).sessions()
    expect(sessions.map((s) => s.sessionId)).toContain('agent')
    const again = new MirageExecutionEnv(remote, { sessionId: 'agent' })
    expect(getOrThrow(await again.readTextFile('/s.txt', context))).toBe('s')
  })

  it('times out a command on the server', async () => {
    const env = new MirageExecutionEnv(await workspace())
    const result = await env.exec('sleep 30', { timeout: 0.3 }, context)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('timeout')
  })

  it('runs a Harness with the coding tools on the server workspace', async () => {
    const remote = await workspace({
      mounts: { '/': { vfs: 'ram', mode: 'write' }, '/data': { vfs: 'ram', mode: 'write' } },
    })
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
    registry.install(mirageExtension(remote))
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models,
        registry,
        env: ({ cwd }) => new MirageExecutionEnv(remote, { cwd: cwd ?? '/data' }),
      },
      context,
    )
    try {
      const model = faux.getModel()
      const root = await harness.root(context, {
        agent: { model: { provider: model.provider, modelId: model.id } },
      })
      const submission = await root.submit({ type: 'input', content: 'write the report' }, context)
      expect((await submission.wait(context)).status).toBe('done')
    } finally {
      await harness.close(context)
    }
    expect(decode(await new MirageClient(remote).read('/data/report.md'))).toBe('# Q3\n')
    const system = seen.find((message) => message.role === 'system')
    const prompt = system?.role === 'system' ? system.sections?.mirage : undefined
    expect(prompt).toContain('Mounted data sources')
    expect(prompt).toContain('/data')
    const results = seen.filter((message) => message.role === 'toolResult')
    expect(text(results.at(-1))).toContain('1 report.md')
  })
})
