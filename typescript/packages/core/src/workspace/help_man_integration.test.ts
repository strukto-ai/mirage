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
import { CLIHandler } from '../commands/cli/types.ts'
import { CommandSpec } from '../commands/spec/types.ts'
import { describe, expect, it } from 'vitest'
import { CLI } from '../commands/cli/types.ts'
import { IOResult } from '../io/types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { stderrStr, stdoutStr } from '../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

function makeWs(): Workspace {
  const r = new RAMVFS()
  r.store.dirs.add('/')
  return new Workspace({ '/ram/': r }, { mode: MountMode.WRITE })
}

function makeMultiWs(): Workspace {
  const ram = new RAMVFS()
  ram.store.dirs.add('/')
  ram.store.files.set('/a.txt', new TextEncoder().encode('a\n'))
  const other = new RAMVFS()
  other.store.dirs.add('/')
  other.store.files.set('/b.txt', new TextEncoder().encode('b\n'))
  const ro = new RAMVFS()
  ro.store.dirs.add('/')
  ro.store.files.set('/c.txt', new TextEncoder().encode('c\n'))
  return new Workspace(
    {
      '/ram/': [ram, MountMode.EXEC],
      '/other/': [other, MountMode.EXEC],
      '/ro/': [ro, MountMode.READ],
    },
    { mode: MountMode.WRITE },
  )
}

function cliWs(): Workspace {
  const ws = makeWs()
  ws.registerCli(
    'linear',
    new CLI({
      spec: new CommandSpec({
        name: 'linear',
        description: 'Linear API client',
        subcommands: [
          new CommandSpec({ name: 'issue', description: 'Manage issues' }),
          new CommandSpec({ name: 'team', description: 'Manage one' }),
        ],
      }),
      handlers: {
        issue: new CLIHandler({ fn: () => [null, new IOResult()] }),
        team: new CLIHandler({ fn: () => [null, new IOResult()] }),
      },
    }),
  )
  return ws
}

describe('--help and man through the executor', () => {
  it('--help on a builtin renders help text without invoking the handler', async () => {
    const ws = makeWs()
    const io = await ws.shell('cat --help')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toContain('Usage: cat')
    expect(out).toContain('--help')
  })

  it('--version on a builtin prints Mirage package version', async () => {
    const ws = makeWs()
    const io = await ws.shell('tsort --version')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })

  it('--version is listed in --help for registered commands', async () => {
    const ws = makeWs()
    const io = await ws.shell('cat --help')
    expect(stdoutStr(io)).toContain('--version')
  })

  it('--version beats the read-only mount refusal', async () => {
    const ws = makeMultiWs()
    const io = await ws.shell('rm --version /ro/c.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toMatch(/^rm \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })

  it('--help beats the read-only mount refusal', async () => {
    const ws = makeMultiWs()
    const io = await ws.shell('rm --help /ro/c.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toContain('Usage: rm')
  })

  it('--version beats cross-mount routing', async () => {
    const ws = makeMultiWs()
    const io = await ws.shell('cat --version /ram/a.txt /other/b.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toMatch(/^cat \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })

  it('--version does not run a write command', async () => {
    const ws = makeMultiWs()
    const io = await ws.shell('rm --version /ram/a.txt')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(await ws.shell('cat /ram/a.txt'))).toBe('a\n')
  })

  it('--version after the end-of-options marker stays an operand', async () => {
    const ws = makeMultiWs()
    const io = await ws.shell('grep -- --version /ram/a.txt')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
  })

  it('man <cmd> prints help from the existing handleMan', async () => {
    const ws = makeWs()
    const io = await ws.shell('man cat')
    const out = stdoutStr(io)
    expect(io.exitCode).toBe(0)
    expect(out).toContain('cat')
  })

  it('man with no page asks for one', async () => {
    const io = await makeWs().shell('man')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toBe("What manual page do you want?\nFor example, try 'man man'.\n")
  })

  it('man -k lists every command', async () => {
    const io = await makeWs().shell('man -k .')
    expect(io.exitCode).toBe(0)
    const names = new Set(
      stdoutStr(io)
        .split('\n')
        .map((line) => line.split(' ', 1)[0]),
    )
    for (const name of ['cat', 'ls', 'cd', 'help']) expect(names.has(name)).toBe(true)
    expect(stdoutStr(io)).not.toContain('RAM')
  })

  it('man documents a wrapper with the page of the program it runs', async () => {
    // Twin of test_a_wrapper_has_the_page_of_the_program_it_runs: Debian
    // links egrep's page to grep's.
    const ws = makeWs()
    const body = async (name: string): Promise<string[]> =>
      stdoutStr(await ws.shell(`man ${name}`))
        .split('\n')
        .slice(4, -2)
    expect(await body('egrep')).toEqual(await body('grep'))
    expect(stdoutStr(await ws.shell('man -k .'))).toContain('\negrep (1) ')
  })

  it('man on an unknown command exits 16', async () => {
    const io = await makeWs().shell('man definitely-not-a-real-command')
    expect(io.exitCode).toBe(16)
    expect(stderrStr(io)).toBe('No manual entry for definitely-not-a-real-command\n')
  })

  it('an installed CLI is discoverable from the shell', async () => {
    const ws = cliWs()
    expect(stdoutStr(await ws.shell('type linear'))).toBe('linear is /usr/bin/linear\n')
    expect(stdoutStr(await ws.shell('type -t linear'))).toBe('file\n')
    expect(stdoutStr(await ws.shell('which linear'))).toBe('/usr/bin/linear\n')
    expect(stdoutStr(await ws.shell('cat /usr/bin/linear'))).toContain('command linear')
    expect(stdoutStr(await ws.shell('man linear'))).toContain('SYNOPSIS\n       linear ')
    expect(stdoutStr(await ws.shell('man -f linear'))).toBe(
      'linear (1)           - Linear API client\n',
    )
  })

  it('man lists every CLI verb whatever the profile', async () => {
    // The allow list refuses a line when it runs; the manual still
    // documents the whole tree.
    const ws = cliWs()
    ws.createSession('narrow', {
      profile: { commands: { allow: ['man', 'linear issue', 'which'], ask: [], deny: [] } },
    })
    const page = stdoutStr(await ws.shell('man linear', { sessionId: 'narrow' }))
    expect(page).toContain('issue')
    expect(page).toContain('team')
    expect((await ws.shell('man linear team', { sessionId: 'narrow' })).exitCode).toBe(0)
  })

  it('which reports a missing name through the status only', async () => {
    const io = await cliWs().shell('which nope-xyz')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
    expect(stderrStr(io)).toBe('')
  })

  it('a shell function shadows a CLI and type -a shows both', async () => {
    const ws = cliWs()
    const io = await ws.shell('linear() { echo shadowed; }; type -a linear')
    expect(stdoutStr(io)).toBe(
      'linear is a function\nlinear () \n{ \n    echo shadowed\n}\nlinear is /usr/bin/linear\n',
    )
  })

  it('workspace vfsMd mentions --help, help and man', async () => {
    const ws = makeWs()
    const prompt = await ws.vfsMd()
    expect(prompt).toContain('--help')
    expect(prompt).toContain('man <cmd>')
    expect(prompt).toContain('`man -k .`')
    expect(prompt).toContain('`help`')
  })
})
