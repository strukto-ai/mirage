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

/**
 * The workspace's built-in command engine as a routing marker.
 *
 * It captures nothing and serves every command no other runtime captures
 * (cat, ls, echo, and anything unknown): it is the catch-all. Every
 * workspace world contains exactly one, appended when its machines are
 * wired; it is never a machine entry, and a session's `commands.allow` is
 * what narrows the commands it serves.
 *
 * It is a pure routing marker, so it carries no capability mixin: a
 * line resolved to workspace runs on the workspace executor inline, the path
 * the line takes anyway, so there is no interpreter entry point (run) and no
 * delegate entry point (runLine) to implement.
 */
export class WorkspaceRuntime extends Runtime {
  readonly name = 'workspace'
  // A workspace-routed line runs on the workspace executor itself: it IS the
  // gate, so there is no entry point around it.
  override readonly reach = 'workspace'

  constructor() {
    super({}, [])
  }
}
