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

import { describe, expect, it, vi } from 'vitest'
import type * as UtilModule from './util.ts'
import type { NotionTransport } from '../../../../core/notion/_client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { NTN } from './index.ts'
import { append } from './blocks/append.ts'
import { create } from './pages/create.ts'
import { edit } from './pages/edit.ts'
import { trash } from './pages/trash.ts'
import { query } from './datasources/query.ts'

const DEC = new TextDecoder()

interface Recorded {
  name: string
  args: Record<string, unknown>
}

const CALLS: Recorded[] = []
let RESPONSE: Record<string, unknown> = { id: 'P1' }

class FakeTransport implements NotionTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    CALLS.push({ name, args })
    return Promise.resolve(RESPONSE)
  }
}

vi.mock('./util.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return { ...actual, notionTransport: () => new FakeTransport() }
})

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('expected a result tuple')
  return result
}

function makeInv(config: unknown, flags: CLIInvocation['flags']): CLIInvocation {
  return { config, argv: [], paths: [], texts: [], flags, stdin: null, env: {} }
}

function leaf(...path: string[]) {
  let node = NTN
  for (const name of path) {
    const child = node.subcommands.find((c) => c.name === name)
    if (child === undefined) throw new Error(`no subcommand ${name}`)
    node = child
  }
  return node
}

describe('ntn tree', () => {
  it('matches the official grammar and registers itself', () => {
    expect(NTN.subcommands.map((g) => g.name)).toEqual([
      'pages',
      'blocks',
      'comments',
      'datasources',
      'search',
    ])
    expect(leaf('pages').subcommands.map((v) => v.name)).toEqual(['get', 'create', 'edit', 'trash'])
    expect(cliSpecFor('ntn')).toBe(NTN)
  })

  it('classifies writers', () => {
    expect(leaf('pages', 'get').write).toBe(false)
    for (const verb of ['create', 'edit', 'trash']) {
      expect(leaf('pages', verb).write).toBe(true)
    }
    expect(leaf('blocks', 'append').write).toBe(true)
    expect(leaf('datasources', 'query').write).toBe(false)
  })
})

describe('ntn verbs', () => {
  it('pages create requires a parent and posts the body', async () => {
    CALLS.length = 0
    const [, io] = unwrap(await create(makeInv({}, { json: '{"properties":{}}' })))
    expect(io.exitCode).toBe(2)
    const [out] = unwrap(
      await create(makeInv({}, { json: '{"parent":{"page_id":"root"},"properties":{}}' })),
    )
    expect(CALLS[0]?.name).toBe('API-post-page')
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual({ id: 'P1' })
  })

  it('malformed --json is a usage error with the shared wording', async () => {
    const [, io] = unwrap(await create(makeInv({}, { json: '{not json' })))
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('--json must be valid JSON\n')
  })

  it('pages edit and trash PATCH the page', async () => {
    CALLS.length = 0
    await edit(makeInv({}, { page: 'P1', json: '{"archived":true}' }))
    await trash(makeInv({}, { page: 'P2' }))
    expect(CALLS[0]).toEqual({
      name: 'API-patch-page',
      args: { archived: true, page_id: 'P1' },
    })
    expect(CALLS[1]).toEqual({ name: 'API-patch-page', args: { in_trash: true, page_id: 'P2' } })
  })

  it('blocks append requires children', async () => {
    const [, io] = unwrap(await append(makeInv({}, { block: 'B1', json: '{"foo":1}' })))
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('--json must contain children\n')
  })

  it('datasources query forwards the filter body', async () => {
    CALLS.length = 0
    RESPONSE = { results: [], has_more: false }
    await query(makeInv({}, { datasource: 'D1', json: '{"filter":{"x":1}}' }))
    expect(CALLS[0]?.name).toBe('API-post-database-query')
    expect(CALLS[0]?.args).toMatchObject({ database_id: 'D1', filter: { x: 1 } })
    RESPONSE = { id: 'P1' }
  })
})
