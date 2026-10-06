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
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
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
import { gnuStrerror, isFsError, isWalkError, enotsup } from '../../../utils/errors.ts'
import { compareCodePoints } from '../../../utils/sort.ts'
import { typedSpec } from '../../../utils/path.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { encodeBase64 } from '../../../utils/base64.ts'

import { renderWriteOut } from './curl_write_out.ts'
import { concat } from '../../../io/cachable_iterator.ts'

const ENC = new TextEncoder()

// Exit codes real curl uses for the failures mirage can hit. An HTTP error
// status is deliberately absent: curl treats 4xx/5xx as a successful transfer
// and prints the body, and only -f/--fail turns it into EXIT_HTTP_ERROR.
// 2 is any line curl refuses before a transfer.
const EXIT_USAGE = 2
const EXIT_CONNECT = 7
const EXIT_HTTP_ERROR = 22
const EXIT_WRITE = 23
const EXIT_READ = 26
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
const JSON_TYPE = 'application/json'
// Every option that adds a piece to the body, in the order curl joins them,
// and the spelling curl names in a read failure.
const DATA_OPTIONS = ['data', 'data_binary', 'data_raw', 'data_urlencode', 'json']
const DATA_SPELLING: Record<string, string> = {
  data: '-d',
  data_binary: '--data-binary',
  data_urlencode: '--data-urlencode',
  json: '--json',
}
// -d @FILE drops these bytes from what it reads; --data-binary keeps them.
const DATA_STRIPPED = new Set([0x0d, 0x0a, 0x00])
const UNRESERVED = /^[A-Za-z0-9\-._~]$/

export function resolveTarget(o: string | PathSpec, cwd: string): PathSpec {
  return typedSpec(o, cwd)
}

/**
 * The headers -H sends, and every name it mentions.
 *
 * curl's reading of each line: `Name: value` sends the header, `Name:` with
 * nothing after it sends nothing and still stops curl adding its own of that
 * name, `Name;` sends it empty, and a line with neither separator is
 * dropped. The value loses its leading blanks only. A name given twice in any
 * case is one header whose values are joined with `, `, a deliberate
 * divergence from curl, which sends two lines: fetch merges them so, and RFC
 * 9110 reads the two forms alike.
 */
export function headerLines(values: readonly string[]): [[string, string][], Set<string>] {
  const sent = new Map<string, [string, string]>()
  const named = new Set<string>()
  for (const line of values) {
    const colon = line.indexOf(':')
    let name: string
    let value: string
    if (colon > 0) {
      name = line.slice(0, colon)
      value = line.slice(colon + 1).replace(/^\s+/, '')
    } else if (colon < 0 && line.endsWith(';') && line.length > 1) {
      name = line.slice(0, -1)
      value = ''
    } else continue
    const key = name.toLowerCase()
    named.add(key)
    if (colon > 0 && value === '') continue
    const prior = sent.get(key)
    sent.set(key, prior === undefined ? [name, value] : [prior[0], `${prior[1]}, ${value}`])
  }
  return [[...sent.values()], named]
}

/**
 * The request curl -v shows, as far as mirage can see it.
 *
 * Only what leaves mirage is dumped: the request line, Host, the headers in
 * curl's order, and the two a -d body adds. curl's `*` transport lines
 * (resolving, connecting, TLS) have no source here and are omitted, as are
 * the headers the HTTP stack appends on its own and a -F body's encoding,
 * which the client builds. `headers` is every header between Host and the
 * body's own, in the order curl sends them; `bodyType` is the Content-Type
 * curl added for the body itself, null when the line named one or there is
 * no body.
 */
export function requestLines(
  url: string,
  method: string,
  headers: readonly [string, string][],
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
  const lines = [`${method} ${target} HTTP/1.1`, `Host: ${host}`]
  for (const [k, v] of headers) lines.push(`${k}: ${v}`)
  if (bodyLen !== null) lines.push(`Content-Length: ${String(bodyLen)}`)
  if (bodyType !== null) lines.push(`Content-Type: ${bodyType}`)
  return lines
}

/**
 * curl's escaping for --data-urlencode: everything but letters, digits and
 * `-._~` becomes `%XX`, and a space then becomes `+` (curl 8.14.1).
 */
