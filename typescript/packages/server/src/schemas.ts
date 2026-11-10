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
import { isPlainObject } from '@struktoai/mirage-core/utils/records'
import { parseSystemTime } from '@struktoai/mirage-core/utils/clock'
import type { JsonValue, MountBackend } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { OverrideShape } from './clone.ts'

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
export interface CreateWorkspaceRequest {
  config?: Record<string, unknown> | null
  template?: string
  id?: string
}

/** A request config rejected by its schema, before operator-only runtime checks. */
export class ConfigValidationError extends Error {
  static readonly time = (value: string | null | undefined, ctx: z.RefinementCtx): void => {
    if (value === undefined || value === null) return
    try {
      parseSystemTime(value)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      ctx.addIssue({ code: 'custom', message: error.message })
    }
  }

  static readonly shape = z.looseObject({
    mounts: z.record(z.string(), z.unknown()),
    system_time: z.string().nullable().optional().superRefine(ConfigValidationError.time),
    profile: z.string().nullable().optional(),
    default_session_id: z.string().nullable().optional(),
    workspace_id: z.string().nullable().optional(),
  })
  readonly detail: {
    type: string
    loc: string[]
    msg: string
    input: unknown
    ctx?: Record<string, unknown>
  }[] = []

  constructor(config: unknown, cause: Error) {
    super(cause.message, { cause })
    if (!isPlainObject(config)) {
      this.detail.push({
        type: 'model_attributes_type',
        loc: ['body', 'config'],
        msg: 'Input should be a valid dictionary or object to extract fields from',
        input: config,
      })
      return
    }
    const checked = ConfigValidationError.shape.safeParse(config)
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        const field = issue.path[0]
        if (typeof field !== 'string') throw checked.error
        const input = config[field]
        if (issue.code === 'custom') {
          this.detail.push({
            type: 'value_error',
            loc: ['body', 'config', field],
            msg: `Value error, ${issue.message}`,
            input,
            ctx: { error: {} },
          })
          continue
        }
        if (issue.code !== 'invalid_type') throw checked.error
        this.detail.push({
          type:
            input === undefined
              ? 'missing'
              : issue.expected === 'string'
                ? 'string_type'
                : 'dict_type',
          loc: ['body', 'config', field],
          msg:
            input === undefined
              ? 'Field required'
              : issue.expected === 'string'
                ? 'Input should be a valid string'
                : 'Input should be a valid dictionary',
          input: input === undefined ? config : input,
        })
      }
    }
    // The shared engine checks allowed keys without running field validators.
    for (const [key, value] of Object.entries(config)) {
      try {
        validateDocument('config', { [key]: value }, 'config')
      } catch (error) {
        if (!(error instanceof Error)) throw error
        this.detail.push({
          type: 'extra_forbidden',
          loc: ['body', 'config', key],
          msg: 'Extra inputs are not permitted',
          input: value,
        })
      }
    }
    if (this.detail.length === 0) {
      this.detail.push({
        type: 'value_error',
        loc: ['body', 'config'],
        msg: cause.message,
        input: config,
      })
    }
  }
}

/**
 * A workspace config checked as a create checks one, taken as written: the
 * caller's CLI expanded its `${VAR}` in the caller's env, and the server's
 * env is not a tenant's to read. Throws an Error naming what is wrong.
 */
export function checkConfig(config: unknown): WorkspaceConfigRaw {
  let cfg: WorkspaceConfigRaw
  try {
    if (!isPlainObject(config)) throw new Error('config must be a mapping')
    ConfigValidationError.shape.parse(config)
    cfg = loadWorkspaceConfig(config, null)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    throw new ConfigValidationError(config, error)
  }
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

export interface CreateTemplateRequest {
  name: string
  description?: string | null
  config: Record<string, unknown>
}

export interface TemplateResponse {
  name: string
  description: string | null
  config: Record<string, JsonValue>
}

export interface CloneWorkspaceRequest {
  id?: string
  override?: OverrideShape
}

export const SnapshotWorkspaceRequest = z.object({ key: z.string() }).strict()

export interface LoadWorkspaceRequest {
  key?: string
  id?: string
  override?: OverrideShape
}
