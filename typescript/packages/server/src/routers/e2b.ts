import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server'
import { closeQuietly } from '@struktoai/mirage-core/io/stream'
import { concat } from '@struktoai/mirage-core/utils/bytes'
import { toHex } from '@struktoai/mirage-core/utils/hex'
import { SYSTEM_IDS } from '@struktoai/mirage-core/utils/ids'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { withCaller } from '@struktoai/mirage-core/workspace/files'
import { Session } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { RAW_BODIES } from '../constants.ts'
import { bodyChunks, parseJson, readBody, readJsonBody, unaryContentType } from '../e2b/body.ts'
import * as constants from '../e2b/constants.ts'
import { CONNECT_STATUS, FileError, connectCode, fileError } from '../e2b/errors.ts'
import { SandboxFiles } from '../e2b/files.ts'
import {
  isProcessRequest,
  isProcessStart,
  registerControl,
  registerStart,
  type SandboxOf,
} from '../e2b/process.ts'
import {
  isLive,
  type LifecycleBackend,
  nowMs,
  Sandbox,
  type SandboxRecord,
  verifyAccess,
} from '../e2b/sandbox.ts'
import { errorOf, HttpError } from '../errors.ts'
import { MAX_REQUEST_PART, partEvents } from '../multipart.ts'
import type {
  RouteApp,
  RouteConfig,
  RouteHandler,
  RouteMethod,
  RouteOptions,
  RouteReply,
  RouteRequest,
} from '../routes.ts'

export type { LifecycleBackend, SandboxRecord } from '../e2b/sandbox.ts'
export { Sandbox }

export function isLifecycleRequest(method: string, path: string): boolean {
  return (
    (method === 'POST' &&
      (path === constants.CREATE ||
        path === constants.CONNECT ||
        path === constants.SET_TIMEOUT)) ||
    (method === 'DELETE' && path === constants.KILL) ||
    constants.UNSUPPORTED_LIFECYCLE_ROUTES.some(
      ([verb, route]) => method === verb && path === route,
    )
  )
}

export function isDataRequest(method: string, path: string): boolean {
  return (
    (method === 'GET' && (path === constants.HEALTH || path === constants.FILES)) ||
    (method === 'POST' && (path === constants.FILES || constants.RPC_PATHS.has(path))) ||
    isProcessRequest(method, path)
  )
}

export function acceptsRawBody(method: string, path: string, contentType: string): boolean {
  if (contentType === constants.CONNECT_STREAM) {
    return (
      isProcessStart(method, path) ||
      (method === 'POST' && constants.UNSUPPORTED_RPC_PATHS.includes(path))
    )
  }
  return method === 'POST' && path === constants.FILES
}

/** An error's answer on `route`: a Connect code on a data route, the status elsewhere. */
export function errorBody(method: string, route: string, error: HttpError) {
  return {
    code: isDataRequest(method, route) ? connectCode(error.status) : error.status,
    message: error.message,
  }
}

function headersOf(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of request.headers) headers[name] = value
  return headers
}

