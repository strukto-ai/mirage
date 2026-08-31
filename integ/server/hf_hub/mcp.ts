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

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolRequest, Tool } from '@modelcontextprotocol/sdk/types.js'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  DEFAULT_RUN,
  DEFAULT_TENANT,
  resolveRun,
  resolveTenant,
  splitRunPath,
  DEFAULT_FIXTURE_ROOT,
  Router,
  bindHost,
  start,
} from '../kit/typescript/index.ts'
import type {
  Clock,
  Ctx,
  JsonValue,
  Minter,
  Reply,
  Runtime,
  Started,
} from '../kit/typescript/index.ts'
import { KINDS, type C } from './config.ts'
import { hfHubFake } from './fake.ts'
import { hfHubRoutes } from './routes.ts'
import {
  FS_INVALID,
  FS_NOT_FOUND,
  catMarkdown,
  detailsMarkdown,
  fsError,
  fsRecovery,
  listingMarkdown,
  operationsMarkdown,
  searchMarkdown,
  statMarkdown,
  type FsEntry,
} from './render.ts'

// The tool document is CAPTURED, never authored. notion's MCP arm can answer
// `{tools: []}` because the vendored upstream server owns the schemas there and
// this fake only has to answer the calls; the Hub has no vendored server, so
// the schemas are this file's problem, and writing them by hand would put a
// mirage-shaped tool surface in front of the agent being measured. Instead the
// live server's own `tools/list` is pinned as a fixture and replayed verbatim.
// Refresh it with `pnpm run hf-mcp:capture`, which records what it came from.
const TOOLS_FIXTURE = join(DEFAULT_FIXTURE_ROOT, 'hf-mcp', 'tools.json')

interface ToolDoc {
  capturedFrom: string
  capturedAt: string
  serverInfo: { name: string; version: string; title?: string }
  tools: Tool[]
}

export function loadToolDoc(): ToolDoc {
  return JSON.parse(readFileSync(TOOLS_FIXTURE, 'utf8')) as ToolDoc
}

// Every tool answers by DISPATCHING THROUGH THE REST ROUTES, not by reaching
// into the store. That is the whole point of the arm: a measurement comparing
// an MCP client against a mirage mount is only meaningful if both are looking
// at one world through one implementation, and a second code path that reads
// the same tables is exactly how the two arms drift apart without anyone
// noticing. The router here is the fake's own.
const routes = hfHubRoutes()
const router = new Router<C>(routes)

interface Dispatch {
  db: C
  tenant: string
  clock: Clock
  minter: Minter
}

async function callRoute(
  at: Dispatch,
  method: string,
  path: string,
  query: Record<string, string | string[]> = {},
): Promise<Reply> {
  const url = new URL(`http://hf-mcp.invalid${path}`)
  for (const [name, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(name, one)
  }
  const hit = router.match(method, url.pathname)
  if (hit === null) return { status: 404, body: { error: `no route for ${method} ${path}` } }
  const ctx: Ctx<C> = {
    params: hit.params,
    query: url.searchParams,
    body: Buffer.alloc(0),
    run: DEFAULT_RUN,
    tenant: at.tenant,
    runPrefix: '',
    db: at.db,
    clock: at.clock,
    minter: at.minter,
    // The routes authenticate off a bearer, and the tenant IS the token in this
    // fake, so the tool arm presents the same credential the REST arm does.
    headers: { authorization: `Bearer ${at.tenant}` },
    url,
    json: () => ({}),
  }
  return router.run(hit.spec, ctx)
}

function ok(reply: Reply): reply is Reply & { body: JsonValue } {
  return reply.status === 200 && reply.body !== undefined && !Buffer.isBuffer(reply.body)
}

function rows(reply: Reply): Record<string, JsonValue>[] {
  if (!ok(reply) || !Array.isArray(reply.body)) return []
  return reply.body.filter(
    (one): one is Record<string, JsonValue> =>
      typeof one === 'object' && one !== null && !Array.isArray(one),
  )
}

function obj(v: JsonValue | undefined): Record<string, JsonValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((one) => String(one)) : []
}

