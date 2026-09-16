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
import { HttpConnectError, HttpTimeoutError } from '../errors.ts'
import {
  DEFAULT_USER_AGENT,
  type HttpResponse,
  httpFormRequest,
  httpRequest,
  isHttpError,
} from '../utils/http.ts'
import { UsageError } from '../../errors.ts'
import { gnuStrerror, isFsError } from '../../../utils/errors.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { FlagView } from '../../spec/types.ts'

const ENC = new TextEncoder()

// Exit codes real curl uses for the failures mirage can hit. An HTTP error
// status is deliberately absent: curl treats 4xx/5xx as a successful transfer
// and prints the body, and only -f/--fail turns it into EXIT_HTTP_ERROR.
// 2 is any line curl refuses before a transfer.
const EXIT_USAGE = 2
const EXIT_CONNECT = 7
const EXIT_HTTP_ERROR = 22
const EXIT_WRITE = 23
const EXIT_TIMEOUT = 28

const DEFAULT_TIMEOUT_MS = 30_000
const CRLF = '\r\n'
const HELP_HINT = "curl: try 'curl --help' or 'curl --manual' for more information"
// curl 8.7.1's wording, wrapped where it wraps it (the trailing space is the
// wrap point).
const HEAD_DATA_WARNING =
  'Warning: You can only select one HTTP request method! You asked for both POST \n' +
  'Warning: (-d, --data) and HEAD (-I, --head).\n'
const HEAD_FORM_WARNING =
  'Warning: You can only select one HTTP request method! You asked for both \n' +
  'Warning: multipart formpost (-F, --form) and HEAD (-I, --head).\n'
// curl's own Content-Type for a -d body, sent unless the line names one:
// httpx's `content=` and fetch's body carry no type of their own.
const BODY_CONTENT_TYPE = 'application/x-www-form-urlencoded'

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

/** Whether the line's headers already carry a Content-Type. */
function namesContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
}

/**
 * The request curl -v shows, as far as mirage can see it.
 *
 * Only what leaves mirage is dumped: the request line, Host, the
 * User-Agent, curl's own Accept, the headers the line added, and the two a
 * -d body adds. curl's `*` transport lines (resolving, connecting, TLS)
 * have no source here and are omitted, as are the headers the HTTP stack
 * appends on its own and a -F body's encoding, which the client builds.
 * `bodyType` is the Content-Type curl added for the body itself, null when
 * the line named one or there is no body.
 */
export function requestLines(
  url: string,
  method: string,
  headers: Record<string, string>,
  bodyLen: number | null,
  bodyType: string | null,
): string[] {
  let target = url
  let host = ''
  try {
    const parsed = new URL(url)
    target = `${parsed.pathname}${parsed.search}`
    host = parsed.port !== '' ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  } catch {
    // Not a URL fetch could parse either; the request line shows the word.
  }
  const lines = [
    `${method} ${target} HTTP/1.1`,
    `Host: ${host}`,
    `User-Agent: ${headers['User-Agent'] ?? DEFAULT_USER_AGENT}`,
    'Accept: */*',
  ]
  for (const [k, v] of Object.entries(headers)) {
    if (k !== 'User-Agent') lines.push(`${k}: ${v}`)
  }
  if (bodyLen !== null) lines.push(`Content-Length: ${String(bodyLen)}`)
  if (bodyType !== null) lines.push(`Content-Type: ${bodyType}`)
  return lines
}

/**
 * The status line and headers -i, -I and -v print.
 *
 * Three deliberate divergences from curl, which prints the bytes as
 * received: names render lowercase, because fetch never exposes the wire
 * casing; they come sorted by name, because the Headers class iterates
 * that way and wire order is gone by then; and the version always reads
 * HTTP/1.1, because fetch cannot observe it. Both hosts therefore print
 * one shape.
 */
export function responseLines(resp: HttpResponse): string[] {
  const lines = [`HTTP/1.1 ${String(resp.status)} ${resp.reason}`]
  const sorted = resp.headers.map(([k, v]): [string, string] => [k.toLowerCase(), v])
  sorted.sort(([a], [b]) => compareCodePoints(a, b))
  for (const [k, v] of sorted) lines.push(`${k}: ${v}`)
  return lines
}

