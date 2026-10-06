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

import { IOResult } from '../../../../io/types.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { expand } from '../../../../core/github/placeholder.ts'
import type { GhConfig } from '../../../../core/github/config.ts'
import { GRAPHQL_PATH } from '../../../../core/github/constants.ts'
import { GitHubApiError, type GitHubResponse } from '../../../../core/github/client.ts'
import { PartialOutputError } from '../../../errors.ts'
import { ghBool, ghTransport, jqLines, readCliFile } from './accessor.ts'
import { HTTP_REASONS } from './constants.ts'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const EMPTY_ARRAY = Symbol('empty-array')
const ENC = new TextEncoder()

// One response as `gh api` prints it: the decoded body, and under `-i` the
// status line and headers that go before it ('' otherwise).
interface Printed {
  data: unknown
  head: string
}

// A failing response: its body verbatim, and its head as for any other.
interface Failure {
  body: string
  head: string
}

function typed(value: string): Json {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

function split(pair: string, emptyArray = false): [string, string | typeof EMPTY_ARRAY] {
  const at = pair.indexOf('=')
  if (at >= 0) return [pair.slice(0, at), pair.slice(at + 1)]
  if (emptyArray && pair.endsWith('[]')) return [pair, EMPTY_ARRAY]
  throw new Error(`expected "key=value", got "${pair}"`)
}

function keyParts(key: string): (string | null)[] {
  const first = key.indexOf('[')
  if (first === 0 || (first < 0 && key.includes(']'))) {
    throw new Error(`invalid field key: "${key}"`)
  }
  if (first < 0) return [key]
  const parts: (string | null)[] = [key.slice(0, first)]
  let rest = key.slice(first)
  while (rest !== '') {
    const close = rest.indexOf(']')
    if (!rest.startsWith('[') || close < 0 || rest.slice(1, close).includes('[')) {
      throw new Error(`invalid field key: "${key}"`)
    }
    const item = rest.slice(1, close)
    parts.push(item === '' ? null : item)
    rest = rest.slice(close + 1)
  }
  return parts
}

function put(container: unknown, parts: (string | null)[], value: unknown): void {
  const token = parts[0]
  const tail = parts.slice(1)
  if (typeof token === 'string') {
    if (container === null || typeof container !== 'object' || Array.isArray(container)) {
      throw new Error('field nesting mixes an object and an array')
    }
    const object = container as Record<string, unknown>
    if (tail.length === 0) {
      object[token] = value
      return
    }
    const wantArray = tail[0] === null
    let child = object[token]
    if ((wantArray && !Array.isArray(child)) || (!wantArray && !isRecord(child))) {
      child = wantArray ? [] : {}
      object[token] = child
    }
    put(child, tail, value)
    return
  }

  if (!Array.isArray(container)) throw new Error('field nesting mixes an object and an array')
  if (tail.length === 0) {
    if (value !== EMPTY_ARRAY) container.push(value)
    return
  }
  const wantArray = tail[0] === null
  let child: unknown = container.at(-1)
  let reuse = wantArray ? Array.isArray(child) : isRecord(child)
  if (reuse && isRecord(child) && typeof tail[0] === 'string') {
    const next = tail[0]
    reuse = !(next in child) || (tail.length > 1 && tail[1] === null)
  }
  if (!reuse) {
    child = wantArray ? [] : {}
    container.push(child)
  }
  put(child, tail, value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function setField(fields: Record<string, unknown>, key: string, value: unknown): void {
  put(fields, keyParts(key), value)
}

async function fieldValue(inv: CLIInvocation, value: string): Promise<Json> {
  const expanded = expand(value, inv.config as GhConfig)
  if (expanded.startsWith('@')) {
    return new TextDecoder().decode(await readCliFile(inv, expanded.slice(1), '--field'))
  }
  return typed(expanded)
}

async function fields(inv: CLIInvocation, fl: FlagView): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const pair of fl.asList('raw_field')) {
    const [key, value] = split(pair)
    setField(result, key, value)
  }
  for (const pair of fl.asList('field')) {
    const [key, value] = split(pair, true)
    setField(result, key, value === EMPTY_ARRAY ? value : await fieldValue(inv, value))
  }
  return result
}

function requestHeaders(fl: FlagView): Record<string, string> {
  const result: Record<string, string> = {}
  for (const header of fl.asList('header')) {
    const at = header.indexOf(':')
    if (at < 1) throw new Error(`expected "key:value", got "${header}"`)
    result[header.slice(0, at).trim()] = header.slice(at + 1).trim()
  }
  return result
}

async function inputBody(inv: CLIInvocation, fl: FlagView): Promise<Json | undefined> {
  const raw = fl.raw('input')
  if (raw === undefined) return undefined
  const path = fl.asPaths('input')[0]?.rawPath ?? fl.asStr('input') ?? ''
  try {
    return JSON.parse(new TextDecoder().decode(await readCliFile(inv, raw, '--input'))) as Json
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`invalid JSON in ${path}: ${err.message}`)
    throw err
  }
}