// The tool document spells a repo type singular ("model") and every route
// spells it plural ("models"), so the two meet in exactly one place.
const PLURAL: Record<string, string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces',
}

// --------------------------------------------------------------- hf_whoami

// A tool that declares an `outputSchema` MUST answer with structuredContent,
// and the SDK client REFUSES the call otherwise -- which is the first thing the
// captured document bought: a hand-written schema would not have carried an
// output schema at all, and the arm would have shipped answering a shape no
// real client accepts. Two of the four tools declare one.
interface Answer {
  text: string
  structured?: JsonValue
}

async function whoamiAnswer(at: Dispatch): Promise<Answer> {
  const reply = await callRoute(at, 'GET', '/api/whoami-v2')
  if (!ok(reply)) {
    return {
      text: '# Hugging Face authentication\n\nNot authenticated.',
      structured: {
        status: 'anonymous',
        account: null,
        organizations: [],
        credential: null,
        guidance: 'The mirage hf_hub fake refused the credential this arm presented.',
      },
    }
  }
  const me = obj(reply.body)
  const name = String(me.name ?? '')
  const orgs = Array.isArray(me.orgs) ? me.orgs.map((one) => obj(one)) : []
  const lines = [
    '# Hugging Face authentication',
    '',
    `Authenticated as [@${name}](https://huggingface.co/${name}) (\`${name}\`).`,
    '',
    `- **Account type:** \`${String(me.type ?? 'user')}\``,
  ]
  if (orgs.length > 0) {
    lines.push('', '## Organizations', ...orgs.map((one) => `- \`${String(one.name ?? '')}\``))
  }
  return {
    text: lines.join('\n'),
    structured: {
      status: 'authenticated',
      account: {
        id: name,
        type: String(me.type ?? 'user'),
        name,
        url: `https://huggingface.co/${name}`,
        is_pro: false,
      },
      organizations: orgs.map((one) => ({
        id: String(one.name ?? ''),
        name: String(one.name ?? ''),
        display_name: String(one.fullname ?? one.name ?? ''),
        url: `https://huggingface.co/${String(one.name ?? '')}`,
      })),
      // `other` is the schema's own catch-all variant, and it is the honest
      // one: the token this fake authenticates with is a tenant name, not a
      // Hub personal access token, so claiming `personal_access_token` would
      // put a role and a permission set behind it that do not exist.
      credential: { type: 'other' },
    },
  }
}

// ---------------------------------------------------------- hub_repo_search

async function searchText(at: Dispatch, args: Record<string, JsonValue>): Promise<string> {
  const types = strList(args.repo_types)
  const kinds = (types.length > 0 ? types : ['model', 'dataset']).map((one) => PLURAL[one] ?? one)
  const query = typeof args.query === 'string' ? args.query : ''
  const limit = typeof args.limit === 'number' ? args.limit : 20
  const found: { kind: string; rows: Record<string, JsonValue>[] }[] = []
  for (const kind of kinds) {
    if (!KINDS.includes(kind)) continue
    const q: Record<string, string | string[]> = {
      limit: String(limit),
      full: '1',
      cardData: '1',
    }
    if (query !== '') q.search = query
    if (typeof args.author === 'string' && args.author !== '') q.author = args.author
    const filters = strList(args.filters)
    if (filters.length > 0) q.filter = filters
    if (typeof args.sort === 'string' && args.sort !== '') q.sort = args.sort
    found.push({ kind, rows: rows(await callRoute(at, 'GET', `/api/${kind}`, q)) })
  }
  return searchMarkdown(query, found)
}

// --------------------------------------------------------- hub_repo_details

// The type is auto-detected when the call does not name one, which is what the
// tool's own schema promises ("otherwise auto-detects"). Order matters only in
// that a repository of one kind never shares an id with another here.
async function detailsOne(at: Dispatch, id: string, named: string): Promise<string> {
  const kinds = named === '' ? KINDS : [PLURAL[named] ?? named]
  for (const kind of kinds) {
    const reply = await callRoute(at, 'GET', `/api/${kind}/${id}`)
    if (ok(reply)) return detailsMarkdown(kind, obj(reply.body))
  }
  return `# ${id}\n\nNot found.`
}

