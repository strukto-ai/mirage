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
 * The one content token a Drive item is named by, read or stat.
 *
 * `readRevalidatable` claims that `io.stat` and the read record stamp the
 * *same kind* of token, and the way to make that structural rather than
 * coincidental is to compute it in one place from one ordered chain that
 * both sides call:
 *
 *     md5Checksum -> headRevisionId -> modifiedTime -> null
 *
 * `md5Checksum` is the real content hash and is present on every ordinary
 * binary file. `headRevisionId` is a second content token that Drive
 * populates only for files with binary content, so it covers the binary
 * file whose md5 Drive withholds -- it is not the native files' token,
 * which is the thing it is easiest to assume.
 *
 * `modifiedTime` is the floor, and for a gdoc, gsheet or gslide it is the
 * only token that exists at all: Drive gives a native file neither of the
 * first two. Ending the chain one step earlier would hand every native
 * file null, which makes the freshness probe answer UNKNOWN and clear the
 * whole mount index on every native read.
 *
 * An empty string is absent, not a value, and the guard below says so
 * explicitly rather than relying on an operator. `IndexEntry.remoteTime`
 * defaults to `''` and `statFromApi` does `item.modifiedTime ?? ''`, so `''`
 * is what actually arrives. Returned, it would escape the
 * `fingerprint === null` checks in the reconcile probe and the drift check,
 * so this host would compare a `''` token and raise a spurious
 * ContentDriftError where the python twin answered None and treated the
 * entry as unverifiable. A `??` chain here would do exactly that, which is
 * why the emptiness test is written out.
 *
 * Each candidate is type-checked rather than merely tested for
 * truthiness: `IndexEntry.extra` is `Record<string, unknown>` and a
 * Redis-restored index can hold whatever was serialized into it.
 *
 * Typed `unknown` rather than `string | null` because two of the three call
 * sites read `IndexEntry.extra`, which is `Record<string, unknown>`; the
 * typeof guard below is the narrowing, and python's twin takes `JsonValue`
 * for the same reason.
 *
 * @param md5 Drive's `md5Checksum`, if the item has one.
 * @param headRevision Drive's `headRevisionId`, if any.
 * @param modified Drive's `modifiedTime`.
 * @returns the first usable token, or null when the item carries none and
 *   the copy is therefore unverifiable.
 */
export function driveFingerprint(
  md5: unknown,
  headRevision: unknown,
  modified: unknown,
): string | null {
  for (const candidate of [md5, headRevision, modified]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return null
}
