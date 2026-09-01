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
  FS_BUDGET,
  FS_IMAGE_ONLY,
  FS_IMAGE_TOO_LARGE,
  FS_NOT_A_FILE,
  FS_NOT_A_DIRECTORY,
  FS_NOT_FOUND,
  FS_TEXT_ONLY,
  FS_UNSUPPORTED_MEDIA,
  catMarkdown,
  type CatBounds,
  detailsMarkdown,
  fsError,
  attachMarkdown,
  fsRecovery,
  fsSuggested,
  LIST_TRUNCATED,
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
// The limits page, captured beside the schemas by the same script and for the
// same reason. `hf://README.md` is a FILE at the root of the virtual
// filesystem -- no owner, no repository, no tree route behind it -- and the
// tool document's own closing line sends the model to it: "Limits and
// path-specific behavior are documented at hf://README.md". A fake that
// refuses the path refuses an instruction it handed out itself, which is what
// happened: an agent asked for it mid-benchmark and was told, in bytes it was
// charged for, that "the mirage hf_hub fake" serves something else.
const README_FIXTURE = join(DEFAULT_FIXTURE_ROOT, 'hf-mcp', 'README.md')
const README_URI = 'hf://README.md'
const README_PATH = 'README.md'
// Declared by the virtual documentation files and by nothing else -- a
// repository file's stat and cat carry no Content-Type at all.
const README_MIME = 'text/markdown'

let readmeCached: Buffer | undefined

function readmeBytes(): Buffer {
  readmeCached ??= readFileSync(README_FIXTURE)
  return readmeCached
}

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
  // `attach` returns the file itself, as MCP image blocks beside the prose.
  images?: { mimeType: string; data: string }[]
  // MCP's own flag on the tool result, which the live server sets when EVERY
  // operation in the batch failed and omits the moment one succeeds. Omitted
  // rather than false, because that is what upstream sends and a client may
  // read the key's presence.
  isError?: boolean
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

// Every root the live server addresses, which is more than this fake holds
// rows for. The distinction matters in exactly one place: a type that is not
// on this list is wrong ANYWHERE and earns upstream's own sentence, while one
// that is on it but missing from KINDS is a real root that this fake does not
// serve, and saying so is more use than pretending the name is invalid.
const UPSTREAM_KINDS = ['models', 'datasets', 'spaces', 'buckets', 'collections', 'papers']

// `docs` is a root too, and is NOT in the sentence above: `ls hf://docs`
// answers with entries. That sentence describes what upstream says when it
// rejects a TYPE; it is not the list of what the server addresses, and
// reading it as one turned two working URIs into errors. `hf://README.md` is
// the other -- a root-level page, where the live server documents its own
// limits. Both are refused below as things this fake does not hold, which is
// true, rather than as bad names, which is not.
const UPSTREAM_ROOTS = [...UPSTREAM_KINDS, 'docs', 'README.md']

