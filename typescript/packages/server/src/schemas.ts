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

import { loadWorkspaceConfig, type WorkspaceConfigRaw } from '@struktoai/mirage-core/config'
import { validateDocument } from '@struktoai/mirage-core/rs/document'
import { parseSystemTime } from '@struktoai/mirage-core/utils/clock'
import type { JsonValue, MountBackend } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'

export interface MountSummary {
  prefix: string
  vfs: string
  mode: string
  description: string
  backend: MountBackend
  mountpoint: string | null
}

/** Running while the server holds it in memory; stopped while only its config and state are kept. */
type WorkspaceStatus = 'running' | 'stopped'

export interface WorkspaceBrief {
  id: string
  status: WorkspaceStatus
  created_at: number
}

export interface SessionSummary {
  session_id: string
  cwd: string
}

export interface WorkspaceInternals {
  cache_bytes: number | null
  cache_entries: number | null
  history_length: number
  in_flight_jobs: number
}

export interface WorkspaceDetail {
  id: string
  status: WorkspaceStatus
  created_at: number
  system_time: string | null
  sessions: SessionSummary[]
  mounts: MountSummary[]
  internals: WorkspaceInternals | null
}

/** A workspace to create: from `config`, or from the saved `template` of that name, never both. */
export const CreateWorkspaceRequest = z.strictObject({
  config: z.record(z.string(), z.unknown()).nullish(),
  template: z.string().nullish(),
  id: z.string().nullish(),
})

export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>

/**
 * A workspace config checked as a create checks one, taken as written: the
 * caller's CLI expanded its `${VAR}` in the caller's env, and the server's
 * env is not a tenant's to read. A field the schema refuses throws a
 * `ZodError` placed from the config's root, the declared fields first and
 * then the first unknown key; any other refusal throws an Error naming what
 * is wrong. Mirrors Python's `check_config`.
 */
export function checkConfig(config: unknown): WorkspaceConfigRaw {
  const time = (value: string | null | undefined, ctx: z.RefinementCtx): void => {
    if (value === undefined || value === null) return
    try {
      parseSystemTime(value)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      ctx.addIssue({ code: 'custom', message: error.message })
    }
  }
  const shape = z.looseObject({
    mounts: z.record(z.string(), z.unknown()),
    system_time: z.string().nullable().optional().superRefine(time),
    profile: z.string().nullable().optional(),
    default_session_id: z.string().nullable().optional(),
    workspace_id: z.string().nullable().optional(),
  })
  const fields = shape.parse(config)
  for (const [key, value] of Object.entries(fields)) {
    try {
      validateDocument('config', { [key]: value }, 'config')
    } catch (error) {
      if (!(error instanceof Error)) throw error
      throw new z.ZodError([
        { code: 'unrecognized_keys', keys: [key], path: [], message: error.message },
      ])
    }
  }
  const cfg = loadWorkspaceConfig(fields, null)
  for (const entry of cfg.runtimes ?? []) {
    if (typeof entry === 'string') continue
    const runtimeConfig = entry.config
    if (
      runtimeConfig !== null &&
      typeof runtimeConfig === 'object' &&
      Object.hasOwn(runtimeConfig, 'initModule')
    ) {
      throw new Error('runtime initModule is only allowed in operator-owned configuration')
    }
  }
  return cfg
}

/** A template to save: its name, an optional description and a whole workspace config. */
export const CreateTemplateRequest = z.strictObject({
  name: z.string(),
  description: z.string().nullish(),
  config: z.record(z.string(), z.unknown()),
})

export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequest>

export interface TemplateResponse {
  name: string
  description: string | null
  config: Record<string, JsonValue>
}

/** A clone of a workspace: its new id, and an override of the source's config. */
export const CloneWorkspaceRequest = z.strictObject({
  id: z.string().nullish(),
  override: z.record(z.string(), z.unknown()).nullish(),
})

export type CloneWorkspaceRequest = z.infer<typeof CloneWorkspaceRequest>

export const SnapshotWorkspaceRequest = z.object({ key: z.string() }).strict()

/** A snapshot to load: a key in the snapshot store or an upload, its id and an override. */
export const LoadWorkspaceRequest = z.strictObject({
  key: z.string().nullish(),
  id: z.string().nullish(),
  override: z.record(z.string(), z.unknown()).nullish(),
})

export type LoadWorkspaceRequest = z.infer<typeof LoadWorkspaceRequest>
