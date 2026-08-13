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
import type { RestCall } from '../../../../core/notion/_client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { NTN } from './index.ts'
import { api } from './api.ts'
import { create } from './pages/create.ts'
import { edit } from './pages/edit.ts'
import { trash } from './pages/trash.ts'
import { query } from './datasources/query.ts'
import { whoamiRow } from './whoami.ts'
import { propertyCell } from './util.ts'
import { yieldBytes } from '../../../../io/stream.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

interface Recorded {
  name: string
  args: Record<string, unknown>
}

const CALLS: Recorded[] = []
const REQUESTS: RestCall[] = []
let RESPONSE: Record<string, unknown> = { id: 'P1' }

class FakeTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    CALLS.push({ name, args })
    return Promise.resolve(RESPONSE)
  }

  request(call: RestCall): Promise<Record<string, unknown>> {
    REQUESTS.push(call)
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

function makeInv(
  flags: CLIInvocation['flags'],
  texts: string[] = [],
  stdin: ByteSource | null = null,
): CLIInvocation {
  return { config: {}, argv: [], paths: [], texts, flags, stdin, env: {} }
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
      'api',
      'auth',
      'datasources',
      'pages',
      'whoami',
    ])
    expect(leaf('pages').subcommands.map((v) => v.name)).toEqual(['get', 'create', 'edit', 'trash'])
    expect(leaf('datasources').subcommands.map((v) => v.name)).toEqual(['query', 'resolve'])
    expect(cliSpecFor('ntn')).toBe(NTN)
  })

  it('takes ids positionally, the way the official CLI does', () => {
    // Names are upstream's, verbatim, because they are what a missing operand
    // is refused by name with (integ/ntn_conformance.ts pins the refusal
    // against the real binary).
    const named: [string[], string][] = [
      [['pages', 'get'], 'PAGE_ID'],
      [['pages', 'edit'], 'PAGE_ID'],
      [['pages', 'trash'], 'PAGE_ID'],
      [['datasources', 'query'], 'ID_OR_URL'],
      [['datasources', 'resolve'], 'ID'],
    ]
    for (const [path, slot] of named) {
      const node = leaf(...path)
      expect(node.rest).toBeNull()
      expect(node.positional.length).toBe(1)
      expect(node.positional[0]?.name).toBe(slot)
      expect(node.positional[0]?.required).toBe(true)
      expect(node.options.some((o) => o.long === '--page')).toBe(false)
    }
  })

  it('leaves the api path optional', () => {
    // `ntn api` with no operand prints its help rather than refusing, so its
    // slot is the one that must not be required.
    const node = leaf('api')
    expect(node.rest).not.toBeNull()
    expect(node.rest?.name).toBe('PATH')
    expect(node.rest?.required).toBe(false)
  })

  it('backs --notion-version with the environment', () => {
    // Declared once on the shared option, so every verb that carries it honors
    // NOTION_API_VERSION identically.
    for (const path of [['pages', 'get'], ['datasources', 'query'], ['whoami']]) {
      const option = leaf(...path).options.find((o) => o.long === '--notion-version')
      expect(option?.env).toBe('NOTION_API_VERSION')
      expect(option?.metavar).toBe('VERSION')
    }
  })

  it('classifies writers', () => {
    expect(leaf('pages', 'get').write).toBe(false)
    for (const verb of ['create', 'edit', 'trash']) {
      expect(leaf('pages', verb).write).toBe(true)
    }
    expect(leaf('datasources', 'query').write).toBe(false)
    expect(leaf('datasources', 'resolve').write).toBe(false)
  })
})

