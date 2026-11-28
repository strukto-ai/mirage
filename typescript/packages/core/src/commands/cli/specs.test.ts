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
import { CommandSpec } from '../spec/types.ts'
import { CLIHandler } from './types.ts'

import { describe, expect, it } from 'vitest'

import { IOResult } from '../../io/types.ts'
import { cliSpecFor, knownCliNames, registerCliSpec, unregisterCliSpec } from './specs.ts'
import { CLI } from './types.ts'

// Mirrors python/tests/commands/cli/test_specs.py.

function noop(): [null, IOResult] {
  return [null, new IOResult()]
}

// Each built-in CLI and the `clis/` entry that installs it.
const ENTRIES = [
  ['airtable', 'airtable'],
  ['ast-grep', 'ast_grep'],
  ['discord', 'discord'],
  ['gh', 'gh'],
  ['git', 'git'],
  ['gws', 'gws'],
  ['hf', 'hf'],
  ['himalaya', 'himalaya'],
  ['linear', 'linear'],
  ['ntn', 'ntn'],
  ['office', 'office'],
  ['pdfinfo', 'pdf'],
  ['pdftotext', 'pdf'],
  ['search', 'search'],
  ['slack', 'slack'],
  ['trello', 'trello'],
  ['tvly', 'tvly'],
] as const

function tree(name: string): CLI {
  return new CLI({
    spec: new CommandSpec({ name, subcommands: [new CommandSpec({ name: 'run' })] }),
    handlers: { run: new CLIHandler({ fn: noop }) },
  })
}

describe('cli spec registry', () => {
  // This file imports the registry and nothing else, so no built-in
  // resolves until a test imports its entry: a bundle holds only the CLIs
  // its host installs.
  it('installs no CLI until its clis entry is imported', () => {
    expect(knownCliNames()).toEqual([])
    for (const [name, entry] of ENTRIES) {
      expect(() => cliSpecFor(name)).toThrow(
        `unknown cli '${name}'; import '@struktoai/mirage-core/clis/${entry}' to install it`,
      )
    }
  })

  it('installs a CLI once its clis entry is imported', async () => {
    const { GH } = await import('../../clis/gh.ts')
    const { SLACK } = await import('../../clis/slack.ts')
    expect(cliSpecFor('gh')).toBe(GH)
    expect(cliSpecFor('slack')).toBe(SLACK)
    expect(knownCliNames()).toEqual(['gh', 'slack'])
  })

  it('registers, resolves, and unregisters', () => {
    const spec = tree('spectest')
    registerCliSpec(spec)
    try {
      expect(cliSpecFor('spectest')).toBe(spec)
    } finally {
      unregisterCliSpec('spectest')
    }
    expect(() => cliSpecFor('spectest')).toThrow(/unknown cli 'spectest'/)
  })

  it('refuses duplicate registration', () => {
    registerCliSpec(tree('spectest2'))
    try {
      expect(() => {
        registerCliSpec(tree('spectest2'))
      }).toThrow(/already registered/)
    } finally {
      unregisterCliSpec('spectest2')
    }
  })

  it('unregistering an unknown name throws', () => {
    expect(() => {
      unregisterCliSpec('spectest3')
    }).toThrow(/not registered/)
  })

  it('an unknown key names the known specs', () => {
    expect(() => cliSpecFor('spectest4')).toThrow(/known: /)
  })
})

describe('the mcp name', () => {
  it('is reserved for MCP servers', () => {
    expect(() => {
      registerCliSpec(tree('mcp'))
    }).toThrow(/reserved/)
    expect(() => cliSpecFor('mcp')).toThrow(/mcpCli/)
  })
})
