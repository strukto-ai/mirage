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
import { SHELL_SPECS } from '../../../../commands/spec/shell.ts'
import { SHELL_SYNOPSES } from '../../../../commands/spec/synopsis.ts'
import { parseSessionProfile } from '../../../../policy/profile.ts'
import { MountMode } from '../../../../types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { VERSION } from '../../../../version.ts'
import { BASH_BUILTINS } from '../../../lookup/constants.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { OPERAND_HELP } from './constants.ts'
import { TOPICS, fill, topicHelp } from './help.ts'

type Ran = [string, string, number]

async function run(line: string, profiled = false): Promise<Ran> {
  const ws = new Workspace(
    { '/': new RAMVFS() },
    profiled
      ? {
          mode: MountMode.WRITE,
          profiles: { p: parseSessionProfile({ commands: { allow: ['help', 'echo'] } }) },
          profile: 'p',
        }
      : { mode: MountMode.WRITE },
  )
  try {
    const io = await ws.shell(line)
    return [io.stdoutText, io.stderrText, io.exitCode]
  } finally {
    await ws.close()
  }
}

const BUILTIN_TOPICS = Object.keys(SHELL_SYNOPSES)
  .filter((name) => BASH_BUILTINS.has(name) && !OPERAND_HELP.has(name))
  .sort(compareCodePoints)