describe('ntn verbs', () => {
  it('pages create posts markdown and prints the new id', async () => {
    CALLS.length = 0
    const [out] = unwrap(await create(makeInv({ content: '# Hi', parent: 'page:root' })))
    expect(CALLS[0]?.name).toBe('API-post-page')
    expect(CALLS[0]?.args).toEqual({ markdown: '# Hi', parent: { page_id: 'root' } })
    expect(DEC.decode(out as Uint8Array)).toBe('P1\n')
  })

  it('pages create maps every --parent kind', async () => {
    CALLS.length = 0
    await create(makeInv({ content: '#', parent: 'database:D1' }))
    await create(makeInv({ content: '#', parent: 'data-source:S1' }))
    expect(CALLS[0]?.args).toMatchObject({ parent: { database_id: 'D1' } })
    expect(CALLS[1]?.args).toMatchObject({ parent: { data_source_id: 'S1' } })
  })

  it('pages create refuses a malformed --parent', async () => {
    const [, io] = unwrap(await create(makeInv({ content: '#', parent: 'nope:X' })))
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      '--parent must be page:<id>, database:<id>, or data-source:<id>\n',
    )
  })

  it('pages edit replaces the body through the markdown endpoint', async () => {
    CALLS.length = 0
    await edit(makeInv({ content: '# New' }, ['P1']))
    expect(CALLS[0]).toEqual({
      name: 'API-patch-page-markdown',
      args: {
        page_id: 'P1',
        type: 'replace_content',
        replace_content: { new_str: '# New' },
      },
    })
  })

  it('pages trash refuses without --yes, the way a non-interactive shell sees it', async () => {
    CALLS.length = 0
    const [, refused] = unwrap(await trash(makeInv({}, ['P2'])))
    expect(refused.exitCode).toBe(1)
    expect(DEC.decode(refused.stderr as Uint8Array)).toBe(
      'error: Cannot confirm in a non-interactive environment.\n' +
        '  hint: Use --yes to skip the confirmation prompt.\n',
    )
    expect(CALLS.length).toBe(0)
    const [, done] = unwrap(await trash(makeInv({ yes: true }, ['P2'])))
    expect(CALLS[0]).toEqual({ name: 'API-patch-page', args: { in_trash: true, page_id: 'P2' } })
    expect(DEC.decode(done.stderr as Uint8Array)).toBe('✔ Page trashed\n')
  })

  it('datasources query sends one page and sorts its columns by name', async () => {
    CALLS.length = 0
    RESPONSE = {
      id: 'S1',
      properties: { Priority: { type: 'number' }, Name: { type: 'title' } },
      results: [
        {
          id: 'R1',
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Write spec' }] },
            Priority: { type: 'number', number: 2 },
          },
        },
      ],
      has_more: false,
    }
    const [out] = unwrap(await query(makeInv({ limit: 5, sort: ['Priority desc'] }, ['S1'])))
    expect(CALLS[0]?.name).toBe('API-retrieve-a-data-source')
    expect(CALLS[1]?.args).toMatchObject({
      data_source_id: 'S1',
      page_size: 5,
      sorts: [{ property: 'Priority', direction: 'descending' }],
    })
    expect(DEC.decode(out as Uint8Array)).toBe('R1\tWrite spec\t2\n')
    RESPONSE = { id: 'P1' }
  })

  // Upstream derives the columns from the page objects it got back, not from
  // the data source's schema, so a result set that does not cover the schema
  // prints narrower. A row created from Markdown alone holds only its title
  // column, and on its own it prints as `<id>\t<title>` rather than as one
  // title among blanks.
  it('datasources query takes its columns from the returned rows', async () => {
    CALLS.length = 0
    RESPONSE = {
      id: 'S1',
      properties: { Priority: { type: 'number' }, Name: { type: 'title' } },
      results: [
        { id: 'R2', properties: { Name: { type: 'title', title: [{ plain_text: 'Row page' }] } } },
      ],
      has_more: false,
    }
    const [out] = unwrap(await query(makeInv({}, ['S1'])))
    expect(DEC.decode(out as Uint8Array)).toBe('R2\tRow page\n')
    RESPONSE = { id: 'P1' }
  })

  // `DELETE /v1/blocks/{id}` is the only delete verb the public API has, and
  // it is the one the MCP tool surface exposes as API-delete-a-block, so a
  // method table without it leaves an agent no way to remove anything.
  it('api can issue the one delete verb the API has', async () => {
    REQUESTS.length = 0
    const [out] = unwrap(await api(makeInv({ method: 'delete' }, ['v1/blocks/B1'])))
    // No body source on the line, so nothing is invented for one.
    expect(REQUESTS[0]).toEqual({ method: 'DELETE', path: '/blocks/B1' })
    expect(DEC.decode(out as Uint8Array)).toBe('{"id":"P1"}\n')
  })

  it('api infers the method and strips the version prefix from the path', async () => {
    REQUESTS.length = 0
    await api(makeInv({}, ['v1/users/me']))
    await api(makeInv({}, ['v1/search', 'query=Roadmap']))
    await api(makeInv({}, ['v1/blocks/B1/children', 'page_size==1']))
    // No `query` key at all when nothing was asked for, which is what
    // python sends (`params or None`).
    expect(REQUESTS[0]).toEqual({ method: 'GET', path: '/users/me' })
    expect(REQUESTS[1]).toEqual({ method: 'POST', path: '/search', body: { query: 'Roadmap' } })
    expect(REQUESTS[2]).toEqual({
      method: 'GET',
      path: '/blocks/B1/children',
      query: { page_size: '1' },
    })
  })

  it('api keeps a query parameter on a call that is not a GET', async () => {
    // `name==value` is a query parameter whatever the method is. The
    // non-GET path used to drop params entirely.
    REQUESTS.length = 0
    await api(makeInv({}, ['v1/search', 'a=1', 'q==2']))
    expect(REQUESTS[0]).toEqual({
      method: 'POST',
      path: '/search',
      query: { q: '2' },
      body: { a: '1' },
    })
  })

  it('api sends a non-object --data rather than refusing it', async () => {
    // There is no client-side object check upstream: probed on the wire,
    // `-d '[]'` POSTs the array. mirage used to refuse it as a usage error,
    // so a line the real CLI accepts exited 2 here.
    REQUESTS.length = 0
    await api(makeInv({ data: '[]' }, ['v1/search']))
    // `{}` is falsy, and inferring the method from truthiness sent it as a
    // GET. The presence of a body source decides the method, not whether the
    // body has anything in it.
    await api(makeInv({ data: '{}' }, ['v1/search']))
    expect(REQUESTS[0]).toEqual({ method: 'POST', path: '/search', body: [] })
    expect(REQUESTS[1]).toEqual({ method: 'POST', path: '/search', body: {} })
  })

  it('api refuses conflicting body sources the way upstream does', async () => {
    const result = await api(makeInv({ data: '{}' }, ['v1/search', 'a=1']))
    const [, io] = unwrap(result)
    expect(io.exitCode).toBe(5)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      'error: Request body can come from only one source, but got: ' +
        '--data, inline body inputs.\n' +
        '  hint: Use only one of: stdin JSON, `--data`, or ' +
        '`path=value` / `path:=json` inputs.\n',
    )
  })

  it('api refuses a malformed inline input with serde’s words and a hint', async () => {
    const result = await api(makeInv({}, ['v1/search', 'a:={']))
    const [, io] = unwrap(result)
    expect(io.exitCode).toBe(5)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      'error: Failed to parse inline request input: invalid JSON value ' +
        'in "a:={": EOF while parsing an object at line 1 column 1\n' +
        '  hint: Use `Header:Value`, `name==value`, `path=value`, or `path:=json`.\n',
    )
  })

  it('api names an input with no separator unexpected', async () => {
    const result = await api(makeInv({}, ['v1/search', 'foo']))
    const [, io] = unwrap(result)
    expect(io.exitCode).toBe(5)
    expect(DEC.decode(io.stderr as Uint8Array)).toContain('unexpected input: "foo"')
  })

  it('api reads the pipe as a body source', async () => {
    REQUESTS.length = 0
    await api(makeInv({}, ['v1/search'], yieldBytes(ENC.encode('{"q":1}'))))
    expect(REQUESTS[0]).toEqual({ method: 'POST', path: '/search', body: { q: 1 } })
  })

  it('api refuses a malformed pipe with its own exit 1', async () => {
    const result = await api(makeInv({}, ['v1/search'], yieldBytes(ENC.encode('{'))))
    const [, io] = unwrap(result)
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('error: Invalid JSON from stdin\n')
  })

  it('api treats a blank pipe as no body source at all', async () => {
    // The conformance harness closes stdin and every other line would
    // otherwise report a conflict it never asked for.
    REQUESTS.length = 0
    const result = await api(makeInv({ data: '{}' }, ['v1/search'], yieldBytes(ENC.encode('  \n'))))
    const [, io] = unwrap(result)
    expect(io.exitCode).toBe(0)
    expect(REQUESTS[0]).toEqual({ method: 'POST', path: '/search', body: {} })
  })

  it('api names an empty --data in its own words', async () => {
    const result = await api(makeInv({ data: '  ' }, ['v1/search']))
    const [, io] = unwrap(result)
    expect(io.exitCode).toBe(5)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe(
      'error: --data requires a valid JSON value.\n' +
        '  hint: Pass a JSON string such as `--data \'{"foo":"bar"}\'`, a file ' +
        'such as `--data @body.json`, or stdin with `--data @-`.\n',
    )
  })

  it('api sends inline headers on the wire', async () => {
    // Probed on the wire against the real ntn 0.21.9, which sends
    // `X-Foo:bar` as a request header. Recognizing the syntax and then
    // dropping the value is the failure this pins.
    REQUESTS.length = 0
    await api(makeInv({}, ['v1/search', 'X-Foo:bar', 'X-Two:baz']))
    expect(REQUESTS[0]?.headers).toEqual({ 'X-Foo': 'bar', 'X-Two': 'baz' })
    // A header value may itself contain colons.
    await api(makeInv({}, ['v1/search', 'X-Trace:a:b:c']))
    expect(REQUESTS[1]?.headers).toEqual({ 'X-Trace': 'a:b:c' })
  })

  it('api omits the header map when no inline header was given', async () => {
    REQUESTS.length = 0
    await api(makeInv({}, ['v1/users/me']))
    expect(REQUESTS[0]?.headers).toBeUndefined()
  })

  it('api refuses malformed --data exactly as upstream does', async () => {
    // Probed against ntn 0.21.9: exit 1 with this wording, which is neither
    // the engine's own parse message nor a generic usage error.
    const [, io] = unwrap(await api(makeInv({ data: '{' }, ['v1/search'])))
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(io.stderr as Uint8Array)).toBe('error: Invalid JSON from --data\n')
  })

  it('api builds nested bodies from bracket paths and typed assignments', async () => {
    REQUESTS.length = 0
    await api(makeInv({}, ['v1/pages', 'parent[page_id]=root', 'archived:=true']))
    expect(REQUESTS[0]?.body).toEqual({ parent: { page_id: 'root' }, archived: true })
  })

  it('api prints compact JSON with sorted keys', async () => {
    RESPONSE = { b: 1, a: { d: 2, c: 3 } }
    const [out] = unwrap(await api(makeInv({}, ['v1/users/me'])))
    expect(DEC.decode(out as Uint8Array)).toBe('{"a":{"c":3,"d":2},"b":1}\n')
    RESPONSE = { id: 'P1' }
  })
})