function locate(uri: string, cmd: string): Located | Refusal {
  const bad = (message: string): Refusal => ({ code: FS_INVALID, message })
  if (!uri.startsWith('hf://')) return bad('EINVAL: URI must start with hf://')
  const parts = uri
    .slice('hf://'.length)
    .split('/')
    .filter((one) => one !== '')
  const kind = parts[0] ?? ''
  if (kind === '') return bad('EINVAL: Missing repository or bucket type in URI.')
  if (!UPSTREAM_ROOTS.includes(kind)) {
    return bad(`EINVAL: Invalid URI type '${kind}'. Must be one of ${UPSTREAM_KINDS.join(', ')}.`)
  }
  if (!KINDS.includes(kind)) {
    return bad(`EINVAL: the mirage hf_hub fake serves ${KINDS.join(', ')} only: ${uri}`)
  }
  // A URI naming a root or an owner is a NAMESPACE, and asking `cat` for one
  // is not a malformed argument -- it is a URI that points at the wrong kind
  // of thing, which is what NOT_A_FILE says. The live server answers that
  // code here, and an agent branching on the code should not be told it
  // mistyped a flag. Every other command still gets the fake's own sentence,
  // because a namespace listing is a thing this fake genuinely cannot do.
  if (parts.length < 3) {
    return cmd === 'cat'
      ? {
          code: FS_NOT_A_FILE,
          message: 'cat requires a URI that points to a file path, not a namespace.',
        }
      : bad(`EINVAL: expected hf://${kind}/<namespace>/<name>: ${uri}`)
  }
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

/**
 * The pages of a repository tree, in order.
 *
 * The REST arm answers one page and puts the cursor in a `Link` header, the
 * way the Hub's own API does. Reading only the first page made this fake
 * quietly disagree with itself on any repository over DEFAULT_LIMIT files:
 * `ls` showed a prefix and said nothing about the rest, `find` missed
 * matches, and `stat` reported a file that exists as `missing` because the
 * recursive tree it searched stopped before reaching it.
 *
 * Followed here rather than at each call site because every caller wants the
 * cursor followed, and only one of them was even aware there were pages. A
 * generator rather than a list because they do not all want the same amount
 * of it: a caller after ONE row can stop on the page that holds it, where a
 * function returning the tree would buy the whole repository to throw it away.
 *
 * Termination is the cursor's, not a page cap's. A cap was written, at 200,
 * and it was the same bug a size larger: a repository past it would have been
 * truncated in silence, which is the failure this loop exists to end rather
 * than to raise the threshold of. A page whose cursor has already been seen
 * cannot advance, and is the only way a well-formed loop fails to end; that
 * state means the REST arm on the other side of `callRoute` is broken, which
 * is this repo's own bug and not a caller's, so it throws where it is
 * discovered rather than handing back a shorter tree that reads exactly like
 * a complete one.
 */
async function* treePages(at: Dispatch, where: Located, recursive: boolean): AsyncGenerator<Reply> {
  const suffix = where.path === '' ? '' : `/${where.path}`
  const path = `/api/${where.kind}/${where.id}/tree/main${suffix}`
  const query: Record<string, string> = recursive ? { recursive: 'true' } : {}
  const seen = new Set<string>()
  let page = await callRoute(at, 'GET', path, query)
  for (;;) {
    yield page
    if (!ok(page) || !Array.isArray(page.body)) return
    const link = (page.headers ?? {}).Link
    if (link === undefined) return
    const cursor = /[?&]cursor=([^&>]+)/.exec(link)?.[1]
    if (cursor === undefined) return
    if (seen.has(cursor)) {
      throw new Error(
        `mock hf mcp: ${path} handed back cursor ${cursor} twice; the tree route is not advancing`,
      )
    }
    seen.add(cursor)
    page = await callRoute(at, 'GET', path, { ...query, cursor: decodeURIComponent(cursor) })
  }
}

/**
 * A repository tree, up to `cap` rows.
 *
 * For the callers that want the rows in hand: `ls` and `find`, which print
 * them, and the two existence tests, which want one page and read no further.
 * `cap` is the listing's `--limit` -- paging stops one row past it, which is
 * enough to report the listing as truncated without holding a tail that is
 * only going to be dropped.
 */
async function treeAt(
  at: Dispatch,
  where: Located,
  recursive: boolean,
  cap = Number.POSITIVE_INFINITY,
): Promise<Reply> {
  const all: JsonValue[] = []
  let head: Reply | undefined
  for await (const page of treePages(at, where, recursive)) {
    head ??= page
    if (!ok(page) || !Array.isArray(page.body)) break
    all.push(...page.body)
    if (all.length > cap) break
  }
  // `treePages` yields its first reply before testing anything, so `head` is
  // always set by the time the loop ends.
  if (head === undefined || !ok(head) || !Array.isArray(head.body)) {
    return head ?? { status: 502, body: null }
  }
  return { ...head, body: all, headers: { ...(head.headers ?? {}) } }
}

// One operation answers twice over: the markdown a reader sees, and the
// structured record the tool's output schema requires. They are built together
// so they cannot disagree about what happened.
interface FsOut {
  text: string
  result?: Record<string, JsonValue>
  image?: { mimeType: string; data: string }
  error?: { code: string; message: string }
}

function fsFail(code: string, message: string): FsOut {
  return { text: fsError(code, message), error: { code, message } }
}

// A bare `cat` is BOUNDED, and these are the live server's own numbers rather
// than a guess at them. It documents its limits at hf://README.md -- a page the
// fake does not serve but the real server does -- and that table says
// `cat --max-bytes` is 20,000 by default and 80,000 at most.
//
// This repo used one invented 64KiB constant for both roles until the page was
// read. It was wrong twice over: too generous as a default, too strict as a
// ceiling, and it silently clamped where upstream refuses. A fake that returns
// whole files would be a different server than the one being measured; so is a
// fake that returns the wrong number of bytes on every cat.
const CAT_DEFAULT_BYTES = 20_000
const CAT_MAX_BYTES = 80_000

interface CatArgs {
  offset: number
  maxBytes: number
}

// `ls` and `find` are BOUNDED upstream too, and by a documented number
// rather than by however much the tree turned out to hold: 1,000 entries by
// default and 10,000 at most. Past it the listing stops and says so, which
// is why the schema carries `truncated` and `truncation_reason` for these
// commands as well as for cat.
const LIST_DEFAULT_LIMIT = 1000
const LIST_MAX_LIMIT = 10000

function listArgs(cmd: string, rest: string[]): number | Refusal {
  const bad = (message: string): Refusal => ({ code: FS_INVALID, message })
  let limit = LIST_DEFAULT_LIMIT
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? ''
    // The other flags this command advertises -- --recursive, --glob, --sort,
    // --name, --path, --type -- are still refused by name below, because the
    // fake has no filtering behind them and a silently ignored flag is worse
    // than an honest EINVAL.
    if (flag !== '--limit') return bad(`EINVAL: unexpected argument for ${cmd}: ${flag}`)
    const raw = rest[i + 1]
    if (raw === undefined) return bad(`EINVAL: ${flag} needs a value`)
    if (!/^-?\d+$/.test(raw)) return bad(`EINVAL: ${flag} requires an integer`)
    const value = Number(raw)
    // "for this command", because upstream's other listings have their own
    // ceilings -- search is 1,000 and documentation search 25.
    if (value < 1 || value > LIST_MAX_LIMIT) {
      return bad(`EINVAL: limit must be between 1 and ${String(LIST_MAX_LIMIT)} for this command`)
    }
    limit = value
  }
  return limit
}

