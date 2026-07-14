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

export type NodeFields = Record<string, string | number>

// Storage seam for the namespace node table. Abstract base. The Namespace
// keeps its node table in memory as the working copy (reads stay
// synchronous on the hot path) and writes every mutation through this
// seam. Subclasses are infra adapters (RAM here, Redis in the node
// package); everything above (symlinks, the attribute overlay, snapshots)
// is storage-agnostic, mirroring the ObserverStore design.
export abstract class NamespaceStore {
  // Read every stored node entry (hydration at first use).
  abstract load(): Promise<Map<string, NodeFields>>
  // Upsert one node entry with its full field set.
  abstract set(path: string, fields: NodeFields): Promise<void>
  // Drop node entries.
  abstract delete(paths: readonly string[]): Promise<void>
  // Overwrite the whole table (snapshot restore).
  abstract replaceAll(entries: Map<string, NodeFields>): Promise<void>
  // Read the stored workspace user (whoami identity); null when never claimed.
  abstract loadUser(): Promise<string | null>
  // Store the workspace user. Workspace-level metadata, not a node entry:
  // replaceAll (snapshot restore of the node table) leaves it alone; only
  // clear drops it.
  abstract setUser(user: string): Promise<void>
  // Delete every stored entry, including the workspace user.
  abstract clear(): Promise<void>
  // Release any held connections or handles.
  abstract close(): Promise<void>
}