describe('ntn rendering', () => {
  it('whoami repeats the workspace in the owner columns for a workspace-owned bot', () => {
    const row = whoamiRow({
      id: 'ID',
      name: 'NAME',
      type: 'bot',
      bot: {
        owner: { type: 'workspace', workspace: true },
        workspace_id: 'WSID',
        workspace_name: 'WSNAME',
      },
    })
    expect(DEC.decode(row as Uint8Array)).toBe(
      'ID\tNAME\tbot\t\tWSID\tWSNAME\tWSID\tWSNAME\tworkspace\n',
    )
  })

  it('whoami names the owning user and their email for a user-owned bot', () => {
    const row = whoamiRow({
      id: 'ID',
      name: 'NAME',
      type: 'bot',
      bot: {
        owner: {
          type: 'user',
          user: {
            id: 'OWNERID',
            name: 'OWNERNAME',
            type: 'person',
            person: { email: 'e@x.com' },
          },
        },
        workspace_id: 'WSID',
        workspace_name: 'WSNAME',
      },
    })
    expect(DEC.decode(row as Uint8Array)).toBe(
      'ID\tNAME\tbot\te@x.com\tWSID\tWSNAME\tOWNERID\tOWNERNAME\tperson\n',
    )
  })

  it('renders each property type the way the official CLI prints it', () => {
    expect(propertyCell({ type: 'checkbox', checkbox: true })).toBe('✓')
    expect(propertyCell({ type: 'checkbox', checkbox: false })).toBe('')
    expect(propertyCell({ type: 'date', date: { start: '2026-02-01' } })).toBe('2026-02-01')
    expect(propertyCell({ type: 'date', date: null })).toBe('')
    expect(propertyCell({ type: 'select', select: { name: 'Review' } })).toBe('Review')
    expect(propertyCell({ type: 'select', select: null })).toBe('')
    expect(
      propertyCell({ type: 'multi_select', multi_select: [{ name: 'infra' }, { name: 'docs' }] }),
    ).toBe('infra, docs')
    expect(propertyCell({ type: 'multi_select', multi_select: [] })).toBe('')
    expect(propertyCell({ type: 'url', url: 'https://example.com' })).toBe('https://example.com')
    expect(propertyCell({ type: 'url', url: null })).toBe('')
    expect(propertyCell({ type: 'number', number: 2 })).toBe('2')
    expect(propertyCell({ type: 'rich_text', rich_text: [{ plain_text: 'note' }] })).toBe('note')
  })
})
