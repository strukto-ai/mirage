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

import type { configToWorkspaceArgs, WorkspaceConfigRaw } from '@struktoai/mirage-core/config'
import type { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import type { ResolvedSource } from '@struktoai/mirage-core/secrets/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import type { ConfigSchemaLoader } from '@struktoai/mirage-core/vfs/registry'
import type { MountBackend } from '@struktoai/mirage-core/types'
import type { WorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/base'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from 'fastify'

/**
 * The slice of an HTTP framework the routers use, so one set of routes runs
 * on every host: Fastify on Node (`app.ts` adapts it) and the web
 * `Request`/`Response` of an edge runtime with no Node
 * (`@struktoai/mirage-cloudflare`). A router imports nothing from a host:
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
 * the shape the body must have, refused with 400 before the handler, and
 * the answer to a JSON body that does not parse, in place of the host's own.
 */
export interface RouteConfig {
  bodyLimit?: number
  schema?: { body?: BodySchema }
  invalidJson?: unknown
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

/**
 * What the routes need from the host they run on: its workspace class (each
 * host rebuilds a saved mount from its own VFS table), the mounts and options
 * a config names, the config schema of each VFS it builds, its CLIs, a
 * profile's policy files, the store the server
 * keeps workspaces' state in, and the network watch a rule needs. Node
 * builds these from `@struktoai/mirage-node`; an edge runtime from core.
 */
export interface ServerHost {
  readonly Workspace: typeof Workspace
  workspaceArgs(cfg: WorkspaceConfigRaw): ReturnType<typeof configToWorkspaceArgs>
  buildVfs(
    name: string,
    config: Record<string, unknown>,
    sources?: Readonly<Record<string, ResolvedSource>>,
  ): Promise<BaseVFS>
  /** The config schema of each VFS this host builds, by name: a saved VFS's fields. */
  readonly vfsSchemas: Readonly<Record<string, ConfigSchemaLoader>>
  loadProfile(profile: SessionProfile): SessionProfile
  /**
   * A fresh handle on the store workspaces keep their state in, or on the
   * one `cfg`'s `store:` block names; the caller closes it.
   */
  stateStore(cfg?: WorkspaceConfigRaw): WorkspaceStateStore
  /**
   * This daemon's id, which the lease of each workspace it runs names; a host
   * that keeps it on disk holds its workspaces again after a restart.
   */
  daemonId(): Promise<string>
  /** An account's name as one path segment of a snapshot key. */
  quoteName(name: string): string
  /** The ids no workspace may take. */
  readonly reservedIds: ReadonlySet<string>
  watchNetwork(): void
  /** Mount `prefix` at a kernel mountpoint (FUSE, FSKit); a host with no kernel refuses. */
  mountKernel(
    ws: Workspace,
    prefix: string,
    mountpoint: string | undefined,
    backend: MountBackend,
  ): Promise<void>
}

/**
 * A web stream of what `source` yields, for a reply on any host. A reader
 * that cancels calls `stop` first: the iterator's return waits behind a
 * read still pending (a line that has printed nothing yet), so `stop` is
 * what ends that read rather than the source's own end.
 */
export function streamOf(
  source: AsyncIterable<Uint8Array>,
  stop?: () => void,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next()
      if (next.done === true) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel(reason) {
      stop?.()
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
  const register = (options: RouteOptions): void => {
    const { invalidJson, ...rest } = options
    app.route({
      ...rest,
      method: options.method as string | string[],
      handler: options.handler as unknown as RouteHandlerMethod,
      ...(invalidJson === undefined
        ? {}
        : {
            errorHandler: (error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
              const parse =
                error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
                error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
              if (!parse) throw error
              void reply.code(400).send(invalidJson)
            },
          }),
    })
  }
  const method =
    (name: string): RouteMethod =>
    (path: string, configOrHandler: RouteConfig | RouteHandler, handler?: RouteHandler): void => {
      const [config, run] =
        handler === undefined
          ? [{}, configOrHandler as RouteHandler]
          : [configOrHandler as RouteConfig, handler]
      register({ method: name, url: path, ...config, handler: run })
    }
  return {
    get: method('GET'),
    post: method('POST'),
    put: method('PUT'),
    patch: method('PATCH'),
    delete: method('DELETE'),
    route: (options) => {
      register(options as RouteOptions)
    },
  }
}
