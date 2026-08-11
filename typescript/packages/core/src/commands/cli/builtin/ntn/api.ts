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
import { IOResult, materialize } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { serdeMessage } from './serde.ts'
import { compactJson, firstText, notionTransport, rustDebug, usageError } from './util.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// Every byte below is probed against ntn 0.21.9. The exit codes are not one
// family: a body that arrived malformed is 1, while a line the CLI refuses to
// interpret at all is 5, and neither is argparse's 2.
const BAD_DATA = 'error: Invalid JSON from --data\n'
const BAD_STDIN = 'error: Invalid JSON from stdin\n'
const EMPTY_DATA =
  'error: --data requires a valid JSON value.\n' +
  '  hint: Pass a JSON string such as `--data \'{"foo":"bar"}\'`, a file ' +
  'such as `--data @body.json`, or stdin with `--data @-`.\n'
const INLINE_LEAD = 'error: Failed to parse inline request input: '
const INLINE_HINT = '  hint: Use `Header:Value`, `name==value`, `path=value`, or `path:=json`.\n'
const CONFLICT_LEAD = 'error: Request body can come from only one source, but got: '
const CONFLICT_HINT =
  '  hint: Use only one of: stdin JSON, `--data`, or `path=value` / `path:=json` inputs.\n'
const STDIN_SOURCE = 'stdin JSON'
const DATA_SOURCE = '--data'
const INLINE_SOURCE = 'inline body inputs'
const BAD_BODY_EXIT = 1
const REFUSAL_EXIT = 5

// DELETE is here because `DELETE /v1/blocks/{id}` is the only delete verb the
// public API has, so without it the one way to remove anything is unreachable
// from this CLI. It takes no body, which is why it is reached through `-X`
// rather than by a body source inferring it.
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])

// One inline input the CLI could not interpret, carrying the clause upstream
// puts after its fixed lead.
class InlineRefusal extends Error {}

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
  headers: Record<string, string>,
): void {
  const typed = token.indexOf(':=')
  if (typed !== -1) {
    const name = token.slice(0, typed)
    const raw = token.slice(typed + 2)
    // serde decides, not JSON.parse: the two disagree about what is valid
    // and never agree on the wording, and this message is compared byte for
    // byte against the real binary.
    const message = serdeMessage(raw)
    if (message !== null) {
      throw new InlineRefusal(`invalid JSON value in ${rustDebug(token)}: ${message}`)
    }
    assign(body, name, JSON.parse(raw))
    return
  }
  const queried = token.indexOf('==')
  if (queried !== -1) {
    params[token.slice(0, queried)] = token.slice(queried + 2)
    return
  }
  const colon = token.indexOf(':')
  const equals = token.indexOf('=')
  if (colon !== -1 && (equals === -1 || colon < equals)) {
    headers[token.slice(0, colon)] = token.slice(colon + 1)
    return
  }
  if (equals !== -1) {
    assign(body, token.slice(0, equals), token.slice(equals + 1))
    return
  }
  throw new InlineRefusal(`unexpected input: ${rustDebug(token)}`)
}

// One of upstream's own refusals, rendered.
function refusal(stderr: string, code: number): CommandFnResult {
  return [null, new IOResult({ stderr: ENC.encode(stderr), exitCode: code })]
}

export async function api(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const inline: Record<string, unknown> = {}
  const params: Record<string, unknown> = {}
  const headers: Record<string, string> = {}
  let path: string
  let method: string
  let body: unknown
  let named: string[]
  try {
    path = firstText(inv.texts, 'api path')

    // Upstream validates the three body sources in this order and only then
    // complains that more than one was given, so a malformed pipe outranks a
    // malformed --data, and both outrank the conflict. Probed against ntn
    // 0.21.9; the order is observable and worth keeping.
    const piped = inv.stdin !== null ? DEC.decode(await materialize(inv.stdin)) : ''
    const hasStdin = piped.trim() !== ''
    let stdinBody: unknown
    if (hasStdin) {
      if (serdeMessage(piped) !== null) return refusal(BAD_STDIN, BAD_BODY_EXIT)
      stdinBody = JSON.parse(piped)
    }

    const data = fl.asStr('data')
    const hasData = data !== undefined
    let dataBody: unknown
    if (data !== undefined) {
      if (data.trim() === '') return refusal(EMPTY_DATA, REFUSAL_EXIT)
      if (serdeMessage(data) !== null) return refusal(BAD_DATA, BAD_BODY_EXIT)
      dataBody = JSON.parse(data)
    }

    try {
      for (const token of inv.texts.slice(1)) classify(token, inline, params, headers)
    } catch (err) {
      if (!(err instanceof InlineRefusal)) throw err
      return refusal(`${INLINE_LEAD}${err.message}\n${INLINE_HINT}`, REFUSAL_EXIT)
    }

    const hasInline = Object.keys(inline).length > 0
    named = [
      ...(hasStdin ? [STDIN_SOURCE] : []),
      ...(hasData ? [DATA_SOURCE] : []),
      ...(hasInline ? [INLINE_SOURCE] : []),
    ]
    if (named.length > 1) {
      return refusal(`${CONFLICT_LEAD}${named.join(', ')}.\n${CONFLICT_HINT}`, REFUSAL_EXIT)
    }

    // A body source makes the call a POST even when what it carries is empty:
    // `--data {}` posts, and there is no object check anywhere, so a list or
    // a scalar goes out exactly as it was typed.
    if (hasStdin) body = stdinBody
    else if (hasData) body = dataBody
    else if (hasInline) body = inline

    method = (fl.asStr('method') ?? (named.length > 0 ? 'POST' : 'GET')).toUpperCase()
    if (!METHODS.has(method)) throw new Error(`unsupported method: ${method}`)
  } catch (err) {
    return usageError(err)
  }

  const rooted = path.startsWith('/') ? path : `/${path}`
  const route = rooted.startsWith('/v1/') ? rooted.slice(3) : rooted
  const call: RestCall = { method: method as RestCall['method'], path: route }
  // `name==value` is a query parameter whatever the method is, so it rides
  // alongside the body rather than being dropped once the call stops being
  // a GET.
  if (Object.keys(params).length > 0) call.query = params
  if (method !== 'GET') call.body = body
  if (Object.keys(headers).length > 0) call.headers = headers
  const result = await notionTransport(inv.config, inv.flags).request(call)
  return [compactJson(result), new IOResult()]
}
