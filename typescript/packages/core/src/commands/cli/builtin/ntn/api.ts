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
import type { RestCall } from '../../../../core/notion/_client.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { compactJson, firstText, notionTransport, usageError } from './util.ts'

const METHODS = new Set(['GET', 'POST', 'PATCH'])

type Container = Record<string, unknown> | unknown[]

function isDigits(text: string): boolean {
  return text !== '' && /^\d+$/.test(text)
}

// Walk one level into a body being built, creating the container the next
// key implies (an array for an index or an append, an object otherwise).
function descend(cursor: Container, key: string, blank: Container): Container {
  if (Array.isArray(cursor)) {
    const at = key === '' ? cursor.length : Number(key)
    cursor[at] ??= blank
    return cursor[at] as Container
  }
  cursor[key] ??= blank
  return cursor[key] as Container
}

function place(cursor: Container, key: string, value: unknown): void {
  if (Array.isArray(cursor)) {
    if (key === '') cursor.push(value)
    else cursor[Number(key)] = value
    return
  }
  cursor[key] = value
}

// Set a bracket path (`a[b][0][c]`) inside a request body.
function assign(body: Record<string, unknown>, path: string, value: unknown): void {
  const at = path.indexOf('[')
  const head = at === -1 ? path : path.slice(0, at)
  const keys = [head]
  if (at !== -1) {
    for (const chunk of path.slice(at + 1).split('[')) keys.push(chunk.replace(/]$/, ''))
  }
  let cursor: Container = body
  for (let index = 0; index < keys.length - 1; index += 1) {
    const step = keys[index + 1] ?? ''
    const blank: Container = step === '' || isDigits(step) ? [] : {}
    cursor = descend(cursor, keys[index] ?? '', blank)
  }
  place(cursor, keys[keys.length - 1] ?? '', value)
}

// Precedence is the upstream CLI's, and it is order-sensitive: `path:=json`
// beats `name==value` beats `Header:Value` beats `path=value`, so a value
// containing one separator cannot be reclassified by another later in it.
function classify(
  token: string,
  body: Record<string, unknown>,
  params: Record<string, unknown>,
): void {
  const typed = token.indexOf(':=')
  if (typed !== -1) {
    const name = token.slice(0, typed)
    try {
      assign(body, name, JSON.parse(token.slice(typed + 2)))
    } catch {
      throw new Error(`${name}:= must be valid JSON`)
    }
    return
  }
  const queried = token.indexOf('==')
  if (queried !== -1) {
    params[token.slice(0, queried)] = token.slice(queried + 2)
    return
  }
  const colon = token.indexOf(':')
  const equals = token.indexOf('=')
  if (colon !== -1 && (equals === -1 || colon < equals)) return
  if (equals !== -1) {
    assign(body, token.slice(0, equals), token.slice(equals + 1))
    return
  }
  throw new Error(`unrecognized request input: ${token}`)
}

export async function api(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const body: Record<string, unknown> = {}
  const params: Record<string, unknown> = {}
  let path: string
  let method: string
  try {
    path = firstText(inv.texts, 'api path')
    for (const token of inv.texts.slice(1)) classify(token, body, params)
    const data = fl.asStr('data')
    if (data !== undefined && data !== '') {
      if (Object.keys(body).length > 0) throw new Error('request body must come from one source')
      const parsed: unknown = JSON.parse(data)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('--data must be a JSON object')
      }
      Object.assign(body, parsed)
    }
    const hasBody = Object.keys(body).length > 0
    method = (fl.asStr('method') ?? (hasBody ? 'POST' : 'GET')).toUpperCase()
    if (!METHODS.has(method)) throw new Error(`unsupported method: ${method}`)
  } catch (err) {
    return usageError(err)
  }

  const rooted = path.startsWith('/') ? path : `/${path}`
  const route = rooted.startsWith('/v1/') ? rooted.slice(3) : rooted
  const call: RestCall = { method: method as RestCall['method'], path: route }
  if (method === 'GET') call.query = params
  else call.body = body
  const result = await notionTransport(inv.config, inv.flags).request(call)
  return [compactJson(result), new IOResult()]
}
