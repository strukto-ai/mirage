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
import { DEFAULT_TENANT } from '../kit/typescript/tenant.ts'
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

// A 1x1 PNG. Written out rather than generated so the bytes in the fixture
// are the bytes an image decoder accepts, signature included.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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
    // The whole tool result, not just its prose: `isError` lives beside the
    // content and the per-operation error objects live inside
    // structuredContent, and neither is visible in the rendered markdown.
    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, JsonValue>> =>
      (await client.callTool({ name, arguments: args })) as Record<string, JsonValue>
    const errorOf = (out: Record<string, JsonValue>, i = 0): Record<string, JsonValue> => {
      const structured = (out.structuredContent ?? {}) as Record<string, JsonValue>
      const rows = (structured.results ?? []) as Record<string, JsonValue>[]
      return ((rows[i] ?? {}).error ?? {}) as Record<string, JsonValue>
    }
    const ops = (...list: Record<string, unknown>[]): Record<string, unknown> => ({
      operations: list,
    })
    const catOp = (uri: string, ...rest: string[]): Record<string, unknown> => ({
      cmd: 'cat',
      args: [uri, ...rest],
    })

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

    // A bare cat is bounded, and the two flags that move the bound are the
    // ones the captured tool document advertises. Without this a caller has
    // no way to read the head of a large file, and no way to learn that the
    // bytes stopped early -- which on a repository holding one 20MB file is
    // the difference between a tool result and a context window.
    const bounded = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/README.md', '--max-bytes', '16'] },
      ],
    })
    check('--max-bytes bounds the read', bounded.includes('Bytes: 16'), bounded.slice(0, 240))
    check(
      'and a bounded read says where it stopped',
      bounded.includes('Content truncated. Resume with offset 16.'),
      bounded.slice(0, 240),
    )
    const offset = await text('hf_fs', {
      operations: [
        {
          cmd: 'cat',
          args: ['hf://models/integ/card-model/README.md', '--offset', '8', '--max-bytes', '8'],
        },
      ],
    })
    check('--offset moves the window', offset.includes('Bytes: 8'), offset.slice(0, 240))
    // Upstream prints no `Offset:` line even when one was asked for, and never
    // names the file's total size. A caller learns that there is more and
    // where to resume, and nothing else.
    check('and the window is not announced', !offset.includes('Offset:'), offset.slice(0, 240))
    check(
      'and the resume point counts from the file, not the window',
      offset.includes('Content truncated. Resume with offset 16.'),
      offset.slice(0, 240),
    )
    const past = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/README.md', '--offset', '99999'] },
      ],
    })
    check('an offset past the end reads nothing', past.includes('Bytes: 0'), past.slice(0, 240))

    // Zero is the MAXIMUM upstream, not an empty read: the documented range is
    // "between 0 and 80000", and `--max-bytes 0` against a 466KB file on the
    // live server answers 80,000 bytes. On a README that fits, it is the whole
    // file -- so a zero-bound read and a default read agree exactly.
    const plain = await text('hf_fs', {
      operations: [{ cmd: 'cat', args: ['hf://models/integ/card-model/README.md'] }],
    })
    const zero = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/README.md', '--max-bytes', '0'] },
      ],
    })
    check('a zero bound reads the maximum, not nothing', zero === plain, zero.slice(0, 200))
    const over = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/README.md', '--max-bytes', '80001'] },
      ],
    })
    check(
      'a bound above the ceiling is refused rather than clamped',
      over.includes('[HF_FS_INVALID_ARGUMENT]') &&
        over.includes('max_bytes must be between 0 and 80000'),
      over.slice(0, 200),
    )
    const negative = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/README.md', '--max-bytes', '-1'] },
      ],
    })
    // A sign parses and then fails the RANGE test, which is the order upstream
    // answers in: the caller learns which rule it broke, not merely that it
    // typed something wrong.
    check(
      'a negative bound is out of range rather than unparsable',
      negative.includes('max_bytes must be between 0 and 80000'),
      negative.slice(0, 200),
    )
    const negOffset = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/README.md', '--offset', '-1'] },
      ],
    })
    check(
      'and a negative offset has its own sentence',
      negOffset.includes('offset must be non-negative'),
      negOffset.slice(0, 200),
    )
    const junk = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/README.md', '--max-bytes', 'lots'] },
      ],
    })
    check(
      'a non-numeric bound is refused rather than guessed at',
      junk.includes('[HF_FS_INVALID_ARGUMENT]') && junk.includes('--max-bytes requires an integer'),
      junk.slice(0, 200),
    )
    const unknown = await text('hf_fs', {
      operations: [{ cmd: 'cat', args: ['hf://models/integ/card-model/README.md', '--recursive'] }],
    })
    check(
      'and a flag cat does not have is still refused',
      unknown.includes('[HF_FS_INVALID_ARGUMENT]'),
      unknown.slice(0, 200),
    )

    // A bound that lands INSIDE a multi-byte character. Cut there, both halves
    // come back as U+FFFD and `next_offset` names a byte the caller never got
    // whole, so no sequence of pages reassembles the file. Pushed through the
    // REST arm of the same server the tool reads, under the tenant an
    // unauthenticated MCP call resolves to.
    //
    // `a\u00e9bc` is 5 bytes -- 0x61, then 0xC3 0xA9, then 0x62 0x63 -- so a
    // 2-byte bound falls between the two bytes of the second character.
    const pushedUtf8 = await fetch(`${mcp.rest.endpoint}/api/models/integ/card-model/commit/main`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_TENANT}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: [
        JSON.stringify({ key: 'header', value: { summary: 'add a multi-byte file' } }),
        JSON.stringify({ key: 'file', value: { path: 'utf8.txt', content: 'a\u00e9bc' } }),
        // 300 bytes that are all continuation bytes, which no UTF-8 sequence
        // can be. Pushed twice under two names, because upstream decides by
        // the NAME: `.bin` is refused unread, while the same bytes under a
        // text extension are served and have to be bounded instead.
        // A file inside a directory, so the repository HAS one: `cat` and
        // `stat` both have to tell a directory from a missing path, and a
        // flat repo cannot prove either.
        JSON.stringify({ key: 'file', value: { path: 'nested/note.txt', content: 'in a dir\n' } }),
        // A REAL 1x1 PNG, header and all, because attach returns the bytes
        // untouched and a caller decodes them.
        JSON.stringify({
          key: 'file',
          value: { path: 'figures/fig1.png', encoding: 'base64', content: PNG_1X1 },
        }),
        // A DIRECTORY whose name ends in an image extension. Nothing stops a
        // repository holding one, and it is the one shape where classifying
        // on the name alone gives the wrong answer.
        JSON.stringify({ key: 'file', value: { path: 'assets.png/inside.txt', content: 'x\n' } }),
        ...['binary.bin', 'invalid.txt'].map((path) =>
          JSON.stringify({
            key: 'file',
            value: {
              path,
              encoding: 'base64',
              content: Buffer.alloc(300, 0x80).toString('base64'),
            },
          }),
        ),
      ].join('\n'),
    })
    check(
      'a multi-byte file and two non-text blobs are pushed',
      pushedUtf8.status === 200,
      String(pushedUtf8.status),
    )
    const cut = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/utf8.txt', '--max-bytes', '2'] },
      ],
    })
    check(
      'a bound inside a character does not split it',
      !cut.includes('\ufffd'),
      cut.slice(0, 240),
    )
    check(
      'the read stops on the character boundary instead',
      cut.includes('Bytes: 3') && cut.includes('Content truncated. Resume with offset 3.'),
      cut.slice(0, 240),
    )
    const rest2 = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/utf8.txt', '--offset', '3'] },
      ],
    })
    // The two pages concatenate back into the file, which is the whole point
    // of reporting an offset to continue from. A rendered page is a header, a
    // blank line, the file's own bytes, and -- only when there is more -- a
    // blank line and the resume notice, so peel both ends.
    const catBody = (rendered: string): string => {
      const body = rendered.slice(rendered.indexOf('\n\n', rendered.indexOf('Bytes: ')) + 2)
      const notice = body.lastIndexOf('\n\nContent truncated.')
      return (notice === -1 ? body : body.slice(0, notice)).trimEnd()
    }
    check(
      'and the next offset returns the remainder',
      `${catBody(cut)}${catBody(rest2)}` === 'a\u00e9bc',
      JSON.stringify(`${catBody(cut)}|${catBody(rest2)}`),
    )

    // An offset the CALLER picked, landing inside the second character. It
    // retreats to that character's start rather than decoding half of it, so
    // the page begins `\u00e9` and carries no U+FFFD.
    const inside = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/utf8.txt', '--offset', '2'] },
      ],
    })
    check(
      'an offset inside a character retreats to its start',
      catBody(inside) === '\u00e9bc' && !inside.includes('\ufffd'),
      JSON.stringify(catBody(inside)),
    )
    check(
      'and the page counts the whole character',
      inside.includes('Bytes: 4'),
      inside.slice(0, 240),
    )

    // `cat` is text-only upstream, and refuses on the extension without
    // reading the blob. The task fixtures carry pytorch_model.bin, so a fake
    // that served these bytes would hand an agent a page the live server
    // never would.
    const refused = await text('hf_fs', {
      operations: [{ cmd: 'cat', args: ['hf://models/integ/card-model/binary.bin'] }],
    })
    check(
      'cat refuses a binary name outright',
      refused.includes('[HF_FS_TEXT_ONLY]') &&
        refused.includes('Refusing to cat non-text file: binary.bin'),
      refused.slice(0, 240),
    )
    check(
      'and says what to use instead',
      refused.includes('Use stat for metadata or ls on the parent directory.'),
      refused.slice(0, 300),
    )

    // The boundary walk is CAPPED, and the cap is what keeps the bound a
    // bound. A text extension is not a promise of text: every byte of this
    // file is a continuation byte, so an uncapped walk would run to the end
    // and return all 300.
    const blob = await text('hf_fs', {
      operations: [
        { cmd: 'cat', args: ['hf://models/integ/card-model/invalid.txt', '--max-bytes', '8'] },
      ],
    })
    check(
      'a run of continuation bytes does not carry the read past the bound',
      blob.includes('Bytes: 11') && blob.includes('Content truncated. Resume with offset 11.'),
      blob.slice(0, 260),
    )

    // ---- the error envelope
    //
    // Every line below was read off https://huggingface.co/mcp. None of it is
    // visible in the rendered markdown, and an agent that branches on a code
    // or on `isError` sees only this.
    const noSuchFile = await call('hf_fs', ops(catOp('hf://models/integ/card-model/nope.txt')))
    eq('a missing file is HF_FS_NOT_FOUND', errorOf(noSuchFile).code ?? null, 'HF_FS_NOT_FOUND')
    // `stat` answers a missing path, a directory and a binary blob without
    // erroring on any of them, so it is the command upstream names for all
    // three -- and names for nothing else.
    eq('and suggests stat', errorOf(noSuchFile).suggestedOperation ?? null, 'stat')
    eq('and the whole result is an error', noSuchFile.isError ?? null, true)

    const binary = await call('hf_fs', ops(catOp('hf://models/integ/card-model/binary.bin')))
    eq('a binary name is HF_FS_TEXT_ONLY', errorOf(binary).code ?? null, 'HF_FS_TEXT_ONLY')
    eq('and suggests stat too', errorOf(binary).suggestedOperation ?? null, 'stat')

    // Three shapes of "that is not a file", each with its own sentence.
    const atRepo = await call('hf_fs', ops(catOp('hf://models/integ/card-model')))
    eq('a repo root is HF_FS_NOT_A_FILE', errorOf(atRepo).code ?? null, 'HF_FS_NOT_A_FILE')
    eq(
      'and says so in upstream words',
      errorOf(atRepo).message ?? null,
      'cat requires a URI that points to a file path.',
    )
    const atNamespace = await call('hf_fs', ops(catOp('hf://models/integ')))
    eq(
      'a namespace is HF_FS_NOT_A_FILE as well',
      errorOf(atNamespace).message ?? null,
      'cat requires a URI that points to a file path, not a namespace.',
    )
    const atDir = await call('hf_fs', ops(catOp('hf://models/integ/card-model/nested')))
    eq(
      'and a directory names itself',
      errorOf(atDir).message ?? null,
      'cat requires a file path, got dir: nested',
    )
    eq('all three suggest stat', errorOf(atDir).suggestedOperation ?? null, 'stat')

    // A malformed argument is the caller's to fix, so upstream suggests
    // nothing -- the key is absent rather than null.
    const flag = await call('hf_fs', ops(catOp('hf://models/integ/card-model/README.md', '--nope')))
    eq('a bad flag is HF_FS_INVALID_ARGUMENT', errorOf(flag).code ?? null, 'HF_FS_INVALID_ARGUMENT')
    check(
      'and suggests nothing at all',
      !('suggestedOperation' in errorOf(flag)),
      JSON.stringify(errorOf(flag)),
    )
    const scheme = await call('hf_fs', ops(catOp('/not/a/uri')))
    eq(
      'a URI without the scheme says so upstream way',
      errorOf(scheme).message ?? null,
      'EINVAL: URI must start with hf://',
    )
    const bogus = await call('hf_fs', ops(catOp('hf://bogus/x/y')))
    eq(
      'and a type upstream does not have is named against upstream list',
      errorOf(bogus).message ?? null,
      "EINVAL: Invalid URI type 'bogus'. Must be one of models, datasets, spaces, buckets, collections, papers.",
    )
    // `papers` IS one of upstream's roots; this fake simply holds no rows for
    // it, and saying that is more use than calling the name invalid.
    const unserved = await call('hf_fs', ops(catOp('hf://papers/2502.16161/metadata.json')))
    check(
      'a real root the fake does not serve says which it serves',
      String(errorOf(unserved).message ?? '').includes('the mirage hf_hub fake serves'),
      JSON.stringify(errorOf(unserved).message ?? null),
    )

    // `isError` is the whole batch's, and one success clears it.
    const bothBad = await call(
      'hf_fs',
      ops(catOp('hf://models/integ/card-model/nope.txt'), catOp('/not/a/uri')),
    )
    eq('a batch where everything failed is an error', bothBad.isError ?? null, true)
    const mixed = await call(
      'hf_fs',
      ops(
        catOp('hf://models/integ/card-model/README.md'),
        catOp('hf://models/integ/card-model/nope.txt'),
      ),
    )
    check('but one success clears it', !('isError' in mixed), JSON.stringify(mixed.isError ?? null))

    // ---- attach
    //
    // The live server returns a COMPLETE image and cannot truncate one, so
    // every refusal below is a refusal rather than a cut. All four codes and
    // all four sentences were read off https://huggingface.co/mcp.
    const attach = (uri: string, ...rest: string[]): Record<string, unknown> => ({
      cmd: 'attach',
      args: [uri, ...rest],
    })
    const png = await call('hf_fs', ops(attach('hf://models/integ/card-model/figures/fig1.png')))
    const blocks = (png.content ?? []) as Record<string, JsonValue>[]
    check(
      'attach returns the image beside the prose',
      blocks.some((one) => one.type === 'image' && one.mimeType === 'image/png'),
      JSON.stringify(blocks.map((one) => one.type)),
    )
    check(
      'and the bytes are the file, decodable',
      Buffer.from(String((blocks.find((one) => one.type === 'image') ?? {}).data ?? ''), 'base64')
        .subarray(0, 8)
        .toString('hex') === '89504e470d0a1a0a',
      String((blocks.find((one) => one.type === 'image') ?? {}).data ?? '').slice(0, 24),
    )
    const attachText = blocks.map((one) => String(one.text ?? '')).join('')
    check(
      'and the prose names the MIME type',
      attachText.includes('- MIME type: `image/png`'),
      attachText.slice(0, 240),
    )
    check('and a whole-file byte count', attachText.includes('- Bytes: '), attachText.slice(0, 240))

    // A text file is the wrong KIND of thing, and upstream names `cat` for it
    // rather than the diagnostic `stat` it names everywhere else.
    const asText = await call('hf_fs', ops(attach('hf://models/integ/card-model/README.md')))
    eq('attaching text is HF_FS_IMAGE_ONLY', errorOf(asText).code ?? null, 'HF_FS_IMAGE_ONLY')
    eq(
      'and says so upstream way',
      errorOf(asText).message ?? null,
      'Refusing to attach known text file: README.md. Attach returns supported image files only.',
    )
    eq('and points at cat, not stat', errorOf(asText).suggestedOperation ?? null, 'cat')

    const asBinary = await call('hf_fs', ops(attach('hf://models/integ/card-model/binary.bin')))
    eq(
      'a non-image binary is unsupported media',
      errorOf(asBinary).code ?? null,
      'HF_FS_UNSUPPORTED_MEDIA',
    )
    const asDir = await call('hf_fs', ops(attach('hf://models/integ/card-model/nested')))
    eq('and so is a directory', errorOf(asDir).code ?? null, 'HF_FS_UNSUPPORTED_MEDIA')

    const tooSmall = await call(
      'hf_fs',
      ops(attach('hf://models/integ/card-model/figures/fig1.png', '--max-bytes', '1')),
    )
    eq(
      'a bound under the file size refuses rather than truncating',
      errorOf(tooSmall).code ?? null,
      'HF_FS_IMAGE_TOO_LARGE',
    )
    const overCeiling = await call(
      'hf_fs',
      ops(attach('hf://models/integ/card-model/figures/fig1.png', '--max-bytes', '25000000')),
    )
    // The bound an agent reached for when it tried to pull a 21MB file past
    // cat's limit. Upstream names its ceiling; this fake used to answer that
    // attach did not exist.
    eq(
      'and a bound over the ceiling names the ceiling',
      errorOf(overCeiling).message ?? null,
      'EINVAL: attach max_bytes must be between 1 and 8388608',
    )
    const zeroBound = await call(
      'hf_fs',
      ops(attach('hf://models/integ/card-model/figures/fig1.png', '--max-bytes', '0')),
    )
    // Zero is INVALID for attach where `cat --max-bytes 0` means the maximum.
    // The two commands genuinely differ; each was read off the live server.
    eq(
      'zero is invalid here, unlike cat',
      errorOf(zeroBound).message ?? null,
      'EINVAL: attach max_bytes must be between 1 and 8388608',
    )
    const withOffset = await call(
      'hf_fs',
      ops(attach('hf://models/integ/card-model/figures/fig1.png', '--offset', '5')),
    )
    eq(
      'and --offset is meaningless for a whole file',
      errorOf(withOffset).message ?? null,
      'EINVAL: unexpected argument for attach: --offset',
    )
    const goneImage = await call('hf_fs', ops(attach('hf://models/integ/card-model/nope.png')))
    eq('a missing image is HF_FS_NOT_FOUND', errorOf(goneImage).code ?? null, 'HF_FS_NOT_FOUND')

    // A directory that ends in `.png` is still a directory. Classified on the
    // name alone it reads as an image, resolves to nothing, and would be
    // reported as a file that does not exist -- of a path that does.
    const dirNamedPng = await call('hf_fs', ops(attach('hf://models/integ/card-model/assets.png')))
    eq(
      'a directory named like an image is still unsupported media',
      errorOf(dirNamedPng).code ?? null,
      'HF_FS_UNSUPPORTED_MEDIA',
    )
    // `cat` answers TEXT_ONLY for the same path, and that is not an
    // oversight: upstream refuses binary on the NAME, before it resolves
    // anything -- "the file extension or MIME type is known to be binary" --
    // so a directory called `assets.png` never reaches a directory check
    // there either. attach differs because its name check is what SELECTS
    // the image branch, so the mistake is only recoverable after the resolve.
    const catDirPng = await call('hf_fs', ops(catOp('hf://models/integ/card-model/assets.png')))
    eq(
      'cat refuses it on the name, as upstream does',
      errorOf(catDirPng).code ?? null,
      'HF_FS_TEXT_ONLY',
    )
    const statDirPng = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://models/integ/card-model/assets.png'] }],
    })
    check('and stat calls it a dir', statDirPng.includes('- Type: `dir`'), statDirPng.slice(0, 200))

    // ---- roots the fake does not hold are not bad NAMES
    //
    // `docs` is addressable upstream, so calling it an invalid TYPE was wrong;
    // it is a root this fake does not hold, which is a different sentence.
    // `README.md` was in here too until the fake started serving it, and the
    // pair is worth keeping side by side: one of these is a gap and the other
    // was, and only the served one stops charging the agent for our name.
    const docs = await call('hf_fs', ops(catOp('hf://docs/transformers/index')))
    check(
      'an unserved root says which roots are served',
      String(errorOf(docs).message ?? '').includes('the mirage hf_hub fake serves'),
      JSON.stringify(errorOf(docs).message ?? null),
    )

    // ---- a repository past one page
    //
    // The REST arm pages at DEFAULT_LIMIT and puts the cursor in a `Link`
    // header. Reading only page one made this fake disagree with itself on
    // any repository bigger than that: `ls` showed a prefix in silence, and
    // `stat` called a file that exists `missing`, because the recursive tree
    // it searched stopped before reaching it. 60 files is one page and a
    // remainder.
    const PAGED = 60
    await fetch(`${mcp.rest.endpoint}/api/repos/create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_TENANT}`,
        'Content-Type': 'application/json',
      },
      // The namespace is the repo's OWNER, which the create route takes from
      // `organization` and otherwise from the bearer -- and the bearer here
      // is the default tenant, not `integ`.
      body: JSON.stringify({ name: 'paged-model', type: 'model', organization: 'integ' }),
    })
    const pushedMany = await fetch(
      `${mcp.rest.endpoint}/api/models/integ/paged-model/commit/main`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${DEFAULT_TENANT}`,
          'Content-Type': 'application/x-ndjson',
        },
        body: [
          JSON.stringify({ key: 'header', value: { summary: 'more than one page' } }),
          ...Array.from({ length: PAGED }, (_unused, i) =>
            JSON.stringify({
              key: 'file',
              value: { path: `f${String(i).padStart(3, '0')}.txt`, content: `row ${String(i)}\n` },
            }),
          ),
        ].join('\n'),
      },
    )
    check(
      'a repository of 60 files is pushed',
      pushedMany.status === 200,
      String(pushedMany.status),
    )
    const lastFile = `f${String(PAGED - 1).padStart(3, '0')}.txt`
    const paged = await call('hf_fs', ops({ cmd: 'ls', args: ['hf://models/integ/paged-model'] }))
    const pagedRows = (
      (
        (((paged.structuredContent ?? {}) as Record<string, JsonValue>).results ?? []) as Record<
          string,
          JsonValue
        >[]
      )[0] ?? {}
    ).result as Record<string, JsonValue>
    check(
      'ls returns every page, not the first',
      ((pagedRows.entries ?? []) as JsonValue[]).length === PAGED,
      String(((pagedRows.entries ?? []) as JsonValue[]).length),
    )
    // ---- and the listing is bounded, by upstream's number
    //
    // 1,000 entries by default and 10,000 at most. The bound matters twice:
    // it is what upstream answers, and it is what stops an arbitrarily large
    // repository being aggregated whole in order to throw most of it away.
    const capped = await call(
      'hf_fs',
      ops({ cmd: 'ls', args: ['hf://models/integ/paged-model', '--limit', '10'] }),
    )
    const cappedRow = (
      (((capped.structuredContent ?? {}) as Record<string, JsonValue>).results ?? []) as Record<
        string,
        JsonValue
      >[]
    )[0]
    const cappedResult = (cappedRow ?? {}).result as Record<string, JsonValue>
    eq('--limit bounds the listing', ((cappedResult.entries ?? []) as JsonValue[]).length, 10)
    eq('and says it was cut', cappedResult.truncated ?? null, true)
    eq('in the schema own vocabulary', cappedResult.truncation_reason ?? null, 'entry_limit')
    const cappedText = ((capped.content ?? []) as Record<string, JsonValue>[])
      .map((one) => String(one.text ?? ''))
      .join('')
    check(
      'and after the table, the way upstream places it',
      cappedText.includes(
        'Result truncated after reaching the entry limit. Rerun with a larger --limit, up to 10000.',
      ),
      cappedText.slice(-200),
    )
    // A listing that FITS is not cut, and says nothing about limits.
    const uncut = await call(
      'hf_fs',
      ops({ cmd: 'ls', args: ['hf://models/integ/paged-model', '--limit', '60'] }),
    )
    const uncutResult = (
      (
        (((uncut.structuredContent ?? {}) as Record<string, JsonValue>).results ?? []) as Record<
          string,
          JsonValue
        >[]
      )[0] ?? {}
    ).result as Record<string, JsonValue>
    check(
      'a listing that fits is not marked truncated',
      !('truncated' in uncutResult),
      JSON.stringify(Object.keys(uncutResult)),
    )
    const badLimit = await call(
      'hf_fs',
      ops({ cmd: 'ls', args: ['hf://models/integ/paged-model', '--limit', '20000'] }),
    )
    eq(
      'a limit past the ceiling names the ceiling',
      errorOf(badLimit).message ?? null,
      'EINVAL: limit must be between 1 and 10000 for this command',
    )
    const otherFlag = await call(
      'hf_fs',
      ops({ cmd: 'ls', args: ['hf://models/integ/paged-model', '--sort', 'downloads'] }),
    )
    eq(
      'and a flag the fake has nothing behind is still an honest EINVAL',
      errorOf(otherFlag).message ?? null,
      'EINVAL: unexpected argument for ls: --sort',
    )

    const statLate = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: [`hf://models/integ/paged-model/${lastFile}`] }],
    })
    check(
      'and stat finds a file past the first page',
      statLate.includes('- Type: `file`') && statLate.includes('- Exists: yes'),
      statLate.slice(0, 220),
    )

    // ---- the shared attachment budget
    //
    // 8MiB across ONE call, whatever the per-file bound allows. The captured
    // schema permits 30 operations, so without this a valid request could ask
    // for 30 x 8MiB. Two 5MiB images are one over.
    const FIVE_MIB = 5 * 1024 * 1024
    const bigPng = Buffer.concat([
      Buffer.from(PNG_1X1, 'base64'),
      Buffer.alloc(FIVE_MIB, 0),
    ]).toString('base64')
    const pushedBig = await fetch(`${mcp.rest.endpoint}/api/models/integ/card-model/commit/main`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DEFAULT_TENANT}`,
        'Content-Type': 'application/x-ndjson',
      },
      body: [
        JSON.stringify({ key: 'header', value: { summary: 'two large images' } }),
        JSON.stringify({
          key: 'file',
          value: { path: 'figures/big1.png', encoding: 'base64', content: bigPng },
        }),
        JSON.stringify({
          key: 'file',
          value: { path: 'figures/big2.png', encoding: 'base64', content: bigPng },
        }),
      ].join('\n'),
    })
    check('two 5MiB images are pushed', pushedBig.status === 200, String(pushedBig.status))
    const twoBig = await call(
      'hf_fs',
      ops(
        attach('hf://models/integ/card-model/figures/big1.png'),
        attach('hf://models/integ/card-model/figures/big2.png'),
      ),
    )
    const rowsOf = (out: Record<string, JsonValue>): Record<string, JsonValue>[] =>
      (((out.structuredContent ?? {}) as Record<string, JsonValue>).results ?? []) as Record<
        string,
        JsonValue
      >[]
    eq('the first attachment is admitted', (rowsOf(twoBig)[0] ?? {}).status ?? null, 'success')
    eq(
      'and the second is dropped on the shared budget',
      errorOf(twoBig, 1).code ?? null,
      'HF_FS_ATTACHMENT_BUDGET_EXCEEDED',
    )
    eq(
      'with upstream sentence',
      errorOf(twoBig, 1).message ?? null,
      'Attachment omitted because the batch exceeds the cumulative response limit of 8388608 bytes.',
    )
    eq('and told to retry it alone', errorOf(twoBig, 1).suggestedOperation ?? null, 'attach')
    check(
      'only the admitted image rides along',
      ((twoBig.content ?? []) as Record<string, JsonValue>[]).filter((one) => one.type === 'image')
        .length === 1,
      JSON.stringify(((twoBig.content ?? []) as Record<string, JsonValue>[]).map((o) => o.type)),
    )

    // ---- stat tells four things apart, which is why upstream recommends it
    // for "an uncertain target type". A repository is `repo` and not `dir`,
    // and a path that is not there is `missing` and not a directory -- the
    // fake reported both wrongly until the tree's ROWS became the test.
    const statRepo = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://models/integ/card-model'] }],
    })
    check(
      'stat calls a repository a repo',
      statRepo.includes('- Type: `repo`'),
      statRepo.slice(0, 200),
    )
    const statDir = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://models/integ/card-model/nested'] }],
    })
    check('and a directory a dir', statDir.includes('- Type: `dir`'), statDir.slice(0, 200))
    const statGone = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://models/integ/card-model/nope.txt'] }],
    })
    check(
      'and a path that is not there missing',
      statGone.includes('- Exists: no') && statGone.includes('- Type: `missing`'),
      statGone.slice(0, 200),
    )
    check(
      'and prints the path even then',
      statGone.includes('- Path: `nope.txt`'),
      statGone.slice(0, 200),
    )

    const stat = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://models/integ/card-model/README.md'] }],
    })
    check('stat reports existence', stat.includes('- Exists: yes'), stat.slice(0, 200))
    check('stat reports a size', stat.includes('- Size: '), stat.slice(0, 200))

    // A file one level down, which is the case stat reads a PARENT listing
    // for rather than the repository root. It used to walk the whole recursive
    // tree to find this row, and paid the repository to keep one entry.
    const statNested = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://models/integ/card-model/nested/note.txt'] }],
    })
    check(
      'stat finds a file inside a directory, with its size',
      statNested.includes('- Type: `file`') &&
        statNested.includes('- Path: `nested/note.txt`') &&
        /- Size: \d/.test(statNested),
      statNested.slice(0, 220),
    )
    // Absent from a directory that IS there -- the listing consulted has to be
    // the parent's, and a row missing from it is what `missing` means.
    const statNestedGone = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://models/integ/card-model/nested/nope.txt'] }],
    })
    check(
      'and calls a name absent from an existing directory missing',
      statNestedGone.includes('- Type: `missing`') && statNestedGone.includes('- Exists: no'),
      statNestedGone.slice(0, 220),
    )
    // A directory below the root is a `dir` too, which only the parent's
    // synthesized row can say: git commits no directory object of its own.
    const statNestedDir = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://models/integ/card-model/assets.png'] }],
    })
    check(
      'and a directory whose name looks like a file is still a dir',
      statNestedDir.includes('- Type: `dir`'),
      statNestedDir.slice(0, 220),
    )

    // ---- hf://README.md, the limits page the tool document points at
    //
    // Every expectation below was read off the live server, including which
    // of the two "wrong kind of thing" codes each command answers with. The
    // fake used to refuse the path outright, in a sentence naming itself.
    const readmeStat = await text('hf_fs', {
      operations: [{ cmd: 'stat', args: ['hf://README.md'] }],
    })
    check(
      'stat hf://README.md is a file with a Content-Type',
      readmeStat.includes('- Type: `file`') &&
        readmeStat.includes('- Path: `README.md`') &&
        readmeStat.includes('- Content-Type: `text/markdown`'),
      readmeStat.slice(0, 260),
    )
    const readmeCat = await text('hf_fs', {
      operations: [{ cmd: 'cat', args: ['hf://README.md'] }],
    })
    check(
      'cat hf://README.md serves the captured page',
      readmeCat.includes('# Hugging Face virtual filesystem') &&
        readmeCat.includes('Content-Type: `text/markdown`'),
      readmeCat.slice(0, 260),
    )
    // The page documents the bounds this fake implements, so a fake that
    // served a DIFFERENT page would be telling the agent the wrong numbers.
    check(
      'and the page still documents the bounds the fake enforces',
      readmeCat.includes('hf_fs_write') && readmeCat.includes('30 operations'),
      readmeCat.slice(0, 200),
    )
    const readmeCut = await text('hf_fs', {
      operations: [{ cmd: 'cat', args: ['hf://README.md', '--max-bytes', '120'] }],
    })
    check(
      'a bounded read of it stops where asked, and says where to resume',
      readmeCut.includes('Bytes: 120') &&
        readmeCut.includes('Content truncated. Resume with offset 120.'),
      readmeCut.slice(0, 200),
    )
    const readmeLs = await call('hf_fs', ops({ cmd: 'ls', args: ['hf://README.md'] }))
    eq(
      'ls on it is ENOTDIR, not the fake naming itself',
      errorOf(readmeLs).code ?? null,
      'HF_FS_NOT_A_DIRECTORY',
    )
    eq(
      'and find answers the same code',
      errorOf(await call('hf_fs', ops({ cmd: 'find', args: ['hf://README.md'] }))).code ?? null,
      'HF_FS_NOT_A_DIRECTORY',
    )
    // A DIFFERENT code from ls: it is a file, just not an attachable one.
    eq(
      'attach on it is NOT_A_FILE, which is a different refusal',
      errorOf(await call('hf_fs', ops({ cmd: 'attach', args: ['hf://README.md'] }))).message ??
        null,
      'attach requires a direct repository or bucket file URI.',
    )

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

    // ---- card validation
    //
    // upload_folder posts every README.md it is about to send here first, and
    // a 404 aborts the upload rather than skipping the check, so the endpoint
    // is exercised for each of the three answers the client tells apart.
    const validate = async (content: string): Promise<Response> =>
      await fetch(`${fake.endpoint}/api/validate-yaml`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TENANT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, repoType: 'model' }),
      })

    const fenced = await validate('---\nlicense: mit\n---\n\n# Card\n')
    const fencedBody = (await fenced.json()) as Record<string, JsonValue>
    check('a fenced card validates', fenced.status === 200, String(fenced.status))
    eq('a fenced card raises nothing', fencedBody.errors ?? null, [])
    eq('and warns about nothing either', fencedBody.warnings ?? null, [])

    // A card with no frontmatter is legal and uploads; the client surfaces the
    // warning and carries on.
    const bareCard = await validate('# Card\n')
    const bareCardBody = (await bareCard.json()) as Record<string, JsonValue>
    check(
      'a card without metadata still validates',
      bareCard.status === 200,
      String(bareCard.status),
    )
    check(
      'and warns that the metadata is missing',
      JSON.stringify(bareCardBody.warnings ?? []).includes('empty or missing yaml metadata'),
      JSON.stringify(bareCardBody.warnings ?? []),
    )

    // A block that never closes is NOT an error upstream, and neither is one
    // whose closing line merely starts with three hyphens. Both are simply not
    // metadata, and a card without metadata uploads with a warning. This file
    // asserted 400 for both until the live endpoint was asked.
    const unclosed = await validate('---\nlicense: mit\n')
    check(
      'an unclosed metadata block is not an error',
      unclosed.status === 200,
      String(unclosed.status),
    )
    const ragged = await validate('---\nlicense: mit\n---oops\n')
    const raggedBody = (await ragged.json()) as Record<string, JsonValue>
    check('nor is a ragged closing fence', ragged.status === 200, String(ragged.status))
    check(
      'and both warn rather than refuse',
      JSON.stringify(raggedBody.warnings ?? []).includes('empty or missing yaml metadata'),
      JSON.stringify(raggedBody.warnings ?? []),
    )

    // What IS an error is a block that closes and does not parse. This is the
    // failure the route exists to reproduce: upload_folder turns the 400 into
    // `ValueError: Invalid metadata in README.md` and never uploads.
    const malformed = await validate('---\nlicense: [\n---\n')
    const malformedBody = (await malformed.json()) as Record<string, JsonValue>
    check('malformed metadata is refused', malformed.status === 400, String(malformed.status))
    // Read off the error itself rather than a stringified blob: the help link
    // is compared whole, because half a URL is not the assertion -- upstream
    // hands back this sentence and nothing near it.
    const malformedError = ((malformedBody.errors ?? []) as Record<string, JsonValue>[])[0] ?? {}
    check(
      'and names README.md the way upstream does',
      String(malformedError.message ?? '').startsWith('Invalid YAML in README.md: '),
      JSON.stringify(malformedError),
    )
    eq(
      'and hands back the help link upstream sends',
      malformedError.help ?? null,
      'You can use a tool like http://www.yamllint.com/ to check it',
    )
    eq('and marks it an error', malformedError.type ?? null, 'error')

    // Parses, but is not a mapping. Upstream separates the two shapes.
    const nullBody = await validate('---\n\n---\n')
    const nullBodyJson = (await nullBody.json()) as Record<string, JsonValue>
    check('an empty block is refused', nullBody.status === 400, String(nullBody.status))
    check(
      'as metadata that is invalid rather than unparseable',
      JSON.stringify(nullBodyJson.errors ?? []).includes(
        'The YAML metadata of your README.md is invalid.',
      ),
      JSON.stringify(nullBodyJson.errors ?? []),
    )
    const listBody = await validate('---\n- a\n- b\n---\n')
    const listBodyJson = (await listBody.json()) as Record<string, JsonValue>
    check('a list is refused', listBody.status === 400, String(listBody.status))
    check(
      'with the schema error upstream answers',
      JSON.stringify(listBodyJson.errors ?? []).includes('must be of type object'),
      JSON.stringify(listBodyJson.errors ?? []),
    )

    // Unknown keys are ACCEPTED upstream, so nothing here may reject them.
    const unknownKey = await validate('---\nbogus_key: 1\n---\n')
    const unknownKeyBody = (await unknownKey.json()) as Record<string, JsonValue>
    check('an unknown key is accepted', unknownKey.status === 200, String(unknownKey.status))
    eq('and raises nothing', unknownKeyBody.errors ?? null, [])

    const anonCard = await fetch(`${fake.endpoint}/api/validate-yaml`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Card\n', repoType: 'model' }),
    })
    check(
      'an unauthenticated validation is refused',
      anonCard.status === 401,
      String(anonCard.status),
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