async function detailsText(at: Dispatch, args: Record<string, JsonValue>): Promise<string> {
  const ids = strList(args.repo_ids)
  const named = typeof args.repo_type === 'string' ? args.repo_type : ''
  // The two operations that read the Dataset Viewer are refused rather than
  // approximated: the fake stores repository files, not parquet, so there is no
  // config, no split and no row to answer with, and a plausible-looking preview
  // of rows nobody uploaded is the one failure mode that would corrupt a
  // measurement silently.
  const wanted = strList(args.operations)
  const unsupported = wanted.filter((one) => one !== 'overview')
  const parts: string[] = []
  for (const id of ids) parts.push(await detailsOne(at, id, named))
  if (unsupported.length > 0) {
    parts.push(
      `**Unsupported operations:** ${unsupported.join(', ')} — the mirage hf_hub fake ` +
        'serves repository metadata only; it has no Dataset Viewer.',
    )
  }
  return parts.join('\n\n---\n\n')
}

// ------------------------------------------------------------------- hf_fs

interface Located {
  kind: string
  id: string
  path: string
}

// `hf://<kind>/<namespace>/<name>[/<path>]`, which is the only URI shape this
// fake has data behind. The live tool also addresses trending listings, papers,
// collections and buckets; those are refused by name below rather than guessed
// at, because the fake has no rows for any of them.
interface Refusal {
  code: string
  message: string
}

function locate(uri: string): Located | Refusal {
  const bad = (message: string): Refusal => ({ code: FS_INVALID, message })
  if (!uri.startsWith('hf://')) {
    return bad(`EINVAL: first argument must be an hf:// URI: ${uri}`)
  }
  const parts = uri
    .slice('hf://'.length)
    .split('/')
    .filter((one) => one !== '')
  const kind = parts[0] ?? ''
  if (!KINDS.includes(kind)) {
    return bad(`EINVAL: the mirage hf_hub fake serves ${KINDS.join(', ')} only: ${uri}`)
  }
  if (parts.length < 3) return bad(`EINVAL: expected hf://${kind}/<namespace>/<name>: ${uri}`)
  return { kind, id: `${parts[1] ?? ''}/${parts[2] ?? ''}`, path: parts.slice(3).join('/') }
}

function entriesOf(reply: Reply): FsEntry[] {
  return rows(reply).map((one) => ({
    type: String(one.type ?? 'file') === 'directory' ? 'dir' : 'file',
    // A tree row's `path` is the full path from the repo root; the listing
    // shows the leaf, which is what the live server's Path column holds.
    path:
      String(one.path ?? '')
        .split('/')
        .pop() ?? '',
    size: typeof one.size === 'number' ? one.size : 0,
    lfs: one.lfs !== undefined,
  }))
}

async function treeAt(at: Dispatch, where: Located, recursive: boolean): Promise<Reply> {
  const suffix = where.path === '' ? '' : `/${where.path}`
  return callRoute(
    at,
    'GET',
    `/api/${where.kind}/${where.id}/tree/main${suffix}`,
    recursive ? { recursive: 'true' } : {},
  )
}

// One operation answers twice over: the markdown a reader sees, and the
// structured record the tool's output schema requires. They are built together
// so they cannot disagree about what happened.
interface FsOut {
  text: string
  result?: Record<string, JsonValue>
  error?: { code: string; message: string }
}

function fsFail(code: string, message: string): FsOut {
  return { text: fsError(code, message), error: { code, message } }
}

