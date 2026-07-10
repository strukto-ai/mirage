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
import { shlexSplit } from '../../../utils/shlex.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { GLOB_CHARS, relativeSpec } from './relative.ts'

const FILENAME_CHAR = /[a-zA-Z0-9_./]/
const NON_PATH_CHAR = /[(){}=;|&<> ]/
const RELATIVE_PATH = /^(?:\.?[a-zA-Z0-9_-]*\/)*[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/

export function unescapePath(word: string): string {
  if (!word.includes('\\')) return word
  const parts = shlexSplit(word)
  return parts[0] ?? word
}

export function classifyWord(
  word: string,
  registry: MountRegistry,
  cwd: string,
): string | PathSpec {
  const hasGlob = GLOB_CHARS.some((ch) => word.includes(ch))

  if (word.startsWith('/')) {
    let w = word
    if (w.includes('\\')) w = unescapePath(w)
    const mount = registry.mountFor(w)
    if (mount === null) return word
    let isDir = w.endsWith('/')
    const path = posixNormpath(w)
    if (!isDir && `${path}/` === mount.prefix) {
      isDir = true
    }
    if (hasGlob) {
      const lastSlash = path.lastIndexOf('/')
      return new PathSpec({
        resourcePath: stripSlash(path),
        virtual: path,
        directory: path.slice(0, lastSlash + 1),
        pattern: path.slice(lastSlash + 1),
        resolved: false,
      })
    }
    if (isDir) {
      return new PathSpec({
        resourcePath: stripSlash(path),
        virtual: path,
        directory: `${path}/`,
        resolved: false,
      })
    }
    const lastSlash = path.lastIndexOf('/')
    return new PathSpec({
      resourcePath: stripSlash(path),
      virtual: path,
      directory: path.slice(0, lastSlash + 1),
      resolved: true,
    })
  }

  if (hasGlob && (word.includes('/') || !word.startsWith('.'))) {
    if (!FILENAME_CHAR.test(word) || NON_PATH_CHAR.test(word)) {
      return word
    }
    return relativeSpec(word, registry, cwd)
  }

  if (!hasGlob && word.includes('/') && RELATIVE_PATH.test(word)) {
    let w = word
    if (w.includes('\\')) w = unescapePath(w)
    return relativeSpec(w, registry, cwd)
  }

  return word
}
