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
import { renderHelp } from './help.ts'
import { CommandSpec, Option } from './types.ts'

describe('renderHelp', () => {
  it('renders name, description, usage, and flag table', () => {
    const spec = new CommandSpec({
      description: 'Send a thing.',
      options: [
        new Option({ long: '--to', type: 'str', description: 'Recipient' }),
        new Option({ long: '--help', type: 'bool', description: 'Show help' }),
      ] })
    const out = renderHelp('gws thing send', spec)
    expect(out).toContain('gws thing send: Send a thing.')
    expect(out).toContain('Usage: gws thing send [flags]')
    expect(out).toContain('--to <text>')
    expect(out).toContain('Recipient')
    expect(out).toContain('--help')
  })

  it('falls back to bare name when description is null', () => {
    const spec = new CommandSpec({ options: [] })
    const out = renderHelp('foo', spec)
    expect(out.split('\n')[0]).toBe('foo')
  })

  it('trails the epilog after the flag table, one blank line apart', () => {
    const spec = new CommandSpec({
      options: [
        new Option({ long: '--help', type: 'bool', description: 'Show help' }),
      ],
      epilog: 'Services:\n  drive\n' })
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
      options: [
        new Option({
          short: '-C',
          long: '--cwd',
          type: 'str',
          description: 'run as if started there' }),
      ] })
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