async function fsOne(at: Dispatch, cmd: string, args: string[]): Promise<FsOut> {
  if (cmd === 'attach' || cmd === 'search') {
    return fsFail(
      FS_INVALID,
      `EINVAL: ${cmd} is not served by the mirage hf_hub fake; use ls, cat, stat or find`,
    )
  }
  const uri = args[0] ?? ''
  const where = locate(uri)
  if (!('kind' in where)) return fsFail(where.code, where.message)
  if (args.length > 1) {
    return fsFail(FS_INVALID, `EINVAL: unexpected argument for ${cmd}: ${args[1] ?? ''}`)
  }
  if (cmd === 'ls' || cmd === 'find') {
    const reply = await treeAt(at, where, cmd === 'find')
    if (!ok(reply)) {
      return fsFail(FS_NOT_FOUND, `${where.path} does not exist on "main". URI: ${uri}`)
    }
    const entries = entriesOf(reply)
    return {
      text: listingMarkdown(cmd, uri, entries),
      result: {
        uri,
        op: cmd,
        // A directory entry carries no `size`, which is the live server's own
        // shape rather than a zero: the schema makes size optional precisely
        // because a Hub directory has none.
        entries: entries.map((one) =>
          one.type === 'dir'
            ? { type: 'dir', path: one.path }
            : { type: 'file', path: one.path, size: one.size, ...(one.lfs ? { lfs: true } : {}) },
        ),
      },
    }
  }
  if (cmd === 'stat') {
    // A path is a file if the repo's recursive tree names it, and a directory
    // if listing it answers at all. Asked in that order because only the
    // listing can tell an empty directory from a missing one.
    const all = entriesOfFull(await treeAt(at, { ...where, path: '' }, true))
    const hit = all.find((one) => one.full === where.path)
    if (hit !== undefined) {
      return {
        text: statMarkdown(uri, { ...hit.entry, type: 'file' }, where.path),
        result: {
          uri,
          op: 'stat',
          exists: true,
          type: 'file',
          path: where.path,
          size: hit.entry.size,
        },
      }
    }
    const listed = await treeAt(at, where, false)
    if (ok(listed)) {
      return {
        text: statMarkdown(uri, { type: 'dir', path: where.path, size: 0, lfs: false }, where.path),
        result: { uri, op: 'stat', exists: true, type: 'dir', path: where.path },
      }
    }
    return {
      text: statMarkdown(uri, null, where.path),
      result: { uri, op: 'stat', exists: false, path: where.path },
    }
  }
  if (cmd === 'cat') {
    if (where.path === '') return fsFail(FS_INVALID, `EINVAL: cat needs a file path: ${uri}`)
    const reply = await callRoute(
      at,
      'GET',
      `/${where.kind === 'models' ? '' : `${where.kind}/`}${where.id}/resolve/main/${where.path}`,
    )
    if (reply.status !== 200 || !Buffer.isBuffer(reply.body)) {
      return fsFail(FS_NOT_FOUND, `File does not exist: ${where.path}`)
    }
    return {
      text: catMarkdown(uri, where.path, reply.body),
      result: {
        uri,
        op: 'cat',
        path: where.path,
        content: reply.body.toString('utf8'),
        bytes: reply.body.length,
        truncated: false,
      },
    }
  }
  return fsFail(FS_INVALID, `EINVAL: unknown command: ${cmd}`)
}

// The recursive listing keeps the FULL path beside the leaf, which `stat`
// needs and `ls` must not print.
function entriesOfFull(reply: Reply): { full: string; entry: FsEntry }[] {
  return rows(reply)
    .filter((one) => String(one.type ?? '') !== 'directory')
    .map((one) => ({
      full: String(one.path ?? ''),
      entry: {
        type: 'file',
        path:
          String(one.path ?? '')
            .split('/')
            .pop() ?? '',
        size: typeof one.size === 'number' ? one.size : 0,
        lfs: one.lfs !== undefined,
      },
    }))
}

async function fsAnswer(at: Dispatch, args: Record<string, JsonValue>): Promise<Answer> {
  const ops = Array.isArray(args.operations) ? args.operations.map((one) => obj(one)) : []
  const texts: string[] = []
  const results: JsonValue[] = []
  for (const [i, one] of ops.entries()) {
    const out = await fsOne(at, String(one.cmd ?? ''), strList(one.args))
    texts.push(out.text)
    results.push(
      out.error === undefined
        ? { index: i, status: 'success', result: out.result ?? {} }
        : {
            index: i,
            status: 'error',
            error: {
              code: out.error.code,
              message: out.error.message,
              recovery: fsRecovery(out.error.code),
              retryable: false,
            },
          },
    )
  }
  return { text: operationsMarkdown(texts), structured: { results } }
}

