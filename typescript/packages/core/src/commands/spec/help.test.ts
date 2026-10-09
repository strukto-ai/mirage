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
import { specOf } from './builtins.ts'
import { argparseHelp, optionMetavar, renderHelp } from './help.ts'
import { CommandSpec, Argument, UsageStyle } from './types.ts'

describe('renderHelp', () => {
  it('renders name, description, usage, and flag table', () => {
    const spec = new CommandSpec({
      description: 'Send a thing.',
      arguments: [
        new Argument('--to', { nargs: 3, help: 'Recipient' }),
        new Argument('--files', { type: 'path', nargs: 2, action: 'extend' }),
        new Argument('--inputs', { type: 'path', nargs: 2, action: 'extend', metavar: 'FILE' }),
        new Argument('--labels', { nargs: 2, action: 'extend' }),
        new Argument(['-h', '--help', '--usage'], { action: 'store_true', help: 'Show help' }),
        new Argument('--color', { nargs: '?' }),
        new Argument('--backup', { nargs: '?', attachedOnly: true }),
        new Argument('RECIPIENT', { help: 'Who receives the message' }),
        new Argument('FILE', { type: 'path', nargs: '?', help: 'Message to send' }),
        new Argument('BACKUP', { type: 'path', nargs: '?' }),
        new Argument('WORDS', { nargs: '*', help: 'Additional words' }),
      ],
    })
    const out = renderHelp('gws thing send', spec)
    expect(out).toContain('gws thing send: Send a thing.')
    expect(out).toContain('Usage: gws thing send [flags]')
    expect(out).toContain('--to <text> <text> <text>')
    expect(out).toContain('Recipient')
    expect(out).toContain('-h, --help, --usage')
    const help = argparseHelp('gws thing send', spec)
    expect(help).toContain('--to TO TO TO')
    expect(help).toContain('--color [COLOR]')
    expect(help).toContain('--backup[=BACKUP]')
    expect(help).toContain('  RECIPIENT  Who receives the message\n')
    expect(help).toContain('  FILE       Message to send\n')
    expect(help).toContain('  BACKUP     Virtual path\n')
    expect(help).toContain('  WORDS      Additional words\n')
    for (const style of Object.values(UsageStyle)) {
      const helpText = renderHelp('gws thing send', spec, [], style)
      expect(helpText).toContain('Arguments:\n')
      expect(helpText).toContain('  <RECIPIENT>  Who receives the message\n')
      expect(helpText).toContain('  <FILE>       Message to send\n')
      expect(helpText).toContain('  <WORDS>      Additional words\n')
    }
    for (const [flag, generic, named] of [
      ['--files', '<path> <path>', 'FILES FILES'],
      ['--inputs', '<FILE> <FILE>', 'FILE FILE'],
      ['--labels', '<text> <text>', 'LABELS LABELS'],
    ] as const) {
      expect(out).toContain(`${flag} ${generic}`)
      expect(help).toContain(`${flag} ${named}`)
    }
    const jq = specOf('jq')
    for (const [flag, value] of [
      ['--arg', 'text'],
      ['--argjson', 'text'],
      ['--rawfile', 'path'],
      ['--slurpfile', 'path'],
    ] as const) {
      expect(renderHelp('jq', jq)).toContain(`${flag} <name> <${value}>`)
      expect(argparseHelp('jq', jq)).toContain(`${flag} NAME ${flag.slice(2).toUpperCase()}`)
    }
  })

  it('falls back to bare name when description is null', () => {
    const spec = new CommandSpec({ arguments: [] })
    const out = renderHelp('foo', spec)
    expect(out.split('\n')[0]).toBe('foo')
  })

  it('trails the epilog after the flag table, one blank line apart', () => {
    const spec = new CommandSpec({
      arguments: [new Argument('--help', { action: 'store_true', help: 'Show help' })],
      epilog: 'Services:\n  drive\n',
    })
    const out = renderHelp('gws', spec)
    expect(out.endsWith('\n  --help  Show help\n\nServices:\n  drive\n')).toBe(true)
  })

  it('omits the epilog when absent', () => {
    expect(renderHelp('foo', new CommandSpec())).toBe('foo\n\nUsage: foo\n')
  })

  it('trims a long run of trailing newlines in linear time', () => {
    const spec = new CommandSpec({ epilog: 'Services:' + '\n'.repeat(100_000) })
    const started = performance.now()
    const out = renderHelp('gws', spec)
    expect(out).toBe('gws\n\nUsage: gws\n\nServices:\n')
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('renderHelp with subcommands', () => {
  it('lists commands after the usage line', () => {
    const spec = new CommandSpec({
      description: 'Google Workspace',
      arguments: [new Argument(['-C', '--cwd'], { help: 'run as if started there' })],
    })
    const rows: [string, string][] = [
      ['gmail', 'Gmail messages\nlong tail ignored'],
      ['docs', ''],
    ]
    expect(renderHelp('gws', spec, rows)).toBe(
      'gws: Google Workspace\n' +
        '\n' +
        'Usage: gws [flags] <command> [<args>]\n' +
        '\n' +
        'Commands:\n' +
        '  docs\n' +
        '  gmail  Gmail messages\n' +
        '\n' +
        'Flags:\n' +
        '  -C, --cwd <text>  run as if started there\n',
    )
  })

  it('renders the minimal group shape', () => {
    expect(renderHelp('tool', new CommandSpec({}), [['run', '']])).toBe(
      'tool\n' + '\n' + 'Usage: tool <command> [<args>]\n' + '\n' + 'Commands:\n' + '  run\n',
    )
  })
})

// Pinned against the real ntn 0.21.9's own --help.
describe('renderHelp in clap style', () => {
  it('heads the page with a bare description', () => {
    const spec = new CommandSpec({ description: 'Manage pages' })
    expect(renderHelp('ntn pages', spec).split('\n')[0]).toBe('ntn pages: Manage pages')
    expect(renderHelp('ntn pages', spec, [], UsageStyle.CLAP).split('\n')[0]).toBe('Manage pages')
  })

  it('spells options and command its own way', () => {
    const spec = new CommandSpec({
      description: 'Manage pages',
      arguments: [new Argument('--json', { action: 'store_true' })],
    })
    const rows: [string, string][] = [['get', 'Retrieve a page']]
    expect(renderHelp('ntn pages', spec, rows, UsageStyle.CLAP)).toContain(
      'Usage: ntn pages [OPTIONS] <COMMAND>',
    )
    expect(renderHelp('ntn pages', spec, rows)).toContain(
      'Usage: ntn pages [flags] <command> [<args>]',
    )
  })

  it('names operand slots and marks optional ones', () => {
    const spec = new CommandSpec({
      description: 'Retrieve a page',
      arguments: [new Argument('PAGE_ID')],
    })
    expect(renderHelp('ntn pages get', spec, [], UsageStyle.CLAP)).toContain(
      'Usage: ntn pages get <PAGE_ID>',
    )
    const loose = new CommandSpec({
      description: 'Call the API',
      arguments: [new Argument('PATH', { nargs: '*' })],
    })
    expect(renderHelp('ntn api', loose, [], UsageStyle.CLAP)).toContain('Usage: ntn api [PATH]...')
  })

  it('keeps subcommands in declaration order', () => {
    // An author's ordering carries information an alphabet loses, and clap
    // preserves it; every other style sorts.
    const spec = new CommandSpec({ description: 'Manage pages' })
    const rows: [string, string][] = [
      ['get', 'one'],
      ['create', 'two'],
      ['edit', 'three'],
    ]
    const listed = (text: string): string[] =>
      text
        .split('\n')
        .filter((line) => line.startsWith('  '))
        .map((line) => line.trim().split(' ')[0] ?? '')
    expect(listed(renderHelp('ntn pages', spec, rows, UsageStyle.CLAP))).toEqual([
      'get',
      'create',
      'edit',
    ])
    expect(listed(renderHelp('ntn pages', spec, rows))).toEqual(['create', 'edit', 'get'])
  })

  it('heads the option list Options: not Flags:', () => {
    const spec = new CommandSpec({
      description: 'x',
      arguments: [new Argument('--json', { action: 'store_true' })],
    })
    expect(renderHelp('ntn whoami', spec, [], UsageStyle.CLAP)).toContain('Options:')
    expect(renderHelp('ntn whoami', spec)).toContain('Flags:')
  })
})

describe('optionMetavar', () => {
  it('derives from the long spelling', () => {
    const option = new Argument('--start-cursor')
    expect(optionMetavar(option)).toBe('START_CURSOR')
  })

  it('prefers a declared name, which is the only reason the field exists', () => {
    const declared = new Argument('--notion-version', { metavar: 'VERSION' })
    expect(optionMetavar(declared)).toBe('VERSION')
  })
})
