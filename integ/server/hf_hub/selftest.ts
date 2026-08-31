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

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import type { JsonValue } from '../kit/typescript/types.ts'
import { loadToolDoc, startHfMcpServer } from './mcp.ts'

// The battery cannot reach any of this, the same way it cannot reach the kit's
// run and tenant isolation. Listing and search are HTTP surface with no client
// inside mirage: the `hf` CLI has no `models ls` verb and a mount never calls
// /api/models, so a corpus case has no line that would send the request. Left
// to the battery alone, the whole endpoint would ship untested.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-hf-hub'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`hf_hub selftest failed: ${name} ${detail}`)
}

// JSON with every object's keys sorted, so two documents that differ only in
// key order compare equal.
function canonical(v: JsonValue): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (typeof v === 'object' && v !== null) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k] as JsonValue)}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
}

async function launch(): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0'],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const first = await new Promise<string>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl !== -1) ok(out.slice(0, nl))
    })
    child.on('exit', (code) => {
      bad(new Error(`fake exited ${String(code)} before announcing\n${err}`))
    })
  })
  check('announce line matches ANNOUNCE_RE', ANNOUNCE_RE.test(first), first)
  return { child, endpoint: first.split('=').slice(1).join('=') }
}

async function get(endpoint: string, path: string): Promise<JsonValue> {
  const r = await fetch(`${endpoint}${path}`, { headers: { Authorization: `Bearer ${TENANT}` } })
  check(`GET ${path} is 200`, r.status === 200, String(r.status))
  return (await r.json()) as JsonValue
}

function ids(rows: JsonValue): string[] {
  return Array.isArray(rows)
    ? rows.map((r) => String((r as Record<string, JsonValue>).id ?? ''))
    : []
}

