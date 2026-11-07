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

/**
 * A line or job refused because another daemon holds the workspace's
 * lease and runs its processes.
 *
 * For now one daemon runs a workspace at a time. Any other one lists,
 * waits on and signals what runs there through the store; forwarding its
 * lines to the holder comes later. Mirrors Python's `WorkspaceHeldError`.
 */
export class WorkspaceHeldError extends Error {
  /**
   * @param workspaceId the workspace.
   * @param holder the id of the daemon holding its lease.
   */
  constructor(
    readonly workspaceId: string,
    readonly holder: string,
  ) {
    super(`workspace '${workspaceId}' runs on daemon '${holder}'; only that daemon runs its lines`)
    this.name = 'WorkspaceHeldError'
  }
}