function catArgs(rest: string[]): CatArgs | Refusal {
  const bad = (message: string): Refusal => ({ code: FS_INVALID, message })
  const out: CatArgs = { offset: 0, maxBytes: CAT_DEFAULT_BYTES }
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? ''
    if (flag !== '--offset' && flag !== '--max-bytes') {
      return bad(`EINVAL: unexpected argument for cat: ${flag}`)
    }
    const raw = rest[i + 1]
    if (raw === undefined) return bad(`EINVAL: ${flag} needs a value`)
    // A sign parses and then fails the range test, which is upstream's order
    // and not a detail: `--max-bytes -1` earns the RANGE message there, not
    // the integer one, so a caller reading the error learns which rule it
    // broke. Both sentences below are the live server's, verbatim.
    if (!/^-?\d+$/.test(raw)) return bad(`EINVAL: ${flag} requires an integer`)
    const value = Number(raw)
    if (flag === '--offset') {
      if (value < 0) return bad('EINVAL: offset must be non-negative')
      out.offset = value
      continue
    }
    if (value < 0 || value > CAT_MAX_BYTES) {
      return bad(`EINVAL: max_bytes must be between 0 and ${String(CAT_MAX_BYTES)}`)
    }
    // Zero is not an empty read upstream, it is the MAXIMUM -- the range is
    // documented as "between 0 and 80000" and `--max-bytes 0` on a 466KB file
    // answers 80,000 bytes. Read as "no bytes" this fake would hand back an
    // empty page where the live server hands back the largest one it serves,
    // which is the widest gap any single flag value could open between them.
    out.maxBytes = value === 0 ? CAT_MAX_BYTES : value
  }
  return out
}

// Where a bounded read may stop. A cut INSIDE a multi-byte character makes
// `toString('utf8')` replace both halves with U+FFFD, and `next_offset` then
// names a byte the caller never received whole -- so the pages of a paginated
// read cannot be reassembled into the file, which is the one thing pagination
// is for.
//
// Upstream appears to do the same, and forward rather than back: a default cat
// of a 466KB tokenizer.json answers `Bytes: 20001` against a documented default
// of 20,000, which is a bound overshot by exactly enough to finish a character.
// Forward also means a character wider than the bound still makes progress,
// instead of answering an empty page at the same offset forever.
//
// The cap keeps the bound a bound. `cat` refuses binary by name above, but a
// name is not a guarantee -- a .txt or .json holding invalid UTF-8 is served,
// and a run of continuation bytes in one would carry an uncapped walk to the
// end of the file. Three bytes is the most a walk can ever need: a UTF-8
// sequence is four bytes at its widest, so a lead byte is never further than
// three continuation bytes from the next boundary, and the walk stops there
// whether or not it found one.
const UTF8_MAX_TAIL = 3

function utf8End(buf: Buffer, end: number): number {
  let at = end
  while (at < buf.length && at - end < UTF8_MAX_TAIL && ((buf[at] ?? 0) & 0xc0) === 0x80) {
    at += 1
  }
  return at
}

