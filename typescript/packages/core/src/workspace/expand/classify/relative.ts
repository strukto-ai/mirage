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

import { PathSpec } from '../../../types.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import { posixNormpath } from '../../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'

export const GLOB_CHARS: readonly string[] = ['*', '?', '[']

/**
 * Build the PathSpec for a word typed relative to cwd.
 *
 * The typed word and the cwd it was typed under are two halves of one
 * path: `virtual` resolves the pair to an absolute path, `rawPath`
 * keeps the typed spelling for display. Glob chars in the word make a
 * pattern spec (unresolved); words whose resolved path has no mount
 * stay plain text.
 */
export function relativeSpec(
  word: string,
  registry: MountRegistry,
  cwd: string,
): string | PathSpec {
  const path = posixNormpath(`${rstripSlash(cwd)}/${word}`)
  if (registry.mountFor(path) === null) return word
  const lastSlash = path.lastIndexOf('/')
  if (GLOB_CHARS.some((ch) => word.includes(ch))) {
    return new PathSpec({
      resourcePath: stripSlash(path),
      virtual: path,
      directory: path.slice(0, lastSlash + 1),
      pattern: path.slice(lastSlash + 1),
      resolved: false,
      rawPath: word,
    })
  }
  return new PathSpec({
    resourcePath: stripSlash(path),
    virtual: path,
    directory: path.slice(0, lastSlash + 1),
    resolved: true,
    rawPath: word,
  })
}