export function urlEncoded(data: Uint8Array): string {
  let out = ''
  for (const byte of data) {
    const char = String.fromCharCode(byte)
    out += UNRESERVED.test(char)
      ? char
      : byte === 0x20
        ? '+'
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/**
 * Read the file an `@NAME` value names, `-` being stdin. curl gives up on
 * the whole line when it cannot (exit 26), naming the file unless -s, and
 * the option either way.
 */
async function readAt(
  option: string,
  name: string,
  opts: CommandOpts,
  silent: boolean,
): Promise<Uint8Array> {
  try {
    if (name === '-') return await materialize(opts.stdin ?? null)
    if (opts.dispatch === undefined) throw enotsup('unavailable', 'read', name)
    const [content] = await opts.dispatch('read', resolveTarget(name, opts.cwd), [])
    return await materialize(content as ByteSource)
  } catch (err) {
    if (!isWalkError(err)) throw err
    const detail = silent ? '' : `curl: Failed to open ${name}\n`
    const failure = new UsageError(
      `${detail}curl: option ${option}: error encountered when reading a file\n${HELP_HINT}`,
      EXIT_READ,
    )
    failure.cause = err
    throw failure
  }
}

/** One data option's contribution to the body. */
async function dataPiece(
  kind: string,
  value: string,
  opts: CommandOpts,
  silent: boolean,
): Promise<Uint8Array> {
  if (kind === 'data_raw') return ENC.encode(value)
  const option = DATA_SPELLING[kind] ?? kind
  if (kind === 'data_urlencode') {
    // `=` is looked for before `@`: `name=content` encodes the content,
    // `name@file` a file's, and a bare value all of it.
    let sep = value.indexOf('=')
    if (sep < 0) sep = value.indexOf('@')
    const name = sep > 0 ? value.slice(0, sep) : ''
    const content = sep >= 0 ? value.slice(sep + 1) : value
    const raw =
      sep >= 0 && value[sep] === '@'
        ? await readAt(option, content, opts, silent)
        : ENC.encode(content)
    const encoded = urlEncoded(raw)
    return ENC.encode(name !== '' ? `${name}=${encoded}` : encoded)
  }
  if (!value.startsWith('@')) return ENC.encode(value)
  const raw = await readAt(option, value.slice(1), opts, silent)
  return kind === 'data' ? raw.filter((byte) => !DATA_STRIPPED.has(byte)) : raw
}

/**
 * The body the data options build, and whether --json was among them. The
 * pieces are joined in line order with `&` between them, except before a
 * --json piece, and only once the body so far is not empty (curl 8.14.1:
 * `-d '' -d b` sends `b`).
 */
async function requestBody(fl: FlagView, opts: CommandOpts): Promise<[Uint8Array | null, boolean]> {
  const silent = fl.asBool('silent')
  const occurrences = fl.occurrences(...DATA_OPTIONS)
  if (occurrences.length === 0) return [null, false]
  let body: Uint8Array = new Uint8Array()
  let json = false
  for (const [kind, value] of occurrences) {
    const piece = await dataPiece(kind, String(value), opts, silent)
    if (body.length > 0 && kind !== 'json') body = concat([body, ENC.encode('&')])
    body = concat([body, piece])
    json ||= kind === 'json'
  }
  return [body, json]
}

/**
 * The Authorization value -u sends, and the prompt it costs. A user without
 * a `:` has curl ask for the password on stderr and read it from stdin,
 * which is all a workspace has: the bytes it read minus the last one, which
 * curl takes to be the newline.
 */
export function basicAuth(user: string, stdin: Uint8Array): [string, Uint8Array] {
  let prompt: Uint8Array = new Uint8Array()
  let pair = user
  if (!user.includes(':')) {
    prompt = ENC.encode(`Enter host password for user '${user}':\n`)
    pair = `${user}:${new TextDecoder().decode(stdin.slice(0, -1))}`
  }
  return [`Basic ${encodeBase64(ENC.encode(pair))}`, prompt]
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

/**
 * The header blocks when -D and -i (or -I) both print to stdout. curl
 * writes each header line to the dump as it arrives and then to the
 * output, so on one stream every line comes out twice, one after the other
 * (curl 8.14.1).
 */
function doubled(hops: HttpResponse[]): string {
  return hops
    .flatMap((hop) => [...responseLines(hop), ''])
    .map((line) => `${line}${CRLF}${line}${CRLF}`)
    .join('')
}

/**
 * Why a write to `shown` failed, in curl's exit code 23.
 *
 * Deliberate divergence: real curl says "Failed writing received data to
 * disk/application" (or "client returned ERROR on write of N bytes") and
 * drops the cause. A mirage write can fail for reasons a local file cannot
 * (read-only mount, unsupported op), so the exit code matches curl while the
 * message keeps path and reason. The refusals whose wording is load-bearing
 * (read-only mount, unsupported op) keep their raw message; an unusable path
 * carries only the path as its message, so it needs the GNU strerror.
 */
function writeFailure(shown: string, err: unknown): string {
  const code = (err as { code?: string }).code
  const strerror = gnuStrerror(code)
  const raw = code === 'EACCES' || code === 'ENOTSUP' || !isFsError(err)
  const detail =
    !raw && strerror !== null ? strerror : err instanceof Error ? err.message : String(err)
  return `curl: (${String(EXIT_WRITE)}) ${shown}: ${detail}\n`
}

async function curl(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('curl'))
  const userAgent = fl.asStr('user_agent') ?? null
  const request = fl.asStr('request') ?? null
  const hasData = fl.occurrences(...DATA_OPTIONS).length > 0
  const form = fl.asStr('form') ?? null
  const output = fl.asPath('output') ?? fl.asStr('output') ?? null
  const outputIsStdout = output === '-' || (output instanceof PathSpec && output.rawPath === '-')
  const dumpHeader = fl.asPath('dump_header') ?? fl.asStr('dump_header') ?? null
  const dumpToStdout =
    dumpHeader === '-' || (dumpHeader instanceof PathSpec && dumpHeader.rawPath === '-')
  const dumpFile = dumpToStdout ? null : dumpHeader
  // -k skips certificate verification through the fetch the host registered
  // (utils/http.ts); the browser has none, so there certificates are still
  // verified.
  const verify = !fl.asBool('insecure')
  const location = fl.asBool('location')
  const failOnError = fl.asBool('fail')
  const verbose = fl.asBool('verbose')
  const include = fl.asBool('include')
  const head = fl.asBool('head')
  const maxTime = fl.asFloat('max_time')
  // -s silences the message, -S puts it back. Neither changes the exit code.
  const quiet = fl.asBool('silent') && !fl.asBool('show_error')

  const [sent, named] = headerLines(fl.asList('header'))
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
  if (head && (hasData || form !== null)) {
    let err = fl.asBool('silent') ? '' : hasData ? HEAD_DATA_WARNING : HEAD_FORM_WARNING
    if (!hasData) err += `curl: option -F: is badly used here\n${HELP_HINT}\n`
    return [null, new IOResult({ exitCode: EXIT_USAGE, stderr: ENC.encode(err) })]
  }
  const url = texts[0]
  if (url === undefined) {
    throw new UsageError(`curl: (2) no URL specified\n${HELP_HINT}`, EXIT_USAGE)
  }
  // A zero --max-time is curl's "no limit", not a deadline of zero.
  const timeoutMs =
    maxTime === undefined ? DEFAULT_TIMEOUT_MS : maxTime === 0 ? null : maxTime * 1000
  let template = fl.asStr('write_out') ?? ''
  // curl 8.14.1: -s suppresses only the opening diagnostic; -S does not
  // restore it. The option error is always printed. Parsed flags lose their
  // spelling, so each option names its usual one.
  if (template.startsWith('@')) {
    const raw = await readAt('-w', template.slice(1), opts, fl.asBool('silent'))
    template = new TextDecoder().decode(raw)
  }
  const [body, json] = await requestBody(fl, opts)
  // A custom header of a name curl would add itself takes its place, so
  // curl's own goes only where the line names none. The trace lists them in
  // curl's order; the wire leaves User-Agent and Accept to the client's
  // defaults unless the line set them.
  const auth: [string, string][] = []
  let prompt: Uint8Array = new Uint8Array()
  const user = fl.asStr('user') ?? null
  if (user !== null && !named.has('authorization')) {
    const stdin = user.includes(':') ? new Uint8Array() : await materialize(opts.stdin ?? null)
    const [token, asked] = basicAuth(user, stdin)
    prompt = asked
    auth.push(['Authorization', token])
  }
  const agent: [string, string][] =
    userAgent !== null && !named.has('user-agent') ? [['User-Agent', userAgent]] : []
  const typed: [string, string][] = json
    ? ['Content-Type', 'Accept']
        .filter((name) => !named.has(name.toLowerCase()))
        .map((name): [string, string] => [name, JSON_TYPE])
    : []
  const headers: Record<string, string> = Object.fromEntries([...auth, ...agent, ...sent, ...typed])
  const traceHeaders: [string, string][] = [
    ...auth,
    ...(named.has('user-agent')
      ? []
      : [['User-Agent', userAgent ?? DEFAULT_USER_AGENT] as [string, string]]),
    ...(named.has('accept') || json ? [] : [['Accept', '*/*'] as [string, string]]),
    ...sent,
    ...typed,
  ]
  const started = performance.now()
  const finish = async (
    stdout: ByteSource | null,
    io: IOResult,
    response?: HttpResponse,
  ): Promise<CommandFnResult> => {
    const code = String(response?.status ?? 0).padStart(3, '0')
    const [out, err] = renderWriteOut(template, {
      http_code: code,
      response_code: code,
      url_effective: response?.url ?? url,
      num_redirects: String(response?.history.length ?? 0),
      size_download: String(response?.body.length ?? 0),
      content_type: response?.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '',
      method:
        response?.method ?? request ?? (head ? 'HEAD' : hasData || form !== null ? 'POST' : 'GET'),
      exitcode: String(io.exitCode),
      time_total: ((performance.now() - started) / 1000).toFixed(6),
    })
    io.stderr = concat([prompt, await materialize(io.stderr), err])
    return [concat([await materialize(stdout), out]), io]
  }
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
        verify,
      })
    } else {
      method = request ?? (head ? 'HEAD' : body !== null ? 'POST' : 'GET')
      bodyLen = body !== null ? body.length : null
      // -v shows what is sent, so curl's default for the body goes on the
      // request, not on the trace alone.
      if (body !== null && !json && !named.has('content-type')) bodyType = BODY_CONTENT_TYPE
      const wire = bodyType !== null ? { ...headers, 'Content-Type': bodyType } : headers
      resp = await httpRequest(url, {
        method,
        headers: wire,
        ...(body !== null ? { body } : {}),
        timeoutMs,
        followRedirects: location,
        verify,
      })
    }
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      // Nothing was received: the body is read whole, so a deadline that
      // hits mid-transfer still counts as zero bytes here.
      const line = `curl: (${String(EXIT_TIMEOUT)}) Operation timed out after ${String(err.elapsedMs)} milliseconds with 0 bytes received\n`
      return await finish(
        null,
        new IOResult({
          exitCode: EXIT_TIMEOUT,
          stderr: quiet ? new Uint8Array() : ENC.encode(line),
        }),
      )
    }
    if (!(err instanceof HttpConnectError)) throw err
    const line = `curl: (${String(EXIT_CONNECT)}) Failed to connect to ${err.host} port ${String(err.port)}: Could not connect to server\n`
    return await finish(
      null,
      new IOResult({
        exitCode: EXIT_CONNECT,
        stderr: quiet ? new Uint8Array() : ENC.encode(line),
      }),
    )
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
                  traceHeaders,
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
  // -i, -I and -D all show every hop's header block (curl 8.14.1); the body
  // a redirect carried is never written, only the final one.
  const blocks = ENC.encode(hops.map((hop) => dump(responseLines(hop))).join(''))
  const writes: Record<string, Uint8Array> = {}
  // -D writes the headers as they arrive, so before -f judges the status and
  // before -o writes the body: a file both name ends up holding the body.
  if (dumpFile !== null) {
    if (opts.dispatch !== undefined) {
      try {
        await opts.dispatch('write', resolveTarget(dumpFile, opts.cwd), [blocks])
      } catch (err) {
        const line = writeFailure(dumpFile instanceof PathSpec ? dumpFile.virtual : dumpFile, err)
        return await finish(
          null,
          new IOResult({
            exitCode: EXIT_WRITE,
            stderr: concat([trace, quiet ? new Uint8Array() : ENC.encode(line)]),
          }),
          resp,
        )
      }
    }
    writes[dumpFile instanceof PathSpec ? dumpFile.virtual : dumpFile] = blocks
  }
  const headerOut = dumpToStdout ? blocks : null
  // Only -f makes an error status an error, and then no body is written; the
  // headers -D already dumped stay dumped.
  if (failOnError && isHttpError(resp)) {
    const line = `curl: (${String(EXIT_HTTP_ERROR)}) The requested URL returned error: ${String(resp.status)}\n`
    return await finish(
      headerOut,
      new IOResult({
        exitCode: EXIT_HTTP_ERROR,
        stderr: concat([trace, quiet ? new Uint8Array() : ENC.encode(line)]),
        writes,
      }),
      resp,
    )
  }
  let result = resp.body
  if (head) {
    // -I prints the headers alone, whatever method -X made it send.
    result = blocks
  } else if (include) {
    result = concat([blocks, result])
  }
  if (output !== null && !outputIsStdout) {
    if (opts.dispatch !== undefined) {
      const scope = resolveTarget(output, opts.cwd)
      try {
        await opts.dispatch('write', scope, [result])
      } catch (err) {
        const line = writeFailure(output instanceof PathSpec ? output.virtual : output, err)
        return await finish(
          headerOut,
          new IOResult({
            exitCode: EXIT_WRITE,
            stderr: concat([trace, quiet ? new Uint8Array() : ENC.encode(line)]),
            writes,
          }),
          resp,
        )
      }
    }
    writes[output instanceof PathSpec ? output.virtual : output] = result
    // Real curl writes the body to the file and prints nothing else on
    // stdout, the headers -D sends there aside.
    return await finish(headerOut, new IOResult({ writes, stderr: trace }), resp)
  }
  if (dumpToStdout) {
    result =
      head || include
        ? concat([ENC.encode(doubled(hops)), head ? new Uint8Array() : resp.body])
        : concat([blocks, result])
  }
  return await finish(result, new IOResult({ writes, stderr: trace }), resp)
}

export const GENERAL_CURL = command({
  name: 'curl',
  vfs: null,
  spec: specOf('curl'),
  fn: curl,
})
