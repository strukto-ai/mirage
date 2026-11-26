import { Buffer } from 'node:buffer'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server'
import { closeQuietly } from '@struktoai/mirage-core/io/stream'
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { withCaller } from '@struktoai/mirage-core/workspace/files'
import { bodyChunks, closeUnreadBody, readJsonBody, unaryContentType } from '../e2b/body.ts'
import * as constants from '../e2b/constants.ts'
import { CONNECT_STATUS, FileError, connectCode, fileError } from '../e2b/errors.ts'
import { SandboxFiles } from '../e2b/files.ts'
import { isProcessRequest, isProcessStart, registerProcess } from '../e2b/process.ts'
import type { Sandboxes, SandboxLease } from '../e2b/sandbox.ts'
import { HttpError } from '../errors.ts'
import { MAX_REQUEST_PART, partEvents } from '../multipart.ts'
import type { RouteApp, RouteReply, RouteRequest } from '../routes.ts'
import { storeRefusal } from './templates.ts'
import { sessionOf } from './vfs.ts'
import { createEphemeralWorkspace, type WorkspaceRoutesDeps } from './workspaces.ts'

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

function present(lease: SandboxLease) {
  return {
    sandboxID: lease.entry.id,
    templateID: constants.BASE_TEMPLATE,
    clientID: lease.entry.id,
    envdVersion: constants.ENVD_VERSION,
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
  return Buffer.concat(chunks)
}

function withFiles<T>(
  lease: SandboxLease,
  closed: AbortSignal,
  operation: (files: SandboxFiles, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return lease.runFile(closed, async (signal) => {
    const session = await sessionOf(lease.entry.runner.ws, undefined)
    signal.throwIfAborted()
    lease.checkFiles()
    return operation(new SandboxFiles(withCaller(session.vfs, { fileSignal: signal })), signal)
  })
}

function downloadOf(
  lease: SandboxLease,
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

export function router(
  app: RouteApp,
  deps: WorkspaceRoutesDeps & { resources: ResourceStore; sandboxes: Sandboxes },
): void {
  const { sandboxes } = deps
  registerProcess(app, sandboxes, deps.registry)
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
    let config: Record<string, JsonValue> = {
      mode: 'read',
      mounts: { [constants.HOME]: { vfs: 'ram', mode: 'write' } },
      env: { HOME: constants.HOME },
    }
    if (!deps.registry.accountsRequired) {
      try {
        config = (await deps.resources.getTemplate(constants.BASE_TEMPLATE)).config
      } catch (error) {
        if (!(error instanceof ResourceError)) throw error
        if (error.code !== 'not_found') throw storeRefusal(error)
        console.debug('using the built-in E2B base:', error.message)
      }
    }
    const entry = await createEphemeralWorkspace(deps, req, reply, config)
    if (deps.registry.draining) {
      await deps.registry.remove(entry.id)
      throw new HttpError('shutting_down', 'server is shutting down')
    }
    void reply.status(201)
    return present(sandboxes.add(entry, envVars, timeout))
  })
  app.post<{ Params: SandboxParams }>(
    constants.CONNECT,
    { bodyLimit: MAX_REQUEST_PART },
    (req, reply) => {
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
      return present(lease)
    },
  )
  app.post<{ Params: SandboxParams }>(
    constants.SET_TIMEOUT,
    { bodyLimit: MAX_REQUEST_PART },
    (req, reply) => {
      const input = SetSandboxTimeoutRequest.safeParse(req.body)
      if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox timeout request')
      if (!sandboxes.setTimeout(req.params.id, req.account, input.data.timeout))
        throw missingSandbox()
      return reply.status(204).send()
    },
  )
  app.delete<{ Params: SandboxParams }>(constants.KILL, async (req, reply) => {
    if (!(await sandboxes.kill(req.params.id, req.account))) throw missingSandbox()
    return reply.status(204).send()
  })
  app.get(constants.HEALTH, (req, reply) => {
    try {
      sandboxes.requireAccess(req.headers)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      if (error.code === 'unauthorized') return reply.status(502).send()
      return reply.status(error.status).send({ code: error.status, message: error.message })
    }
    return reply.status(204).send()
  })
  app.get(constants.FILES, async (request, reply) => {
    try {
      const lease = sandboxes.requireAccess(request.headers)
      const body = await downloadOf(lease, queryPath(request), request.closed)
      return reply.type('application/octet-stream').header('Cache-Control', 'no-store').send(body)
    } catch (error) {
      return failure(reply, error)
    }
  })

  app.post(constants.FILES, async (request, reply) => {
    try {
      const lease = sandboxes.requireAccess(request.headers)
      if (Object.keys(request.headers).some((name) => name.startsWith('x-metadata-'))) {
        throw new FileError('unimplemented', 'file metadata is unsupported')
      }
      const path = queryPath(request)
      const data = await multipartFile(request, AbortSignal.any([lease.revoked, request.closed]))
      return await withFiles(lease, request.closed, async (files) => [
        await files.write(path, data),
      ])
    } catch (error) {
      closeUnreadBody(request, reply)
      return failure(reply, error)
    }
  })

  for (const method of constants.METHODS) {
    app.post(constants.RPC_PREFIX + method, { rawBody: true }, async (request, reply) => {
      try {
        const lease = sandboxes.requireAccess(request.headers)
        unaryContentType(request, constants.CONNECT_STREAM)
        const body = await readJsonBody(
          request,
          AbortSignal.any([lease.revoked, request.closed]),
          DEFAULT_MAX_REQUEST_BODY_SIZE,
        )
        lease.checkFiles()
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
        closeUnreadBody(request, reply)
        return failure(reply, error, true)
      }
    })
  }

  for (const [method, url] of constants.UNSUPPORTED_LIFECYCLE_ROUTES) {
    app.route({
      method,
      url,
      handler: (_req, reply) =>
        unsupportedLifecycle(reply, 'E2B sandbox operation is unsupported by Mirage'),
    })
  }
  for (const url of constants.UNSUPPORTED_RPC_PATHS) {
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