function dump(lines: string[], prefix = ''): string {
  return [...lines, ''].map((line) => `${prefix}${line}${CRLF}`).join('')
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

async function curlCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('curl'))
  const header = fl.asStr('header') ?? null
  const userAgent = fl.asStr('user_agent') ?? null
  const request = fl.asStr('request') ?? null
  const data = fl.asStr('data') ?? null
  const form = fl.asStr('form') ?? null
  const output = fl.asStr('output') ?? null
  const location = fl.asBool('location')
  const failOnError = fl.asBool('fail')
  const verbose = fl.asBool('verbose')
  const include = fl.asBool('include')
  const head = fl.asBool('head')
  const maxTime = fl.asFloat('max_time')
  // -s silences the message, -S puts it back. Neither changes the exit code.
  const quiet = fl.asBool('silent') && !fl.asBool('show_error')

  const headers: Record<string, string> = {}
  if (header !== null) {
    const idx = header.indexOf(':')
    if (idx > 0) {
      headers[header.slice(0, idx).trim()] = header.slice(idx + 1).trim()
    }
  }
  if (userAgent !== null) {
    headers['User-Agent'] = userAgent
  }
  // curl refuses these lines before any transfer (curl 8.7.1, exit 2). A
  // negative --max-time is not a number curl takes; curl names the spelling
  // typed, which the handler cannot see, so the long one.
  if (maxTime !== undefined && maxTime < 0) {
    throw new UsageError(
      `curl: option --max-time: expected a positive numerical parameter\n${HELP_HINT}`,
      EXIT_USAGE,
    )
  }
  // -I beside a body option asks two methods of one request: curl warns and
  // refuses. -s mutes the warning and -S does not bring it back; the option
  // error -F adds is never muted.
  if (head && (data !== null || form !== null)) {
    let err = fl.asBool('silent') ? '' : data !== null ? HEAD_DATA_WARNING : HEAD_FORM_WARNING
    if (data === null) err += `curl: option -F: is badly used here\n${HELP_HINT}\n`
    return [null, new IOResult({ exitCode: EXIT_USAGE, stderr: ENC.encode(err) })]
  }
  const url = texts[0]
  if (url === undefined) {
    throw new UsageError(`curl: (2) no URL specified\n${HELP_HINT}`, EXIT_USAGE)
  }
  // A zero --max-time is curl's "no limit", not a deadline of zero.
  const timeoutMs =
    maxTime === undefined ? DEFAULT_TIMEOUT_MS : maxTime === 0 ? null : maxTime * 1000
  let method: string
  let bodyLen: number | null = null
  let bodyType: string | null = null
  let resp: HttpResponse
  try {
    if (form !== null) {
      method = request ?? 'POST'
      const eq = form.indexOf('=')
      const key = eq >= 0 ? form.slice(0, eq) : form
      const value = eq >= 0 ? form.slice(eq + 1) : ''
      resp = await httpFormRequest(url, {
        method,
        formData: { [key]: value },
        headers,
        timeoutMs,
        followRedirects: location,
      })
    } else {
      method = request ?? (head ? 'HEAD' : data !== null ? 'POST' : 'GET')
      const body = data !== null ? ENC.encode(data) : undefined
      bodyLen = body !== undefined ? body.length : null
      // -v shows what is sent, so curl's default for the body goes on the
      // request, not on the trace alone.
      if (body !== undefined && !namesContentType(headers)) bodyType = BODY_CONTENT_TYPE
      const sent = bodyType !== null ? { ...headers, 'Content-Type': bodyType } : headers
      resp = await httpRequest(url, {
        method,
        headers: sent,
        ...(body !== undefined ? { body } : {}),
        timeoutMs,
        followRedirects: location,
      })
    }
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      // Nothing was received: the body is read whole, so a deadline that
      // hits mid-transfer still counts as zero bytes here.
      const line = `curl: (${String(EXIT_TIMEOUT)}) Operation timed out after ${String(err.elapsedMs)} milliseconds with 0 bytes received\n`
      return [
        null,
        new IOResult({
          exitCode: EXIT_TIMEOUT,
          stderr: quiet ? new Uint8Array() : ENC.encode(line),
        }),
      ]
    }
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
  const hops = [...resp.history, resp]
  // The first request is the one this handler built; each redirect's is
  // the one the client reports, at the URL the server named.
  const requests: [string, string][] = [
    [url, method],
    ...hops.slice(1).map((hop): [string, string] => [hop.url, hop.method]),
  ]
  // -v is not a message, so -s leaves it alone. A followed redirect is a
  // request of its own, traced in turn; the body rides only the hops that
  // kept the method (a 302 turns a POST into a GET without one).
  const trace = verbose
    ? ENC.encode(
        hops
          .map((hop, index) => {
            const [target, sentAs] = requests[index] ?? [hop.url, hop.method]
            const carries = sentAs === method
            return (
              dump(
                requestLines(
                  target,
                  sentAs,
                  headers,
                  carries ? bodyLen : null,
                  carries ? bodyType : null,
                ),
                '> ',
              ) + dump(responseLines(hop), '< ')
            )
          })
          .join(''),
      )
    : new Uint8Array()
  // Only -f makes an error status an error, and then nothing is written.
  if (failOnError && isHttpError(resp)) {
    const line = `curl: (${String(EXIT_HTTP_ERROR)}) The requested URL returned error: ${String(resp.status)}\n`
    return [
      null,
      new IOResult({
        exitCode: EXIT_HTTP_ERROR,
        stderr: concat(trace, quiet ? new Uint8Array() : ENC.encode(line)),
      }),
    ]
  }
  let result = resp.body
  // -i and -I print every hop's header block (curl 8.7.1); the body a
  // redirect carried is never written, only the final one.
  const blocks = ENC.encode(hops.map((hop) => dump(responseLines(hop))).join(''))
  if (head) {
    // -I prints the headers alone, whatever method -X made it send.
    result = blocks
  } else if (include) {
    result = concat(blocks, result)
  }
  if (output !== null) {
    if (opts.dispatch !== undefined) {
      const scope = resolveTarget(output, opts.cwd)
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
        const line = `curl: (${String(EXIT_WRITE)}) ${output}: ${detail}\n`
        return [
          null,
          new IOResult({
            exitCode: EXIT_WRITE,
            stderr: concat(trace, quiet ? new Uint8Array() : ENC.encode(line)),
          }),
        ]
      }
    }
    // Real curl writes the body to the file and prints nothing on stdout.
    return [null, new IOResult({ writes: { [output]: result }, stderr: trace })]
  }
  return [result, new IOResult({ stderr: trace })]
}

export const GENERAL_CURL = command({
  name: 'curl',
  resource: null,
  spec: specOf('curl'),
  fn: curlCommand,
})
