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
 * Mirage's default content fingerprint from listing metadata.
 *
 * The size always, joined to the backend's native version (ETag/rev, the
 * same value backends put in `FileStat.fingerprint`) when the listing
 * carries one and to the last-modified stamp when it does not.
 *
 * The size rides along with the ETag because a native version is not a
 * sufficient validator on its own: a backend can report current content
 * under an unchanged ETag. Measured on Nextcloud 30 from two directions --
 * with and without a local memcache configured -- a file overwritten from 4
 * bytes to 11 was listed with size=11 and an ETag byte-identical to the one
 * before the write, matching a direct backend stat exactly, so the listing
 * was not stale. Its ETag is derived from an mtime with one-second
 * granularity: unchanged in 6 of 6 rewrites 0s apart, 4 of 6 at 0.3s, 0 of 6
 * at 1.1s. Returning the ETag alone threw away the size that had changed,
 * and the update was lost outright -- intermittently, since whether two
 * writes land in one second is a matter of how fast the machine is.
 *
 * The stamp stays OUT of the ETag branch, and that is not an oversight. A
 * content-addressed version (S3's single-part ETag, Dropbox's content_hash)
 * is deliberately unchanged when a file is rewritten with identical bytes,
 * while the stamp moves: folding it in would report that idempotent rewrite
 * as an UPDATE. It also buys nothing for the case above, because a stamp
 * coarse enough to give two writes one ETag is coarse enough to give them
 * one stamp -- both sides of the probe read the same second. So the stamp
 * serves only as the substitute version for a listing that has none.
 *
 * Note that the checkpoint format changes with the size, so the first pull
 * against a persisted checkpoint written by an earlier version reports every
 * file on an etag-bearing backend as an UPDATE once.
 *
 * Distinct from the file cache's stored fingerprint (`CacheEntry.fingerprint`),
 * which is whatever token the backend returned for the bytes it cached, or
 * null. `None` stands in for an absent size so the string matches python's
 * `stat_fingerprint` byte for byte.
 */
export function statFingerprint(
  etag: string | null,
  modified: string | null,
  size: number | null,
): string {
  const bytes = size === null ? 'None' : String(size)
  if (etag !== null && etag !== '') return `${etag}|${bytes}`
  return `${modified ?? ''}|${bytes}`
}