// Create a repo and give it one README, which is how every card in the tests
// after this point gets there: through the commit endpoint, not a fixture.
async function repoWithCard(
  endpoint: string,
  kind: string,
  name: string,
  card: string,
): Promise<void> {
  const made = await fetch(`${endpoint}/api/repos/create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type: kind === 'models' ? 'model' : kind.slice(0, -1) }),
  })
  check(`${name} is created`, made.status === 200, String(made.status))
  const pushed = await fetch(`${endpoint}/api/${kind}/${TENANT}/${name}/commit/main`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
    body: [
      JSON.stringify({ key: 'header', value: { summary: 'add a card' } }),
      JSON.stringify({ key: 'file', value: { path: 'README.md', content: card } }),
    ].join('\n'),
  })
  check(`${name} gets its card`, pushed.status === 200, String(pushed.status))
}

// The MCP arm. It answers the SAME seeded world as the REST arm and it answers
// it through the same routes, so what is asserted here is the two things that
// arm adds on top: that `tools/list` REPLAYS the captured document rather than
// anything this repo authored, and that the markdown a tool answers with is the
// shape captured from the live server.
async function mcpChecks(): Promise<void> {
  const doc = loadToolDoc()
  check(
    'the tool document records its source',
    doc.capturedFrom === 'https://huggingface.co/mcp',
    doc.capturedFrom,
  )
  const mcp = await startHfMcpServer()
  const client = new Client({ name: 'hf-hub-selftest', version: '0' }, { capabilities: {} })
  try {
    // The same cast the notion arm needs: this project sets
    // exactOptionalPropertyTypes and the SDK's transport declares an optional
    // `sessionId` the strict Transport type will not accept.
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(mcp.port)}/mcp`),
    )
    await client.connect(transport as Parameters<typeof client.connect>[0])
    const listed = await client.listTools()
    // Verbatim replay is the point: a schema this repo wrote would put a
    // mirage-shaped tool surface in front of the agent being measured.
    eq(
      'tools/list replays the captured document',
      listed.tools.map((one) => one.name).sort(),
      doc.tools.map((one) => one.name).sort(),
    )
    // Compared field for field rather than byte for byte: the SDK re-emits a
    // tool through its own zod schema, which reorders the keys (`outputSchema`
    // moves ahead of `annotations`) without touching a value. Key order is not
    // part of the contract; every schema being present and unchanged is.
    eq(
      'the captured schemas are replayed unchanged',
      canonical(listed.tools as unknown as JsonValue) ===
        canonical(doc.tools as unknown as JsonValue),
      true,
    )

    const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const out = await client.callTool({ name, arguments: args })
      const content = out.content as { type: string; text?: string }[]
      return content.map((one) => one.text ?? '').join('')
    }

    const who = await text('hf_whoami', {})
    check(
      'hf_whoami renders the authenticated form',
      who.includes('Authenticated as'),
      who.slice(0, 60),
    )

    const search = await text('hub_repo_search', {
      query: 'card-model',
      repo_types: ['model'],
      limit: 5,
    })
    check(
      'search finds the seeded model',
      search.includes('### integ/card-model'),
      search.slice(0, 80),
    )
    // The block shape is the live server's, down to the pipe-joined facts line
    // and the abbreviated download count (5000 -> 5.0K).
    check(
      'search renders the facts line',
      search.includes('**Downloads:** 5.0K'),
      search.slice(0, 400),
    )
    check('search renders a hf.co link', search.includes('[https://hf.co/integ/card-model]'), '')

    // A run-scoped endpoint answers THAT run's world. `/_run/scoped/mcp` is a
    // fresh empty run, so the repo seeded into the default run must not leak
    // into it; the default-path client above keeps finding it.
    const scopedClient = new Client(
      { name: 'hf-hub-selftest-run', version: '0' },
      { capabilities: {} },
    )
    const scopedTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(mcp.port)}/_run/scoped/mcp`),
    )
    await scopedClient.connect(scopedTransport as Parameters<typeof scopedClient.connect>[0])
    const scopedOut = await scopedClient.callTool({
      name: 'hub_repo_search',
      arguments: { query: 'card-model', repo_types: ['model'], limit: 5 },
    })
    const scopedText = (scopedOut.content as { type: string; text?: string }[])
      .map((one) => one.text ?? '')
      .join('')
    check(
      'a run-scoped MCP call answers that run, not the default world',
      !scopedText.includes('integ/card-model'),
      scopedText.slice(0, 80),
    )
    await scopedClient.close()

    const details = await text('hub_repo_details', { repo_ids: ['integ/card-model'] })
    check('details name the type', details.startsWith('**Type: Model**'), details.slice(0, 40))
    check('details lift the card task', details.includes('- **Task:** summarization'), '')
    check('details render the license', details.includes('- **License:** apache-2.0'), '')

    // The Dataset Viewer operations are refused rather than approximated: the
    // fake has no parquet behind a dataset, and a plausible preview of rows
    // nobody uploaded is the one failure that would corrupt a measurement
    // without ever looking wrong.
    const preview = await text('hub_repo_details', {
      repo_ids: ['integ/card-data-a'],
      operations: ['overview', 'dataset_preview'],
    })
    check(
      'an unservable operation is named',
      preview.includes('**Unsupported operations:** dataset_preview'),
      '',
    )

    const ls = await text('hf_fs', {
      operations: [{ cmd: 'ls', args: ['hf://models/integ/card-model'] }],
    })
    check(
      'ls renders the captured table header',
      ls.includes('| Type | Path | URI | Target | Details |'),
      '',
    )
    check('ls lists the seeded files', ls.includes('| file | README.md |'), ls.slice(0, 300))

    const cat = await text('hf_fs', {
      operations: [{ cmd: 'cat', args: ['hf://models/integ/card-model/config.json'] }],
    })
    check('cat reports the byte count', /Bytes: \d+/.test(cat), cat.slice(0, 200))

    const stat = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://models/integ/card-model/README.md'] }],
    })
    check('stat reports existence', stat.includes('- Exists: yes'), stat.slice(0, 200))
    check('stat reports a size', stat.includes('- Size: '), stat.slice(0, 200))

    // Both error codes are the live server's own, captured rather than coined,
    // because an agent may branch on the bracketed code.
    const missing = await text('hf_fs', {
      operations: [{ cmd: 'cat', args: ['hf://models/integ/card-model/nope.txt'] }],
    })
    check(
      'a missing file is HF_FS_NOT_FOUND',
      missing.includes('[HF_FS_NOT_FOUND]'),
      missing.slice(0, 120),
    )
    const bad = await text('hf_fs', { operations: [{ cmd: 'ls', args: ['/not/a/uri'] }] })
    check(
      'a bad URI is HF_FS_INVALID_ARGUMENT',
      bad.includes('[HF_FS_INVALID_ARGUMENT]'),
      bad.slice(0, 120),
    )

    const two = await text('hf_fs', {
      operations: [
        { cmd: 'ls', args: ['hf://models/integ/card-model'] },
        { cmd: 'stat', args: ['hf://models/integ/card-model/README.md'] },
      ],
    })
    check(
      'a batch is numbered',
      two.includes('## Operation 1') && two.includes('## Operation 2'),
      '',
    )
    check('a batch is rule-separated', two.includes('\n---\n'), '')
  } finally {
    await client.close()
    await mcp.close()
  }
}

// Launchability, which is a separate fact from correctness and was the gap:
// every check above runs the MCP arm IN PROCESS, and an agent harness cannot do
// that. toolathlon builds each server from a dict and picks its transport by
// shape -- `{"url": ...}` becomes MCPServerHttp, anything else MCPServerStdio
// -- so what it needs from mirage is a process that prints a URL. This spawns
// `main.ts` exactly as a harness would and drives the announced URL.
async function launchChecks(): Promise<void> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0', '--mcp-port', '0'],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const lines = await new Promise<string[]>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const found = out.split('\n').filter((l) => l !== '')
      if (found.length >= 2) ok(found)
    })
    child.on('exit', (code) => {
      bad(new Error(`hf_hub exited ${String(code)} before announcing both arms\n${err}`))
    })
  })
  try {
    check(
      'the REST arm announces first',
      (lines[0] ?? '').startsWith('HF_HUB_URL='),
      lines[0] ?? '',
    )
    const mcpLine = lines[1] ?? ''
    check('the MCP arm announces its own token', mcpLine.startsWith('HF_MCP_URL='), mcpLine)
    check('and both announce lines are announce-shaped', ANNOUNCE_RE.test(mcpLine), mcpLine)
    const url = mcpLine.split('=').slice(1).join('=')
    check('the announced URL carries the vendor path', url.endsWith('/mcp'), url)
    // A harness pointed at the wrong path must be told, not quietly served.
    const stray = await fetch(url.replace(/\/mcp$/, '/nope'))
    check('a path that is not /mcp is 404', stray.status === 404, String(stray.status))
    const client = new Client({ name: 'hf-hub-launch', version: '0' }, { capabilities: {} })
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url))
      await client.connect(transport as Parameters<typeof client.connect>[0])
      const listed = await client.listTools()
      eq(
        'a spawned server serves the same four tools',
        listed.tools.map((one) => one.name).sort(),
        ['hf_fs', 'hf_whoami', 'hub_repo_details', 'hub_repo_search'],
      )
      // One store behind both arms: a REST read and a tool call in the same run
      // must see the same rows, which two runtimes would not.
      // The REST arm reads its tenant off the bearer (the Hub's token IS the
      // account), while the MCP arm is bound to the default tenant when it is
      // constructed -- so the bearer here has to name that same tenant for the
      // two reads to be comparable at all.
      const rest = (lines[0] ?? '').split('=').slice(1).join('=')
      const viaRest = (await (
        await fetch(`${rest}/api/models?search=card`, {
          headers: { Authorization: 'Bearer default' },
        })
      ).json()) as JsonValue[]
      const called = await client.callTool({
        name: 'hub_repo_search',
        arguments: { query: 'card', type: 'model' },
      })
      const text = JSON.stringify(called.content)
      check(
        'and both arms answer from the same store',
        Array.isArray(viaRest) && viaRest.length > 0 && text.includes('card-model'),
        `${String(Array.isArray(viaRest) ? viaRest.length : -1)} rest rows`,
      )
    } finally {
      await client.close()
    }
  } finally {
    child.kill('SIGTERM')
  }
}

async function main(): Promise<void> {
  const fake = await launch()
  try {
    const reset = await fetch(`${fake.endpoint}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('/reset seeds the fixture', reset.status === 200, String(reset.status))

    // ---- card metadata is derived from README.md, not stored twice
    const info = (await get(fake.endpoint, '/api/models/integ/card-model')) as Record<
      string,
      JsonValue
    >
    eq('author is the namespace', info.author ?? null, 'integ')
    eq('downloads come from the row', info.downloads ?? null, 5000)
    eq('likes come from the row', info.likes ?? null, 42)
    eq('gated "" renders as false', info.gated ?? null, false)
    const card = (info.cardData ?? {}) as Record<string, JsonValue>
    eq('cardData carries the license', card.license ?? null, 'apache-2.0')
    eq('pipeline_tag is lifted from the card', info.pipeline_tag ?? null, 'summarization')
    eq('library_name is lifted from the card', info.library_name ?? null, 'transformers')
    // A MODEL spells its language, library and pipeline bare; only license is
    // prefixed. Probed on google-bert/bert-base-uncased, which carries
    // "transformers", "fill-mask", "en" and "license:apache-2.0".
    eq('a model card becomes model-spelled facets', info.tags ?? null, [
      'conversational',
      'en',
      'license:apache-2.0',
      'summarization',
      'transformers',
    ])
    // A DATASET prefixes its language and its task categories, which is the
    // spelling rajpurkar/squad uses.
    const dsInfo = (await get(fake.endpoint, '/api/datasets/integ/card-data-a')) as Record<
      string,
      JsonValue
    >
    eq('a dataset card becomes dataset-spelled facets', dsInfo.tags ?? null, [
      'language:en',
      'license:mit',
      'size_categories:n<1K',
      'task_categories:summarization',
    ])

    // A git tag must NOT appear in `tags`. The two were conflated, so
    // `hf repo tag create` surfaced as a facet on the model object.
    const tagged = await fetch(`${fake.endpoint}/api/models/integ/card-model/tag/main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'v9' }),
    })
    check('a git tag is created', tagged.status === 200, String(tagged.status))
    const after = (await get(fake.endpoint, '/api/models/integ/card-model')) as Record<
      string,
      JsonValue
    >
    check(
      'a git tag stays out of the facet list',
      !JSON.stringify(after.tags ?? []).includes('v9'),
      JSON.stringify(after.tags ?? []),
    )
    const refs = (await get(fake.endpoint, '/api/models/integ/card-model/refs')) as Record<
      string,
      JsonValue
    >
    check(
      'the git tag is reachable at /refs',
      JSON.stringify(refs.tags ?? []).includes('v9'),
      JSON.stringify(refs.tags ?? []),
    )

    // ---- listing and search
    eq(
      'search matches a substring of the id',
      ids(await get(fake.endpoint, '/api/datasets?search=card')),
      ['integ/card-data-a', 'other/card-data-b'],
    )
    eq(
      'search is case insensitive',
      ids(await get(fake.endpoint, '/api/datasets?search=CARD-DATA-B')),
      ['other/card-data-b'],
    )
    eq(
      'search that matches nothing is an empty list',
      ids(await get(fake.endpoint, '/api/models?search=zzz')),
      [],
    )
    eq(
      'author narrows to one namespace',
      ids(await get(fake.endpoint, '/api/datasets?author=other')),
      ['other/card-data-b'],
    )
    eq(
      'filter matches a card facet',
      ids(await get(fake.endpoint, '/api/datasets?filter=license:mit')),
      ['integ/card-data-a'],
    )
    // The facets a model request actually filters on. These are bare, so a
    // model-only field left out of `tags` makes the query silently empty.
    eq(
      'filter matches a model pipeline tag',
      ids(await get(fake.endpoint, '/api/models?filter=summarization')),
      ['integ/card-model'],
    )
    eq(
      'filter matches a model library',
      ids(await get(fake.endpoint, '/api/models?filter=transformers')),
      ['integ/card-model'],
    )
    eq(
      'a model language filter is bare, not prefixed',
      ids(await get(fake.endpoint, '/api/models?filter=en')),
      ['integ/card-model'],
    )
    eq(
      'a dataset language filter IS prefixed',
      ids(await get(fake.endpoint, '/api/datasets?filter=language:en')),
      ['integ/card-data-a', 'other/card-data-b'],
    )
    eq(
      'two filters narrow rather than widen',
      ids(await get(fake.endpoint, '/api/datasets?filter=license:mit&filter=language:fr')),
      [],
    )
    eq(
      'sort defaults to descending',
      ids(await get(fake.endpoint, '/api/datasets?sort=downloads')).slice(0, 2),
      ['integ/card-data-a', 'other/card-data-b'],
    )
    // Ordered AGAINST likes in the fixture on purpose: while the two were
    // aliased, this assertion and the likes one could not disagree.
    eq(
      'sort=trending_score is not sort=likes',
      ids(await get(fake.endpoint, '/api/datasets?sort=trending_score')).slice(0, 2),
      ['other/card-data-b', 'integ/card-data-a'],
    )
    eq(
      'sort=likes orders the other way round',
      ids(await get(fake.endpoint, '/api/datasets?sort=likes')).slice(0, 2),
      ['integ/card-data-a', 'other/card-data-b'],
    )
    eq(
      'direction=1 ascends',
      ids(await get(fake.endpoint, '/api/datasets?sort=downloads&direction=1')).slice(-1),
      ['integ/card-data-a'],
    )
    eq('limit truncates', ids(await get(fake.endpoint, '/api/datasets?sort=likes&limit=1')), [
      'integ/card-data-a',
    ])
    // An unknown sort key is ignored rather than guessed at, which is what the
    // Hub does; the five legal keys are upstream's ModelSort_T verbatim.
    eq(
      'an unknown sort key is ignored',
      ids(await get(fake.endpoint, '/api/datasets?sort=nonsense')).length,
      3,
    )

    const expanded = (await get(
      fake.endpoint,
      '/api/models?search=card&expand=likes&expand=downloads',
    )) as JsonValue
    eq('expand returns id and trendingScore plus the named properties', expanded, [
      { id: 'integ/card-model', trendingScore: 8, likes: 42, downloads: 5000 },
    ])

    // ---- the trimmed row, and the one parameter that un-trims it
    const bare = (await get(fake.endpoint, '/api/models')) as Record<string, JsonValue>[]
    const first = bare[0] ?? {}
    // The three field sets are the probed ones. A bare row carries no
    // author/sha/lastModified/gated, and NO row carries cardData without the
    // parameter of that name, which is not part of `full`.
    eq('a bare listing row is the probed trimmed field set', Object.keys(first).sort(), [
      'createdAt',
      'downloads',
      'id',
      'library_name',
      'likes',
      'modelId',
      'pipeline_tag',
      'private',
      'tags',
      'trendingScore',
    ])
    const bareData = (await get(fake.endpoint, '/api/datasets')) as Record<string, JsonValue>[]
    eq('a dataset row is wider and carries no modelId', Object.keys(bareData[0] ?? {}).sort(), [
      'author',
      'createdAt',
      'disabled',
      'downloads',
      'gated',
      'id',
      'lastModified',
      'likes',
      'private',
      'sha',
      'tags',
      'trendingScore',
    ])
    const bareSpace = (await get(fake.endpoint, '/api/spaces')) as Record<string, JsonValue>[]
    eq('a space row is the narrowest of the three', Object.keys(bareSpace[0] ?? {}).sort(), [
      'createdAt',
      'id',
      'likes',
      'private',
      'tags',
      'trendingScore',
    ])
    const fullRows = (await get(fake.endpoint, '/api/models?full=1')) as Record<string, JsonValue>[]
    const fullFirst = fullRows[0] ?? {}
    check('full=1 adds siblings', fullFirst.siblings !== undefined, '')
    check(
      'full=1 adds author, sha, gated and lastModified',
      fullFirst.author !== undefined &&
        fullFirst.sha !== undefined &&
        fullFirst.gated !== undefined &&
        fullFirst.lastModified !== undefined,
      '',
    )
    check('full=1 does NOT add cardData', fullFirst.cardData === undefined, '')
    const carded = (await get(fake.endpoint, '/api/models?cardData=1')) as Record<
      string,
      JsonValue
    >[]
    check(
      'cardData=1 adds it to an otherwise trimmed row',
      (carded[0] ?? {}).cardData !== undefined && (carded[0] ?? {}).siblings === undefined,
      '',
    )
    // Upstream's own rule, stated on `list_models`: full "is set to `True` by
    // default when using a filter".
    const filtered = (await get(fake.endpoint, '/api/models?filter=summarization')) as Record<
      string,
      JsonValue
    >[]
    check('a filter defaults to the full row', (filtered[0] ?? {}).siblings !== undefined, '')
    const searched = (await get(fake.endpoint, '/api/models?search=card')) as Record<
      string,
      JsonValue
    >[]
    check('search alone stays trimmed', (searched[0] ?? {}).siblings === undefined, '')

    // A repository cannot have been modified before it existed. The fixture
    // states a repo's createdAt and its initial commit's separately, so the
    // two can drift apart silently now that lastModified comes from the
    // commit; this is the guard that says so.
    for (const kind of ['models', 'datasets', 'spaces']) {
      const rows = (await get(fake.endpoint, `/api/${kind}?full=1`)) as Record<string, JsonValue>[]
      const bad = rows.filter((r) => String(r.lastModified) < String(r.createdAt))
      check(
        `every ${kind} row is modified at or after it was created`,
        bad.length === 0,
        JSON.stringify(bad.map((r) => [r.id, r.createdAt, r.lastModified])),
      )
    }

    // ---- lastModified is the HEAD commit's, not the first blob's
    const before = (await get(fake.endpoint, '/api/datasets/other/card-data-b')) as Record<
      string,
      JsonValue
    >
    // The added path sorts AFTER README.md, so the first blob keeps the old
    // timestamp and only the commit knows the repository moved.
    const pushed = await fetch(`${fake.endpoint}/api/datasets/other/card-data-b/commit/main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
      body: [
        JSON.stringify({ key: 'header', value: { summary: 'add a late-sorting file' } }),
        JSON.stringify({ key: 'file', value: { path: 'zz-late.txt', content: 'later\n' } }),
      ].join('\n'),
    })
    check('a second commit lands', pushed.status === 200, String(pushed.status))
    const after2 = (await get(fake.endpoint, '/api/datasets/other/card-data-b')) as Record<
      string,
      JsonValue
    >
    check(
      'lastModified follows the new commit, not the first blob',
      String(after2.lastModified) > String(before.lastModified),
      `${String(before.lastModified)} -> ${String(after2.lastModified)}`,
    )
    // The info endpoint and the listing derive it the same way, so a fix to
    // one that misses the other fails here.
    const listed = (await get(fake.endpoint, '/api/datasets?author=other&full=1')) as Record<
      string,
      JsonValue
    >[]
    eq(
      'the listing agrees with the info endpoint',
      (listed[0] ?? {}).lastModified ?? null,
      after2.lastModified ?? null,
    )
    eq(
      'sort=last_modified puts the just-committed repo first',
      ids(await get(fake.endpoint, '/api/datasets?sort=last_modified'))[0] ?? '',
      'other/card-data-b',
    )

    // ---- a Space carries one facet its card does not
    // `hf repo create --repo-type space --space_sdk gradio` stores the sdk and
    // writes no README, so a card-only tag list left the new Space
    // unreachable by the facet the Hub spells bare (`gradio/hello_world` ->
    // ["gradio", "region:us"]) while the body reported it as `sdk`.
    const made = await fetch(`${fake.endpoint}/api/repos/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'sdk-space', type: 'space', sdk: 'gradio' }),
    })
    check('a space is created with an sdk', made.status === 200, String(made.status))
    const spaceInfo = (await get(fake.endpoint, `/api/spaces/${TENANT}/sdk-space`)) as Record<
      string,
      JsonValue
    >
    eq('the stored sdk is a bare facet', spaceInfo.tags ?? null, ['gradio'])
    eq(
      'the new space is reachable by its sdk facet',
      ids(await get(fake.endpoint, '/api/spaces?filter=gradio')),
      [`${TENANT}/sdk-space`],
    )

    // The card outranks the stored sdk. A Space created as gradio whose card
    // later says docker IS a docker Space; answering ?filter=gradio with it
    // would be reporting history.
    const moved = await fetch(`${fake.endpoint}/api/spaces/${TENANT}/sdk-space/commit/main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
      body: [
        JSON.stringify({ key: 'header', value: { summary: 'switch to docker' } }),
        JSON.stringify({
          key: 'file',
          value: { path: 'README.md', content: '---\nsdk: docker\n---\n\n# Space\n' },
        }),
      ].join('\n'),
    })
    check('the space card lands', moved.status === 200, String(moved.status))
    const moved2 = (await get(fake.endpoint, `/api/spaces/${TENANT}/sdk-space`)) as Record<
      string,
      JsonValue
    >
    eq('the card sdk replaces the stored one in tags', moved2.tags ?? null, ['docker'])
    eq('the rendered sdk agrees with the tag', moved2.sdk ?? null, 'docker')
    eq(
      'the old sdk no longer matches',
      ids(await get(fake.endpoint, '/api/spaces?filter=gradio')),
      [],
    )

    // A card key the parser does not model is dropped WHOLE. Half-collecting
    // it put the string "name: text" into dataset_info, which is worse than
    // losing the key because it renders malformed cardData to a client.
    const nested = await fetch(`${fake.endpoint}/api/repos/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'nested-card', type: 'dataset' }),
    })
    check('a dataset for the nested card is created', nested.status === 200, String(nested.status))
    // Modelled on rajpurkar/squad, whose card carries all three constructs
    // this subset refuses AND every dataset facet field. `configs:` is the
    // one that has no indented `key:` line at all: its single item IS the
    // mapping, so only the item-shape rule catches it.
    const nestedCard = [
      '---',
      'license: mit',
      'annotations_creators:',
      '  - crowdsourced',
      'language_creators:',
      '  - crowdsourced',
      '  - found',
      'language:',
      '  - en',
      'multilinguality:',
      '  - monolingual',
      'size_categories:',
      '  - 10K<n<100K',
      'source_datasets:',
      '  - extended|wikipedia',
      'task_categories:',
      '  - question-answering',
      'task_ids:',
      '  - extractive-qa',
      'extra_gated_prompt: |',
      '  You agree not to do bad things.',
      '  Second line.',
      'dataset_info:',
      '  features:',
      '  - name: text',
      '    dtype: string',
      'configs:',
      '  - config_name: default',
      'pretty_name: Nested',
      '---',
      '',
      '# Nested',
      '',
    ].join('\n')
    const pushedCard = await fetch(
      `${fake.endpoint}/api/datasets/${TENANT}/nested-card/commit/main`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
        body: [
          JSON.stringify({ key: 'header', value: { summary: 'add a nested card' } }),
          JSON.stringify({ key: 'file', value: { path: 'README.md', content: nestedCard } }),
        ].join('\n'),
      },
    )
    check('the nested card lands', pushedCard.status === 200, String(pushedCard.status))
    const nestedInfo = (await get(fake.endpoint, `/api/datasets/${TENANT}/nested-card`)) as Record<
      string,
      JsonValue
    >
    const nestedData = (nestedInfo.cardData ?? {}) as Record<string, JsonValue>
    check(
      'a nested mapping key is omitted, not half-collected',
      nestedData.dataset_info === undefined,
      JSON.stringify(nestedData.dataset_info ?? null),
    )
    check(
      'a bare sequence of mappings is omitted too',
      nestedData.configs === undefined,
      JSON.stringify(nestedData.configs ?? null),
    )
    check(
      'a block scalar is omitted rather than stored as "|"',
      nestedData.extra_gated_prompt === undefined,
      JSON.stringify(nestedData.extra_gated_prompt ?? null),
    )
    eq('and the key after all three still parses', nestedData.pretty_name ?? null, 'Nested')
    eq('the keys before them still parse', nestedData.license ?? null, 'mit')
    // The facet list the real squad card produces on the Hub, minus the
    // facets derived from files and hosting (format:, modality:, library:,
    // region:) that a card-only fake cannot know.
    eq('every dataset card facet is spelled', nestedInfo.tags ?? null, [
      'annotations_creators:crowdsourced',
      'language:en',
      'language_creators:crowdsourced',
      'language_creators:found',
      'license:mit',
      'multilinguality:monolingual',
      'size_categories:10K<n<100K',
      'source_datasets:extended|wikipedia',
      'task_categories:question-answering',
      'task_ids:extractive-qa',
    ])

    // ---- a CRLF card is still a card
    // A README uploaded from Windows has CRLF, which is legal YAML. The
    // opening fence did not match it, so the whole card read as absent and
    // cardData, sdk and every facet vanished without an error anywhere.
    await repoWithCard(
      fake.endpoint,
      'models',
      'crlf-model',
      ['---', 'license: mit', '---', '', '# CRLF', ''].join('\r\n'),
    )
    const crlf = (await get(fake.endpoint, `/api/models/${TENANT}/crlf-model`)) as Record<
      string,
      JsonValue
    >
    eq(
      'a CRLF card parses',
      ((crlf.cardData ?? {}) as Record<string, JsonValue>).license ?? null,
      'mit',
    )
    eq('a CRLF card yields its facets', crlf.tags ?? null, ['license:mit'])

    // ---- base_model is card-derived, so it is a facet
    // The Hub also emits a relationship form (`base_model:finetune:X`,
    // `base_model:quantized:X`). That one is its own analysis of the model,
    // not a card field, so it belongs with arxiv:/region:/format: among the
    // facets a card-only fake cannot know.
    await repoWithCard(
      fake.endpoint,
      'models',
      'derived-model',
      [
        '---',
        'license: apache-2.0',
        'library_name: transformers',
        'pipeline_tag: text-generation',
        'base_model:',
        '  - acme/base',
        '---',
        '',
        '# Derived',
        '',
      ].join('\n'),
    )
    const derived = (await get(fake.endpoint, `/api/models/${TENANT}/derived-model`)) as Record<
      string,
      JsonValue
    >
    eq('base_model is spelled as the Hub spells it', derived.tags ?? null, [
      'base_model:acme/base',
      'license:apache-2.0',
      'text-generation',
      'transformers',
    ])
    eq(
      'a model is reachable by its base_model facet',
      ids(await get(fake.endpoint, '/api/models?filter=base_model:acme/base')),
      [`${TENANT}/derived-model`],
    )

    // ---- an inline comment is a comment, and a bare # is not
    // `license: mit # SPDX` kept its tail, so the facet read
    // `license:mit # SPDX` and an ordinary ?filter=license:mit missed it.
    // The two literal cases have to survive: YAML starts a comment only at a
    // `#` preceded by whitespace, and never inside quotes.
    await repoWithCard(
      fake.endpoint,
      'models',
      'commented',
      [
        '---',
        'license: bsd-3-clause # SPDX identifier',
        'library_name: transformers # the library',
        'pipeline_tag: text-generation',
        'tags:',
        '  - some#tag',
        '  - conversational # a real comment',
        '---',
        '',
        '# Commented',
        '',
      ].join('\n'),
    )
    const commented = (await get(fake.endpoint, `/api/models/${TENANT}/commented`)) as Record<
      string,
      JsonValue
    >
    eq('an inline comment is stripped, a bare # is kept', commented.tags ?? null, [
      'conversational',
      'license:bsd-3-clause',
      'some#tag',
      'text-generation',
      'transformers',
    ])
    eq(
      'the commented card is reachable by the plain facet',
      ids(await get(fake.endpoint, '/api/models?filter=license:bsd-3-clause')),
      [`${TENANT}/commented`],
    )

    // ---- a tree page's Link header carries the run it was reached through
    // The request flow strips `/_run/<id>` before a handler sees the path, so
    // a Link header built from ctx.url alone pointed page two at the DEFAULT
    // run. Only the path channel can express this, which is the point of it:
    // a mount hands its base URL to a vendor SDK and never sees the request
    // again, so a header or a query parameter cannot survive the handoff.
    const RUN = 'hf-hub-page'
    const scoped = `${fake.endpoint}/_run/${RUN}`
    const mkRepo = await fetch(`${scoped}/api/repos/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'paged', type: 'model' }),
    })
    check('a repo is created inside the run', mkRepo.status === 200, String(mkRepo.status))
    const three = await fetch(`${scoped}/api/models/${TENANT}/paged/commit/main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/x-ndjson' },
      body: [
        JSON.stringify({ key: 'header', value: { summary: 'three files' } }),
        JSON.stringify({ key: 'file', value: { path: 'a.txt', content: 'a' } }),
        JSON.stringify({ key: 'file', value: { path: 'b.txt', content: 'b' } }),
        JSON.stringify({ key: 'file', value: { path: 'c.txt', content: 'c' } }),
      ].join('\n'),
    })
    check('the run gets three files', three.status === 200, String(three.status))
    const pageOne = await fetch(`${scoped}/api/models/${TENANT}/paged/tree/main?limit=2`, {
      headers: { Authorization: `Bearer ${TENANT}` },
    })
    const link = pageOne.headers.get('link') ?? ''
    check(
      'the next-page Link carries the run prefix',
      link.includes(`/_run/${RUN}/api/models/`),
      link,
    )
    // Followed rather than only inspected: the prefix is only worth anything
    // if the URL it produces answers from the same world.
    const next = await fetch(link.slice(1, link.indexOf('>')), {
      headers: { Authorization: `Bearer ${TENANT}` },
    })
    check('page two is 200', next.status === 200, String(next.status))
    eq(
      'page two holds this run rows, not the default run',
      ((await next.json()) as JsonValue[]).map((r) =>
        String((r as Record<string, JsonValue>).path ?? ''),
      ),
      ['c.txt'],
    )

    const unauth = await fetch(`${fake.endpoint}/api/models`)
    check('an unauthenticated listing is refused', unauth.status === 401, String(unauth.status))

    await mcpChecks()
    await launchChecks()

    process.stdout.write(`hf_hub selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
