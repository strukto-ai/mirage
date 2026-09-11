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

import type { CLISpec } from '../../commands/cli/types.ts'
import type { SessionProfile } from '../../policy/profile.ts'
import type { ConsistencyPolicy, MountMode } from '../../types.ts'
import type { Resource } from '../../resource/base.ts'

/**
 * Constructor inputs derived from a state dict. `Workspace.load` uses
 * this to instantiate a fresh Workspace; snapshot code never constructs
 * one itself. Mirrors the Python `MountArgs`.
 */
export interface MountArgs {
  clis?: Record<string, [string | CLISpec, Record<string, unknown> | null]>
  mountArgs: Record<string, [Resource, MountMode]>
  /** The workspace's consistency knob, LAZY for a state that predates the key. */
  consistency: ConsistencyPolicy
  defaultSessionId: string | undefined
  defaultAgentId: string | null
  /** The named profiles the snapshot carried, parsed; absent when it carried none. */
  profiles?: Record<string, SessionProfile>
  /** The default profile's name, null for the implicit `default` or no default at all. */
  profile: string | null
  /**
   * The class names of the coded policies the source registered beyond
   * the built-ins. Informational: code is the loader's to supply, and
   * `Workspace.fromState` warns about a name it does not find registered.
   */
  policies: readonly string[]
}
