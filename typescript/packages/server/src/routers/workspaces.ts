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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { MountMode } from '@struktoai/mirage-node'
import { Workspace, type Resource } from '@struktoai/mirage-node'
import type { WorkspaceRegistry } from '../registry.ts'
import { buildOverrideResources, cloneWorkspaceWithOverride, type OverrideShape } from '../clone.ts'
import {
  configToWorkspaceArgs,
  loadWorkspaceConfig,
  type WorkspaceArgs,
  type WorkspaceConfigRaw,
} from '../config.ts'
import { makeBrief, makeDetail } from '../summary.ts'

export interface WorkspaceRoutesDeps {
  registry: WorkspaceRegistry
}

interface CreateWorkspaceBody {
  config: Record<string, unknown>
  id?: string
}

interface WorkspaceIdParams {
  id: string
}

interface WorkspaceGetQuery {
  verbose?: string
}

interface CloneWorkspaceBody {
  id?: string
  override?: OverrideShape
}

export function registerWorkspacesRoutes(app: FastifyInstance, deps: WorkspaceRoutesDeps): void {
  app.post<{ Body: CreateWorkspaceBody }>(
    '/v1/workspaces',
    async (req: FastifyRequest<{ Body: CreateWorkspaceBody }>, reply: FastifyReply) => {
      const body = req.body
      if (body.id !== undefined && deps.registry.has(body.id)) {
        return reply.status(409).send({ detail: `workspace id already exists: ${body.id}` })
      }
      let cfg: WorkspaceConfigRaw
      try {
        cfg = loadWorkspaceConfig(body.config)
      } catch (e) {
        return reply.status(400).send({ detail: (e as Error).message })
      }
      let args: WorkspaceArgs
      try {
        args = await configToWorkspaceArgs(cfg)
      } catch (e) {
        return reply.status(502).send({ detail: `resource build failed: ${(e as Error).message}` })
      }
      const resourceMap: Record<string, Resource> = {}
      const modeOverrides: Record<string, MountMode> = {}
      for (const [prefix, [resource, mode]] of Object.entries(args.resources)) {
        resourceMap[prefix] = resource
        modeOverrides[prefix] = mode
      }
      const ws = new Workspace(resourceMap, {
        mode: args.options.mode,
        modeOverrides,
        ...(args.options.cache !== undefined ? { cache: args.options.cache } : {}),
        ...(args.options.index !== undefined ? { index: args.options.index } : {}),
      })
      let entry
      try {
        entry = deps.registry.add(ws, body.id)
      } catch (e) {
        return reply.status(409).send({ detail: (e as Error).message })
      }
      return reply.status(201).send(makeDetail(entry))
    },
  )

  app.get('/v1/workspaces', () => deps.registry.list().map(makeBrief))

  app.post('/v1/workspaces/load', async (req, reply) => {
    let tarBuf: Buffer | null = null
    let workspaceId: string | undefined
    let override: unknown = null
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'tar') {
        tarBuf = await part.toBuffer()
      } else if (part.type === 'field' && part.fieldname === 'id') {
        workspaceId = String(part.value)
      } else if (part.type === 'field' && part.fieldname === 'override') {
        try {
          override = JSON.parse(String(part.value))
        } catch {
          return reply.status(400).send({ detail: 'override must be JSON' })
        }
      }
    }
    if (tarBuf === null) return reply.status(400).send({ detail: 'missing tar field' })
    if (workspaceId !== undefined && deps.registry.has(workspaceId)) {
      return reply.status(409).send({ detail: `workspace id already exists: ${workspaceId}` })
    }
    let overrides: Record<string, Resource>
    try {
      overrides = await buildOverrideResources(override as OverrideShape | null)
    } catch (e) {
      return reply.status(400).send({ detail: `override build failed: ${(e as Error).message}` })
    }
    let ws: Workspace
    try {
      ws = await Workspace.load(new Uint8Array(tarBuf), {}, overrides)
    } catch (e) {
      return reply.status(400).send({ detail: `load failed: ${(e as Error).message}` })
    }
    let entry
    try {
      entry = deps.registry.add(ws, workspaceId)
    } catch (e) {
      return reply.status(409).send({ detail: (e as Error).message })
    }
    return reply.status(201).send(makeDetail(entry))
  })

  app.get<{ Params: WorkspaceIdParams; Querystring: WorkspaceGetQuery }>(
    '/v1/workspaces/:id',
    (req, reply) => {
      const { id } = req.params
      if (!deps.registry.has(id)) return reply.status(404).send({ detail: 'workspace not found' })
      const verbose = req.query.verbose === 'true'
      return makeDetail(deps.registry.get(id), verbose)
    },
  )

  app.delete<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id', async (req, reply) => {
    const { id } = req.params
    if (!deps.registry.has(id)) return reply.status(404).send({ detail: 'workspace not found' })
    await deps.registry.remove(id)
    return { id, closedAt: Date.now() / 1000 }
  })

  app.post<{ Params: WorkspaceIdParams; Body: CloneWorkspaceBody }>(
    '/v1/workspaces/:id/clone',
    async (req, reply) => {
      const { id } = req.params
      if (!deps.registry.has(id)) return reply.status(404).send({ detail: 'workspace not found' })
      const body = req.body
      if (body.id !== undefined && deps.registry.has(body.id)) {
        return reply.status(409).send({ detail: `workspace id already exists: ${body.id}` })
      }
      const src = deps.registry.get(id).runner.ws
      const newWs = await cloneWorkspaceWithOverride(src, body.override ?? null)
      let entry
      try {
        entry = deps.registry.add(newWs, body.id)
      } catch (e) {
        return reply.status(409).send({ detail: (e as Error).message })
      }
      return reply.status(201).send(makeDetail(entry))
    },
  )

  app.get<{ Params: WorkspaceIdParams }>('/v1/workspaces/:id/snapshot', async (req, reply) => {
    const { id } = req.params
    if (!deps.registry.has(id)) return reply.status(404).send({ detail: 'workspace not found' })
    const tmp = mkdtempSync(join(tmpdir(), 'mirage-snap-'))
    const out = join(tmp, `${id}.tar`)
    try {
      await deps.registry.get(id).runner.ws.snapshot(out)
      const buf = readFileSync(out)
      reply.header('Content-Type', 'application/x-tar')
      reply.header('Content-Disposition', `attachment; filename="${id}.tar"`)
      return await reply.send(buf)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}
