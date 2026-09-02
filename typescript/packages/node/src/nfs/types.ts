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
 * One entry's attributes, as the server layer needs them.
 *
 * Enough to build an fattr3 and nothing more. `size` already counts
 * writes the adapter has buffered but not yet stored, because the
 * client was told those writes succeeded.
 */
export interface NFSAttrs {
  /** The id this entry is addressed by. */
  fileid: number
  /** Byte length a client should see; 0 for a directory. */
  size: number
  isDir: boolean
  isSymlink: boolean
  /** Permission bits when the namespace holds an overlay, else undefined. */
  mode?: number
  /** Modification time in epoch seconds, when known. */
  mtimeEpoch?: number
}

/**
 * One listing entry. `cookie` is the entry's fileid: the server crate
 * derives the wire cookie from it and hands it back as `startAfter`.
 */
export interface DirEntry {
  name: string
  fileid: number
  cookie: number
  attrs: NFSAttrs
}
