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
import { ghTransport, jsonOut } from './accessor.ts'

/**
 * `-f key=value` is always a string; `-F key=value` reads `true`, `false`,
 * `null` and integers as their JSON types, which is gh's own split between
 * `--raw-field` and `--field`.
 */
function typed(value: string): string | number | boolean | null {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+$/.test(value)) return Number(value)
  return value
}

function split(pair: string): [string, string] {
  const at = pair.indexOf('=')
  if (at < 0) throw new Error(`expected "key=value", got "${pair}"`)
  return [pair.slice(0, at), pair.slice(at + 1)]
}

export async function api(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const endpoint = inv.texts[0] ?? ''
  if (endpoint === '') throw new Error('an API endpoint is required')
  const body: Record<string, string | number | boolean | null> = {}
  for (const pair of fl.asList('raw_field')) body[split(pair)[0]] = split(pair)[1]
  for (const pair of fl.asList('field')) body[split(pair)[0]] = typed(split(pair)[1])
  // gh sends a body-bearing call as POST unless --method says otherwise,
  // and a bare one as GET.
  const method = fl.asStr('method') ?? (Object.keys(body).length > 0 ? 'POST' : 'GET')
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  const upper = method.toUpperCase()
  const payload = upper === 'GET' ? undefined : body
  const params = upper === 'GET' ? (body as Record<string, string>) : undefined
  return jsonOut(await ghTransport(inv.config).request(upper, path, payload, params))
}
