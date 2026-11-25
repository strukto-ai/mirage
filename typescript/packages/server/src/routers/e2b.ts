import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { Sandboxes, SandboxNotRunning, type SandboxLease } from '../e2b/leases.ts'
import { isProcessStart, registerProcess } from '../e2b/process.ts'
import { HttpError } from '../errors.ts'
import type { RouteApp } from '../routes.ts'
import { isFileRoute, registerFileRoutes } from './e2b_files.ts'
import { storeRefusal } from './templates.ts'
import { createEphemeralWorkspace, type WorkspaceRoutesDeps } from './workspaces.ts'

const CREATE = '/v2/sandboxes'
const CONNECT = '/v2/sandboxes/:id/connect'
const KILL = '/sandboxes/:id'
const SET_TIMEOUT = '/sandboxes/:id/timeout'
const HEALTH = '/health'

const DEFAULT_TIMEOUT = 300
const ENVD_VERSION = '0.5.6'
const Timeout = z.number().int().positive().default(DEFAULT_TIMEOUT)
const CreateSandboxRequest = z.object({
  templateID: z.string().default('base'),
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
    (method === 'GET' && path === HEALTH) ||
    isProcessStart(method, path) ||
    isFileRoute(method, path)
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

export function router(
  app: RouteApp,
  deps: WorkspaceRoutesDeps & {
    resources: ResourceStore
    template: string
    matchesAccessToken: (expected: string, presented: string) => boolean
  },
): Sandboxes {
  const sandboxes = new Sandboxes(deps.registry, deps.matchesAccessToken)
  app.post(CREATE, async (req, reply) => {
    const input = CreateSandboxRequest.safeParse(req.body === undefined ? {} : req.body)
    if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox create request')
    const { templateID, timeout, envVars } = input.data
    if (templateID !== 'base' && templateID !== deps.template) {
      throw new HttpError('not_found', 'sandbox template not found')
    }
    let saved
    try {
      saved = await deps.resources.getTemplate(deps.template)
    } catch (error) {
      if (error instanceof ResourceError) throw storeRefusal(error)
      throw error
    }
    const entry = await createEphemeralWorkspace(deps, req, reply, saved.config)
    void reply.status(201)
    return present(sandboxes.add(entry, envVars, timeout), deps.template)
  })
  app.post<{ Params: SandboxParams }>(CONNECT, (req) => {
    const input = ConnectSandboxRequest.safeParse(req.body === undefined ? {} : req.body)
    if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox connect request')
    const lease = sandboxes.reconnect(req.params.id, req.account, input.data.timeout)
    if (lease === null) throw missingSandbox()
    return present(lease, deps.template)
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
  registerFileRoutes(app, (request) => sandboxes.requireAccess(request.headers))
  return sandboxes
}