function queryValue(value: unknown): string {
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function nextPath(link: string | undefined, baseUrl: string | undefined): string | undefined {
  if (link === undefined || link === '') return undefined
  for (const item of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(item)
    if (match === null || !(match[2] ?? '').split(/\s+/).includes('next')) continue
    const target = match[1] ?? ''
    let path: string
    try {
      const url = new URL(target)
      path = `${url.pathname}${url.search}`
    } catch {
      path = target.startsWith('/') ? target : `/${target}`
    }
    const queryAt = path.indexOf('?')
    let pathname = queryAt < 0 ? path : path.slice(0, queryAt)
    const search = queryAt < 0 ? '' : path.slice(queryAt)
    const basePath = baseUrl === undefined ? '' : new URL(baseUrl).pathname.replace(/\/$/, '')
    if (basePath !== '' && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
      pathname = pathname.slice(basePath.length) || '/'
    }
    return `${pathname}${search}`
  }
  return undefined
}

export async function api(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const endpoint = inv.texts[0] ?? ''
  if (endpoint === '') throw new Error('an API endpoint is required')
  const values = await fields(inv, fl)
  const input = await inputBody(inv, fl)
  const hasInput = fl.raw('input') !== undefined
  const method = fl.asStr('method') ?? (Object.keys(values).length > 0 || hasInput ? 'POST' : 'GET')
  const upper = method.toUpperCase()
  const expanded = expand(endpoint, inv.config as GhConfig)
  const path =
    expanded === GRAPHQL_PATH ? expanded : expanded.startsWith('/') ? expanded : `/${expanded}`

  let body: unknown
  let params: Record<string, string> | undefined
  if (hasInput) {
    body = input
    params = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, queryValue(value)]),
    )
  } else if (upper === 'GET') {
    params = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, queryValue(value)]),
    )
  } else if (Object.keys(values).length > 0) {
    body = values
  }
  if (params !== undefined && Object.keys(params).length === 0) params = undefined

  const pages: Printed[] = []
  const include = ghBool(fl, 'include')
  const transport = ghTransport(inv.config)
  let current: string | undefined = path
  let first = true
  while (current !== undefined) {
    const headers = requestHeaders(fl)
    let response: GitHubResponse
    try {
      response =
        transport.requestWithResponse === undefined
          ? {
              data: await transport.request(
                upper,
                current,
                body,
                first ? params : undefined,
                Object.keys(headers).length === 0 ? undefined : headers,
              ),
              status: 200,
              headers: {},
            }
          : await transport.requestWithResponse(
              upper,
              current,
              body,
              first ? params : undefined,
              Object.keys(headers).length === 0 ? undefined : headers,
            )
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error
      return failed(
        pages,
        fl,
        { body: error.body, head: include ? responseHead(error.status, error.headers) : '' },
        serverError(error.data, error.status) || `HTTP ${String(error.status)}`,
      )
    }
    const head = include ? responseHead(response.status, response.headers) : ''
    if (endpoint === 'graphql') {
      const diagnostic = serverError(response.data, response.status)
      if (diagnostic !== '') {
        return failed(pages, fl, { body: JSON.stringify(response.data), head }, diagnostic)
      }
    }
    pages.push({ data: response.data, head })
    first = false
    current = ghBool(fl, 'paginate')
      ? nextPath(response.headers.link, (inv.config as GhConfig).baseUrl)
      : undefined
  }

  return [await renderPages(pages, fl), new IOResult()]
}

// gh's name for a header: each word capitalized, the way Go canonicalizes one.
function canonical(name: string): string {
  return name
    .toLowerCase()
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('-')
}

/**
 * The status line and headers `gh api -i` prints before a body.
 *
 * gh prints the protocol and status Go's client reports, then every header
 * but `Status` in name order, each line ending `\r\n`, then a blank `\r\n`
 * line. Mirage's clients speak HTTP/1.1, and the reason is Go's phrase for
 * the code. The body arrives decoded, so the headers describing its encoded
 * form (`Content-Encoding`, `Content-Length`) are dropped, which is what Go's
 * transport does when it inflates a body itself.
 */
