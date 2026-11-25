import { Buffer } from 'node:buffer'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server'
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { FileError, SandboxFiles, fileError } from '../e2b/files.ts'
import { Sandboxes, SandboxNotRunning, type SandboxLease } from '../e2b/leases.ts'
import { isProcessStart, registerProcess } from '../e2b/process.ts'
import { HttpError } from '../errors.ts'
import { partEvents } from '../multipart.ts'
import { streamOf, type RouteApp, type RouteReply, type RouteRequest } from '../routes.ts'
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
const METHODS = ['Stat', 'ListDir', 'MakeDir', 'Remove'] as const
const RPC_PATHS: ReadonlySet<string> = new Set(METHODS.map((method) => RPC_PREFIX + method))

const BASE_TEMPLATE = 'base'
const DEFAULT_TIMEOUT = 300
const ENVD_VERSION = '0.5.6'
const Timeout = z.number().int().positive().default(DEFAULT_TIMEOUT)
const CreateSandboxRequest = z.object({
  templateID: z.string().default(BASE_TEMPLATE),
  timeout: Timeout,
  envVars: z.record(z.string(), z.string()).default({}),
})
const ConnectSandboxRequest = z.object({ timeout: Timeout })
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
const List = Path.extend({ depth: z.number().int().default(1) })

interface SandboxParams {
  id: string
}

export function isLifecycleRequest(method: string, path: string): boolean {
  return (
    (method === 'POST' && (path === CREATE || path === CONNECT || path === SET_TIMEOUT)) ||
    (method === 'DELETE' && path === KILL)
  )
}

export function isDataRequest(method: string, path: string): boolean {
  return (
    (method === 'GET' && (path === HEALTH || path === FILES)) ||
    (method === 'POST' && (path === FILES || RPC_PATHS.has(path))) ||
    isProcessStart(method, path)
  )
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
    case 503:
      return 'unavailable'
    default:
      return 'internal'
  }
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
  const parsed = Path.safeParse(request.query)
  if (!parsed.success || parsed.data.path === '' || parsed.data.path.includes('\0')) {
    throw new FileError('invalid_argument', 'one file path is required')
  }
  return parsed.data.path
}

async function* uploadBody(request: RouteRequest): AsyncGenerator<Uint8Array> {
  let size = 0
  for await (const chunk of request.raw) {
    size += chunk.byteLength
    if (size > MAX_UPLOAD_BYTES) throw new HttpError('too_large', 'file upload is too large')
    yield chunk
  }
}

async function multipartFile(request: RouteRequest): Promise<Uint8Array> {
  const contentType = request.headers['content-type'] ?? ''
  if (contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'multipart/form-data') {
    throw new FileError('invalid_argument', 'expected a multipart file upload')
  }
  let found = false
  const chunks: Uint8Array[] = []
  for await (const part of partEvents(uploadBody(request), contentType)) {
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

async function filesOf(lease: SandboxLease): Promise<SandboxFiles> {
  const session = await sessionOf(lease.entry.runner.ws, undefined)
  return new SandboxFiles(session.vfs)
}

export function router(
  app: RouteApp,
  deps: WorkspaceRoutesDeps & {
    resources: ResourceStore
    template: string | undefined
    matchesAccessToken: (expected: string, presented: string) => boolean
  },
): Sandboxes {
  const sandboxes = new Sandboxes(deps.registry, deps.matchesAccessToken)
  const template = deps.template ?? BASE_TEMPLATE
  app.post(CREATE, async (req, reply) => {
    const input = CreateSandboxRequest.safeParse(req.body === undefined ? {} : req.body)
    if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox create request')
    const { templateID, timeout, envVars } = input.data
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
  app.post<{ Params: SandboxParams }>(CONNECT, (req) => {
    const input = ConnectSandboxRequest.safeParse(req.body === undefined ? {} : req.body)
    if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox connect request')
    const lease = sandboxes.reconnect(req.params.id, req.account, input.data.timeout)
    if (lease === null) throw missingSandbox()
    return present(lease, template)
  })
  app.post<{ Params: SandboxParams }>(SET_TIMEOUT, (req, reply) => {
    const input = SetSandboxTimeoutRequest.safeParse(req.body)
    if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox timeout request')
    if (!sandboxes.setTimeout(req.params.id, req.account, input.data.timeout))
      throw missingSandbox()
    return reply.status(204).send()
  })
  app.delete<{ Params: SandboxParams }>(KILL, async (req, reply) => {
    if (!(await sandboxes.kill(req.params.id, req.account))) throw missingSandbox()
    return reply.status(204).send()
  })
  app.get(HEALTH, (req, reply) => {
    try {
      sandboxes.requireAccess(req.headers)
    } catch (error) {
      if (error instanceof SandboxNotRunning) return reply.status(502).send()
      if (!(error instanceof HttpError)) throw error
      return reply.status(error.status).send({ code: error.status, message: error.message })
    }
    return reply.status(204).send()
  })
  registerProcess(app, sandboxes, deps.registry)
  app.get(FILES, async (request, reply) => {
    try {
      const lease = sandboxes.requireAccess(request.headers)
      const path = queryPath(request)
      const files = await filesOf(lease)
      const source = await files.read(path)
      return reply
        .type('application/octet-stream')
        .header('Cache-Control', 'no-store')
        .send(streamOf(source))
    } catch (error) {
      return failure(reply, error)
    }
  })

  app.post(FILES, async (request, reply) => {
    try {
      sandboxes.requireAccess(request.headers)
      const path = queryPath(request)
      const data = await multipartFile(request)
      const files = await filesOf(sandboxes.requireAccess(request.headers))
      return [await files.write(path, data)]
    } catch (error) {
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
          if (method === 'ListDir') {
            const parsed = List.safeParse(request.body)
            if (!parsed.success) {
              throw new FileError('invalid_argument', 'expected a file path and list depth')
            }
            const files = await filesOf(lease)
            return { entries: await files.listDir(parsed.data.path, parsed.data.depth) }
          }
          const parsed = Path.safeParse(request.body)
          if (!parsed.success) throw new FileError('invalid_argument', 'expected a file path')
          const files = await filesOf(lease)
          const { path } = parsed.data
          if (method === 'Stat') return { entry: await files.stat(path) }
          if (method === 'MakeDir') await files.mkdir(path)
          else await files.remove(path)
          return {}
        } catch (error) {
          return failure(reply, error, true)
        }
      },
    )
  }
  return sandboxes
}
