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
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { POLICY_NAME } from '@struktoai/mirage-core/resources/constants'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import type { Policy } from '@struktoai/mirage-core/resources/types'
import type { WorkspaceRegistry } from '../registry.ts'
import type { RouteApp, RouteReply } from '../routes.ts'
import { storeRefusal } from './templates.ts'

interface RefParams {
  ref: string
}

/** A policy is a script, not a project, so its source is at most 64 KiB. */
const MAX_SOURCE = 64 * 1024

interface PolicyResponse {
  name: string
  source: string
}

interface PolicyName {
  name: string
}

interface PolicyList {
  items: PolicyName[]
}

interface CreatePolicyRequest {
  name: string
  source: string
}

interface UpdatePolicyRequest {
  source: string
}

interface Refusal {
  status: number
  detail: string
}

/**
 * Refuse policies on a server of many accounts: its one store would let each
 * account read and change the others'. Null when the server has one account.
 */
function requireOneAccount(registry: WorkspaceRegistry): Refusal | null {
  return registry.accountsRequired
    ? { status: 501, detail: 'policies are kept only on a server of one account' }
    : null
}

/**
 * The body's fields when it holds exactly `fields` as strings, else the 400
 * the Python server's model answers with (unknown fields included).
 */
function bodyOf(body: unknown, fields: readonly string[]): Record<string, string> | Refusal {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, detail: 'body must be an object' }
  }
  const given = body as Record<string, unknown>
  const unknown = Object.keys(given).filter((k) => !fields.includes(k))
  if (unknown.length > 0) return { status: 400, detail: `unknown fields: ${unknown.join(', ')}` }
  const out: Record<string, string> = {}
  for (const field of fields) {
    const value = given[field]
    if (typeof value !== 'string') return { status: 400, detail: `${field} must be a string` }
    out[field] = value
  }
  return out
}

/** A refusal for a source over 64 KiB, else null. */
function checkSource(source: string): Refusal | null {
  return new TextEncoder().encode(source).length > MAX_SOURCE
    ? { status: 400, detail: `source must be at most ${String(MAX_SOURCE / 1024)} KB` }
    : null
}

function present(policy: Policy): PolicyResponse {
  return { name: policy.name, source: policy.source }
}

function isRefusal(value: Record<string, string> | Refusal): value is Refusal {
  return typeof (value as Refusal).status === 'number'
}

/** Run a store call; a refusal answers by its code, anything else propagates. */
async function stored<T>(
  registry: WorkspaceRegistry,
  reply: RouteReply,
  run: () => Promise<T>,
): Promise<T | RouteReply> {
  const refused = requireOneAccount(registry)
  if (refused !== null) return reply.status(refused.status).send({ detail: refused.detail })
  try {
    return await run()
  } catch (e) {
    if (!(e instanceof ResourceError)) throw e
    const { status, detail } = storeRefusal(e)
    return reply.status(status).send({ detail })
  }
}

export function registerPoliciesRoutes(
  app: RouteApp,
  deps: {
    resources: ResourceStore
    registry: WorkspaceRegistry
  },
): void {
  const { resources, registry } = deps
  app.get('/v1/policies', (_req, reply) =>
    stored(registry, reply, async (): Promise<PolicyList> => ({
      items: (await resources.listPolicies()).map((p) => ({ name: p.name })),
    })),
  )

  // A name already saved is a 409.
  app.post('/v1/policies', (req, reply) =>
    stored(registry, reply, async () => {
      const body = bodyOf(req.body, ['name', 'source'])
      if (isRefusal(body)) return reply.status(body.status).send({ detail: body.detail })
      const { name, source } = body as unknown as CreatePolicyRequest
      if (!POLICY_NAME.test(name)) {
        return reply.status(400).send({ detail: 'policy name must end in .py, such as guard.py' })
      }
      const tooBig = checkSource(source)
      if (tooBig !== null) return reply.status(tooBig.status).send({ detail: tooBig.detail })
      return reply.status(201).send(present(await resources.createPolicy({ name, source })))
    }),
  )

  app.get<{ Params: RefParams }>('/v1/policies/:ref', (req, reply) =>
    stored(registry, reply, async () => present(await resources.getPolicy(req.params.ref))),
  )

  // A missing policy is a 404, not a create.
  app.put<{ Params: RefParams }>('/v1/policies/:ref', (req, reply) =>
    stored(registry, reply, async () => {
      const body = bodyOf(req.body, ['source'])
      if (isRefusal(body)) return reply.status(body.status).send({ detail: body.detail })
      const { source } = body as unknown as UpdatePolicyRequest
      const tooBig = checkSource(source)
      if (tooBig !== null) return reply.status(tooBig.status).send({ detail: tooBig.detail })
      return present(await resources.updatePolicy({ name: req.params.ref, source }))
    }),
  )

  app.delete<{ Params: RefParams }>('/v1/policies/:ref', (req, reply) =>
    stored(registry, reply, async () => {
      await resources.deletePolicy(req.params.ref)
      return reply.status(204).send()
    }),
  )
}
