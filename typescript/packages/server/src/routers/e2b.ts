import { Buffer } from 'node:buffer'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server'
import { closeQuietly } from '@struktoai/mirage-core/io/stream'
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { FileError, SandboxFiles, fileError } from '../e2b/files.ts'
import type { Sandboxes, SandboxLease } from '../e2b/leases.ts'
import { bodyChunks, closeUnreadBody } from '../e2b/body.ts'
import {
  CONNECT_STREAM,
  isProcessRequest,
  isProcessStart,
  registerProcess,
} from '../e2b/process.ts'
import { HttpError } from '../errors.ts'
import { MAX_REQUEST_PART, partEvents } from '../multipart.ts'
import type { RouteApp, RouteReply, RouteRequest } from '../routes.ts'
import { storeRefusal } from './templates.ts'
import { sessionOf } from './vfs.ts'
import { createEphemeralWorkspace, type WorkspaceRoutesDeps } from './workspaces.ts'

const CREATE = '/v2/sandboxes'
const CONNECT = '/v2/sandboxes/:id/connect'
const KILL = '/sandboxes/:id'
const SET_TIMEOUT = '/sandboxes/:id/timeout'
const HEALTH = '/health'
const FILES = '/files'
const RPC_PREFIX = '/filesystem.Filesystem/'
const METHODS = ['Stat', 'ListDir', 'MakeDir', 'Move', 'Remove'] as const
const UNSUPPORTED_LIFECYCLE_ROUTES = [
  ['GET', CREATE],
  ['GET', '/sandboxes'],
  ['GET', KILL],
  ['GET', '/sandboxes/:id/metrics'],
  ['POST', '/sandboxes/:id/pause'],
  ['POST', '/sandboxes/:id/resume'],
] as const
const UNSUPPORTED_RPC_PATHS = [
  RPC_PREFIX + 'WatchDir',
  RPC_PREFIX + 'CreateWatcher',
  RPC_PREFIX + 'GetWatcherEvents',
  RPC_PREFIX + 'RemoveWatcher',
  '/process.Process/Connect',
  '/process.Process/Update',
  '/process.Process/StreamInput',
]
const RPC_PATHS: ReadonlySet<string> = new Set([
  ...METHODS.map((method) => RPC_PREFIX + method),
  ...UNSUPPORTED_RPC_PATHS,
])

