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
import { Argument, CommandSpec } from '../spec/types.ts'
import type { ParsedArgs } from '../spec/parser.ts'
import {
  cobraRefusal,
  cobraUsage,
  groupMessage,
  leafMessage,
  setsValueFlag,
  unknownCommand,
} from './cobra.ts'

const BOOLEAN = ['true', 'false']

function flag(names: string[], help: string): Argument {
  return new Argument(names, {
    nargs: '?',
    attachedOnly: true,
    shortValue: false,
    choices: BOOLEAN,
    help,
  })
}

const LEAF = new CommandSpec({
  name: 'list',
  arguments: [
    new Argument(['-R', '--repo'], { help: 'Select another repository' }),
    new Argument('--json', { metavar: 'fields', help: 'Output JSON' }),
    new Argument(['-L', '--limit'], { type: 'int', default: '30', help: 'Maximum items' }),
    new Argument(['-s', '--state'], {
      choices: ['open', 'all'],
      default: 'open',
      help: 'Filter by state',
    }),
    new Argument(['-l', '--label'], { action: 'append', help: 'Filter by label' }),
    flag(['-d', '--draft'], 'Filter by draft'),
    flag(['--confirm'], 'Deprecated: use --yes instead'),
  ],
})

function refused(reports: Record<string, unknown>): ParsedArgs {
  return reports as unknown as ParsedArgs
}

describe('cobraUsage', () => {
  it("lists a leaf's own flags as pflag aligns them", () => {
    expect(cobraUsage('gh pr list', LEAF)).toBe(
      'Usage:  gh pr list [flags]\n\n' +
        'Flags:\n' +
        '  -d, --draft           Filter by draft\n' +
        '      --json fields     Output JSON\n' +
        '  -l, --label strings   Filter by label\n' +
        '  -L, --limit int       Maximum items (default 30)\n' +
        '  -s, --state string    Filter by state: {open|all} (default "open")\n' +
        '  \n',
    )
  })

  it("treats a repo flag with a value name as the command's own", () => {
    const node = new CommandSpec({
      name: 'rename',
      arguments: [
        new Argument('NAME', { metavar: '[<new-name>]' }),
        new Argument(['-R', '--repo'], { metavar: 'OWNER/REPO', help: 'Select' }),
      ],
    })
    expect(cobraUsage('gh repo rename', node)).toBe(
      'Usage:  gh repo rename [<new-name>] [flags]\n\n' +
        'Flags:\n' +
        '  -R, --repo OWNER/REPO   Select\n' +
        '  \n',
    )
  })

  it('dedents a table of long flags only', () => {
    const node = new CommandSpec({ name: 'delete', arguments: [flag(['--yes'], 'Confirm')] })
    expect(cobraUsage('gh label delete', node).endsWith('Flags:\n  --yes   Confirm\n  \n')).toBe(
      true,
    )
  })

  it('renders a leaf with no flags on one line', () => {
    expect(cobraUsage('gh version', new CommandSpec({ name: 'version' }))).toBe(
      'Usage:  gh version [flags]\n',
    )
  })

  it('lists a group commands sorted', () => {
    const node = new CommandSpec({
      name: 'pr',
      subcommands: [new CommandSpec({ name: 'view' }), new CommandSpec({ name: 'list' })],
    })
    expect(cobraUsage('gh pr', node)).toBe(
      'Usage:  gh pr <command> [flags]\n\nAvailable commands:\n  list\n  view\n\n',
    )
  })

  it('names two slots at the root', () => {
    const node = new CommandSpec({ name: 'gh', subcommands: [new CommandSpec({ name: 'pr' })] })
    expect(cobraUsage('gh', node).startsWith('Usage:  gh <command> <subcommand> [flags]\n')).toBe(
      true,
    )
  })

  it('omits flags from a use line that carries git flags', () => {
    const node = new CommandSpec({
      name: 'clone',
      arguments: [new Argument('GIST', { metavar: '<gist>' })],
    })
    expect(cobraUsage('gh gist clone', node)).toBe('Usage:  gh gist clone <gist>\n')
  })
})

describe('cobraRefusal', () => {
  it('keeps one blank line before the block', () => {
    const node = new CommandSpec({ name: 'version' })
    const block = 'Usage:  gh version [flags]\n'
    expect(cobraRefusal('no', 'gh version', node)).toBe(`no\n\n${block}`)
    expect(cobraRefusal('no\n', 'gh version', node)).toBe(`no\n\n${block}`)
  })
})

