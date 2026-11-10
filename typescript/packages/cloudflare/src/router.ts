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

import { errorOf, errorResponse, HttpError } from '@struktoai/mirage-server/errors'
import type {
  BodySchema,
  RouteApp,
  RouteConfig,
  RouteHandler,
  RouteMethod,
  RouteOptions,
  RouteReply,
  RouteRequest,
} from '@struktoai/mirage-server/routes'

/** Fastify's default: the largest body a route reads unless it names its own. */
const BODY_LIMIT = 1024 * 1024
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

interface Route {
  readonly method: string
  readonly pattern: RegExp
  readonly keys: readonly string[]
  readonly config: RouteConfig
  readonly handler: RouteHandler
}

class RouteError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = []
  const source = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      keys.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { pattern: new RegExp(`^${source}$`), keys }
}

function queryOf(params: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const [key, value] of params) {
    const held = query[key]
    query[key] = held === undefined ? value : Array.isArray(held) ? [...held, value] : [held, value]
  }
  return query
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/**
 * Check `body` against `schema` as Fastify's validator does for the shapes
 * the routes declare: the required fields, each field's type, and the
 * fields past `properties` dropped when `additionalProperties` is false.
 */
function validate(body: unknown, schema: BodySchema): unknown {
  if (typeOf(body) !== 'object')
    throw new RouteError(400, 'FST_ERR_VALIDATION', 'body must be object')
  const given = body as Record<string, unknown>
  for (const field of schema.required ?? []) {
    if (!Object.hasOwn(given, field)) {
      throw new RouteError(400, 'FST_ERR_VALIDATION', `body must have required property '${field}'`)
    }
  }
  const record: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(given)) {
    const declared = Object.hasOwn(schema.properties, field) ? schema.properties[field] : undefined
    if (declared === undefined) {
      if (schema.additionalProperties !== false) record[field] = value
      continue
    }
    const types: readonly string[] =
      typeof declared.type === 'string' ? [declared.type] : declared.type
    const actual = typeOf(value)
    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
      throw new RouteError(400, 'FST_ERR_VALIDATION', `body/${field} must be ${types.join(',')}`)
    }
    record[field] = value
  }
  return record
}

/** The body as text, refused once it passes `limit` bytes, before the rest is read. */
async function readBody(request: Request, limit: number): Promise<string> {
  const tooLarge = new RouteError(413, 'FST_ERR_CTP_BODY_TOO_LARGE', 'Request body is too large')
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw tooLarge
  if (request.body === null) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = request.body.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw tooLarge
    }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** The parsed body Fastify's default parsers would hand a route, JSON and plain text. */
async function parseBody(request: Request, config: RouteConfig): Promise<unknown> {
  if (!BODY_METHODS.has(request.method) || request.body === null) return undefined
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase()
  if (contentType.startsWith('multipart/') || contentType.startsWith('application/octet-stream')) {
    return undefined
  }
  const limit = config.bodyLimit ?? BODY_LIMIT
  if (contentType === '') {
    const text = await readBody(request, limit)
    if (text === '') return undefined
    throw new RouteError(415, 'FST_ERR_CTP_INVALID_MEDIA_TYPE', 'Unsupported Media Type')
  }
  if (contentType.startsWith('application/json')) {
    const text = await readBody(request, limit)
    if (text === '') {
      throw new RouteError(
        400,
        'FST_ERR_CTP_EMPTY_JSON_BODY',
        "Body cannot be empty when content-type is set to 'application/json'",
      )
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new RouteError(400, 'FST_ERR_CTP_INVALID_JSON_BODY', 'Body is not valid JSON')
    }
  }
  if (contentType.startsWith('text/plain')) return readBody(request, limit)
  throw new RouteError(
    415,
    'FST_ERR_CTP_INVALID_MEDIA_TYPE',
    `Unsupported Media Type: ${contentType}`,
  )
}

class WebReply implements RouteReply {
  statusCode = 200
  sent = false
  readonly headers = new Headers()
  payload: unknown = undefined

  status(code: number): this {
    this.statusCode = code
    return this
  }

  code(code: number): this {
    return this.status(code)
  }

  header(name: string, value: string | number): this {
    this.headers.set(name, String(value))
    return this
  }

  type(contentType: string): this {
    return this.header('content-type', contentType)
  }

  send(payload?: unknown): this {
    this.payload = payload
    this.sent = true
    return this
  }

