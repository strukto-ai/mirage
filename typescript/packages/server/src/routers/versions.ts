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

import type { FastifyInstance } from 'fastify'
import { Errors } from 'isomorphic-git'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import { Workspace } from '@struktoai/mirage-node'
import type { SourceEntries } from '@struktoai/mirage-core/secrets/config'
import { z } from '@struktoai/mirage-core/resource/secrets'
import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import { cloneWorkspaceWithOverride } from '../clone.ts'
import type { WorkspaceRegistry } from '../registry.ts'
import { makeDetail } from '../summary.ts'
import {
  checkout,
  commitState,
  createBranch,
  diffLiveVsRef,
  readVersion,
  resolveRef,
  statusState,
  versionDiff,
  versionLog,
} from '../version/api.ts'
import type { VersionBackend } from '../version/backend.ts'
import { HeadMovedError, NoSuchBranchError } from '../version/errors.ts'
import { toState } from '../version/stateTree.ts'
import { VersionStore } from '../version/store.ts'

export interface VersionRoutesDeps {
  registry: WorkspaceRegistry
  versionBackend: VersionBackend
}

interface CommitBody {
  branch?: string
  message?: string
}

interface BranchBody {
  name: string
  fromBranch?: string
}

interface CheckoutBody {
  ref: string
}

interface CloneBody {
  sourceId: string
  at?: string
  id?: string
  /**
   * A version store holds no `secrets:` block, and the live source may
   * be gone (a restart), so a historical clone that restores managed
   * pointers names their declarations here.
   */
  secrets?: SourceEntries
}

interface IdParams {
  id: string
}

interface DiffQuery {
  a?: string
  b?: string
  branch?: string
}

interface VersionsQuery {
  branch?: string
}

export function registerVersionsRoutes(app: FastifyInstance, deps: VersionRoutesDeps): void {
  const openStore = (id: string): Promise<VersionStore> =>
    VersionStore.open(deps.versionBackend, id)

  app.post<{ Params: IdParams; Body: CommitBody }>(
    '/v1/workspaces/:id/commit',
    async (req, reply) => {
      const { id } = req.params
      if (!deps.registry.has(id)) return reply.status(404).send({ detail: 'workspace not found' })
      const branch = req.body.branch ?? 'main'
      const message = req.body.message ?? ''
      const state = await toStateDict(deps.registry.get(id).runner.ws)
      const store = await openStore(id)
      try {
        const version = await commitState(store, state, branch, message)
        return await reply.status(200).send({ version, branch })
      } catch (e) {
        if (e instanceof HeadMovedError) return reply.status(409).send({ detail: e.message })
        if (e instanceof NoSuchBranchError) return reply.status(404).send({ detail: e.message })
        throw e
      }
    },
  )

  app.get<{ Params: IdParams; Querystring: VersionsQuery }>(
    '/v1/workspaces/:id/versions',
    async (req) => {
      const branch = req.query.branch ?? 'main'
      const store = await openStore(req.params.id)
      if (!(await store.branches()).includes(branch)) return []
      return versionLog(store, branch)
    },
  )

  app.post<{ Params: IdParams; Body: BranchBody }>(
    '/v1/workspaces/:id/branch',
    async (req, reply) => {
      const { name, fromBranch } = req.body
      const store = await openStore(req.params.id)
      if ((await store.branches()).includes(name)) {
        return reply.status(409).send({ detail: `branch already exists: ${name}` })
      }
      try {
        const version = await createBranch(store, name, fromBranch ?? 'main')
        return await reply.status(201).send({ branch: name, version })
      } catch (e) {
        if (e instanceof Errors.NotFoundError) {
          return reply.status(404).send({ detail: `no such branch: ${fromBranch ?? 'main'}` })
        }
        throw e
      }
    },
  )

  app.get<{ Params: IdParams; Querystring: DiffQuery }>(
    '/v1/workspaces/:id/diff',
    async (req, reply) => {
      const { id } = req.params
      const { a, b } = req.query
      const branch = req.query.branch ?? 'main'
      const store = await openStore(id)
      const needsLive = a === undefined || b === undefined
      if (needsLive && !deps.registry.has(id)) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      try {
        if (a !== undefined && b !== undefined) {
          return await versionDiff(store, await resolveRef(store, a), await resolveRef(store, b))
        }
        const state = await toStateDict(deps.registry.get(id).runner.ws)
        if (a !== undefined) return await diffLiveVsRef(store, state, a)
        return await statusState(store, state, branch)
      } catch (e) {
        if (e instanceof Errors.NotFoundError) {
          return reply.status(404).send({ detail: 'version not found' })
        }
        throw e
      }
    },
  )

  app.post<{ Params: IdParams; Body: CheckoutBody }>(
    '/v1/workspaces/:id/checkout',
    async (req, reply) => {
      const { id } = req.params
      if (!deps.registry.has(id)) return reply.status(404).send({ detail: 'workspace not found' })
      const store = await openStore(id)
      try {
        await checkout(store, deps.registry.get(id).runner.ws, req.body.ref)
      } catch (e) {
        if (e instanceof Errors.NotFoundError) {
          return reply.status(404).send({ detail: `version not found: ${req.body.ref}` })
        }
        throw e
      }
      return await makeDetail(deps.registry.get(id))
    },
  )

  app.post<{ Body: CloneBody }>('/v1/workspaces/clone', async (req, reply) => {
    const { sourceId, at, id, secrets } = req.body
    if (id !== undefined && deps.registry.has(id)) {
      return reply.status(409).send({ detail: `workspace id already exists: ${id}` })
    }
    let ws: Workspace
    if (at !== undefined) {
      const store = await openStore(sourceId)
      try {
        const version = await resolveRef(store, at)
        const { entries, meta } = await readVersion(store, version)
        // A version store holds no `secrets:` block either. The
        // request names the declarations when it has them, which is
        // the only route open once the live source is gone (a
        // restart); otherwise the live workspace supplies them.
        const live = deps.registry.has(sourceId) ? deps.registry.get(sourceId).runner.ws : null
        const declared = secrets ?? (live !== null ? live.declaredSources : undefined)
        ws = await Workspace.fromState(
          toState(entries, meta),
          declared !== undefined ? { secrets: declared } : {},
        )
      } catch (e) {
        if (e instanceof Errors.NotFoundError) {
          return reply.status(404).send({ detail: `version not found: ${at}` })
        }
        if (e instanceof SecretsError || e instanceof z.ZodError) {
          // A declarations override the host cannot resolve, or a
          // block the schema refuses, is a bad request, not a 500.
          // The python twin catches ValueError for the same pair,
          // pydantic's ValidationError being one.
          return reply.status(400).send({ detail: e.message })
        }
        throw e
      }
    } else {
      if (!deps.registry.has(sourceId)) {
        return reply.status(404).send({ detail: 'workspace not found' })
      }
      ws = await cloneWorkspaceWithOverride(deps.registry.get(sourceId).runner.ws, null)
    }
    try {
      const entry = deps.registry.add(ws, id)
      return await reply.status(201).send(await makeDetail(entry))
    } catch (e) {
      return reply.status(409).send({ detail: (e as Error).message })
    }
  })
}
