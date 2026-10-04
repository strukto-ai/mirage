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

import {
  ARGPARSE_EXIT,
  clapMissingOperands,
  clapSupplied,
  gitOptionRefusal,
  gitUsage,
  leafRefusal,
} from './refusal.js'
import { CommandSpec, Operand, Option, UsageStyle } from '../spec/types.js'
import type { ParsedCommand } from '../../workspace/executor/command/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const ARGPARSE_MESSAGE = ENC.encode("gws gmail: unrecognized option '--nosuch'\n")

const SPEC = new CommandSpec({
  options: [
    new Option({ short: '-q', long: '--quiet', description: 'be quiet' }),
    new Option({ long: '--no-quiet', description: 'be loud' }),
    new Option({ short: '-m', type: 'str', metavar: 'msg', description: 'message' }),
    new Option({ long: '--count', type: 'int', description: 'how many' }),
    new Option({ long: '--abbrev', type: 'int', valueOptional: true, description: 'abbreviate' }),
    new Option({ long: '--ignore-unmatch', description: 'exit zero' }),
    new Option({ long: '--no-ignore-unmatch', description: 'fail' }),
    new Option({ short: '-i', long: '--interactive-mode', description: 'too long' }),
  ],
})
const USAGE =
  'usage: git rm [-f | --force] [-r] [--cached] [--ignore-unmatch]\n' +
  '              [--quiet] [--] [<pathspec>...]\n' +
  '\n' +
  '    -q, --[no-]quiet      be quiet\n' +
  '    -m <msg>              message\n' +
  '    --count <count>       how many\n' +
  '    --abbrev[=<abbrev>]   abbreviate\n' +
  '    --[no-]ignore-unmatch exit zero\n' +
  '    -i, --interactive-mode\n' +
  '                          too long\n' +
  '\n'

function refused(
  fields: Partial<
    Pick<
      ParsedCommand,
      'invalidOptions' | 'ambiguousOptions' | 'optionErrorKinds' | 'needsValueOptions'
    >
  > = {},
): Pick<
  ParsedCommand,
  'invalidOptions' | 'ambiguousOptions' | 'optionErrorKinds' | 'needsValueOptions'
> {
  return {
    invalidOptions: [],
    ambiguousOptions: [],
    optionErrorKinds: [],
    needsValueOptions: [],
    ...fields,
  }
}

describe('gitUsage', () => {
  // parse-options' layout, pinned against git 2.47.3: synopsis lines, then the
  // rows with help from column 26, a 25-wide spelling one space short of it
  // and a wider one on a line of its own, and `--[no-]` where git's own table
  // spells the long so.
  it('lays rows out as parse-options does', () => {
    expect(gitUsage('rm', SPEC)).toBe(USAGE)
  })

  // log has no table, and git lists a `--no-` filter like `--no-merges` apart
  // from the option it looks like a negation of.
  it('keeps a negation apart where git does', () => {
    const rows = gitUsage('log', SPEC)
    expect(rows).toContain('    -q, --quiet           be quiet\n')
    expect(rows).toContain('    --no-quiet            be loud\n')
  })

  it('closes a verb without options with a blank line', () => {
    expect(gitUsage('version', new CommandSpec())).toBe('usage: git version\n\n')
  })
})

// Pinned against git 2.50.1: a long option is named without its dashes and a
// short one is a switch, both before the usage block; `-h` puts the usage on
// stdout; a boolean handed a value is refused on one line.
describe('gitOptionRefusal', () => {
  it.each([
    ['--nosuch', ['', `error: unknown option \`nosuch'\n${USAGE}`]],
    ['-Z', ['', `error: unknown switch \`Z'\n${USAGE}`]],
    ['-h', [USAGE, '']],
    ['--quiet=1', ['', "error: option `quiet' takes no value\n"]],
  ])('words %s as parse-options does', (word, streams) => {
    expect(gitOptionRefusal(word, 'rm', SPEC)).toEqual(streams)
  })
})

