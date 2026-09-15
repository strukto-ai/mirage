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
 * Composite of all three inputs, so a change in any one of them moves the
 * fingerprint. The backend's native version (ETag/rev, the same value
 * backends put in `FileStat.fingerprint`) is not a sufficient validator on
 * its own: a backend can report current content under an unchanged ETag.
 * Measured on Nextcloud, twice and with no local memcache configured -- a
 * file overwritten from 4 bytes to 11 was listed with size=11 and an ETag
 * byte-identical to the one before the write, and the listing matched a
 * direct backend stat exactly, so it was not stale. Returning the ETag alone
 * therefore lost the update outright; folding `modified` and `size` in
 * alongside it means a lazy validator costs nothing rather than hiding a
 * write.
 *
 * Note that the checkpoint format changes with this composite, so the first
 * pull against a persisted checkpoint written by an earlier version reports
 * every file as an UPDATE once.
 *
 * Distinct from `cache/file/utils`'s `defaultFingerprintAsync`, which hashes
 * the content bytes themselves. `None` stands in for an absent size so the
 * string matches python's `stat_fingerprint` byte for byte.
 */
export function statFingerprint(
  etag: string | null,
  modified: string | null,
  size: number | null,
): string {
  return `${etag ?? ''}|${modified ?? ''}|${size === null ? 'None' : String(size)}`
}
