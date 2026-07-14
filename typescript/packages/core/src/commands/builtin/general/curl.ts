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

import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { httpFormRequest, httpRequest } from '../utils/http.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'

const ENC = new TextEncoder()

export function resolveTarget(o: string, cwd: string): PathSpec {
  let path = o
  if (!o.startsWith('/')) {
    const base = rstripSlash(cwd)
    path = base !== '' ? `${base}/${o}` : `/${o}`
  }
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/'
  return new PathSpec({ resourcePath: stripSlash(path), virtual: path, directory, resolved: true })
}

async function curlCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const H = typeof opts.flags.H === 'string' ? opts.flags.H : null
  const A = typeof opts.flags.A === 'string' ? opts.flags.A : null
  const X = typeof opts.flags.X === 'string' ? opts.flags.X : null
  const d = typeof opts.flags.d === 'string' ? opts.flags.d : null
  const F = typeof opts.flags.F === 'string' ? opts.flags.F : null
  const o = typeof opts.flags.o === 'string' ? opts.flags.o : null
  const L = opts.flags.L === true
  const silent = opts.flags.s === true

  const headers: Record<string, string> = {}
  if (H !== null) {
    const idx = H.indexOf(':')
    if (idx > 0) {
      headers[H.slice(0, idx).trim()] = H.slice(idx + 1).trim()
    }
  }
  if (A !== null) {
    headers['User-Agent'] = A
  }
  const url = texts[0]
  if (url === undefined) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('curl: missing URL\n') })]
  }
  let result: Uint8Array
  try {
    if (F !== null) {
      const method = X ?? 'POST'
      const eq = F.indexOf('=')
      const key = eq >= 0 ? F.slice(0, eq) : F
      const value = eq >= 0 ? F.slice(eq + 1) : ''
      result = await httpFormRequest(url, {
        method,
        formData: { [key]: value },
        headers,
      })
    } else {
      const method = X ?? (d !== null ? 'POST' : 'GET')
      const body = d !== null ? ENC.encode(d) : undefined
      result = await httpRequest(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        followRedirects: L,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 22, stderr: ENC.encode(`curl: ${msg}\n`) })]
  }
  if (o !== null) {
    if (opts.dispatch !== undefined) {
      const scope = resolveTarget(o, opts.cwd)
      try {
        await opts.dispatch('write', scope, [result])
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`curl: ${o}: ${errMsg}\n`) })]
      }
    }
    const msg = silent ? new Uint8Array() : ENC.encode(`saved to ${o}`)
    return [msg, new IOResult({ writes: { [o]: result } })]
  }
  return [result, new IOResult()]
}

export const GENERAL_CURL = command({
  name: 'curl',
  resource: null,
  spec: specOf('curl'),
  fn: curlCommand,
})
