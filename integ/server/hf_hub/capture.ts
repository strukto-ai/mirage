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

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_FIXTURE_ROOT } from '../kit/typescript/index.ts'

// Refreshes integ/fixtures/hf-mcp/tools.json from the live Hugging Face MCP
// server. It exists so the pinned document has a stated source and a way to be
// re-derived, which is the whole difference between a capture and a file
// somebody typed: `mcp.ts` replays these schemas verbatim in front of the agent
// being measured, so a hand-edit here is a silent change to the measurement.
//
// Run it deliberately, never in CI: it talks to huggingface.co, and a fixture
// that refreshed itself on a schedule would move the tool surface underneath a
// comparison that has already started.
//
//   pnpm run hf-mcp:capture                 anonymous, which is what CI sees
//   HF_TOKEN=... pnpm run hf-mcp:capture    and with a credential
//
// The two are asserted to AGREE before anything is written. They did when this
// was first captured (0.4.15, four tools), and if they ever stop agreeing the
// document has to say which one it is rather than silently becoming whichever
// the last operator happened to run.

const URL_MCP = 'https://huggingface.co/mcp'
const OUT = join(DEFAULT_FIXTURE_ROOT, 'hf-mcp', 'tools.json')
// The limits page, captured for the same reason the schemas are: the tool
// document's own closing line sends the model to `hf://README.md`, so it is
// part of the surface being measured rather than reference material for us.
// It is also where every bound in this fake came from -- cat's 20,000/80,000,
// ls and find's 1,000/10,000 -- which were invented here until it was read.
const OUT_README = join(DEFAULT_FIXTURE_ROOT, 'hf-mcp', 'README.md')

interface Rpc {
  result?: Record<string, unknown>
  error?: { message?: string }
}

async function rpc(
  body: Record<string, unknown>,
  session: string,
  token: string,
): Promise<{ session: string; reply: Rpc }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (session !== '') headers['Mcp-Session-Id'] = session
  if (token !== '') headers.Authorization = `Bearer ${token}`
  const res = await fetch(URL_MCP, { method: 'POST', headers, body: JSON.stringify(body) })
  const got = res.headers.get('mcp-session-id') ?? session
  const text = await res.text()
  return { session: got, reply: text === '' ? {} : (JSON.parse(text) as Rpc) }
}

async function listTools(token: string): Promise<{
  init: Record<string, unknown>
  tools: unknown[]
}> {
  const opened = await rpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mirage-capture', version: '0' },
      },
    },
    '',
    token,
  )
  const init = opened.reply.result
  if (init === undefined) throw new Error(`initialize failed: ${JSON.stringify(opened.reply)}`)
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, opened.session, token)
  const listed = await rpc(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    opened.session,
    token,
  )
  const tools = listed.reply.result?.tools
  if (!Array.isArray(tools)) throw new Error(`tools/list failed: ${JSON.stringify(listed.reply)}`)
  return { init, tools }
}

/** The bytes `cat hf://README.md` serves, without the cat rendering around them. */
async function readmeOf(token: string): Promise<string> {
  const opened = await rpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mirage-capture', version: '0' },
      },
    },
    '',
    token,
  )
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, opened.session, token)
  const got = await rpc(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'hf_fs',
        // No --max-bytes: the default is 20,000 and the page is a third of
        // that, so asking for it whole is asking for it once. A page that
        // outgrows the default would arrive truncated and SAY so, which is
        // the assertion below.
        arguments: { operations: [{ cmd: 'cat', args: ['hf://README.md'] }] },
      },
    },
    opened.session,
    token,
  )
  // Taken from the structured result and not from the markdown: the rendered
  // form wraps the file in a header this fake generates for itself, and
  // capturing that too would nest one copy inside another.
  const results = (got.reply.result as { structuredContent?: { results?: unknown[] } } | undefined)
    ?.structuredContent?.results
  const first = Array.isArray(results) ? (results[0] as Record<string, unknown>) : undefined
  const result = first?.result as Record<string, unknown> | undefined
  const content = result?.content
  if (typeof content !== 'string') {
    throw new Error(`cat hf://README.md failed: ${JSON.stringify(got.reply).slice(0, 400)}`)
  }
  if (result?.truncated === true) {
    throw new Error(
      'hf://README.md now exceeds the default cat bound, so this capture is a prefix; ' +
        'raise --max-bytes here before refreshing the fixture',
    )
  }
  return content
}

const token = process.env.HF_TOKEN ?? ''
const anon = await listTools('')
// Anonymously for BOTH, because the pair has to describe one server. The
// document below is built from `anon`, so a README fetched with the token
// would pin the authenticated page beside the anonymous schemas -- one
// fixture from each of two snapshots, which is the thing this script exists
// to prevent.
const readme = await readmeOf('')
if (token !== '') {
  const authed = await listTools(token)
  if (JSON.stringify(anon.tools) !== JSON.stringify(authed.tools)) {
    throw new Error(
      'the anonymous and authenticated tool lists differ; the fixture can only pin one, ' +
        'so decide which the measurement uses before refreshing it',
    )
  }
  if (readme !== (await readmeOf(token))) {
    throw new Error(
      'the anonymous and authenticated README pages differ; the fixture can only pin one, ' +
        'so decide which the measurement uses before refreshing it',
    )
  }
}

const doc = {
  capturedFrom: URL_MCP,
  capturedAt: new Date().toISOString(),
  protocolVersion: anon.init.protocolVersion,
  serverInfo: anon.init.serverInfo,
  instructions: anon.init.instructions,
  tools: anon.tools,
}

// Both writes LAST, after every fetch and every assertion above. Written as
// they were reached -- tool document, then page -- a failed or truncated
// README left tools.json already replaced and README.md still the previous
// capture: two snapshots of a surface the fake presents as one, and the
// script exiting non-zero would not have put it back.
// The page is verbatim, with no trailing newline added: the fake serves it
// byte for byte and `Bytes:` in the reply counts whatever is written here.
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`)
writeFileSync(OUT_README, readme)
const info = doc.serverInfo as { name?: string; version?: string }
process.stdout.write(
  `captured ${String(anon.tools.length)} tools and ${String(Buffer.byteLength(readme))} ` +
    `README bytes from ${String(info.name)} ${String(info.version)}` +
    `${token === '' ? '' : ' (anonymous == authenticated)'}\n`,
)
