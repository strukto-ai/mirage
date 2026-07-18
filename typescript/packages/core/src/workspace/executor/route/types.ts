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

import type { Runtime } from '../runtime.ts'

/** Parse facts for one command of the line being routed. */
export interface CommandFacts {
  command: string
  words: readonly string[]
  known: boolean
  paths: readonly string[]
}

/** Facts about the line being routed, parse-before-route. */
export interface RouteContext {
  line: string
  commands: readonly CommandFacts[]
  command: string
  known: boolean
  cwd: string
  env: Record<string, string>
  sessionId: string
  agentId: string
  mounts: readonly string[]
}

export type RouteScript = ((ctx: RouteContext) => boolean | Promise<boolean>) | string
export type RouteFn = ((ctx: RouteContext) => string | null | Promise<string | null>) | string

/** The one-line placement decision the dispatcher consults. */
export interface RoutingDecision {
  /** Command -> runtime for this line. */
  bindings: Record<string, Runtime>
  /**
   * Whether unbound commands may run on the vfs executor; false turns
   * them into admission failures.
   */
  vfsAllowed: boolean
  /**
   * Commands captured by some entry; an unbound captured command is an
   * admission failure (its capturers all refused), never a silent
   * fallback.
   */
  captured: ReadonlySet<string>
}
