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

import { RAMWorkspaceStateStore } from './store/ram.ts'
import { describe, expect, it } from 'vitest'
import { SLACK } from '../commands/cli/builtin/slack/index.ts'
import { SLACK_PROMPT, SLACK_WRITE_PROMPT } from '../resource/slack/prompt.ts'
import { NTN } from '../commands/cli/builtin/ntn/index.ts'
import { skillFor } from '../commands/cli/skill.ts'
import { CLISpec } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

function ramWs(): Workspace {
  const r = new RAMResource()
  r.store.dirs.add('/')
  const registry = new OpsRegistry()
  registry.registerResource(r)
  return new Workspace(
    { '/': r },
    { mode: MountMode.WRITE, ops: registry, shellParserFactory: getTestParser },
  )
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

  it('uses the installed alias guide with a service mount', () => {
    class ChatResource extends RAMResource {
      override readonly prompt: string = SLACK_PROMPT
      readonly writePrompt = SLACK_WRITE_PROMPT
    }
    const ws = new Workspace({ '/customer-chat': new ChatResource() }, { mode: MountMode.WRITE })
    ws.registerCli('slack-customer', SLACK, { token: 'fake' })
    expect(ws.filePrompt).toContain('Guide: man slack-customer')
    expect(ws.filePrompt).not.toMatch(/\bman slack(?=\s|$)/)
  })

  it('omits CLIs hidden from the default session', () => {
    const ws = new Workspace(
      {},
      { profiles: { reader: { commands: { allow: ['man'] } } }, profile: 'reader' },
    )
    ws.registerCli('ntn', NTN, { apiKey: 'fake' })
    expect(ws.filePrompt).not.toContain('Installed CLIs')
    expect(ws.filePrompt).not.toContain('Notion')
  })

  it('omits full descriptions for a restricted CLI', () => {
    const ws = new Workspace(
      {},
      {
        profiles: { reader: { commands: { allow: ['man', 'ntn-prod pages get'] } } },
        profile: 'reader',
      },
    )
    ws.registerCli('ntn', NTN, { apiKey: 'other' })
    ws.registerCli('ntn-prod', NTN, { apiKey: 'fake' })
    expect(ws.filePrompt).not.toContain('- ntn —')
    expect(ws.filePrompt).toContain('Guide: man ntn-prod')
    const skill = skillFor(NTN, 'ntn-prod')
    if (skill === null) throw new Error('ntn ships no skill')
    expect(ws.filePrompt).not.toContain(skill.description)
  })

  it('does not recommend a hidden man command', () => {
    const ws = new Workspace(
      {},
      { profiles: { reader: { commands: { allow: ['ntn'] } } }, profile: 'reader' },
    )
    ws.registerCli('ntn', NTN, { apiKey: 'fake' })
    expect(ws.filePrompt).not.toContain('Guide: man ntn')
    expect(ws.filePrompt).not.toContain('run `man`')
    expect(ws.filePrompt).toContain('Guide: ntn --help')
  })

  it('waits for the persisted default session before listing CLIs', async () => {
    const store = new RAMWorkspaceStateStore()
    const owner = new Workspace(
      {},
      {
        store,
        workspaceId: 'shared',
        profiles: {
          reader: { commands: { allow: ['man', 'ntn-prod pages get'] } },
        },
        profile: 'reader',
      },
    )
    await owner.ensureSessionsLoaded()
    await owner.flushSessions()
    const attached = new Workspace({}, { store, workspaceId: 'shared' })
    attached.registerCli('ntn', NTN, { apiKey: 'other' })
    attached.registerCli('ntn-prod', NTN, { apiKey: 'fake' })
    expect(attached.filePrompt).not.toContain('Installed CLIs')
    await attached.ensureSessionsLoaded()
    expect(attached.defaultSessionId).toBe(owner.defaultSessionId)
    expect(attached.filePrompt).not.toContain('- ntn —')
    expect(attached.filePrompt).toContain('Guide: man ntn-prod')
    const skill = skillFor(NTN, 'ntn-prod')
    if (skill === null) throw new Error('ntn ships no skill')
    expect(attached.filePrompt).not.toContain(skill.description)
    await attached.close()
    await owner.close()
  })

  it.each([
    ['man ls', 'ntn --help'],
    ['man ntn', 'man ntn'],
  ])('checks the exact manual permission %s', async (manual, guide) => {
    const ws = new Workspace(
      {},
      {
        profiles: { reader: { commands: { allow: [manual, 'ntn'] } } },
        profile: 'reader',
        shellParserFactory: getTestParser,
      },
    )
    ws.registerCli('ntn', NTN, { apiKey: 'fake' })
    expect(ws.filePrompt).not.toContain('run `man`')
    expect(ws.filePrompt).toContain(`Guide: ${guide}`)
    const result = await ws.execute(guide)
    expect(result.exitCode).toBe(0)
  })

  it.each(['ntn() { :; }', 'shopt -s expand_aliases\nalias ntn=:'])(
    'omits help for a shadowed CLI: %s',
    async (shadow) => {
      const ws = new Workspace(
        {},
        {
          profiles: { reader: { commands: { allow: ['ntn', 'alias', 'shopt'] } } },
          profile: 'reader',
          shellParserFactory: getTestParser,
        },
      )
      ws.registerCli('ntn', NTN, { apiKey: 'fake' })
      expect((await ws.execute(shadow)).exitCode).toBe(0)
      expect(ws.filePrompt).not.toContain('Guide: ntn --help')
    },
  )

  it('does not recommend an aliased man command', async () => {
    const ws = ramWs()
    ws.registerCli('ntn', NTN, { apiKey: 'fake' })
    expect((await ws.execute('alias man=:')).exitCode).toBe(0)
    expect(ws.filePrompt).toContain('Guide: man ntn')
    expect((await ws.execute('man ntn')).exitCode).toBe(0)
    expect((await ws.execute('shopt -s expand_aliases')).exitCode).toBe(0)
    expect(ws.filePrompt).not.toContain('run `man`')
    expect(ws.filePrompt).not.toContain('Guide: man ntn')
    expect(ws.filePrompt).toContain('Guide: ntn --help')
    expect((await ws.execute('shopt -u expand_aliases')).exitCode).toBe(0)
    expect(ws.filePrompt).toContain('Guide: man ntn')
  })

  it('keeps a custom CLI guide when its spec name matches a builtin', async () => {
    const ws = ramWs()
    ws.registerCli(
      'ntn-custom',
      new CLISpec({
        name: 'ntn',
        description: 'Custom utility',
        fn: () => [null, new IOResult()],
      }),
    )
    expect(ws.filePrompt).toContain('Custom utility')
    expect(ws.filePrompt).not.toContain('Notion')
    const page = await ws.execute('man ntn-custom')
    expect(page.exitCode).toBe(0)
    const text = new TextDecoder().decode(page.stdout)
    expect(text).toContain('Custom utility')
    expect(text).not.toContain('Notion')
  })

  it('lists each install of a shared spec separately, each under its own head', () => {
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
    // One skill, respelled for the head each install answers to.
    expect(descriptionOf('ntn')).toContain('`ntn` CLI')
    expect(descriptionOf('ntn2')).toContain('`ntn2` CLI')
    expect(descriptionOf('ntn').replaceAll('`ntn`', '`ntn2`')).toBe(descriptionOf('ntn2'))
    expect(ws.filePrompt).toContain('Guide: man ntn2')
  })
})
