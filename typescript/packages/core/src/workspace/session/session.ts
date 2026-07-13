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

import type { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import type { MountMode } from '../../types.ts'

export interface SessionInit {
  sessionId: string
  cwd?: string
  env?: Record<string, string>
  createdAt?: number
  functions?: Record<string, unknown>
  lastExitCode?: number
  positionalArgs?: string[]
  shellOptions?: Record<string, boolean>
  readonlyVars?: Set<string>
  arrays?: Record<string, string[]>
  /**
   * Per-mount mode caps for this session. `null` (the default) means
   * no restriction: every mount in the workspace is reachable at its own
   * mode. When provided, a mount absent from the map is invisible
   * (dispatch / handle_command / Ops reject it with a capability error)
   * and a present mount is narrowed to the weaker of its own mode and
   * the session's mode. The workspace always implicitly grants its own
   * infrastructure mounts (implicit scratch root, observer, /dev).
   */
  mountModes?: ReadonlyMap<string, MountMode> | null
  pipelineTimeoutSeconds?: number | null
}

export class Session {
  readonly sessionId: string
  cwd: string
  env: Record<string, string>
  readonly createdAt: number
  functions: Record<string, unknown>
  lastExitCode: number
  positionalArgs: string[]
  shellOptions: Record<string, boolean>
  readonlyVars: Set<string>
  arrays: Record<string, string[]>
  stdinBuffer: AsyncLineIterator | null = null
  localVars: Map<string, string | null> | null = null
  readonly mountModes: ReadonlyMap<string, MountMode> | null
  pipelineTimeoutSeconds: number | null

  constructor(init: SessionInit) {
    this.sessionId = init.sessionId
    this.cwd = init.cwd ?? '/'
    this.env = init.env ?? {}
    this.createdAt = init.createdAt ?? Date.now() / 1000
    this.functions = init.functions ?? {}
    this.lastExitCode = init.lastExitCode ?? 0
    this.positionalArgs = init.positionalArgs ?? []
    this.shellOptions = init.shellOptions ?? {}
    this.readonlyVars = init.readonlyVars ?? new Set()
    this.arrays = init.arrays ?? {}
    this.mountModes = init.mountModes ?? null
    this.pipelineTimeoutSeconds = init.pipelineTimeoutSeconds ?? null
  }

  /**
   * Return a copy of this session with `overrides` applied. Mutable
   * containers (env, functions, readonlyVars, arrays, positionalArgs)
   * are shallow-copied so mutations on the fork do not leak back into
   * the source. Every field — including capability fields like
   * `mountModes` — is propagated, so callers cannot accidentally
   * forget one when adding new fields.
   */
  fork(overrides: Partial<SessionInit> = {}): Session {
    return new Session({
      sessionId: overrides.sessionId ?? this.sessionId,
      cwd: overrides.cwd ?? this.cwd,
      env: overrides.env ?? { ...this.env },
      createdAt: overrides.createdAt ?? this.createdAt,
      functions: overrides.functions ?? { ...this.functions },
      lastExitCode: overrides.lastExitCode ?? this.lastExitCode,
      positionalArgs: overrides.positionalArgs ?? [...this.positionalArgs],
      shellOptions: overrides.shellOptions ?? { ...this.shellOptions },
      readonlyVars: overrides.readonlyVars ?? new Set(this.readonlyVars),
      arrays:
        overrides.arrays ??
        Object.fromEntries(Object.entries(this.arrays).map(([k, v]) => [k, [...v]])),
      mountModes: overrides.mountModes ?? this.mountModes,
      pipelineTimeoutSeconds: overrides.pipelineTimeoutSeconds ?? this.pipelineTimeoutSeconds,
    })
  }

  toJSON(): Record<string, unknown> {
    const data: Record<string, unknown> = {
      sessionId: this.sessionId,
      cwd: this.cwd,
      env: this.env,
      createdAt: this.createdAt,
    }
    if (this.mountModes !== null) {
      data.mountModes = Object.fromEntries(this.mountModes)
    }
    return data
  }

  static fromJSON(data: {
    sessionId: string
    cwd?: string
    env?: Record<string, string>
    createdAt?: number
    mountModes?: Record<string, MountMode> | null
  }): Session {
    const { mountModes, ...rest } = data
    return new Session({
      ...rest,
      mountModes: mountModes != null ? new Map(Object.entries(mountModes)) : null,
    })
  }
}