// Where a bounded read may START, which upstream resolves the other way: the
// offset RETREATS to the beginning of the character it landed in, rather than
// advancing past it. Read against the live server, on a card whose byte 61
// opens the three-byte `\u7c73`:
//
//   --offset 61 --max-bytes 12  ->  bytes=12  next=73  '\u7c73\u996d\u662f\u4e00'
//   --offset 62 --max-bytes 12  ->  bytes=15  next=76  '\u7c73\u996d\u662f\u4e00\u79cd'
//   --offset 63 --max-bytes 12  ->  bytes=15  next=76  '\u7c73\u996d\u662f\u4e00\u79cd'
//   --offset 64 --max-bytes 12  ->  bytes=12  next=76  '\u996d\u662f\u4e00\u79cd'
//
// 62 and 63 both answer a page that BEGINS at 61 -- the character is served
// whole rather than dropped -- and the bound is still measured from the offset
// the caller asked for, so the page runs to 76 and reports 15 bytes for a
// 12-byte request. Retreating cannot loop: the start only ever moves earlier,
// while `next_offset` is an end that always lands on a boundary, so a caller
// paginating from a reported offset never enters this path at all.
function utf8Start(buf: Buffer, from: number): number {
  let at = from
  while (at > 0 && from - at < UTF8_MAX_TAIL && ((buf[at] ?? 0) & 0xc0) === 0x80) {
    at -= 1
  }
  return at
}

// `cat` is TEXT-ONLY upstream, and refuses on the name rather than on the
// bytes: "The file extension or MIME type is known to be binary." That makes
// the refusal cheap -- no blob is fetched -- and makes the list of suffixes
// the whole of the behaviour.
//
// `.bin`, `.safetensors` and `.h5` were each confirmed against a live repo.
// The rest are this fake's reconstruction of the classes hf://README.md names
// in its own words -- "model weights, archives, images, media, Parquet" -- and
// are the one part of the cat surface not read off the live server. The list
// earns its place anyway: the huggingface-upload fixture carries
// pytorch_model.bin and figures/*.png, so an agent that cats them is refused
// upstream and would be handed bytes by a fake that skipped this.
const BINARY_SUFFIX = [
  '.bin',
  '.safetensors',
  '.h5',
  '.ckpt',
  '.pt',
  '.pth',
  '.onnx',
  '.msgpack',
  '.tflite',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.mp3',
  '.mp4',
  '.wav',
  '.flac',
  '.ogg',
  '.webm',
  '.mov',
  '.parquet',
  '.arrow',
  '.npy',
  '.npz',
  '.pkl',
  '.pdf',
]

function binaryName(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return BINARY_SUFFIX.some((suffix) => name.endsWith(suffix))
}

// `attach` returns a COMPLETE file and cannot truncate one, so its bound is a
// refusal rather than a cut: 8MiB, which is upstream's documented default and
// maximum both. Zero is invalid here, where `cat --max-bytes 0` means the
// maximum -- the two commands genuinely differ, and each was read off the
// live server rather than assumed from the other.
const ATTACH_MAX_BYTES = 8 * 1024 * 1024

// And the same number again, as a budget shared by every attachment in ONE
// call. The captured schema allows 30 operations, so without this a valid
// request could ask for 30 x 8MiB and be answered with a quarter of a
// gigabyte of base64. Upstream documents the cap at hf://README.md and
// answers HF_FS_ATTACHMENT_BUDGET_EXCEEDED for each attachment it drops.
//
// Admission here is in the order the operations were written. Upstream's is
// not: probed with four images it dropped the FIRST and returned the other
// three, which is what "attachment admission is best-effort" means when the
// fetches run in parallel and whichever lands first reserves. Its own advice
// -- "Split attachments across separate calls when deterministic inclusion is
// required" -- is an admission that the choice is not promised, so this fake
// makes the deterministic choice rather than simulating a race.
const ATTACH_BATCH_BYTES = 8 * 1024 * 1024

// Upstream matches these case-insensitively and by extension alone: "bytes
// are opaque, are never inspected or altered before MCP encoding".
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

function imageMime(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const at = name.lastIndexOf('.')
  return at === -1 ? undefined : IMAGE_MIME[name.slice(at)]
}