function responseHead(status: number, headers: Record<string, string>): string {
  const decoded = headers['content-encoding'] !== undefined
  const lines = Object.entries(headers)
    .map(([name, value]): [string, string] => [canonical(name), value])
    .filter(
      ([name]) =>
        name !== 'Status' &&
        !(decoded && (name === 'Content-Encoding' || name === 'Content-Length')),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}: ${value}\r\n`)
  return `HTTP/1.1 ${String(status)} ${HTTP_REASONS[status] ?? ''}\n${lines.join('')}\r\n`
}

/**
 * What gh reports from a JSON error body, empty when it names nothing.
 *
 * gh's `parseErrorResponse`: a string `errors` is the failure, with
 * `message` in parentheses; otherwise `message` is, with the status;
 * otherwise the messages of an `errors` array, one per line.
 */
function serverError(data: unknown, status: number): string {
  if (!isRecord(data)) return ''
  const message = typeof data.message === 'string' ? data.message : ''
  const errors = data.errors
  if (typeof errors === 'string' && errors !== '') {
    return message !== '' ? `${errors} (${message})` : errors
  }
  if (message !== '') return `${message} (HTTP ${String(status)})`
  if (!Array.isArray(errors)) return ''
  const lines: string[] = []
  for (const entry of errors) {
    if (typeof entry === 'string') lines.push(entry)
    else if (isRecord(entry)) lines.push(typeof entry.message === 'string' ? entry.message : '')
  }
  return lines.join('\n')
}

async function failed(
  pages: Printed[],
  fl: FlagView,
  failure: Failure,
  diagnostic: string,
): Promise<CommandFnResult> {
  return [
    await renderPages(pages, fl, failure),
    new IOResult({ exitCode: 1, stderr: ENC.encode(`gh: ${diagnostic}\n`) }),
  ]
}

/**
 * A page's body as gh copies it out: verbatim, with no newline added. The
 * body arrives decoded, and the vendor's JSON is compact, so the compact
 * spelling of what arrived is the text it sent. A body that is not JSON is
 * its own text, bytes that are not text (a run's log archive) are copied
 * as they came, and a call that answered with none prints nothing.
 */
function bodyText(page: unknown): string | Uint8Array {
  if (page === null) return ''
  if (page instanceof Uint8Array) return page
  return typeof page === 'string' ? page : JSON.stringify(page)
}

function bytesOf(parts: readonly (string | Uint8Array)[]): Uint8Array {
  const chunks = parts.map((part) => (typeof part === 'string' ? ENC.encode(part) : part))
  const out = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

// `parts` with `between` inserted between each two.
function joined(
  parts: readonly (readonly (string | Uint8Array)[])[],
  between: string,
): (string | Uint8Array)[] {
  return parts.flatMap((part, index) => (index === 0 ? [...part] : [between, ...part]))
}

/**
 * The bodies of `--paginate` as gh's paginatedArrayReader streams them.
 *
 * A JSON array body after the first opens with a comma instead of its
 * bracket (an empty one with a space), and one that more pages follow drops
 * its closing bracket, so array pages print as one array. Object bodies, and
 * bodies that are not JSON, run on as they came. `more` says a failing body
 * follows the last page here.
 */
function joinedPages(pages: unknown[], more: boolean): (string | Uint8Array)[] {
  return pages.map((page, index) => {
    let text = bodyText(page)
    if (page === null || typeof page === 'string' || typeof text !== 'string') return text
    if (index > 0 && text.startsWith('[')) {
      text = `${text.startsWith('[]') ? ' ' : ','}${text.slice(1)}`
    }
    if ((more || index < pages.length - 1) && text.endsWith(']')) text = text.slice(0, -1)
    return text
  })
}

/**
 * Render the completed pages, then a failing response's body.
 *
 * gh copies the failing body out verbatim, past `--jq`. Under `--slurp`
 * that body is still the array's last element, even an empty one or one
 * that is not JSON, which is gh's own output.
 *
 * Under `-i` every response's head goes before its body, a newline goes
 * between two responses, and pages print as they came rather than joined
 * into one array. `--silent` drops the bodies and keeps the heads, and under
 * `--slurp` the array's `[` or `,` goes before a page's head, since gh's
 * writer opens each page before the head is printed.
 */
async function renderPages(pages: Printed[], fl: FlagView, failure?: Failure): Promise<Uint8Array> {
  const include = ghBool(fl, 'include')
  const between = include ? '\n' : ''
  const all = failure === undefined ? pages : [...pages, { data: null, head: failure.head }]
  if (ghBool(fl, 'silent'))
    return bytesOf(
      joined(
        all.map((page) => [page.head]),
        between,
      ),
    )
  const slurp = ghBool(fl, 'slurp')
  const printed = pages.map((page) => [page.head, bodyText(page.data)])
  const failed = failure === undefined ? [] : [[failure.head, failure.body]]
  // gh's jsonArrayWriter: every body in one array, a comma between each.
  if (slurp && failure !== undefined) {
    return bytesOf(['[', ...joined([...printed, ...failed], `${between},`), ']'])
  }
  const program = fl.asStr('jq')
  if (program !== undefined && program !== '') {
    if (!include || slurp) {
      const heads = joined(
        pages.map((page) => [page.head]),
        between,
      )
      const data = pages.map((page) => page.data)
      return bytesOf([...heads, await jqLines(slurp ? [data] : data, program), failure?.body ?? ''])
    }
    const parts: (string | Uint8Array)[][] = []
    for (const page of pages) {
      try {
        parts.push([page.head, await jqLines([page.data], program)])
      } catch (err) {
        if (!(err instanceof PartialOutputError)) throw err
        const done = bytesOf([...joined([...parts, [page.head]], between), err.stdout])
        throw new PartialOutputError(err.message, done)
      }
    }
    return bytesOf(joined([...parts, ...failed], between))
  }
  if (slurp) return bytesOf(['[', ...joined(printed, `${between},`), ']'])
  if (include) return bytesOf(joined([...printed, ...failed], between))
  return bytesOf([
    ...joinedPages(
      pages.map((page) => page.data),
      failure !== undefined,
    ),
    failure?.body ?? '',
  ])
}
