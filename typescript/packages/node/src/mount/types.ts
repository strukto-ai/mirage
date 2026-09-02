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
 * One entry's POSIX attributes, as any kernel adapter needs them.
 *
 * Neutral on purpose: nothing here is libfuse's. It was called
 * `FuseAttr` and lived in the fuse package only because that adapter
 * was written first, which is the same accident that had the nfs
 * adapter importing from `fuse/`.
 */
export interface MountAttrs {
  mtime: Date
  atime: Date
  ctime: Date
  nlink: number
  size: number
  mode: number
  uid: number
  gid: number
}

/**
 * One listing entry, described as it is listed.
 *
 * A protocol that lists with attributes (NFSv3's READDIRPLUS, and
 * libfuse's readdir-plus) would otherwise stat every name a second
 * time, once per entry per listing. Carrying the path as well as the
 * name is what lets an adapter address the entry -- mint a file handle
 * for it, cache it -- without rejoining the parent itself and
 * disagreeing with the core about how a name becomes a path.
 */
export interface MountEntry {
  name: string
  path: string
  attrs: MountAttrs
}

/**
 * The attribute change a set-attributes request carries.
 *
 * Only `size` acts. Mode, owner and timestamps are accepted and
 * discarded: a mirage backend has nowhere to persist them, and refusing
 * would fail ordinary tools. Neutral rather than nfs's, because every
 * kernel protocol asks the same narrow question here.
 */
export interface SetAttrs {
  size: number | null
}
