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
import { CLI, CLIHandler } from '../../../../commands/cli/types.ts'
import { Command } from '../../../../commands/config.ts'
import { Argument, CommandSpec } from '../../../../commands/spec/types.ts'
import { IOResult } from '../../../../io/types.ts'
import { VERSION } from '../../../../version.ts'
import { CLIRegistry } from '../../../cli/registry.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { SessionState } from '../../../session/session.ts'
import { seedVar } from '../../../session/state.ts'
import { findPage, handleMan, renderPage } from './man.ts'

function mkCmd(name: string, spec: CommandSpec): Command {
  return new Command({ name, spec, vfs: 'ram', fn: () => null })
}

interface FakeMount {
  prefix: string
  resolveCommand: (name: string) => Command | null
  allCommands: () => readonly Command[]
}

function mkMount(prefix: string, cmds: Record<string, Command> = {}): FakeMount {
  return {
    prefix,
    resolveCommand: (name) => cmds[name] ?? null,
    allCommands: () => Object.values(cmds),
  }
}

function mkRegistry(mounts: readonly FakeMount[] = []): MountRegistry {
  return { clis: new CLIRegistry(), allMounts: () => mounts } as unknown as MountRegistry
}

function cliRegistry(mounts: readonly FakeMount[] = []): MountRegistry {
  const reg = mkRegistry(mounts)
  reg.clis.install(
    'linear',
    new CLI({
      spec: new CommandSpec({
        name: 'linear',
        description: 'Linear API client',
        subcommands: [
          new CommandSpec({
            name: 'issue',
            description: 'Manage issues',
            aliases: ['i'],
            subcommands: [new CommandSpec({ name: 'create', description: 'Create one' })],
          }),
          new CommandSpec({ name: 'team', description: 'Manage one' }),
        ],
      }),
      handlers: {
        'issue create': new CLIHandler({ fn: () => [null, new IOResult()] }),
        team: new CLIHandler({ fn: () => [null, new IOResult()] }),
      },
    }),
  )
  return reg
}

interface Ran {
  out: string | null
  err: string
  code: number
}

function man(args: string[], reg: MountRegistry, env: Record<string, string> = {}): Ran {
  const session = new SessionState({ sessionId: 's1' })
  for (const [name, value] of Object.entries(env)) seedVar(session, name, value)
  const [out, io] = handleMan(args, reg, session)
  const decoder = new TextDecoder()
  return {
    out: out instanceof Uint8Array ? decoder.decode(out) : null,
    err: io.stderr instanceof Uint8Array ? decoder.decode(io.stderr) : '',
    code: io.exitCode,
  }
}

function header(title: string): string {
  const centered = title.padEnd(28) + 'General Commands Manual'
  return `${centered.padEnd(79 - title.length)}${title}\n`
}

function footer(title: string): string {
  return `${`Mirage ${VERSION}`.padEnd(79 - title.length)}${title}\n`
}

const HINT = "Try 'man --help' or 'man --usage' for more information.\n"