interface Route {
  readonly method: string
  readonly url: string
  readonly pattern: RegExp
  readonly keys: readonly string[]
  readonly config: RouteConfig
  readonly handler: RouteHandler
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
    if (held === undefined) query[key] = value
    else if (Array.isArray(held)) held.push(value)
    else query[key] = [held, value]
  }
  return query
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

  /**
   * The answer as a web Response. `Connection` is the daemon's hint to drop a
   * socket with an unread body; a web host owns its connections, so it goes.
   */
  response(): Response {
    const { payload, headers, statusCode: status } = this
    headers.delete('connection')
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

function refusal(method: string, url: string, error: unknown): Response {
  const failure = errorOf(error)
  const reply = new WebReply()
  for (const [name, value] of Object.entries(failure.headers)) reply.header(name, value)
  return reply
    .status(failure.status)
    .send(errorBody(method, url, failure))
    .response()
}

/**
 * The E2B routes on a web `Request`/`Response` host, reading bodies and
 * answering errors as the daemon's E2B listener does. Each request carries a
 * host value of type `C` its routes reach through `contextOf`.
 */
class E2BRoutes<C> implements RouteApp {
  private readonly routes: Route[] = []
  private readonly contexts = new WeakMap<RouteRequest, C>()

  readonly get = this.method('GET')
  readonly post = this.method('POST')
  readonly put = this.method('PUT')
  readonly patch = this.method('PATCH')
  readonly delete = this.method('DELETE')

  route<S extends object>(options: RouteOptions<S>): void {
    const { method, url, handler, ...config } = options
    const { pattern, keys } = compile(url)
    for (const name of typeof method === 'string' ? [method] : method) {
      this.routes.push({
        method: name,
        url,
        pattern,
        keys,
        config,
        handler: handler as RouteHandler,
      })
    }
  }

  /** Every method and path registered, for a host whose framework wants them one by one. */
  get list(): readonly { method: string; url: string }[] {
    return this.routes.map(({ method, url }) => ({ method, url }))
  }

  contextOf(request: RouteRequest): C {
    if (!this.contexts.has(request)) throw new Error('E2B route request has no host context')
    return this.contexts.get(request) as C
  }

  /** Answer `request` as `account` (null when the auth mode names none); HEAD answers no body. */
  async fetch(request: Request, account: string | null, context: C): Promise<Response> {
    const response = await this.answer(request, account, context)
    if (request.method !== 'HEAD' || response.body === null) return response
    await response.body.cancel()
    return new Response(null, { status: response.status, headers: response.headers })
  }

  private async answer(request: Request, account: string | null, context: C): Promise<Response> {
    const url = new URL(request.url)
    const method = request.method === 'HEAD' ? 'GET' : request.method
    let found: [Route, Record<string, string>] | null
    try {
      found = this.match(method, url.pathname)
    } catch (error) {
      if (!(error instanceof URIError)) throw error
      return refusal(method, '', new HttpError('invalid_request', 'path is not percent-encoded'))
    }
    if (found === null) return refusal(method, '', new HttpError('not_found', 'not found'))
    const [route, params] = found
    const headers = headersOf(request)
    const base = {
      query: queryOf(url.searchParams),
      params,
      headers,
      url: url.pathname + url.search,
      method: request.method,
      ip: '',
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
    const reply = new WebReply()
    try {
      const req: RouteRequest = { ...base, body: await this.bodyOf(request, base, route) }
      this.contexts.set(req, context)
      const answer = await route.handler(req, reply)
      if (!reply.sent && answer !== undefined && answer !== reply) reply.send(answer)
    } catch (error) {
      return refusal(method, route.url, error)
    }
    return reply.response()
  }

  /**
   * The body read as JSON whatever its Content-Type says, as the daemon's
   * E2B listener reads one: left unread on a raw route or a raw upload the
   * route takes, and refused when a raw type reaches a unary route.
   */
  private async bodyOf(
    request: Request,
    base: Omit<RouteRequest, 'body'>,
    route: Route,
  ): Promise<unknown> {
    if (route.config.rawBody === true || !constants.BODY_METHODS.has(request.method))
      return undefined
    if (request.body === null) return undefined
    const media = (request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (media !== undefined && (RAW_BODIES.test(media) || media === constants.CONNECT_STREAM)) {
      if (acceptsRawBody(request.method, route.url, media)) return undefined
      throw new HttpError('invalid_request', 'expected JSON on a unary E2B route', {
        headers: { connection: 'close' },
      })
    }
    const bytes = await readBody(
      { ...base, body: undefined },
      request.signal,
      route.config.bodyLimit ?? constants.BODY_LIMIT,
    )
    return parseJson(bytes)
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

const Timeout = z.number().int().positive().default(constants.DEFAULT_TIMEOUT)
const CreateSandboxRequest = z.looseObject({
  templateID: z.string().default(constants.BASE_TEMPLATE),
  timeout: Timeout,
  envVars: z.record(z.string(), z.string()).default({}),
})
const ConnectSandboxRequest = z.looseObject({ timeout: Timeout })
const SetSandboxTimeoutRequest = z.object({
  timeout: z
    .number()
    .int()
    .nonnegative()
    .max(2 ** 31 - 1),
})

const InertCreateOptions = z.strictObject({
  metadata: z.strictObject({}).optional(),
  allow_internet_access: z.literal(true).optional(),
  autoPause: z.literal(false).optional(),
  autoResume: z.strictObject({ enabled: z.literal(false) }).optional(),
})

interface SandboxParams {
  id: string
}

function unsupportedCreateOption(options: Record<string, unknown>): string | undefined {
  const result = InertCreateOptions.safeParse(options)
  if (result.success) return undefined
  const first = result.error.issues[0]
  if (first?.path[0] !== undefined) return String(first.path[0])
  if (first?.code === 'unrecognized_keys') return first.keys[0] ?? 'unknown'
  return 'unknown'
}

function unsupportedLifecycle(reply: RouteReply, message: string): RouteReply {
  return reply.status(501).send({ code: 501, message })
}

function present(record: SandboxRecord) {
  return {
    sandboxID: record.sandboxId,
    templateID: constants.BASE_TEMPLATE,
    clientID: record.sandboxId,
    envdVersion: constants.ENVD_VERSION,
    envdAccessToken: record.accessToken,
  }
}

function missingSandbox(): HttpError {
  return new HttpError('not_found', 'sandbox not found')
}

/** The live sandbox `owner` owns, or the 404 a missing or foreign one answers. */
async function ownedSandbox(
  backend: LifecycleBackend,
  sandboxId: string,
  owner: string,
): Promise<SandboxRecord> {
  const record = await backend.get(sandboxId)
  if (record === null || !isLive(record) || record.owner !== owner) throw missingSandbox()
  return record
}

/** A new sandbox's record: its id is its workspace's, its token is fresh. */
function newRecord(
  owner: string,
  workspaceId: string,
  envVars: Readonly<Record<string, string>>,
  timeoutSeconds: number,
): SandboxRecord {
  return {
    sandboxId: workspaceId,
    workspaceId,
    owner,
    accessToken: toHex(SYSTEM_IDS.secureBytes(32)),
    envVars,
    expiresAtMs: nowMs() + timeoutSeconds * 1000,
  }
}

/**
 * Create, connect, set timeout and delete, over `backend`, for the account
 * `ownerOf` names; the lifecycle routes E2B serves but Mirage does not
 * answer 501. A sandbox another account owns answers as one that does not
 * exist.
 */
interface LifecycleContext {
  readonly backend: LifecycleBackend
  readonly owner: string
}

function registerLifecycle(
  app: RouteApp,
  contextOf: (request: RouteRequest) => LifecycleContext,
): void {
  app.post(constants.CREATE, { bodyLimit: MAX_REQUEST_PART }, async (req, reply) => {
    const input = CreateSandboxRequest.safeParse(req.body === undefined ? {} : req.body)
    if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox create request')
    const { templateID, timeout, envVars, ...options } = input.data
    const unsupported =
      req.headers['idempotency-key'] === undefined
        ? unsupportedCreateOption(options)
        : 'Idempotency-Key'
    if (unsupported !== undefined) {
      return unsupportedLifecycle(reply, `sandbox create option is unsupported: ${unsupported}`)
    }
    if (templateID !== constants.BASE_TEMPLATE) {
      throw new HttpError('not_found', 'sandbox template not found')
    }
    const { backend, owner } = contextOf(req)
    const workspaceId = await backend.start(owner, templateID)
    const record = newRecord(owner, workspaceId, envVars, timeout)
    try {
      await backend.put(record)
    } catch (error) {
      await backend.stop(workspaceId)
      throw error
    }
    void reply.status(201)
    return present(record)
  })
  app.post<{ Params: SandboxParams }>(
    constants.CONNECT,
    { bodyLimit: MAX_REQUEST_PART },
    async (req, reply) => {
      const input = ConnectSandboxRequest.safeParse(req.body === undefined ? {} : req.body)
      if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox connect request')
      const { timeout, ...options } = input.data
      const invalid = Object.entries(options).find(
        ([name, value]) => name !== 'memory' || value !== true,
      )
      if (invalid !== undefined) {
        return unsupportedLifecycle(reply, `sandbox connect option is unsupported: ${invalid[0]}`)
      }
      const { backend, owner } = contextOf(req)
      const record = await ownedSandbox(backend, req.params.id, owner)
      const extended = {
        ...record,
        expiresAtMs: Math.max(record.expiresAtMs, nowMs() + timeout * 1000),
      }
      await backend.put(extended)
      return present(extended)
    },
  )
  app.post<{ Params: SandboxParams }>(
    constants.SET_TIMEOUT,
    { bodyLimit: MAX_REQUEST_PART },
    async (req, reply) => {
      const input = SetSandboxTimeoutRequest.safeParse(req.body)
      if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox timeout request')
      const { backend, owner } = contextOf(req)
      const record = await ownedSandbox(backend, req.params.id, owner)
      await backend.put({ ...record, expiresAtMs: nowMs() + input.data.timeout * 1000 })
      return reply.status(204).send()
    },
  )
  app.delete<{ Params: SandboxParams }>(constants.KILL, async (req, reply) => {
    const { backend, owner } = contextOf(req)
    const record = await ownedSandbox(backend, req.params.id, owner)
    await backend.stop(record.workspaceId)
    await backend.delete(record.sandboxId)
    return reply.status(204).send()
  })
  for (const [method, url] of constants.UNSUPPORTED_LIFECYCLE_ROUTES) {
    app.route({
      method,
      url,
      handler: (_req, reply) =>
        unsupportedLifecycle(reply, 'E2B sandbox operation is unsupported by Mirage'),
    })
  }
}

const LIFECYCLE = new E2BRoutes<LifecycleContext>()
registerLifecycle(LIFECYCLE, (request) => LIFECYCLE.contextOf(request))

/** The lifecycle routes over `backend`, as one web handler that runs as `owner`. */
export function lifecycleRoutes(
  backend: LifecycleBackend,
): (request: Request, owner: string) => Promise<Response> {
  return (request, owner) => LIFECYCLE.fetch(request, owner, { backend, owner })
}

const Path = z.object({ path: z.string() })
const FileQuery = Path.extend({ username: z.string().optional() })
const List = Path.extend({ depth: z.number().int().default(1) })
const Move = z.object({ source: z.string(), destination: z.string() })

function failure(reply: RouteReply, error: unknown, connect = false): RouteReply {
  if (error instanceof HttpError) {
    for (const [name, value] of Object.entries(error.headers)) reply.header(name, value)
    const code = connect ? connectCode(error.status) : error.status
    return reply.status(error.status).send({ code, message: error.message })
  }
  const mapped = fileError(error)
  if (mapped.code === 'internal') console.warn('sandbox file operation failed', error)
  const status =
    !connect && mapped.code === 'resource_exhausted' ? 507 : CONNECT_STATUS[mapped.code]
  return reply
    .status(status)
    .send({ code: connect ? mapped.code : status, message: mapped.message })
}

function queryPath(request: RouteRequest): string {
  const parsed = FileQuery.safeParse(request.query)
  if (!parsed.success || parsed.data.path === '' || parsed.data.path.includes('\0')) {
    throw new FileError('invalid_argument', 'one file path is required')
  }
  if (parsed.data.username !== undefined && parsed.data.username !== 'user') {
    throw new FileError('invalid_argument', 'only the default sandbox user is supported')
  }
  return parsed.data.path
}

async function* uploadBody(request: RouteRequest, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let size = 0
  for await (const chunk of bodyChunks(request, signal)) {
    size += chunk.byteLength
    if (size > constants.MAX_UPLOAD_BYTES)
      throw new HttpError('too_large', 'file upload is too large')
    yield chunk
  }
}

async function multipartFile(request: RouteRequest, signal: AbortSignal): Promise<Uint8Array> {
  const contentType = request.headers['content-type'] ?? ''
  if (contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'multipart/form-data') {
    throw new FileError('invalid_argument', 'expected a multipart file upload')
  }
  let found = false
  const chunks: Uint8Array[] = []
  for await (const part of partEvents(uploadBody(request, signal), contentType)) {
    if (part.kind === 'begin') {
      if (found || part.name !== 'file') {
        throw new FileError('invalid_argument', 'expected one file part')
      }
      found = true
    } else if (part.kind === 'data') {
      chunks.push(part.data)
    }
  }
  if (!found) throw new FileError('invalid_argument', 'expected one file part')
  return concat(chunks)
}

function withFiles<T>(
  lease: Sandbox,
  closed: AbortSignal,
  operation: (files: SandboxFiles, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return lease.runFile(closed, async (signal) => {
    await lease.workspace.ensureSessionsLoaded()
    const session = new Session(lease.workspace, null)
    signal.throwIfAborted()
    lease.stopped.throwIfAborted()
    return operation(new SandboxFiles(withCaller(session.vfs, { fileSignal: signal })), signal)
  })
}

function downloadOf(
  lease: Sandbox,
  path: string,
  closed: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const canceled = new AbortController()
  const connection = AbortSignal.any([closed, canceled.signal])
  return new Promise((resolve, reject) => {
    const running = withFiles(lease, connection, async (files, signal) => {
      const source = await files.read(path)
      const cursor = source[Symbol.asyncIterator]()
      let finish = (): void => undefined
      const finished = new Promise<void>((done) => {
        finish = done
      })
      let pulling: Promise<IteratorResult<Uint8Array>> | undefined
      let stop: (() => void) | undefined
      try {
        lease.stopped.throwIfAborted()
        signal.throwIfAborted()
        resolve(
          new ReadableStream({
            start(controller) {
              stop = () => {
                controller.error(signal.reason)
                finish()
              }
              signal.addEventListener('abort', stop, { once: true })
            },
            async pull(controller) {
              try {
                lease.stopped.throwIfAborted()
                pulling = cursor.next()
                const next = await pulling
                if (signal.aborted) return
                if (next.done === true) {
                  controller.close()
                  finish()
                } else {
                  controller.enqueue(next.value)
                }
              } catch (error) {
                finish()
                throw error
              } finally {
                pulling = undefined
              }
            },
            cancel(reason) {
              canceled.abort(reason)
              finish()
            },
          }),
        )
        await finished
      } finally {
        if (stop !== undefined) signal.removeEventListener('abort', stop)
        await Promise.allSettled([pulling, closeQuietly(cursor)])
      }
    })
    void running.catch(reject)
  })
}

/**
 * The routes that run against one sandbox's workspace: health, the command
 * stream, upload, download and the filesystem calls. Each finds its sandbox
 * through `access`, which refuses a request it does not admit.
 */
function registerData(app: RouteApp, sandboxOf: SandboxOf): void {
  registerStart(app, sandboxOf)
  registerControl(app, sandboxOf)
  app.get(constants.HEALTH, (req, reply) => {
    try {
      sandboxOf(req)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      if (error.code === 'unauthorized') return reply.status(502).send()
      return reply.status(error.status).send({ code: error.status, message: error.message })
    }
    return reply.status(204).send()
  })
  app.get(constants.FILES, async (request, reply) => {
    try {
      const lease = sandboxOf(request)
      const body = await downloadOf(lease, queryPath(request), request.closed)
      return reply.type('application/octet-stream').header('Cache-Control', 'no-store').send(body)
    } catch (error) {
      return failure(reply, error)
    }
  })

  app.post(constants.FILES, async (request, reply) => {
    try {
      const lease = sandboxOf(request)
      if (Object.keys(request.headers).some((name) => name.startsWith('x-metadata-'))) {
        throw new FileError('unimplemented', 'file metadata is unsupported')
      }
      const path = queryPath(request)
      const data = await multipartFile(request, AbortSignal.any([lease.stopped, request.closed]))
      return await withFiles(lease, request.closed, async (files) => [
        await files.write(path, data),
      ])
    } catch (error) {
      return failure(reply, error)
    }
  })

  for (const method of constants.METHODS) {
    app.post(constants.RPC_PREFIX + method, { rawBody: true }, async (request, reply) => {
      try {
        const lease = sandboxOf(request)
        unaryContentType(request, constants.CONNECT_STREAM)
        const body = await readJsonBody(
          request,
          AbortSignal.any([lease.stopped, request.closed]),
          DEFAULT_MAX_REQUEST_BODY_SIZE,
        )
        lease.stopped.throwIfAborted()
        if (method === 'Move') {
          const parsed = Move.safeParse(body)
          if (!parsed.success) {
            throw new FileError('invalid_argument', 'expected source and destination paths')
          }
          const { source, destination } = parsed.data
          return await withFiles(lease, request.closed, async (files) => ({
            entry: await files.move(source, destination),
          }))
        }
        if (method === 'ListDir') {
          const parsed = List.safeParse(body)
          if (!parsed.success) {
            throw new FileError('invalid_argument', 'expected a file path and list depth')
          }
          return await withFiles(lease, request.closed, async (files) => ({
            entries: await files.listDir(parsed.data.path, parsed.data.depth),
          }))
        }
        const parsed = Path.safeParse(body)
        if (!parsed.success) throw new FileError('invalid_argument', 'expected a file path')
        return await withFiles(lease, request.closed, async (files) => {
          const { path } = parsed.data
          if (method === 'Stat') return { entry: await files.stat(path) }
          if (method === 'MakeDir') await files.mkdir(path)
          else await files.remove(path)
          return {}
        })
      } catch (error) {
        return failure(reply, error, true)
      }
    })
  }

  for (const url of constants.UNSUPPORTED_RPC_PATHS) {
    app.post(url, (request, reply) => {
      try {
        sandboxOf(request)
      } catch (error) {
        return failure(reply, error, true)
      }
      return failure(
        reply,
        new FileError('unimplemented', 'E2B data operation is unsupported by Mirage'),
        true,
      )
    })
  }
}

const WEB = new E2BRoutes<Sandbox>()
registerData(WEB, (request) => WEB.contextOf(request))

/** Answer one data request against `sandbox`, after `checkSandboxAccess` let it through. */
export const dataRoutes = (request: Request, sandbox: Sandbox): Promise<Response> =>
  WEB.fetch(request, null, sandbox)

/**
 * The answer that refuses a data request, or null when it may proceed: the
 * daemon's own answers, so every host refuses alike. A live health check
 * answers 204; one the daemon would refuse with 401 answers 502, as E2B's
 * proxy does for a sandbox that is gone.
 */
export function checkSandboxAccess(
  request: Request,
  record: SandboxRecord | null,
): Response | null {
  const path = new URL(request.url).pathname
  const health = path === constants.HEALTH
  try {
    verifyAccess(headersOf(request), record)
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    if (health && error.code === 'unauthorized') return new Response(null, { status: 502 })
    const code = health || path === constants.FILES ? error.status : connectCode(error.status)
    return Response.json({ code, message: error.message }, { status: error.status })
  }
  return health ? new Response(null, { status: 204 }) : null
}

/** Every E2B route, for a host whose framework registers routes one by one. */
export const ROUTES: readonly { method: string; url: string }[] = [...LIFECYCLE.list, ...WEB.list]
