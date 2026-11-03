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

import type { FastifyInstance, RouteHandlerMethod } from 'fastify'

/**
 * The slice of an HTTP framework the routers use, so one set of routes runs
 * on every host: Fastify on Node (`app.ts` adapts it) and the web
 * `Request`/`Response` of a runtime with no Node, such as a Cloudflare
 * Worker (`@struktoai/mirage-edge`). A router imports nothing from a host:
 * what a host must supply it gets through its deps.
 */
export interface RouteShape {
  Body?: unknown
  Querystring?: unknown
  Params?: unknown
}

export interface RouteRequest<S extends RouteShape = RouteShape> {
  readonly body: S['Body']
  readonly query: S['Querystring']
  readonly params: S['Params']
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly url: string
  readonly method: string
  readonly ip: string
  readonly protocol: string
  readonly host: string
  /** Who the request runs as; null when the auth mode names no account. */
  account: string | null
  /** The body as it arrives, for a route that reads it unparsed (multipart). */
  readonly raw: AsyncIterable<Uint8Array>
  /** Aborted when the client goes away before its answer has finished. */
  readonly closed: AbortSignal
}

export interface RouteReply {
  status(code: number): RouteReply
  code(code: number): RouteReply
  header(name: string, value: string | number): RouteReply
  type(contentType: string): RouteReply
  /** An object answers as JSON; bytes and a web `ReadableStream` as themselves. */
  send(payload?: unknown): RouteReply
  readonly sent: boolean
  readonly statusCode: number
}

/** A handler answers by returning a value (200, as JSON) or through `reply`. */
export type RouteHandler<S extends RouteShape = RouteShape> = (
  req: RouteRequest<S>,
  reply: RouteReply,
) => unknown

/** A JSON body's shape, as far as the routes check one: an object's fields. */
export interface BodySchema {
  type: 'object'
  required?: readonly string[]
  properties: Readonly<Record<string, { type: string | readonly string[] }>>
  additionalProperties?: boolean
}

/**
 * Per-route settings a host honours: the largest body it reads, in bytes,
 * and the shape the body must have, refused with 400 before the handler.
 */
export interface RouteConfig {
  bodyLimit?: number
  schema?: { body?: BodySchema }
}

export interface RouteOptions<S extends RouteShape = RouteShape> extends RouteConfig {
  method: string | readonly string[]
  url: string
  handler: RouteHandler<S>
}

export interface RouteMethod {
  <S extends RouteShape = RouteShape>(path: string, handler: RouteHandler<S>): void
  <S extends RouteShape = RouteShape>(
    path: string,
    config: RouteConfig,
    handler: RouteHandler<S>,
  ): void
}

export interface RouteApp {
  get: RouteMethod
  post: RouteMethod
  put: RouteMethod
  patch: RouteMethod
  delete: RouteMethod
  route<S extends RouteShape = RouteShape>(options: RouteOptions<S>): void
}

/** A web stream of what `source` yields, for a reply on any host. */
export function streamOf(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done === true) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
}

/**
 * Fastify as a `RouteApp`: its request and reply already carry what the
 * contract names (`closed` is set by the app's first hook), so each route
 * registers as written.
 */
export function fastifyRoutes(app: FastifyInstance): RouteApp {
  const method =
    (name: string): RouteMethod =>
    (path: string, configOrHandler: RouteConfig | RouteHandler, handler?: RouteHandler): void => {
      const [config, run] =
        handler === undefined
          ? [{}, configOrHandler as RouteHandler]
          : [configOrHandler as RouteConfig, handler]
      app.route({ method: name, url: path, ...config, handler: run as RouteHandlerMethod })
    }
  return {
    get: method('GET'),
    post: method('POST'),
    put: method('PUT'),
    patch: method('PATCH'),
    delete: method('DELETE'),
    route: (options) => {
      app.route({
        ...options,
        method: options.method as string | string[],
        handler: options.handler as RouteHandlerMethod,
      })
    },
  }
}
