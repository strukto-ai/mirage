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

import { FlagView } from '../../../spec/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { expand } from '../../../../core/github/placeholder.ts'
import type { GhConfig } from '../../../../core/github/config.ts'
import type { GitHubResponse } from '../../../../core/github/client.ts'
import { jqEval } from '../../../../core/jq/index.ts'
import { materialize } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import { resolvePath } from '../../../../utils/path.ts'
import { ghTransport, jsonOut, textOut } from './accessor.ts'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const EMPTY_ARRAY = Symbol('empty-array')

function typed(value: string): Json {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

function jqLine(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
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

async function stdinBytes(inv: CLIInvocation): Promise<Uint8Array> {
  if (inv.stdin === null) throw new Error('standard input is required')
  return materialize(inv.stdin)
}

function isDashInput(inv: CLIInvocation, long: string): boolean {
  return inv.argv.some(
    (word, index) => word === `${long}=-` || (word === long && inv.argv[index + 1] === '-'),
  )
}

async function readFile(inv: CLIInvocation, path: string): Promise<Uint8Array> {
  if (path === '-') return stdinBytes(inv)
  const dispatch = inv.doors?.dispatch
  if (dispatch === undefined) throw new Error(`read ${path}: a workspace is required`)
  const cwd = inv.env.PWD ?? '/'
  const virtual = resolvePath(path, cwd)
  try {
    const [data] = await dispatch('read', PathSpec.fromStrPath(virtual))
    return data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
  } catch (err) {
    if (err instanceof Error && err.name === 'FileNotFoundError') {
      throw new Error(`read ${path}: No such file or directory`)
    }
    throw err
  }
}

async function fieldValue(inv: CLIInvocation, value: string): Promise<Json> {
  const expanded = expand(value, inv.config as GhConfig)
  if (expanded.startsWith('@')) {
    return new TextDecoder().decode(await readFile(inv, expanded.slice(1)))
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
  const raw = fl.asStr('input')
  if (raw === undefined) return undefined
  const path = raw === '-' || isDashInput(inv, '--input') ? '-' : raw
  try {
    return JSON.parse(new TextDecoder().decode(await readFile(inv, path))) as Json
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
  const path = expanded.startsWith('/') ? expanded : `/${expanded}`

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

  const pages: unknown[] = []
  const transport = ghTransport(inv.config)
  let current: string | undefined = path
  let first = true
  while (current !== undefined) {
    const headers = requestHeaders(fl)
    const response: GitHubResponse =
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
    pages.push(response.data)
    first = false
    current = fl.asBool('paginate')
      ? nextPath(response.headers.link, (inv.config as GhConfig).baseUrl)
      : undefined
  }

  if (fl.asBool('silent')) return textOut('')
  const slurp = fl.asBool('slurp')
  const program = fl.asStr('jq')
  if (program !== undefined && program !== '') {
    const inputs = slurp ? [pages] : pages
    const output: string[] = []
    for (const item of inputs) {
      for (const value of await jqEval(item, program)) output.push(`${jqLine(value)}\n`)
    }
    return textOut(output.join(''))
  }
  if (slurp) return jsonOut(pages)
  if (pages.length === 1) {
    return typeof pages[0] === 'string' ? textOut(pages[0]) : jsonOut(pages[0])
  }
  return textOut(
    pages
      .map((page) => (typeof page === 'string' ? page : `${JSON.stringify(page, null, 2)}\n`))
      .join(''),
  )
}
