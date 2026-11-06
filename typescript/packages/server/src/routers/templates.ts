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
import type { RouteApp, RouteReply } from '../routes.ts'
import { checkConfig, type CreateTemplateRequest, type TemplateResponse } from '../schemas.ts'

interface RefParams {
  ref: string
}

const STATUS: Readonly<Record<ResourceErrorCode, number>> = {
  not_found: 404,
  conflict: 409,
  invalid: 400,
}

/** The answer for a store's refusal: 404, 409 or 400 by its code. */
export function storeRefusal(e: ResourceError): { status: number; detail: string } {
  return { status: STATUS[e.code], detail: e.message }
}

function present(template: Template): TemplateResponse {
  return { name: template.name, description: template.description, config: template.config }
}

/** Run a store call; a refusal answers by its code, anything else propagates. */
async function stored<T>(reply: RouteReply, run: () => Promise<T>): Promise<T | RouteReply> {
  try {
    return await run()
  } catch (e) {
    if (!(e instanceof ResourceError)) throw e
    const { status, detail } = storeRefusal(e)
    return reply.status(status).send({ detail })
  }
}

export function registerTemplatesRoutes(
  app: RouteApp,
  deps: {
    resources: ResourceStore
  },
): void {
  const { resources } = deps
  app.get('/v1/templates', async () => (await resources.listTemplates()).map(present))

  // A whole workspace config, checked as a create checks one, and kept as
  // written. A name already saved is a 409.
  app.post<{ Body: CreateTemplateRequest }>('/v1/templates', async (req, reply) => {
    const body = req.body as Partial<CreateTemplateRequest> | null
    if (body === null || typeof body !== 'object' || typeof body.name !== 'string') {
      return reply.status(400).send({ detail: 'name must be a string' })
    }
    const { name, description } = body
    if (description !== undefined && description !== null && typeof description !== 'string') {
      return reply.status(400).send({ detail: 'description must be a string' })
    }
    try {
      checkConfig(body.config)
    } catch (e) {
      return reply.status(400).send({ detail: (e as Error).message })
    }
    const config = body.config as Record<string, JsonValue>
    return stored(reply, async () => {
      try {
        await resources.getTemplate(name)
        return reply.status(409).send({ detail: `template ${name} already exists` })
      } catch (e) {
        if (!(e instanceof ResourceError) || e.code !== 'not_found') throw e
      }
      const saved = await resources.putTemplate({ name, description: description ?? null, config })
      return reply.status(201).send(present(saved))
    })
  })

  app.get<{ Params: RefParams }>('/v1/templates/:ref', (req, reply) =>
    stored(reply, async () => present(await resources.getTemplate(req.params.ref))),
  )

  // Deleted, not wiped: restore brings it back.
  app.delete<{ Params: RefParams }>('/v1/templates/:ref', (req, reply) =>
    stored(reply, async () => {
      await resources.deleteTemplate(req.params.ref)
      return reply.status(204).send()
    }),
  )

  app.post<{ Params: RefParams }>('/v1/templates/:ref/restore', (req, reply) =>
    stored(reply, async () => present(await resources.restoreTemplate(req.params.ref))),
  )
}
