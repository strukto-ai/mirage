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

function token(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

// Docs, Sheets and Slides: rendered to JSON rather than downloaded, and
// carrying no content hash.
export const NATIVE_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'gdrive/gdoc',
  'gdrive/gsheet',
  'gdrive/gslide',
])

// The token a Drive file's stat and read both stamp, chosen by kind. Drive
// gives every file with content an md5 and a head revision. A Doc, Sheet or
// Slides file has neither, so its modified stamp stands in: a weaker token,
// but it errs toward refetching. An absent, empty or non-string field is no
// token, the same on both hosts.
export function driveFingerprint(
  resourceType: string,
  md5: unknown,
  headRevision: unknown,
  modified: unknown,
): string | null {
  if (NATIVE_RESOURCE_TYPES.has(resourceType)) return token(modified)
  return token(md5) ?? token(headRevision)
}