describe('leafMessage', () => {
  it('drops the value of an unknown long flag', () => {
    const parsed = refused({ optionErrorKinds: ['invalid'], invalidOptions: ['--nope=2'] })
    expect(leafMessage(parsed, LEAF, ['--nope=2'], 'pr list')).toBe('unknown flag: --nope')
  })

  it('names the rest of the cluster of an unknown short flag', () => {
    const parsed = refused({ optionErrorKinds: ['invalid'], invalidOptions: ['x'] })
    expect(leafMessage(parsed, LEAF, ['-xd'], 'pr list')).toBe("unknown shorthand flag: 'x' in -xd")
  })

  it('words a flag short of its value', () => {
    const long = refused({ optionErrorKinds: ['needs_value'], needsValueOptions: ['--limit'] })
    const short = refused({ optionErrorKinds: ['needs_value'], needsValueOptions: ['L'] })
    expect(leafMessage(long, LEAF, ['--limit'], 'pr list')).toBe('flag needs an argument: --limit')
    expect(leafMessage(short, LEAF, ['-L'], 'pr list')).toBe("flag needs an argument: 'L' in -L")
  })

  it("refuses a value in its type's words", () => {
    const number = refused({ optionErrorKinds: ['int'], invalidIntOptions: [['--limit', 'x']] })
    const choice = refused({
      optionErrorKinds: ['value'],
      invalidValueOptions: [['--state', 'x', []]],
    })
    const toggle = refused({
      optionErrorKinds: ['value'],
      invalidValueOptions: [['--draft', 'x', []]],
    })
    expect(leafMessage(number, LEAF, [], 'pr list')).toBe(
      'invalid argument "x" for "-L, --limit" flag: strconv.ParseInt: parsing "x": invalid syntax',
    )
    expect(leafMessage(choice, LEAF, [], 'pr list')).toBe(
      'invalid argument "x" for "-s, --state" flag: valid values are {open|all}',
    )
    expect(leafMessage(toggle, LEAF, [], 'pr list')).toBe(
      'invalid argument "x" for "-d, --draft" flag: strconv.ParseBool: parsing "x": invalid syntax',
    )
  })

  it('adds the hint of a clone verb', () => {
    const parsed = refused({ optionErrorKinds: ['invalid'], invalidOptions: ['--nope'] })
    expect(leafMessage(parsed, LEAF, [], 'repo clone')).toBe(
      "unknown flag: --nope\nSeparate git clone flags with '--'.",
    )
    expect(leafMessage(parsed, LEAF, [], 'repo fork')).toBe(
      'unknown flag: --nope\nSeparate git clone flags with `--`.',
    )
  })

  it('has no message for a parse with no option error', () => {
    expect(leafMessage(refused({ optionErrorKinds: [] }), LEAF, [], 'pr list')).toBeNull()
  })
})

describe('groupMessage', () => {
  it("words a group's refusals as pflag does", () => {
    expect(groupMessage('unknown option: --x', '--x')).toBe('unknown flag: --x')
    expect(groupMessage('unknown option: -x', undefined)).toBe("unknown shorthand flag: 'x' in -x")
    expect(groupMessage("error: option '--x' requires a value", undefined)).toBe(
      'flag needs an argument: --x',
    )
    expect(groupMessage('error: other', undefined)).toBe('error: other')
  })
})

describe('unknownCommand', () => {
  it('suggests a near or longer name', () => {
    const node = new CommandSpec({
      name: 'pr',
      subcommands: [new CommandSpec({ name: 'list' }), new CommandSpec({ name: 'merge' })],
    })
    expect(unknownCommand('lisst', 'gh pr', node)).toBe(
      'unknown command "lisst" for "gh pr"\n\nDid you mean this?\n\tlist\n',
    )
    expect(unknownCommand('zzzzzz', 'gh pr', node)).toBe('unknown command "zzzzzz" for "gh pr"')
    expect(unknownCommand('mer', 'gh pr', node)).toContain('\tmerge\n')
  })
})

describe('setsValueFlag', () => {
  it('ignores switches and what follows a dash dash', () => {
    expect(setsValueFlag(LEAF, ['--limit', '3'])).toBe(true)
    expect(setsValueFlag(LEAF, ['--limit=3'])).toBe(true)
    expect(setsValueFlag(LEAF, ['-L3'])).toBe(true)
    expect(setsValueFlag(LEAF, ['--draft', 'a'])).toBe(false)
    expect(setsValueFlag(LEAF, ['--', '--limit'])).toBe(false)
  })
})
