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

import type { FileStat } from '../types.ts'

export type StatOverlay = (path: string, stat: FileStat) => FileStat

// Stat one virtual path through the workspace rather than one backend, so
// a path under another mount still answers; null when nothing is there.
// What a traversal command asks about its own start point, which decides
// whether a walk is possible at all.
export type StatPath = (path: string) => Promise<FileStat | null>

// The mount prefix serving a virtual path. A mount boundary is a filesystem
// boundary, which is where git stops looking for a repository
// (GIT_DISCOVERY_ACROSS_FILESYSTEM); crossing it would probe an unrelated
// backend.
export type MountRoot = (path: string) => string

// The symlink facts a command may consult, as one injected object.
//
// Symlinks live in the workspace namespace and no backend can see them,
// so a command that must report them has to be handed the facts from
// above. Bundling them means a command that grows a new symlink need
// does not also grow a new property on every call site between here and
// the generic; it reads another field off the view it already receives.
//
// Unlike python, no gating is needed: a command that does not read
// `links` off its context simply ignores the property.
export interface LinkView {
  // lstat one path (a link operand: `ls -l link`, `stat link`).
  statAt(path: string): FileStat | null
  // One directory level (a listing: `ls`, `ls -R` per group).
  children(directory: string): FileStat[]
  // The whole subtree (a walker: `find`, `du`).
  subtree(directory: string): [string, FileStat][]
  // Where a path really points, for deciding whether a link is broken.
  resolve(path: string): string
  // Whether anything is actually there, resolved through the workspace
  // rather than one backend, so a link across mounts answers correctly.
  exists(path: string): Promise<boolean>
  // What a link points at (`-L` reports the target's identity, not the
  // link's), null when it dangles or loops. Resolved through the
  // workspace too, for the same reason.
  targetStat(path: string): Promise<FileStat | null>
}