describe('help', () => {
  it('fills at spaces and after a hyphen inside a word', () => {
    expect(fill('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
    expect(fill('aaaa read-only', 10)).toEqual(['aaaa read-', 'only'])
    expect(fill('aaaa --all', 8)).toEqual(['aaaa', '--all'])
    expect(fill('averyveryverylongword x', 5)).toEqual(['averyveryverylongword', 'x'])
  })

  it('heads the listing with the version and lays out two columns', async () => {
    const [out, err, code] = await run('help')
    expect([err, code]).toEqual(['', 0])
    const lines = out.split('\n')
    expect(lines[0]).toBe(`bash (Mirage) ${VERSION}`)
    expect(lines[1]).toBe('A composable, scriptable and durable virtual terminal for AI agents.')
    expect(lines[5]).toBe('A star (*) next to a name means that this session may not run it.')
    const rows = lines.slice(7, -1)
    expect(rows.length).toBe(Math.floor((TOPICS.length + 1) / 2))
    expect(rows[0]).toBe(`${' (( expression ))'.padEnd(40)} kill [-s sigspec | -n signum | -sigs>`)
    expect(Math.max(...rows.map((row) => row.length))).toBe(78)
  })

  it('cuts a synopsis too long for its column with a mark', async () => {
    const rows = (await run('help'))[0].split('\n').slice(7)
    const left = rows.find((row) => row.startsWith(' declare ')) ?? ''
    expect(left.slice(0, 40)).toBe(' declare [-aAfFgiIlnrtux] [name[=value> ')
    const right = rows.find((row) => row.includes(' read [')) ?? ''
    expect(right.endsWith(' read [-ers] [-a array] [-d delim] [->')).toBe(true)
  })

  it.each([
    ['60', 30],
    ['100x', 50],
    ['7', 40],
    ['abc', 40],
  ])('reads COLUMNS=%s as a leading integer', async (columns, width) => {
    const first = (await run(`COLUMNS='${columns}' help`))[0].split('\n')[7] ?? ''
    expect(first.startsWith(`${' (( expression ))'.padEnd(width)} kill `)).toBe(true)
  })

  it('stars a command the profile refuses', async () => {
    const rows = (await run('help', true))[0].split('\n').slice(7)
    expect(rows.some((row) => row.startsWith(' echo [-neE]'))).toBe(true)
    expect(rows.some((row) => row.startsWith('*cd [-L'))).toBe(true)
    expect(rows.some((row) => row.startsWith(' for NAME'))).toBe(true)
  })

  it('names the exact topic, else prefixes and globs', async () => {
    expect((await run('help -d read'))[0]).toBe('read - Read one line and split it into fields.\n')
    const names = (await run('help -d e'))[0]
      .trimEnd()
      .split('\n')
      .map((line) => line.split(' - ')[0])
    expect(names).toEqual(['echo', 'eval', 'exec', 'exit', 'export'])
    expect((await run("help -s '[['"))[0]).toBe('[[ ... ]]: [[ expression ]]\n')
  })

  it('titles the output when the first pattern is a glob', async () => {
    expect((await run("help -d 'w*' cd"))[0]).toBe(
      "Shell commands matching keywords `w*, cd'\n\n" +
        'wait - Wait for jobs and return their status.\n' +
        'while - Run commands for as long as a condition holds.\n' +
        'cd - Change the working directory.\n',
    )
  })

  it('lets -d win over -m and -m over -s', async () => {
    expect((await run('help -sd wait'))[0].startsWith('wait - ')).toBe(true)
    expect((await run('help -sm wait'))[0].startsWith('NAME\n    wait - ')).toBe(true)
  })

  it('shows a topic as its synopsis and indented help', async () => {
    const out = (await run('help wait'))[0]
    expect(out).toBe(topicHelp('wait'))
    expect(
      out.startsWith(
        'wait: wait [-fn] [-p var] [id ...]\n    Wait for jobs and return their status.\n    \n',
      ),
    ).toBe(true)
    expect(out).toContain('    Options:\n      -f\twait until each ID ends')
    expect(Math.max(...out.split('\n').map((line) => line.length))).toBeLessThanOrEqual(80)
  })

  it('ends the manual layout with the implementation', async () => {
    const out = (await run('help -m wait'))[0]
    expect(
      out.startsWith(
        'NAME\n    wait - Wait for jobs and return their status.\n\n' +
          'SYNOPSIS\n    wait [-fn] [-p var] [id ...]\n\nDESCRIPTION\n',
      ),
    ).toBe(true)
    expect(
      out.endsWith(`SEE ALSO\n    bash(1)\n\nIMPLEMENTATION\n    bash (Mirage) ${VERSION}\n\n`),
    ).toBe(true)
  })

  it('answers no match with status 1 naming the last pattern', async () => {
    expect(await run('help zz yy')).toEqual([
      '',
      "bash: help: no help topics match `yy'.  Try `help help' or `man -k yy' or `info yy'.\n",
      1,
    ])
    expect((await run('help -d wait zz'))[2]).toBe(0)
  })

  it('answers an invalid option with status 2 and the usage', async () => {
    expect(await run('help -x')).toEqual([
      '',
      'bash: help: -x: invalid option\nhelp: usage: help [-dms] [pattern ...]\n',
      2,
    ])
  })

  it('names a raw-byte pattern as typed', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const io = await ws.shell("help $'\\xff'")
      expect(io.exitCode).toBe(1)
      const text =
        "bash: help: no help topics match `\xff'.  Try `help help' or `man -k \xff' or `info \xff'.\n"
      expect(io.stderr).toEqual(Uint8Array.from(text, (ch) => ch.charCodeAt(0)))
    } finally {
      await ws.close()
    }
  })

  it("is the shell's own and no program", async () => {
    expect(await run('which help; echo rc=$?')).toEqual(['rc=1\n', '', 0])
    expect(await run('type -a help')).toEqual(['help is a shell builtin\n', '', 0])
  })

  it('describes every topic with a spec', () => {
    expect(TOPICS).toEqual(Object.keys(SHELL_SYNOPSES).sort(compareCodePoints))
    for (const name of TOPICS) expect(SHELL_SPECS[name]?.description).toBeTruthy()
  })

  it.each(BUILTIN_TOPICS)('answers %s --help with its help', async (name) => {
    expect(await run(`( ${name} --help )`)).toEqual([topicHelp(name), '', 2])
  })

  it.each([
    ['echo --help', ['--help\n', '', 0]],
    ['true --help', ['', '', 0]],
    ['false --help', ['', '', 1]],
    [': --help', ['', '', 0]],
    ['test --help', ['', '', 0]],
  ] as [string, Ran][])('reads %s as an operand', async (line, expected) => {
    expect(await run(line)).toEqual(expected)
  })

  it('reads --help past the first word as an operand', async () => {
    const [out, , code] = await run('wait 99 --help')
    expect(code).not.toBe(2)
    expect(out).not.toContain('Wait for jobs')
  })

  const SKIPPED = new Set([
    'break',
    'continue',
    'exit',
    'return',
    'shift',
    'fg',
    'eval',
    'let',
    'local',
    'source',
    '.',
    'getopts',
    'help',
    'kill',
  ])
  it.each(BUILTIN_TOPICS.filter((name) => !SKIPPED.has(name)))(
    'ends the usage error of %s with its synopsis',
    async (name) => {
      const [, err] = await run(`( ${name} -% )`)
      expect(err).toContain(`${name}: usage: ${SHELL_SYNOPSES[name] ?? ''}`)
    },
  )
})
