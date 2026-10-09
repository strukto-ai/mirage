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

import { Runtime } from './base.ts'
import type { RuntimeOptions } from './config.ts'

/**
 * The workspace's built-in command engine as a routing marker.
 *
 * By default it captures nothing and serves every command no other
 * runtime captures (cat, ls, echo, and anything unknown): it is the
 * catch-all. Passing explicit captures flips it into an ordinary
 * capturer: the workspace serves exactly those commands and anything
 * unclaimed exits 126. Required: every workspace world contains
 * exactly one, appended automatically when the runtimes list omits it;
 * pass your own instance to customize it.
 *
 * It is a pure routing marker, so it carries no capability mixin: a
 * line resolved to workspace runs on the workspace executor inline, the path
 * the line takes anyway, so there is no interpreter door (run) and no
 * delegate door (runLine) to implement.
 *
 * Constructed like every runtime (captures, config, script), with two
 * workspace readings: captures undefined (the default) keeps the catch-all
 * behavior, an empty array serves nothing (full lockdown); and the
 * config has no fields today, the slot exists for uniformity.
 */
export class WorkspaceRuntime extends Runtime {
  readonly name = 'workspace'
  // A workspace-routed line runs on the workspace executor itself: it IS the
  // gate, so there is no door around it.
  override readonly reach = 'workspace'
  // Declaring captures (even empty) turns the catch-all off; the
  // dispatcher reads this bit, not the array's length.
  readonly restricted: boolean

  constructor(options: RuntimeOptions = {}) {
    super(options, [], [])
    this.restricted = options.captures !== undefined
  }
}
