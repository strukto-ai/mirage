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

import { Glob, globMatcher } from '../rs/glob.ts'

export const QUOTED_CHARS: Readonly<Record<string, string>> = Object.fromEntries(
  ['*', '?', '[', '@', '+', '!', '(', ')', '|'].map((ch, i) => [
    String.fromCharCode(0xfdd0 + i),
    ch,
  ]),
)
export const EXTGLOB_RE = /[@?*+!]\(/

/** Replace extended groups with wildcards for word classification. */
export function patternShape(pattern: string): string {
  if (!EXTGLOB_RE.test(pattern)) return pattern
  const glob = new Glob(pattern, true)
  try {
    return glob.shape()
  } finally {
    glob.close()
  }
}

/** Split a pathname around slashes outside extended groups. */
export function patternParts(pattern: string): string[] {
  if (!EXTGLOB_RE.test(pattern)) return pattern.split('/')
  const glob = new Glob(pattern, true)
  try {
    return glob.parts()
  } finally {
    glob.close()
  }
}

/** Match a case-sensitive shell pattern, preserving quoting sentinels. */
export function fnmatch(name: string, pattern: string, extglob = false, period = false): boolean {
  return globMatcher(pattern, extglob, period).matches(name)
}

/** Match Python's fnmatchcase dialect, including literal class carets. */
export function fnmatchcase(name: string, pattern: string): boolean {
  return globMatcher(pattern, false, false, 'python').matches(name)
}
