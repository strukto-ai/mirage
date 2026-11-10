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
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { HttpError, validationError } from '../errors.ts'
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

const CreatePolicyRequest = z.strictObject({ name: z.string(), source: z.string() })

const UpdatePolicyRequest = z.strictObject({ source: z.string() })

/**
 * Refuse policies on a server of many accounts: its one store would let each
 * account read and change the others'. Mirrors Python's `require_one_account`.
 */
function requireOneAccount(registry: WorkspaceRegistry): void {
  if (registry.accountsRequired) {
    throw new HttpError('not_supported', 'policies are kept only on a server of one account')
  }
}

/** The body as `schema` reads it, else its first bad field. */
function bodyOf<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw validationError(parsed.error, body)
  return parsed.data
}

/** `source`, refused past 64 KiB of UTF-8. Mirrors Python's `check_source`. */
function checkSource(source: string): string {
  if (new TextEncoder().encode(source).length > MAX_SOURCE) {
    throw new HttpError('invalid_value', `source must be at most ${String(MAX_SOURCE / 1024)} KB`, {
      param: 'source',
    })
  }
  return source
}

function present(policy: Policy): PolicyResponse {
  return { name: policy.name, source: policy.source }
}

/** Run a store call; a refusal answers by its code, anything else propagates. */
async function stored<T>(registry: WorkspaceRegistry, run: () => Promise<T>): Promise<T> {
  requireOneAccount(registry)
  try {
    return await run()
  } catch (e) {
    if (!(e instanceof ResourceError)) throw e
    throw storeRefusal(e)
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
  app.get('/v1/policies', () =>
    stored(registry, async (): Promise<PolicyList> => ({
      items: (await resources.listPolicies()).map((p) => ({ name: p.name })),
    })),
  )

  // A name already saved is a 409.
  app.post('/v1/policies', (req, reply) =>
    stored(registry, async (): Promise<RouteReply> => {
      const { name, source } = bodyOf(CreatePolicyRequest, req.body)
      if (!POLICY_NAME.test(name)) {
        throw new HttpError('invalid_value', 'name must end in .py, such as guard.py', {
          param: 'name',
        })
      }
      const checked = checkSource(source)
      return reply
        .status(201)
        .send(present(await resources.createPolicy({ name, source: checked })))
    }),
  )

  app.get<{ Params: RefParams }>('/v1/policies/:ref', (req) =>
    stored(registry, async () => present(await resources.getPolicy(req.params.ref))),
  )

  // A missing policy is a 404, not a create.
  app.put<{ Params: RefParams }>('/v1/policies/:ref', (req) =>
    stored(registry, async () => {
      const source = checkSource(bodyOf(UpdatePolicyRequest, req.body).source)
      return present(await resources.updatePolicy({ name: req.params.ref, source }))
    }),
  )

  app.delete<{ Params: RefParams }>('/v1/policies/:ref', (req, reply) =>
    stored(registry, async () => {
      await resources.deletePolicy(req.params.ref)
      return reply.status(204).send()
    }),
  )
}