  /** The answer as a web Response, serialized the way Fastify serializes it. */
  response(): Response {
    const payload = this.payload
    if (payload instanceof Response) return payload
    const headers = this.headers
    const status = this.statusCode
    if (payload === undefined || status === 204 || status === 304) {
      return new Response(null, { status, headers })
    }
    if (payload instanceof ReadableStream) return new Response(payload, { status, headers })
    if (payload instanceof Uint8Array) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
      return new Response(payload as Uint8Array<ArrayBuffer>, { status, headers })
    }
    if (typeof payload === 'string') {
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8')
      return new Response(payload, { status, headers })
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
    return new Response(JSON.stringify(payload), { status, headers })
  }
}

function failure(error: unknown, config: RouteConfig): WebReply {
  const reply = new WebReply()
  if (
    error instanceof RouteError &&
    config.invalidJson !== undefined &&
    (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY')
  ) {
    return reply.status(error.statusCode).send(config.invalidJson)
  }
  return errorResponse(reply, error instanceof RouteError ? routeError(error) : errorOf(error))
}

/**
 * A body this router refused before the route ran, as the error the Node
 * server answers: a body it cannot read as JSON or past the limit as
 * Fastify's are, a media type or schema miss as a bad request.
 */
function routeError(error: RouteError): HttpError {
  if (error.statusCode === 415) return new HttpError('invalid_request', 'body must be JSON')
  if (error.code === 'FST_ERR_VALIDATION') return new HttpError('invalid_request', error.message)
  return errorOf(error)
}

/**
 * The server's routes on a web `Request`/`Response` host: each route
 * registers through the same contract Fastify satisfies on Node, and
 * `fetch` answers a request the way the Node daemon would.
 */
export class WebRoutes implements RouteApp {
  private readonly routes: Route[] = []

  readonly get = this.method('GET')
  readonly post = this.method('POST')
  readonly put = this.method('PUT')
  readonly patch = this.method('PATCH')
  readonly delete = this.method('DELETE')

  route<S extends object>(options: RouteOptions<S>): void {
    const { method, url, handler, ...config } = options
    const { pattern, keys } = compile(url)
    for (const name of typeof method === 'string' ? [method] : method) {
      this.routes.push({ method: name, pattern, keys, config, handler: handler as RouteHandler })
    }
  }

  /** Answer `request` as `account` (null when the auth mode names none). */
  async fetch(request: Request, account: string | null): Promise<Response> {
    const url = new URL(request.url)
    let found: [Route, Record<string, string>] | null
    try {
      found = this.match(request.method === 'HEAD' ? 'GET' : request.method, url.pathname)
    } catch (error) {
      if (!(error instanceof URIError)) throw error
      const refused = new HttpError('invalid_request', 'path is not percent-encoded')
      return Response.json(refused.body(), { status: refused.status })
    }
    if (found === null) {
      const missing = new HttpError('not_found', 'not found')
      return Response.json(missing.body(), { status: missing.status })
    }
    const [route, params] = found
    let reply = new WebReply()
    try {
      let body = await parseBody(request, route.config)
      const schema = route.config.schema?.body
      if (schema !== undefined) body = validate(body, schema)
      const headers: Record<string, string> = {}
      for (const [name, value] of request.headers) headers[name] = value
      const req: RouteRequest = {
        body,
        query: queryOf(url.searchParams),
        params,
        headers,
        url: url.pathname + url.search,
        method: request.method,
        ip: request.headers.get('cf-connecting-ip') ?? '',
        protocol: url.protocol.slice(0, -1),
        host: url.host,
        account,
        raw: (request.body ??
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          })) as unknown as AsyncIterable<Uint8Array>,
        closed: request.signal,
      }
      const answer = await route.handler(req, reply)
      if (!reply.sent && answer !== undefined && answer !== reply) reply.send(answer)
    } catch (error) {
      reply = failure(error, route.config)
    }
    return reply.response()
  }

  private method(name: string): RouteMethod {
    return (path: string, configOrHandler: RouteConfig | RouteHandler, handler?: RouteHandler) => {
      const [config, run] =
        handler === undefined
          ? [{}, configOrHandler as RouteHandler]
          : [configOrHandler as RouteConfig, handler]
      this.route({ method: name, url: path, ...config, handler: run })
    }
  }

  /** The route a path takes, a static segment winning over a parameter as Fastify's does. */
  private match(method: string, path: string): [Route, Record<string, string>] | null {
    let best: [Route, Record<string, string>] | null = null
    for (const route of this.routes) {
      if (route.method !== method) continue
      const hit = route.pattern.exec(path)
      if (hit === null) continue
      if (best !== null && best[0].keys.length <= route.keys.length) continue
      const params: Record<string, string> = {}
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(hit[i + 1] ?? '')
      })
      best = [route, params]
    }
    return best
  }
}
