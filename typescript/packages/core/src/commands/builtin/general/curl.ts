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
import {
  HttpConnectError,
  type HttpResponse,
  httpFormRequest,
  httpRequest,
  isHttpError,
} from '../utils/http.ts'
import { UsageError } from '../../errors.ts'
import { gnuStrerror, isFsError } from '../../../utils/errors.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { FlagView } from '../../spec/types.ts'

const ENC = new TextEncoder()

// Exit codes real curl uses for the failures mirage can hit. An HTTP error
// status is deliberately absent: curl treats 4xx/5xx as a successful transfer
// and prints the body, and only -f/--fail turns it into EXIT_HTTP_ERROR.
const EXIT_NO_URL = 2
const EXIT_CONNECT = 7
const EXIT_HTTP_ERROR = 22
const EXIT_WRITE = 23

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
  const fl = new FlagView(opts.flags, specOf('curl'))
  const H = fl.asStr('H') ?? null
  const A = fl.asStr('A') ?? null
  const X = fl.asStr('X') ?? null
  const d = fl.asStr('d') ?? null
  const F = fl.asStr('F') ?? null
  const o = fl.asStr('o') ?? null
  const L = fl.asBool('L')
  const failOnError = fl.asBool('fail')
  // -s silences the message, -S puts it back. Neither changes the exit code.
  const quiet = fl.asBool('s') && !fl.asBool('S')

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
    throw new UsageError(
      "curl: (2) no URL specified\ncurl: try 'curl --help' or 'curl --manual' for more information",
      EXIT_NO_URL,
    )
  }
  let resp: HttpResponse
  try {
    if (F !== null) {
      const method = X ?? 'POST'
      const eq = F.indexOf('=')
      const key = eq >= 0 ? F.slice(0, eq) : F
      const value = eq >= 0 ? F.slice(eq + 1) : ''
      resp = await httpFormRequest(url, {
        method,
        formData: { [key]: value },
        headers,
        followRedirects: L,
      })
    } else {
      const method = X ?? (d !== null ? 'POST' : 'GET')
      const body = d !== null ? ENC.encode(d) : undefined
      resp = await httpRequest(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        followRedirects: L,
      })
    }
  } catch (err) {
    if (!(err instanceof HttpConnectError)) throw err
    const line = `curl: (${String(EXIT_CONNECT)}) Failed to connect to ${err.host} port ${String(err.port)}: Could not connect to server\n`
    return [
      null,
      new IOResult({
        exitCode: EXIT_CONNECT,
        stderr: quiet ? new Uint8Array() : ENC.encode(line),
      }),
    ]
  }
  // Only -f makes an error status an error, and then nothing is written.
  if (failOnError && isHttpError(resp)) {
    const line = `curl: (${String(EXIT_HTTP_ERROR)}) The requested URL returned error: ${String(resp.status)}\n`
    return [
      null,
      new IOResult({
        exitCode: EXIT_HTTP_ERROR,
        stderr: quiet ? new Uint8Array() : ENC.encode(line),
      }),
    ]
  }
  const result = resp.body
  if (o !== null) {
    if (opts.dispatch !== undefined) {
      const scope = resolveTarget(o, opts.cwd)
      try {
        await opts.dispatch('write', scope, [result])
      } catch (err) {
        // Deliberate divergence: real curl says "client returned ERROR on
        // write of N bytes" and drops the cause. A mirage write can fail for
        // reasons a local file cannot (read-only mount, unsupported op), so
        // the exit code matches curl while the message keeps path and reason.
        //
        // The refusals whose wording is load-bearing (read-only mount,
        // unsupported op) keep their raw message; an unusable path carries
        // only the path as its message, so it needs the GNU strerror.
        const code = (err as { code?: string }).code
        const strerror = gnuStrerror(code)
        const raw = code === 'EACCES' || code === 'ENOTSUP' || !isFsError(err)
        const detail =
          !raw && strerror !== null ? strerror : err instanceof Error ? err.message : String(err)
        const line = `curl: (${String(EXIT_WRITE)}) ${o}: ${detail}\n`
        return [
          null,
          new IOResult({
            exitCode: EXIT_WRITE,
            stderr: quiet ? new Uint8Array() : ENC.encode(line),
          }),
        ]
      }
    }
    // Real curl writes the body to the file and prints nothing on stdout.
    return [null, new IOResult({ writes: { [o]: result } })]
  }
  return [result, new IOResult()]
}

export const GENERAL_CURL = command({
  name: 'curl',
  resource: null,
  spec: specOf('curl'),
  fn: curlCommand,
})