describe('leafRefusal', () => {
  // parse-options names the last two options an abbreviation matched, each
  // with the `no-` it was matched under, puts the usage on stdout and exits
  // 129 (git 2.50.1).
  it('words an ambiguous abbreviation the way git does', () => {
    const [msg, code, shown] = leafRefusal(
      UsageStyle.GIT,
      ARGPARSE_MESSAGE,
      refused({
        ambiguousOptions: [['--no-m=x', ['--no-merged', '--no-move']]],
        optionErrorKinds: ['ambiguous'],
      }),
      'rm',
      SPEC,
    )
    expect(DEC.decode(msg)).toBe(
      'error: ambiguous option: no-m=x (could be --no-merged or --no-move)\n',
    )
    expect(code).toBe(129)
    expect(DEC.decode(shown ?? new Uint8Array())).toBe(USAGE)
  })

  it('names a short cluster letter the parser reports bare', () => {
    const [msg, code, shown] = leafRefusal(
      UsageStyle.GIT,
      ARGPARSE_MESSAGE,
      refused({ invalidOptions: ['Z'], optionErrorKinds: ['invalid'] }),
      'rm',
      SPEC,
    )
    expect([DEC.decode(msg), code, shown]).toEqual([
      `error: unknown switch \`Z'\n${USAGE}`,
      129,
      null,
    ])
  })

  it.each([
    ['--count', "error: option `count' requires a value\n"],
    ['m', "error: switch `m' requires a value\n"],
  ])('words a missing value on one line: %s', (needy, line) => {
    const [msg, code, shown] = leafRefusal(
      UsageStyle.GIT,
      ARGPARSE_MESSAGE,
      refused({ needsValueOptions: [needy], optionErrorKinds: ['needs_value'] }),
      'rm',
      SPEC,
    )
    expect([DEC.decode(msg), code, shown]).toEqual([line, 129, null])
  })

  it('leaves the default style exactly as it was', () => {
    // Every other installed CLI has to keep argparse's shape and its exit 2:
    // an installed name is not a GNU tool with a pinned exit.
    const [msg, code, shown] = leafRefusal(
      UsageStyle.ARGPARSE,
      ARGPARSE_MESSAGE,
      refused({ invalidOptions: ['--nosuch'], optionErrorKinds: ['invalid'] }),
      'rm',
      SPEC,
    )
    expect([msg, code, shown]).toEqual([ARGPARSE_MESSAGE, ARGPARSE_EXIT, null])
  })

  it('keeps the argparse wording for errors git shares', () => {
    // A refusal git has no wording of its own for keeps the spec machinery's
    // message, and only the exit code moves.
    const [msg, code, shown] = leafRefusal(UsageStyle.GIT, ARGPARSE_MESSAGE, refused(), 'rm', SPEC)
    expect([msg, code, shown]).toEqual([ARGPARSE_MESSAGE, 129, null])
  })
})

// Pinned against the real ntn 0.21.9; integ/ntn_conformance.ts runs the same
// lines through it.
describe('clap refusals', () => {
  it('names the empty slot and echoes what was supplied', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--json', type: 'bool' })],
      positional: [new Operand({ type: 'str', name: 'PAGE_ID', required: true })],
    })
    const msg = clapMissingOperands('ntn pages get', spec, ['PAGE_ID'], ['--json'], {})
    expect(DEC.decode(msg)).toBe(
      'error: the following required arguments were not provided:\n' +
        '  <PAGE_ID>\n\n' +
        'Usage: ntn pages get --json <PAGE_ID>\n\n' +
        "For more information, try '--help'.\n",
    )
  })

  it('echoes typed options in the order they were typed', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--limit', type: 'int' }),
        new Option({ long: '--sort', type: 'str' }),
      ],
    })
    // No metavar declared, so both names derive from the long spelling.
    expect(clapSupplied(spec, ['--limit', '--sort'], {})).toEqual([
      '--limit <LIMIT>',
      '--sort <SORT>',
    ])
    expect(clapSupplied(spec, ['--sort', '--limit'], {})).toEqual([
      '--sort <SORT>',
      '--limit <LIMIT>',
    ])
  })

  it('appends env-sourced options after the typed ones', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--json', type: 'bool' }),
        new Option({
          long: '--notion-version',
          type: 'str',
          metavar: 'VERSION',
          env: 'NOTION_API_VERSION',
        }),
      ],
    })
    const env = { NOTION_API_VERSION: '2025-09-03' }
    expect(clapSupplied(spec, ['--json'], env)).toEqual(['--json', '--notion-version <VERSION>'])
    // Unset, it is simply not supplied.
    expect(clapSupplied(spec, ['--json'], {})).toEqual(['--json'])
  })

  it('omits a merely defaulted option', () => {
    // GNU-style defaults are invisible to clap's usage line: only what the line
    // carried (or an env supplied) is echoed.
    const spec = new CommandSpec({
      options: [new Option({ long: '--limit', type: 'int', default: '25' })],
    })
    expect(clapSupplied(spec, [], {})).toEqual([])
  })

  it('exits 2 like argparse but for its own reason', () => {
    const [msg, code, shown] = leafRefusal(UsageStyle.CLAP, ARGPARSE_MESSAGE, refused(), 'rm', SPEC)
    expect([msg, code, shown]).toEqual([ARGPARSE_MESSAGE, 2, null])
  })
})