// Whether a path inside a repository is a DIRECTORY. Rows, not merely a
// reply: the tree route answers 200 with nothing for a path that is not
// there, so `ok` alone calls every miss a directory. A directory in git
// always holds something -- an empty one cannot be committed -- so the rows
// are the test, and this is the only place that knows it.
async function isDirectory(at: Dispatch, where: Located): Promise<boolean> {
  if (where.path === '') return false
  // One page: the question is whether there is a row, not what the rows are.
  const listed = await treeAt(at, where, false, 1)
  return ok(listed) && entriesOf(listed).length > 0
}

/**
 * The tree row for ONE path, or nothing where the repository has no entry.
 *
 * The PARENT directory is listed, not the repository. git names a path's type
 * and size in the entry its own directory holds, so the parent is the smallest
 * listing guaranteed to carry the answer, and paging stops on the page the row
 * is on -- a hit costs one request far more often than it costs the directory.
 *
 * `stat` used to walk the whole recursive tree and then search it, which cost
 * the entire repository to keep a single row; a batch of the 30 operations one
 * call allows paid that thirty times over.
 */
async function rowAt(at: Dispatch, where: Located): Promise<FsEntry | undefined> {
  const cut = where.path.lastIndexOf('/')
  const parent = cut === -1 ? '' : where.path.slice(0, cut)
  for await (const page of treePages(at, { ...where, path: parent }, false)) {
    const hit = rows(page).find((one) => String(one.path ?? '') === where.path)
    if (hit === undefined) continue
    return {
      type: String(hit.type ?? 'file') === 'directory' ? 'dir' : 'file',
      path: where.path,
      size: typeof hit.size === 'number' ? hit.size : 0,
      lfs: hit.lfs !== undefined,
    }
  }
  return undefined
}

function attachArgs(rest: string[]): number | Refusal {
  const bad = (message: string): Refusal => ({ code: FS_INVALID, message })
  let bound = ATTACH_MAX_BYTES
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i] ?? ''
    // Only one flag, where cat has two: `--offset` is meaningless for a file
    // that arrives whole, and upstream refuses it by name.
    if (flag !== '--max-bytes') {
      return bad(`EINVAL: unexpected argument for attach: ${flag}`)
    }
    const raw = rest[i + 1]
    if (raw === undefined) return bad(`EINVAL: ${flag} needs a value`)
    if (!/^-?\d+$/.test(raw)) return bad(`EINVAL: ${flag} requires an integer`)
    const value = Number(raw)
    if (value < 1 || value > ATTACH_MAX_BYTES) {
      return bad(`EINVAL: attach max_bytes must be between 1 and ${String(ATTACH_MAX_BYTES)}`)
    }
    bound = value
  }
  return bound
}

interface Budget {
  left: number
}

/**
 * The four answers `hf://README.md` has, each read off the live server.
 *
 * It is a file, so `ls` and `find` refuse it as ENOTDIR and `attach` refuses
 * it as the wrong kind of file -- the two refusals differ because upstream's
 * differ, and an agent may branch on either code. `cat` and `stat` serve the
 * captured page, and both name a Content-Type that a repository file does not
 * have.
 *
 * Served from the fixture rather than through `callRoute` because there is no
 * route: this page belongs to the MCP server, not to the Hub behind it, and
 * the REST arm has nothing to answer for it. That is the one place the two
 * arms legitimately do not share an implementation.
 */
function readmeOne(cmd: string, rest: string[]): FsOut {
  const whole = readmeBytes()
  if (cmd === 'stat') {
    if (rest.length > 0) {
      return fsFail(FS_INVALID, `EINVAL: unexpected argument for ${cmd}: ${rest[0] ?? ''}`)
    }
    return {
      text: statMarkdown(README_URI, 'file', README_PATH, whole.length, README_MIME),
      result: {
        uri: README_URI,
        op: 'stat',
        exists: true,
        type: 'file',
        path: README_PATH,
        content_type: README_MIME,
        size: whole.length,
      },
    }
  }
  if (cmd === 'ls' || cmd === 'find') return fsFail(FS_NOT_A_DIRECTORY, 'ENOTDIR: not a directory')
  if (cmd === 'attach') {
    return fsFail(FS_NOT_A_FILE, 'attach requires a direct repository or bucket file URI.')
  }
  if (cmd !== 'cat') return fsFail(FS_INVALID, `EINVAL: unknown command: ${cmd}`)
  const flags = catArgs(rest)
  if ('code' in flags) return fsFail(flags.code, flags.message)
  // The same slicing a repository file gets, including the mid-character
  // retreat: this page is UTF-8 and a caller may resume into the middle of a
  // character exactly as it may anywhere else.
  const asked = Math.min(flags.offset, whole.length)
  const from = utf8Start(whole, asked)
  const end = utf8End(whole, Math.min(asked + flags.maxBytes, whole.length))
  const slice = whole.subarray(from, end)
  const bounds: CatBounds = { offset: from, total: whole.length, next: end }
  const truncated = bounds.next < bounds.total
  return {
    text: catMarkdown(README_URI, README_PATH, slice, bounds, README_MIME),
    result: {
      uri: README_URI,
      op: 'cat',
      path: README_PATH,
      content: slice.toString('utf8'),
      content_type: README_MIME,
      bytes: slice.length,
      truncated,
      ...(truncated ? { truncation_reason: 'max_bytes', next_offset: bounds.next } : {}),
    },
  }
}