describe('man', () => {
  it('lays a page out as man does', () => {
    const spec = new CommandSpec({
      description: 'Join files.',
      arguments: [
        new Argument(['-n', '--number'], { action: 'store_true', help: 'number lines' }),
        new Argument('-s', { action: 'store_true', help: 'squeeze blanks' }),
      ],
    })
    const ran = man(['cat'], mkRegistry([mkMount('/a/', { cat: mkCmd('cat', spec) })]))
    expect(ran.code).toBe(0)
    expect(ran.out).toBe(
      header('CAT(1)') +
        '\nNAME\n       cat - Join files.\n\n' +
        'SYNOPSIS\n       cat [OPTION]... [FILE]...\n\n' +
        'DESCRIPTION\n       Join files.\n\n' +
        'OPTIONS\n       -n, --number\n              number lines\n\n' +
        '       -s     squeeze blanks\n\n' +
        footer('CAT(1)'),
    )
  })

  it('lists an operand with help of its own', () => {
    const spec = new CommandSpec({
      arguments: [
        new Argument('PATH', { type: 'path', help: 'where to write' }),
        new Argument('rest', { nargs: '*' }),
      ],
    })
    const text = man(['put'], mkRegistry([mkMount('/a/', { put: mkCmd('put', spec) })])).out ?? ''
    expect(text).toContain('OPERANDS\n       PATH   where to write\n\n')
    expect(text.split('OPERANDS')[1]).not.toContain('rest')
  })

  it('names a page without a description alone', () => {
    const page = renderPage({ name: 'bc', summary: '', sections: [['SYNOPSIS', ['bc']]] }, 80)
    expect(page).toContain('\nNAME\n       bc\n\n')
  })

  it('fills the line and breaks after a hyphen', () => {
    const words = `${Array(33).fill('a').join(' ')} read-only word`
    const page = renderPage({ name: 'x', summary: '', sections: [['DESCRIPTION', [words]]] }, 80)
    expect(page).toContain(`       ${Array(33).fill('a').join(' ')} read-\n       only word\n`)
  })

  it('takes the width from MANWIDTH, then COLUMNS', () => {
    const spec = new CommandSpec({ description: 'Join files.' })
    const reg = mkRegistry([mkMount('/a/', { cat: mkCmd('cat', spec) })])
    const narrow = man(['cat'], reg, { MANWIDTH: '60', COLUMNS: '100' }).out ?? ''
    expect(narrow.split('\n')[0]?.length).toBe(59)
    const wide = man(['cat'], reg, { COLUMNS: '100' }).out ?? ''
    expect(wide.split('\n')[0]?.length).toBe(99)
  })

  it('takes the first registration and skips /dev', () => {
    const page = (description: string): Command => mkCmd('cat', new CommandSpec({ description }))
    const reg = mkRegistry([
      mkMount('/dev/', { cat: page('dev') }),
      mkMount('/a/', { cat: page('ram') }),
      mkMount('/b/', { cat: page('s3') }),
    ])
    expect(findPage('cat', reg)?.summary).toBe('ram')
  })

  it('gives a wrapper the page of the program it runs', () => {
    const grep = mkCmd('grep', new CommandSpec({ description: 'Search.' }))
    const reg = mkRegistry([mkMount('/a/', { grep })])
    const page = findPage('egrep', reg)
    expect(page?.name).toBe('egrep')
    expect(page?.sections).toEqual(findPage('grep', reg)?.sections)
  })

  it('makes a builtin page of its help topic', () => {
    const text = man(['wait'], mkRegistry()).out ?? ''
    expect(text.startsWith(header('WAIT(1)'))).toBe(true)
    expect(text).toContain('NAME\n       wait - Wait for jobs and return their status.\n')
    expect(text).toContain('SYNOPSIS\n       wait [-fn] [-p var] [id ...]\n')
    expect(text).toContain('       -n     wait for the next job to end')
    expect(text).toContain('EXIT STATUS\n')
  })

  it('gives bash and sh the bash spec page', () => {
    expect((man(['bash'], mkRegistry()).out ?? '').startsWith(header('BASH(1)'))).toBe(true)
    expect((man(['sh'], mkRegistry()).out ?? '').startsWith('SH(1)')).toBe(true)
    const reg = mkRegistry()
    expect(findPage('sh', reg)?.sections.slice(1)).toEqual(findPage('bash', reg)?.sections.slice(1))
  })

  it('asks which page when none is named', () => {
    expect(man([], mkRegistry())).toEqual({
      out: null,
      err: "What manual page do you want?\nFor example, try 'man man'.\n",
      code: 1,
    })
  })

  it('answers status 16 for a missing page after the pages found', () => {
    const ran = man(['nope', 'wait'], mkRegistry())
    expect(ran.out?.startsWith('WAIT(1)')).toBe(true)
    expect([ran.code, ran.err]).toEqual([16, 'No manual entry for nope\n'])
  })

  it('has no pages in a section other than 1', () => {
    expect(man(['2', 'wait'], mkRegistry())).toEqual({
      out: null,
      err: 'No manual entry for wait in section 2\n',
      code: 16,
    })
    expect(man(['1', 'wait'], mkRegistry()).code).toBe(0)
  })

  it('reads an option after a page as a page', () => {
    expect(man(['wait', '-f'], mkRegistry()).err).toBe('No manual entry for -f\n')
  })

  it('prints the summary lines under -f', () => {
    const ran = man(['-f', 'wait', 'nope', 'cd'], mkRegistry())
    expect(ran).toEqual({
      out:
        'wait (1)             - Wait for jobs and return their status.\n' +
        'cd (1)               - Change the working directory.\n',
      err: 'nope: nothing appropriate.\n',
      code: 0,
    })
    expect(man(['-f', 'nope'], mkRegistry()).code).toBe(16)
  })

  it('searches names and summaries ignoring case under -k', () => {
    const ran = man(['-k', 'JOB'], mkRegistry())
    expect(ran.code).toBe(0)
    const names = (ran.out ?? '')
      .trimEnd()
      .split('\n')
      .map((line) => line.split(' ')[0])
    expect(names).toEqual(['disown', 'fg', 'jobs', 'kill', 'wait'])
    expect(man(['-k', 'zzzz'], mkRegistry()).code).toBe(16)
  })

  it.each([
    [['-x'], "man: invalid option -- 'x'\n"],
    [['--nope'], "man: unrecognized option '--nope'\n"],
    [['--a', 'ls'], "man: option '--a' is ambiguous; possibilities: '--all' '--apropos'\n"],
    [['--whatis=ls'], "man: option '--whatis' doesn't allow an argument\n"],
    [['-fk', 'ls'], 'man: -f -k : incompatible options\n'],
  ])('refuses %j naming the option, with the hint', (args, message) => {
    const ran = man(args, mkRegistry())
    expect([ran.code, ran.err]).toEqual([1, message + HINT])
  })

  it('asks what to look up under a bare -f or -k', () => {
    expect(man(['-f'], mkRegistry()).err).toBe('whatis what?\n')
    expect(man(['-k'], mkRegistry()).err).toBe('apropos what?\n')
  })

  it('answers --help and --usage on stdout', () => {
    const ran = man(['--help'], mkRegistry())
    expect(ran.code).toBe(0)
    expect(
      ran.out?.startsWith(
        'man: Show the manual page of a command.\n\nUsage: man [OPTION...] [SECTION] PAGE...\n',
      ),
    ).toBe(true)
    expect(man(['-?'], mkRegistry()).out).toBe(ran.out)
    expect(man(['-h'], mkRegistry()).out).toBe(ran.out)
    expect(man(['--usage'], mkRegistry()).out).toBe('Usage: man [OPTION...] [SECTION] PAGE...\n')
  })

  it('gives an installed CLI a page with its commands', () => {
    const text = man(['linear'], cliRegistry()).out ?? ''
    expect(text.startsWith(header('LINEAR(1)'))).toBe(true)
    expect(text).toContain('NAME\n       linear - Linear API client\n')
    expect(text).toContain('COMMANDS\n       issue  Manage issues\n\n       team   Manage one\n')
  })

  it('names a subcommand page with hyphens', () => {
    const reg = cliRegistry()
    const text = man(['linear', 'issue', 'create'], reg).out ?? ''
    expect(text.startsWith('LINEAR-ISSUE-CREATE(1)')).toBe(true)
    expect(text).toContain('NAME\n       linear-issue-create - Create one\n')
    expect(man(['linear', 'i', 'create'], reg).out).toBe(text)
    expect(man(['linear-issue-create'], reg).out).toBe(text)
    expect(man(['linear-i-create'], reg).out).toBe(text)
  })

  it('reads words past a CLI path as pages of their own', () => {
    const ran = man(['linear', 'bogus'], cliRegistry())
    expect(ran.out?.startsWith('LINEAR(1)')).toBe(true)
    expect([ran.code, ran.err]).toEqual([16, 'No manual entry for bogus\n'])
  })

  it('puts a CLI before a colliding command, and -a shows both', () => {
    const spec = new CommandSpec({ description: 'mount side' })
    const reg = cliRegistry([mkMount('/ram/', { linear: mkCmd('linear', spec) })])
    const first = man(['linear'], reg).out ?? ''
    expect(first).not.toContain('mount side')
    const both = man(['-a', 'linear'], reg).out ?? ''
    expect(both.startsWith(first)).toBe(true)
    expect(both.slice(first.length)).toContain('mount side')
  })

  it('lists CLI subcommand pages under -k', () => {
    expect(man(['-k', 'create one'], cliRegistry()).out).toBe(
      'linear-issue-create (1) - Create one\n',
    )
  })
})
