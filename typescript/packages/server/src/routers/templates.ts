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
import { ResourceError, type ResourceErrorCode } from '@struktoai/mirage-core/resources/errors'
import type { Template } from '@struktoai/mirage-core/resources/types'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { type ErrorCode, HttpError, loaderError, validationError } from '../errors.ts'
import type { WorkspaceRegistry } from '../registry.ts'
import type { RouteApp } from '../routes.ts'
import { checkConfig, CreateTemplateRequest, type TemplateResponse } from '../schemas.ts'

interface RefParams {
  ref: string
}

/**
 * Every workspace made from a template would claim one id, which a worker
 * proxy cannot see without reading the template; the create names it.
 */
export const NO_WORKSPACE_ID =
  "a template's config cannot set workspace_id; give the id when you create from it"

const CODE: Readonly<Record<ResourceErrorCode, ErrorCode>> = {
  not_found: 'not_found',
  conflict: 'conflict',
  invalid: 'invalid_request',
}

/** The answer for a store's refusal, by its code. Mirrors Python's `store_refusal`. */
export function storeRefusal(e: ResourceError): HttpError {
  return new HttpError(CODE[e.code], e.message, { cause: e })
}

function present(template: Template): TemplateResponse {
  return { name: template.name, description: template.description, config: template.config }
}

/**
 * Refuse templates on a server of many accounts: its one store would let each
 * account read and use the others'. Mirrors Python's `require_one_account`.
 */
export function requireOneAccount(registry: WorkspaceRegistry): void {
  if (registry.accountsRequired) {
    throw new HttpError('not_supported', 'templates are kept only on a server of one account')
  }
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

export function registerTemplatesRoutes(
  app: RouteApp,
  deps: {
    resources: ResourceStore
    registry: WorkspaceRegistry
  },
): void {
  const { resources, registry } = deps
  app.get('/v1/templates', () =>
    stored(registry, async () => ({
      items: (await resources.listTemplates()).map(present),
    })),
  )

  // A whole workspace config, checked as a create checks one, and kept as
  // written. A name already saved is a 409. The declared fields are
  // checked before an unknown key, the config's own fields among them.
  app.post('/v1/templates', async (req, reply) => {
    requireOneAccount(registry)
    const body = req.body
    const parsed = CreateTemplateRequest.safeParse(body)
    if (!parsed.success && parsed.error.issues.some((i) => i.code !== 'unrecognized_keys')) {
      throw validationError(parsed.error, body)
    }
    const config = (body as { config: Record<string, JsonValue> }).config
    let checked
    try {
      checked = checkConfig(config)
    } catch (e) {
      throw loaderError(e, ['config'], config)
    }
    if (!parsed.success) throw validationError(parsed.error, body)
    if ((checked.workspaceId ?? null) !== null) {
      throw new HttpError('invalid_request', NO_WORKSPACE_ID)
    }
    const { name, description } = parsed.data
    return stored(registry, async () => {
      const saved = await resources.createTemplate({
        name,
        description: description ?? null,
        config,
      })
      return reply.status(201).send(present(saved))
    })
  })

  app.get<{ Params: RefParams }>('/v1/templates/:ref', (req) =>
    stored(registry, async () => present(await resources.getTemplate(req.params.ref))),
  )

  // Deleted, not wiped: restore brings it back.
  app.delete<{ Params: RefParams }>('/v1/templates/:ref', (req, reply) =>
    stored(registry, async () => {
      await resources.deleteTemplate(req.params.ref)
      return reply.status(204).send()
    }),
  )

  app.post<{ Params: RefParams }>('/v1/templates/:ref/restore', (req) =>
    stored(registry, async () => present(await resources.restoreTemplate(req.params.ref))),
  )
}
