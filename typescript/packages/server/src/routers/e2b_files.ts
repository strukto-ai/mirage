import { Buffer } from 'node:buffer'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { FileError, SandboxFiles, fileError } from '../e2b/files.ts'
import type { SandboxLease } from '../e2b/leases.ts'
import { HttpError } from '../errors.ts'
import { partEvents } from '../multipart.ts'
import { streamOf, type RouteApp, type RouteReply, type RouteRequest } from '../routes.ts'
import { sessionOf } from './vfs.ts'

const FILES = '/files'
const RPC_PREFIX = '/filesystem.Filesystem/'
const METHODS = ['Stat', 'ListDir', 'MakeDir', 'Remove'] as const
const RPC_PATHS: ReadonlySet<string> = new Set(METHODS.map((method) => RPC_PREFIX + method))
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
const HTTP_CONNECT_CODE: Readonly<Partial<Record<number, string>>> = {
  400: 'invalid_argument',
  401: 'unauthenticated',
  403: 'permission_denied',
  404: 'not_found',
  413: 'resource_exhausted',
  429: 'resource_exhausted',
  503: 'unavailable',
}
const Path = z.object({ path: z.string() })
const List = Path.extend({ depth: z.number().int().default(1) })

type RequireSandbox = (request: RouteRequest) => SandboxLease & { readonly sessionId?: string }

export function isFileRoute(method: string, path: string): boolean {
  return (
    (path === FILES && (method === 'GET' || method === 'POST')) ||
    (method === 'POST' && RPC_PATHS.has(path))
  )
}

function failure(reply: RouteReply, error: unknown, connect = false): RouteReply {
  if (error instanceof HttpError) {
    for (const [name, value] of Object.entries(error.headers)) reply.header(name, value)
    const code = connect ? (HTTP_CONNECT_CODE[error.status] ?? 'internal') : error.status
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

async function filesOf(lease: ReturnType<RequireSandbox>): Promise<SandboxFiles> {
  const session = await sessionOf(lease.entry.runner.ws, lease.sessionId)
  return new SandboxFiles(session.vfs)
}

export function registerFileRoutes(app: RouteApp, requireSandbox: RequireSandbox): void {
  app.get(FILES, async (request, reply) => {
    try {
      const lease = requireSandbox(request)
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
      requireSandbox(request)
      const path = queryPath(request)
      const data = await multipartFile(request)
      const files = await filesOf(requireSandbox(request))
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
          const lease = requireSandbox(request)
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
}
