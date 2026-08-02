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
import { OperandKind, Option } from '../spec/types.ts'
import { renderGroupHelp } from './help.ts'
import { CLISpec, type CLIVerbFn } from './types.ts'

const verb: CLIVerbFn = () => null

describe('renderGroupHelp', () => {
  it('renders the full shape', () => {
    const node = new CLISpec({
      name: 'gws',
      description: 'Google Workspace',
      options: [
        new Option({
          short: '-C',
          long: '--cwd',
          valueKind: OperandKind.TEXT,
          description: 'run as if started there',
        }),
      ],
      subcommands: [
        new CLISpec({
          name: 'gmail',
          description: 'Gmail messages\nlong tail ignored',
          subcommands: [new CLISpec({ name: 'send', fn: verb })],
        }),
        new CLISpec({ name: 'docs', subcommands: [new CLISpec({ name: 'cat', fn: verb })] }),
      ],
    })
    expect(renderGroupHelp('gws', node)).toBe(
      'usage: gws [<options>] <command> [<args>]\n' +
        '\n' +
        'Google Workspace\n' +
        '\n' +
        'Commands:\n' +
        '  docs\n' +
        '  gmail  Gmail messages\n' +
        '\n' +
        'Flags:\n' +
        '  -C, --cwd <text>  run as if started there\n',
    )
  })

  it('renders the minimal shape', () => {
    const node = new CLISpec({
      name: 'tool',
      subcommands: [new CLISpec({ name: 'run', fn: verb })],
    })
    expect(renderGroupHelp('tool', node)).toBe(
      'usage: tool <command> [<args>]\n' + '\n' + 'Commands:\n' + '  run\n',
    )
  })
})
