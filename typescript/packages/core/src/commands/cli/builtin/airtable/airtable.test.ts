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

import { compileSpec } from '../../../spec/compile.ts'
import type { CommandSpec } from '../../../spec/types.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AirtableConfigSchema } from '../../../../core/airtable/config.ts'
import {
  FEATURES,
  FakeAirtable,
  OPS,
  ROADMAP,
  TOKEN,
} from '../../../../core/airtable/_test_util.ts'
import { getTestParser } from '../../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { UsageStyle } from '../../../spec/types.ts'
import { cliSpecFor } from '../../specs.ts'
import { AIRTABLE } from './index.ts'

// Mirrors python/tests/commands/cli/builtin/airtable/test_tree.py.

const DEC = new TextDecoder()

const VERBS = {
  base: ['list', 'get'],
  table: ['get'],
  record: ['list', 'get', 'create', 'update', 'delete'],
  comment: ['list', 'add'],
} satisfies Record<string, string[]>

const WRITES = new Set(['record create', 'record update', 'record delete', 'comment add'])

const HELP = `usage: airtable [-h] {base,table,record,comment} ...

Airtable Web API client

commands:
  base     Read bases
  table    Read table schemas
  record   Read and write records
  comment  Read and add record comments

options:
  -h, --help  Show this help and exit
`

function leaf(...path: string[]): CommandSpec {
  let node = AIRTABLE.spec
  for (const name of path) {
    const child = node.subcommands.find((c) => c.name === name)
    if (child === undefined) throw new Error(`no subcommand ${name}`)
    node = child
  }
  return node
}

async function shell(line: string): Promise<[number, string, string]> {
  vi.stubGlobal('fetch', new FakeAirtable().fetch)
  const ws = new Workspace({}, { shellParser: await getTestParser() })
  ws.registerCli('airtable', AIRTABLE, { token: TOKEN, requests_per_second: 10_000 })
  try {
    const io = await ws.shell(line)
    return [io.exitCode, DEC.decode(io.stdout), DEC.decode(io.stderr)]
  } finally {
    await ws.close()
  }
}

describe('airtable tree', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is registered under its name', () => {
    expect(cliSpecFor('airtable')).toBe(AIRTABLE)
    expect(AIRTABLE.configModel).toBe(AirtableConfigSchema)
    expect(AIRTABLE.spec.usageStyle).toBe(UsageStyle.ARGPARSE)
    expect(
      Object.fromEntries(
        AIRTABLE.spec.subcommands.map((g) => [g.name, g.subcommands.map((v) => v.name)]),
      ),
    ).toEqual(VERBS)
  })

  it('classifies only the writers as writes', () => {
    for (const [noun, verbs] of Object.entries(VERBS)) {
      for (const verb of verbs)
        expect(AIRTABLE.handlers[[noun, verb].join(' ')]?.write).toBe(WRITES.has(`${noun} ${verb}`))
    }
  })

  it('names the base and the table on every verb below a base', () => {
    const below = [
      ...VERBS.record.map((v) => ['record', v]),
      ['comment', 'list'],
      ['comment', 'add'],
    ]
    for (const path of below) {
      const required = compileSpec(leaf(...path)).options.filter((o) => o.required)
      expect(required.map((o) => o.names.at(-1)).sort()).toEqual(['--base', '--table'])
    }
    expect(compileSpec(leaf('table', 'get')).options.map((o) => o.names.at(-1))).toEqual(['--base'])
  })

  it('renders the tree as help', async () => {
    expect(await shell('airtable --help')).toEqual([0, HELP, ''])
  })

  it('answers a second install under its own name', async () => {
    vi.stubGlobal('fetch', new FakeAirtable().fetch)
    const ws = new Workspace({}, { shellParser: await getTestParser() })
    ws.registerCli('work', AIRTABLE, {
      token: TOKEN,
      base_ids: [ROADMAP],
      requests_per_second: 10_000,
    })
    try {
      const refused = await ws.shell(`work base get ${OPS}`)
      expect([refused.exitCode, DEC.decode(refused.stderr)]).toEqual([
        1,
        `work base get: ${OPS}: Permission denied\n`,
      ])
      const usage = await ws.shell(`work record get --base ${ROADMAP} --table ${FEATURES}`)
      expect([usage.exitCode, DEC.decode(usage.stderr)]).toEqual([
        2,
        'the following arguments are required: RECORD\n',
      ])
      const missing = await ws.shell(
        `work record get --base ${ROADMAP} --table ${FEATURES} recZZZZZZZZZZZZZZ`,
      )
      expect(missing.exitCode).toBe(1)
      expect(DEC.decode(missing.stderr)).toMatch(
        new RegExp(`^work record get: Airtable API error \\(GET /${ROADMAP}/`),
      )
    } finally {
      await ws.close()
    }
  })

  it('leaves a missing base to the parser', async () => {
    expect(await shell('airtable record list --table tblFeatures000001')).toEqual([
      2,
      '',
      "airtable record list: option '--base' is required\n" +
        "Try 'airtable record list --help' for more information.\n",
    ])
  })
})