async function fsOne(at: Dispatch, cmd: string, args: string[], budget: Budget): Promise<FsOut> {
  if (cmd === 'search') {
    return fsFail(
      FS_INVALID,
      `EINVAL: ${cmd} is not served by the mirage hf_hub fake; use ls, cat, stat or find`,
    )
  }
  const uri = args[0] ?? ''
  if (uri === README_URI) return readmeOne(cmd, args.slice(1))
  const where = locate(uri, cmd)
  if (!('kind' in where)) return fsFail(where.code, where.message)
  const rest = args.slice(1)
  // `stat` is the only command that takes the URI alone; cat, attach, ls and
  // find each parse their own flags below and refuse the rest by name there.
  // Listing the exceptions here was a standing trap -- attach and then ls
  // were each given a flag and then refused it by a guard written when they
  // had none -- so the condition names the one command that has no grammar
  // rather than the growing set that does.
  if (cmd === 'stat' && rest.length > 0) {
    return fsFail(FS_INVALID, `EINVAL: unexpected argument for ${cmd}: ${rest[0] ?? ''}`)
  }

  if (cmd === 'ls' || cmd === 'find') {
    const limit = listArgs(cmd, rest)
    if (typeof limit !== 'number') return fsFail(limit.code, limit.message)
    // One past the limit, so a listing that exactly fills it is not reported
    // as cut and one that overflows is -- without reading the rest of a tree
    // whose tail is going to be dropped anyway.
    const reply = await treeAt(at, where, cmd === 'find', limit)
    if (!ok(reply)) {
      return fsFail(FS_NOT_FOUND, `${where.path} does not exist on "main". URI: ${uri}`)
    }
    const found = entriesOf(reply)
    const truncated = found.length > limit
    const entries = truncated ? found.slice(0, limit) : found
    return {
      text: listingMarkdown(cmd, uri, entries, truncated),
      result: {
        uri,
        op: cmd,
        // The schema's own three, and the same vocabulary cat uses -- with
        // `entry_limit` where cat says `max_bytes`, because that is the enum
        // value upstream answers for a listing.
        ...(truncated
          ? {
              truncated: true,
              truncation_reason: 'entry_limit',
              truncation_message: LIST_TRUNCATED,
            }
          : {}),
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
    // Four outcomes, in the order that can tell them apart. A repository root
    // is answered first and without a lookup, because upstream calls it
    // `repo` and not `dir` -- the distinction is the whole reason stat is
    // recommended for "an uncertain target type".
    if (where.path === '') {
      // Looked up, not assumed. Returning `repo` without asking made every
      // syntactically valid URI a repository that exists -- and on a task
      // whose Hub starts EMPTY, an agent that stats the repository it is
      // about to create would be told it is already there.
      //
      // Upstream answers HF_FS_ACCESS_DENIED here rather than `missing`,
      // because anonymously it will not confirm that a repository is absent
      // as opposed to private. This fake is always authenticated as the
      // tenant and does know, so it says so in stat's own vocabulary; that
      // divergence is the one place it prefers the truth it has.
      // One page: only the status is read, never the rows.
      const exists = ok(await treeAt(at, { ...where, path: '' }, false, 1))
      return {
        text: statMarkdown(uri, exists ? 'repo' : 'missing', ''),
        result: exists
          ? { uri, op: 'stat', exists: true, type: 'repo', path: '' }
          : { uri, op: 'stat', exists: false, type: 'missing', path: '' },
      }
    }
    // One row answers all three of the remaining outcomes: the parent's
    // listing names the type, and for a file the size, which is every field
    // stat prints. A row absent from the directory it would have to be in is
    // what `missing` means -- read from the rows and not from the status,
    // because the tree route answers 200 with nothing for a path that is not
    // there, and `ok` alone called every missing file a directory.
    const row = await rowAt(at, where)
    if (row === undefined) {
      return {
        text: statMarkdown(uri, 'missing', where.path),
        result: { uri, op: 'stat', exists: false, type: 'missing', path: where.path },
      }
    }
    if (row.type === 'dir') {
      return {
        text: statMarkdown(uri, 'dir', where.path),
        result: { uri, op: 'stat', exists: true, type: 'dir', path: where.path },
      }
    }
    return {
      text: statMarkdown(uri, 'file', where.path, row.size),
      result: { uri, op: 'stat', exists: true, type: 'file', path: where.path, size: row.size },
    }
  }
  if (cmd === 'attach') {
    const bound = attachArgs(rest)
    if (typeof bound !== 'number') return fsFail(bound.code, bound.message)
    const mime = imageMime(where.path)
    const name = where.path.slice(where.path.lastIndexOf('/') + 1)
    const unsupported = (): FsOut =>
      fsFail(
        FS_UNSUPPORTED_MEDIA,
        `Unsupported attachment media: ${name === '' ? where.id : name}. ` +
          `The file extension is not .jpg, .jpeg, .png, or .webp.`,
      )
    if (mime === undefined) {
      // Three answers, and the classifier is the one `cat` uses read the other
      // way round. A known binary -- and a DIRECTORY, which has no extension
      // to match -- is unsupported media; anything else is a file upstream
      // calls text and sends you to `cat` for.
      if (where.path === '' || binaryName(where.path) || (await isDirectory(at, where))) {
        return unsupported()
      }
      return fsFail(
        FS_IMAGE_ONLY,
        `Refusing to attach known text file: ${name}. Attach returns supported image files only.`,
      )
    }
    const reply = await callRoute(
      at,
      'GET',
      `/${where.kind === 'models' ? '' : `${where.kind}/`}${where.id}/resolve/main/${where.path}`,
    )
    if (reply.status !== 200 || !Buffer.isBuffer(reply.body)) {
      // A name is not a promise of a file. `assets.png` can be a DIRECTORY,
      // and the extension branch above would have taken it for an image; a
      // resolve that fails is where the two become distinguishable again.
      // NOT_FOUND here would assert that something which exists does not,
      // and a directory is the one thing upstream can be OBSERVED calling
      // unsupported media -- no repository reachable from here holds a
      // directory named `*.png` to ask about directly.
      if (await isDirectory(at, where)) return unsupported()
      return fsFail(FS_NOT_FOUND, `File does not exist: ${where.path}`)
    }
    const whole = reply.body
    if (whole.length > bound) {
      return fsFail(
        FS_IMAGE_TOO_LARGE,
        `Image is too large to attach: ${where.path} is ${String(whole.length)} bytes; ` +
          `complete-file limit is ${String(bound)} bytes.`,
      )
    }
    // Checked against what the BATCH has left, and checked here rather than
    // after the loop so an over-budget image is released instead of retained:
    // the cost this cap exists to prevent is the response, and the buffer is
    // most of it.
    if (whole.length > budget.left) {
      return fsFail(
        FS_BUDGET,
        `Attachment omitted because the batch exceeds the cumulative response limit of ` +
          `${String(ATTACH_BATCH_BYTES)} bytes.`,
      )
    }
    budget.left -= whole.length
    return {
      text: attachMarkdown(uri, where.path, mime, whole.length),
      result: { op: 'attach', uri, path: where.path, mime_type: mime, bytes: whole.length },
      image: { mimeType: mime, data: whole.toString('base64') },
    }
  }
  if (cmd === 'cat') {
    // A repo root is not a malformed argument either -- it is a URI naming a
    // repository where a file was wanted, and the live server distinguishes
    // the three by wording alone: this sentence for a repository, the
    // "not a namespace" one above for a root or an owner, and "got dir"
    // below for a directory inside a repository.
    if (where.path === '') {
      return fsFail(FS_NOT_A_FILE, 'cat requires a URI that points to a file path.')
    }
    const flags = catArgs(rest)
    if ('code' in flags) return fsFail(flags.code, flags.message)
    if (binaryName(where.path)) {
      return fsFail(
        FS_TEXT_ONLY,
        `Refusing to cat non-text file: ${where.path.slice(where.path.lastIndexOf('/') + 1)}. ` +
          `The file extension or MIME type is known to be binary. ` +
          `Use ls or stat for file metadata.`,
      )
    }
    const reply = await callRoute(
      at,
      'GET',
      `/${where.kind === 'models' ? '' : `${where.kind}/`}${where.id}/resolve/main/${where.path}`,
    )
    if (reply.status !== 200 || !Buffer.isBuffer(reply.body)) {
      // A path that does not resolve is either missing or a DIRECTORY, and
      // the live server tells them apart. Only asked on the miss path, so a
      // read that succeeds still costs one request; and asked of the tree
      // rather than guessed from the name, because a directory is not
      // required to look like one.
      // A listing that ANSWERS is not a directory -- the tree route replies
      // 200 with no rows for a path that is not there at all, so the rows are
      // the test. A directory in git always holds something; an empty one
      // cannot be committed.
      if (await isDirectory(at, where)) {
        return fsFail(FS_NOT_A_FILE, `cat requires a file path, got dir: ${where.path}`)
      }
      return fsFail(FS_NOT_FOUND, `File does not exist: ${where.path}`)
    }
    // The whole file is fetched and then sliced, because the resolve route
    // serves a stored blob rather than a range. What the bound protects is the
    // TOOL RESULT, which is the thing that costs the caller.
    const whole = reply.body
    const asked = Math.min(flags.offset, whole.length)
    const from = utf8Start(whole, asked)
    // Measured from the offset the caller ASKED for, not from the retreated
    // one, which is what makes a mid-character read report more bytes than it
    // requested rather than fewer.
    const end = utf8End(whole, Math.min(asked + flags.maxBytes, whole.length))
    const slice = whole.subarray(from, end)
    const bounds: CatBounds = { offset: from, total: whole.length, next: end }
    const truncated = bounds.next < bounds.total
    return {
      text: catMarkdown(uri, where.path, slice, bounds),
      result: {
        uri,
        op: 'cat',
        path: where.path,
        content: slice.toString('utf8'),
        bytes: slice.length,
        truncated,
        // Both names are the captured schema's own vocabulary, not coined:
        // `truncation_reason` is an enum there and `max_bytes` is one of its
        // four values.
        ...(truncated ? { truncation_reason: 'max_bytes', next_offset: bounds.next } : {}),
      },
    }
  }
  return fsFail(FS_INVALID, `EINVAL: unknown command: ${cmd}`)
}

async function fsAnswer(at: Dispatch, args: Record<string, JsonValue>): Promise<Answer> {
  const ops = Array.isArray(args.operations) ? args.operations.map((one) => obj(one)) : []
  const texts: string[] = []
  const results: JsonValue[] = []
  const images: { mimeType: string; data: string }[] = []
  const budget: Budget = { left: ATTACH_BATCH_BYTES }
  for (const [i, one] of ops.entries()) {
    const out = await fsOne(at, String(one.cmd ?? ''), strList(one.args), budget)
    texts.push(out.text)
    if (out.image !== undefined) images.push(out.image)
    if (out.error === undefined) {
      results.push({ index: i, status: 'success', result: out.result ?? {} })
      continue
    }
    const error: Record<string, JsonValue> = {
      code: out.error.code,
      message: out.error.message,
      recovery: fsRecovery(out.error.code),
      retryable: false,
    }
    // Assigned rather than spread, so the key is absent when there is no
    // suggestion instead of present and undefined -- which is what upstream
    // sends, and the difference a client checking `in` would see.
    const suggested = fsSuggested(out.error.code)
    if (suggested !== undefined) error.suggestedOperation = suggested
    results.push({ index: i, status: 'error', error })
  }
  // A batch of nothing is not a batch of failures. The captured schema puts
  // `minItems: 1` on operations, so this cannot arrive from a conforming
  // caller, but `every` on an empty array is true and would report a batch
  // that ran nothing as a batch where everything failed.
  const failed = ops.length > 0 && ops.every((_, i) => obj(results[i]).status === 'error')
  return {
    text: operationsMarkdown(texts),
    structured: { results },
    ...(failed ? { isError: true } : {}),
    // One block per attachment, after the prose, which is the order upstream
    // sends them in: the text names what arrived and the block is what did.
    ...(images.length > 0 ? { images } : {}),
  }
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
      content: [
        { type: 'text', text: answer.text },
        ...(answer.images ?? []).map((one) => ({
          type: 'image' as const,
          mimeType: one.mimeType,
          data: one.data,
        })),
      ],
      ...(answer.structured === undefined ? {} : { structuredContent: answer.structured }),
      ...(answer.isError === true ? { isError: true } : {}),
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