// ---------------------------------------------------------------- assembly

export async function toolAnswer(
  at: Dispatch,
  name: string,
  args: Record<string, JsonValue>,
): Promise<Answer> {
  if (name === 'hf_whoami') return whoamiAnswer(at)
  if (name === 'hub_repo_search') return { text: await searchText(at, args) }
  if (name === 'hub_repo_details') return { text: await detailsText(at, args) }
  if (name === 'hf_fs') return fsAnswer(at, args)
  throw new Error(`mock hf mcp: unsupported tool ${name}`)
}

function buildMcpServer(at: Dispatch, doc: ToolDoc): McpServer {
  const server = new McpServer(
    { name: doc.serverInfo.name, version: doc.serverInfo.version },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: doc.tools }))
  server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
    const answer = await toolAnswer(
      at,
      req.params.name,
      obj((req.params.arguments ?? {}) as JsonValue),
    )
    return {
      content: [{ type: 'text', text: answer.text }],
      ...(answer.structured === undefined ? {} : { structuredContent: answer.structured }),
    }
  })
  return server
}

// The real server answers MCP at ONE path (huggingface.co/mcp), and so does
// this one. Answering every path would let a harness pointed at the wrong URL
// work anyway and then fail against the real thing, which is the class of
// difference a fake exists to surface rather than absorb.
export const MCP_PATH = '/mcp'

// The MCP arm over a REST arm that already exists, so both speak to ONE store:
// a tool call and a REST read in the same run must see the same rows, and two
// runtimes would be two SQLite files that silently diverge.
export function mcpServerFor(runtime: Runtime<C>): Server {
  const fallback = (hfHubFake.defaultTenants ?? [])[0] ?? DEFAULT_TENANT
  const { tenantKind, tenantFromBearer, tenantTokenPattern } = hfHubFake.config
  const doc = loadToolDoc()
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mcp.invalid')
      // The run and tenant are the REQUEST'S, resolved exactly as the REST arm
      // resolves them, because both arms answer one store: an MCP call pinned
      // to the default world while REST seeded `/_run/<id>` would compare two
      // different sets of repositories without ever looking wrong. A caller
      // naming nothing keeps the seeded default tenant, which is what the
      // announced bare `/mcp` URL has always meant.
      const split = splitRunPath(url.pathname)
      if (split.path !== MCP_PATH) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not_found', path: url.pathname, expected: MCP_PATH }))
        return
      }
      const run = resolveRun(req.headers, url, split.run)
      const named = resolveTenant(
        req.headers,
        url,
        tenantKind,
        tenantFromBearer,
        tenantTokenPattern,
      )
      const tenant = named === DEFAULT_TENANT ? fallback : named
      const state = runtime.state(run).of(tenant)
      const at: Dispatch = {
        db: runtime.pool.client(run),
        tenant,
        clock: state.clock,
        minter: state.minter,
      }
      const mcp = buildMcpServer(at, doc)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0])
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport as Parameters<typeof mcp.connect>[0])
      await transport.handleRequest(req, res)
    })().catch((err: unknown) => {
      res.writeHead(500)
      res.end(String(err))
    })
  })
}

export async function listenMcp(server: Server, port: number): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, bindHost(), () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve(address.port)
    })
  })
}

// The in-process convenience: its OWN REST arm on an ephemeral port. Used by
// the selftest, which wants a server it can tear down; `main.ts` builds the
// same thing over the REST arm `serve()` already announced.
export async function startHfMcpServer(port = 0): Promise<{
  server: Server
  port: number
  rest: Started<C>
  close: () => Promise<void>
}> {
  const rest = await start(hfHubFake, 0)
  const server = mcpServerFor(rest.runtime)
  const bound = await listenMcp(server, port)
  return {
    server,
    port: bound,
    rest,
    close: async () => {
      await new Promise<void>((done) => {
        server.close(() => {
          done()
        })
        server.closeAllConnections()
      })
      await rest.close()
    },
  }
}