const BASE_TEMPLATE = 'base'
const DEFAULT_TIMEOUT = 300
const ENVD_VERSION = '0.5.6'
const Timeout = z.number().int().positive().default(DEFAULT_TIMEOUT)
const CreateSandboxRequest = z.looseObject({
  templateID: z.string().default(BASE_TEMPLATE),
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

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
const CONNECT_STATUS: Record<FileError['code'], number> = {
  invalid_argument: 400,
  failed_precondition: 400,
  permission_denied: 403,
  not_found: 404,
  already_exists: 409,
  resource_exhausted: 429,
  internal: 500,
  unimplemented: 501,
}
const Path = z.object({ path: z.string() })
const FileQuery = Path.extend({ username: z.string().optional() })
const List = Path.extend({ depth: z.number().int().default(1) })
const Move = z.object({ source: z.string(), destination: z.string() })

const InertCreateOptions = z.strictObject({
  metadata: z.strictObject({}).optional(),
  allow_internet_access: z.literal(true).optional(),
  autoPause: z.literal(false).optional(),
  autoResume: z.strictObject({ enabled: z.literal(false) }).optional(),
})

interface SandboxParams {
  id: string
}

export function isLifecycleRequest(method: string, path: string): boolean {
  return (
    (method === 'POST' && (path === CREATE || path === CONNECT || path === SET_TIMEOUT)) ||
    (method === 'DELETE' && path === KILL) ||
    UNSUPPORTED_LIFECYCLE_ROUTES.some(([verb, route]) => method === verb && path === route)
  )
}

export function isDataRequest(method: string, path: string): boolean {
  return (
    (method === 'GET' && (path === HEALTH || path === FILES)) ||
    (method === 'POST' && (path === FILES || RPC_PATHS.has(path))) ||
    isProcessRequest(method, path)
  )
}

export function acceptsRawBody(method: string, path: string, contentType: string): boolean {
  if (contentType === CONNECT_STREAM) {
    return (
      isProcessStart(method, path) || (method === 'POST' && UNSUPPORTED_RPC_PATHS.includes(path))
    )
  }
  return method === 'POST' && path === FILES
}

export function sandboxAccount(
  sandboxes: Sandboxes | null,
  headers: Parameters<Sandboxes['requireAccess']>[0],
): string | null {
  return sandboxAccess(sandboxes, headers)?.entry.owner ?? null
}

function sandboxAccess(
  sandboxes: Sandboxes | null,
  headers: Parameters<Sandboxes['requireAccess']>[0],
): SandboxLease | null {
  try {
    return sandboxes?.requireAccess(headers) ?? null
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    console.debug('sandbox access could not be verified:', error.message)
    return null
  }
}

export function sandboxWorkspace(
  sandboxes: Sandboxes | null,
  path: string,
  request: Pick<RouteRequest, 'method' | 'params' | 'account'> & {
    headers: Parameters<Sandboxes['requireAccess']>[0]
  },
): string | null {
  if (sandboxes === null) return null
  if (isDataRequest(request.method, path)) {
    return sandboxAccess(sandboxes, request.headers)?.entry.id ?? null
  }
  const { params } = request
  if (
    !isLifecycleRequest(request.method, path) ||
    typeof params !== 'object' ||
    params === null ||
    !('id' in params) ||
    typeof params.id !== 'string'
  ) {
    return null
  }
  return sandboxes.owned(params.id, request.account)?.entry.id ?? null
}

export function connectCode(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_argument'
    case 401:
      return 'unauthenticated'
    case 403:
      return 'permission_denied'
    case 404:
      return 'not_found'
    case 413:
    case 429:
      return 'resource_exhausted'
    case 501:
      return 'unimplemented'
    case 503:
      return 'unavailable'
    default:
      return 'internal'
  }
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

function present(lease: SandboxLease, template: string) {
  return {
    sandboxID: lease.entry.id,
    templateID: template,
    clientID: lease.entry.id,
    envdVersion: ENVD_VERSION,
    envdAccessToken: lease.accessToken,
  }
}

function missingSandbox(): HttpError {
  return new HttpError('not_found', 'sandbox not found')
}

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
    if (size > MAX_UPLOAD_BYTES) throw new HttpError('too_large', 'file upload is too large')
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
  return Buffer.concat(chunks)
}

function withFiles<T>(
  lease: SandboxLease,
  operation: (files: SandboxFiles) => Promise<T>,
): Promise<T> {
  return lease.runFile(async () => {
    const session = await sessionOf(lease.entry.runner.ws, undefined)
    lease.checkFiles()
    return operation(new SandboxFiles(session.vfs))
  })
}

function downloadOf(
  lease: SandboxLease,
  path: string,
  closed: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const signal = AbortSignal.any([lease.revoked, closed])
  return new Promise((resolve, reject) => {
    const running = withFiles(lease, async (files) => {
      const source = await files.read(path)
      const cursor = source[Symbol.asyncIterator]()
      let finish = (): void => undefined
      const finished = new Promise<void>((done) => {
        finish = done
      })
      let pulling: Promise<IteratorResult<Uint8Array>> | undefined
      let stop: (() => void) | undefined
      try {
        lease.checkFiles()
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
                lease.checkFiles()
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
            cancel() {
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

export function router(
  app: RouteApp,
  deps: WorkspaceRoutesDeps & {
    resources: ResourceStore
    template: string | undefined
    sandboxes: Sandboxes
  },
): void {
  const { sandboxes } = deps
  registerProcess(app, sandboxes, deps.registry)
  const template = deps.template ?? BASE_TEMPLATE
  app.post(CREATE, { bodyLimit: MAX_REQUEST_PART }, async (req, reply) => {
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
    if (templateID !== BASE_TEMPLATE && templateID !== template) {
      throw new HttpError('not_found', 'sandbox template not found')
    }
    let config: Record<string, JsonValue> = {
      mode: 'read',
      mounts: { '/home/user': { vfs: 'ram', mode: 'write' } },
    }
    if (deps.template !== undefined) {
      try {
        config = (await deps.resources.getTemplate(deps.template)).config
      } catch (error) {
        if (error instanceof ResourceError) throw storeRefusal(error)
        throw error
      }
    }
    const entry = await createEphemeralWorkspace(deps, req, reply, config)
    void reply.status(201)
    return present(sandboxes.add(entry, envVars, timeout), template)
  })
  app.post<{ Params: SandboxParams }>(CONNECT, { bodyLimit: MAX_REQUEST_PART }, (req, reply) => {
    const input = ConnectSandboxRequest.safeParse(req.body === undefined ? {} : req.body)
    if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox connect request')
    const { timeout, ...options } = input.data
    const invalid = Object.entries(options).find(
      ([name, value]) => name !== 'memory' || value !== true,
    )
    if (invalid !== undefined) {
      return unsupportedLifecycle(reply, `sandbox connect option is unsupported: ${invalid[0]}`)
    }
    const lease = sandboxes.reconnect(req.params.id, req.account, timeout)
    if (lease === null) throw missingSandbox()
    return present(lease, template)
  })
  app.post<{ Params: SandboxParams }>(
    SET_TIMEOUT,
    { bodyLimit: MAX_REQUEST_PART },
    (req, reply) => {
      const input = SetSandboxTimeoutRequest.safeParse(req.body)
      if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox timeout request')
      if (!sandboxes.setTimeout(req.params.id, req.account, input.data.timeout))
        throw missingSandbox()
      return reply.status(204).send()
    },
  )
  app.delete<{ Params: SandboxParams }>(KILL, async (req, reply) => {
    if (!(await sandboxes.kill(req.params.id, req.account))) throw missingSandbox()
    return reply.status(204).send()
  })
  app.get(HEALTH, (req, reply) => {
    try {
      sandboxes.requireAccess(req.headers)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      if (error.code === 'unauthorized') return reply.status(502).send()
      return reply.status(error.status).send({ code: error.status, message: error.message })
    }
    return reply.status(204).send()
  })
  app.get(FILES, async (request, reply) => {
    try {
      const lease = sandboxes.requireAccess(request.headers)
      const body = await downloadOf(lease, queryPath(request), request.closed)
      return reply.type('application/octet-stream').header('Cache-Control', 'no-store').send(body)
    } catch (error) {
      return failure(reply, error)
    }
  })

  app.post(FILES, async (request, reply) => {
    try {
      const lease = sandboxes.requireAccess(request.headers)
      if (Object.keys(request.headers).some((name) => name.startsWith('x-metadata-'))) {
        throw new FileError('unimplemented', 'file metadata is unsupported')
      }
      const path = queryPath(request)
      const data = await multipartFile(request, AbortSignal.any([lease.revoked, request.closed]))
      return await withFiles(lease, async (files) => [await files.write(path, data)])
    } catch (error) {
      closeUnreadBody(request, reply)
      return failure(reply, error)
    }
  })

  for (const method of METHODS) {
    app.post(
      RPC_PREFIX + method,
      {
        bodyLimit: DEFAULT_MAX_REQUEST_BODY_SIZE,
        invalidJson: { code: 'invalid_argument', message: 'body must be JSON' },
      },
      async (request, reply) => {
        try {
          const lease = sandboxes.requireAccess(request.headers)
          if (method === 'Move') {
            const parsed = Move.safeParse(request.body)
            if (!parsed.success) {
              throw new FileError('invalid_argument', 'expected source and destination paths')
            }
            const { source, destination } = parsed.data
            return await withFiles(lease, async (files) => ({
              entry: await files.move(source, destination),
            }))
          }
          if (method === 'ListDir') {
            const parsed = List.safeParse(request.body)
            if (!parsed.success) {
              throw new FileError('invalid_argument', 'expected a file path and list depth')
            }
            return await withFiles(lease, async (files) => ({
              entries: await files.listDir(parsed.data.path, parsed.data.depth),
            }))
          }
          const parsed = Path.safeParse(request.body)
          if (!parsed.success) throw new FileError('invalid_argument', 'expected a file path')
          return await withFiles(lease, async (files) => {
            const { path } = parsed.data
            if (method === 'Stat') return { entry: await files.stat(path) }
            if (method === 'MakeDir') await files.mkdir(path)
            else await files.remove(path)
            return {}
          })
        } catch (error) {
          return failure(reply, error, true)
        }
      },
    )
  }

  for (const [method, url] of UNSUPPORTED_LIFECYCLE_ROUTES) {
    app.route({
      method,
      url,
      handler: (_req, reply) =>
        unsupportedLifecycle(reply, 'E2B sandbox operation is unsupported by Mirage'),
    })
  }
  for (const url of UNSUPPORTED_RPC_PATHS) {
    app.post(url, (request, reply) => {
      closeUnreadBody(request, reply)
      try {
        sandboxes.requireAccess(request.headers)
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
