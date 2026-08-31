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

const token = process.env.HF_TOKEN ?? ''
const anon = await listTools('')
if (token !== '') {
  const authed = await listTools(token)
  if (JSON.stringify(anon.tools) !== JSON.stringify(authed.tools)) {
    throw new Error(
      'the anonymous and authenticated tool lists differ; the fixture can only pin one, ' +
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
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`)
const info = doc.serverInfo as { name?: string; version?: string }
process.stdout.write(
  `captured ${String(anon.tools.length)} tools from ${String(info.name)} ${String(info.version)}` +
    `${token === '' ? '' : ' (anonymous == authenticated)'}\n`,
)
