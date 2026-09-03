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
import { skillFor } from '../commands/cli/skill.ts'
import { CLISpec } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { MountMode } from '../types.ts'
import { getTestParser, stderrStr, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  const registry = new OpsRegistry()
  registry.registerResource(r)
  return new Workspace(
    { '/ram/': r },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

async function makeMultiWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ram = new RAMResource()
  ram.store.dirs.add('/')
  ram.store.files.set('/a.txt', new TextEncoder().encode('a\n'))
  const other = new RAMResource()
  other.store.dirs.add('/')
  other.store.files.set('/b.txt', new TextEncoder().encode('b\n'))
  const ro = new RAMResource()
  ro.store.dirs.add('/')
  ro.store.files.set('/c.txt', new TextEncoder().encode('c\n'))
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  registry.registerResource(other)
  registry.registerResource(ro)
  return new Workspace(
    {
      '/ram/': [ram, MountMode.EXEC],
      '/other/': [other, MountMode.EXEC],
      '/ro/': [ro, MountMode.READ],
    },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

async function cliWs(): Promise<Workspace> {
  const ws = await makeWs()
  // The spec's own name, not the installed head word, is what skillFor
  // keys on; "acmeapi" deliberately is not a real skilled CLI's name so
  // this fixture never picks up a real skill body.
  ws.registerCli(
    'linear',
    new CLISpec({
      name: 'acmeapi',
      description: 'Linear API client',
      subcommands: [
        new CLISpec({
          name: 'issue',
          description: 'Manage issues',
          fn: () => [null, new IOResult()],
        }),
        new CLISpec({
          name: 'team',
          description: 'Manage one',
          fn: () => [null, new IOResult()],
        }),
      ],
    }),
  )
  return ws
}

describe('--help and man through the executor', () => {
  it('--help on a builtin renders help text without invoking the handler', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cat --help')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toContain('Usage: cat')
    expect(out).toContain('--help')
  })

  it('--version on a builtin prints Mirage package version', async () => {
    const ws = await makeWs()
    const io = await ws.execute('tsort --version')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })

  it('--version is listed in --help for registered commands', async () => {
    const ws = await makeWs()
    const io = await ws.execute('cat --help')
    expect(stdoutStr(io)).toContain('--version')
  })

  it('--version beats the read-only mount refusal', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('rm --version /ro/c.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toMatch(/^rm \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })

  it('--help beats the read-only mount refusal', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('rm --help /ro/c.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('Usage: rm')
  })

  it('--version beats cross-mount routing', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('cat --version /ram/a.txt /other/b.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toMatch(/^cat \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })

  it('--version does not run a write command', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('rm --version /ram/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(await ws.execute('cat /ram/a.txt'))).toBe('a\n')
  })

  it('--version after the end-of-options marker stays an operand', async () => {
    const ws = await makeMultiWs()
    const io = await ws.execute('grep -- --version /ram/a.txt')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
  })

  it('man <cmd> prints help from the existing handleMan', async () => {
    const ws = await makeWs()
    const io = await ws.execute('man cat')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toContain('cat')
  })

  it('man with no args lists every command by kind of word', async () => {
    const ws = await makeWs()
    const io = await ws.execute('man')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out.startsWith('# commands\n\n')).toBe(true)
    expect(out).toContain('- cat')
    expect(out).toContain('- ls')
    expect(out).not.toContain('# ram')
    expect(out).not.toContain('# general')
  })

  it('man on an unknown command exits 1', async () => {
    const ws = await makeWs()
    const io = await ws.execute('man definitely-not-a-real-command')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('no entry for')
  })

  it('an installed CLI is discoverable from the shell', async () => {
    const ws = await cliWs()
    expect(stdoutStr(await ws.execute('type linear'))).toBe('linear is a mirage CLI\n')
    expect(stdoutStr(await ws.execute('type -t linear'))).toBe('cli\n')
    expect(stdoutStr(await ws.execute('which linear'))).toBe('linear\n')
    expect(stdoutStr(await ws.execute('man linear'))).toContain('Usage: linear')
    expect(stdoutStr(await ws.execute('man'))).toContain('# clis')
  })

  it('man lists only the CLI verbs the profile can reach', async () => {
    const ws = await cliWs()
    ws.createSession('narrow', {
      profile: { commands: { allow: ['man', 'linear issue', 'which'], ask: [], deny: [] } },
    })
    const page = stdoutStr(await ws.execute('man linear', { sessionId: 'narrow' }))
    expect(page).toContain('issue')
    expect(page).not.toContain('team')
    // The head word still routes, because one line of the tree runs.
    expect(stdoutStr(await ws.execute('which linear', { sessionId: 'narrow' }))).toBe('linear\n')
    // A verb the list does not reach has no page.
    const io = await ws.execute('man linear team', { sessionId: 'narrow' })
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toBe('man: no entry for linear team\n')
    // The host's own view is unnarrowed.
    expect(stdoutStr(await ws.execute('man linear'))).toContain('team')
  })

  it('man <cli> leads with the skill body for a skilled CLI', async () => {
    const ws = await makeWs()
    ws.registerCli('ntn', NTN, { apiKey: 'secret_fake' })
    const skill = skillFor('ntn')
    if (skill === null) throw new Error('ntn ships no skill')
    const firstHeading = skill.body.split('\n').find((line) => line.startsWith('#'))
    if (firstHeading === undefined) throw new Error('ntn skill body has no heading')
    const page = stdoutStr(await ws.execute('man ntn'))
    expect(page.startsWith(firstHeading)).toBe(true)
    // The verb listing (the ordinary --help rendering) follows the body.
    expect(page).toContain('Usage: ntn')
  })

  it('man <cli> <verb> carries no skill body', async () => {
    const ws = await makeWs()
    ws.registerCli('ntn', NTN, { apiKey: 'secret_fake' })
    const bodyFirstLine = skillFor('ntn')?.body.split('\n')[0] ?? ''
    expect(bodyFirstLine).not.toBe('')
    const page = stdoutStr(await ws.execute('man ntn pages'))
    expect(page).toContain('Usage: ntn pages')
    expect(page).not.toContain(bodyFirstLine)
  })

  it('which reports a missing name through the status only', async () => {
    const io = await (await cliWs()).execute('which nope-xyz')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
    expect(stderrStr(io)).toBe('')
  })

  it('a shell function shadows a CLI and type -a shows both', async () => {
    const ws = await cliWs()
    const io = await ws.execute('linear() { echo shadowed; }; type -a linear')
    expect(stdoutStr(io)).toBe('linear is a function\nlinear is a mirage CLI\n')
  })

  it('workspace filePrompt mentions --help and man (with and without args)', async () => {
    const ws = await makeWs()
    const prompt = ws.filePrompt
    expect(prompt).toContain('--help')
    expect(prompt).toContain('man <cmd>')
    expect(prompt).toContain('`man`')
  })
})
