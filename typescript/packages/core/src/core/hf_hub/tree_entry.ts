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
 * One row of a Hub repository tree.
 *
 * `path` is repo-relative with no leading slash. A subtree listing
 * reports full repo-relative paths too, not paths relative to the
 * subtree, which is what lets a keyPrefix mount fetch only its own
 * subtree and strip the prefix.
 *
 * `size` is the *content* length. For an LFS file this is the real size,
 * never the 135-byte pointer; reporting the pointer would make wc -c and
 * ls -l lie and risk truncated copies over FUSE.
 *
 * `oid` is the git object sha. Content-addressed, so it is the strongest
 * fingerprint available and identical bytes carry an identical oid.
 */
export interface TreeEntry {
  path: string
  type: string
  oid: string
  size?: number | undefined
  /** The date of the commit that last touched the path, when the listing
   * was expanded; '' otherwise. */
  lastModified: string
  lastCommit: string
  /** The LFS sha256, '' for a regular git blob. */
  lfsOid: string
  /** The Xet content hash, '' when the file is not Xet-backed. */
  xetHash: string
}

export function isDirEntry(entry: TreeEntry): boolean {
  return entry.type === 'directory'
}
