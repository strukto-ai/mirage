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
import { stripSlash } from '../../../utils/slash.ts'
import { hasGlob } from '../../../utils/glob_walk.ts'
import { relativeSpec } from './relative.ts'

const FILENAME_CHAR = /[a-zA-Z0-9_./]/
const NON_PATH_CHAR = /[(){}=;|&<> ]/
const RELATIVE_PATH = /^(?:\.?[a-zA-Z0-9_-]*\/)*[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/

// Every caller hands this an already-expanded word, so quote removal has
// happened and a surviving backslash is a literal character of the name
// (GNU reads a file named `a\b` as `cat '/data/a\b'`). Unescaping again
// here corrupted both that name and any control character an escape had
// produced.
export function classifyWord(
  word: string,
  registry: MountRegistry,
  cwd: string,
): string | PathSpec {
  const wordHasGlob = hasGlob(word)

  if (word.startsWith('/')) {
    const mount = registry.mountFor(word)
    if (mount === null) return word
    let isDir = word.endsWith('/')
    const path = posixNormpath(word)
    if (!isDir && `${path}/` === mount.prefix) {
      isDir = true
    }
    // `rawPath` keeps the spelling as typed, the way relativeSpec does:
    // `virtual` has already lost any `..`, and `cd -P` has to resolve the
    // link a `..` follows before applying it.
    if (wordHasGlob) {
      const lastSlash = path.lastIndexOf('/')
      return new PathSpec({
        resourcePath: stripSlash(path),
        virtual: path,
        directory: path.slice(0, lastSlash + 1),
        pattern: path.slice(lastSlash + 1),
        rawPath: word,
        resolved: false,
      })
    }
    if (isDir) {
      return new PathSpec({
        resourcePath: stripSlash(path),
        virtual: path,
        directory: `${path}/`,
        rawPath: word,
        resolved: false,
      })
    }
    const lastSlash = path.lastIndexOf('/')
    return new PathSpec({
      resourcePath: stripSlash(path),
      virtual: path,
      directory: path.slice(0, lastSlash + 1),
      rawPath: word,
      resolved: true,
    })
  }

  if (wordHasGlob && (word.includes('/') || !word.startsWith('.'))) {
    if (!FILENAME_CHAR.test(word) || NON_PATH_CHAR.test(word)) {
      return word
    }
    return relativeSpec(word, registry, cwd)
  }

  if (!wordHasGlob && word.includes('/') && RELATIVE_PATH.test(word)) {
    return relativeSpec(word, registry, cwd)
  }

  return word
}
