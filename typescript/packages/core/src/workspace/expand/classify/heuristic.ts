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
import { extglobActive } from '../../../context/session_context.ts'
import { patternShape } from '../../../utils/fnmatch.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import { dottedSpelling, posixNormpath } from '../../../utils/path.ts'
import { stripSlash } from '../../../utils/slash.ts'
import { hasGlob, unmarkGlobs } from '../../../utils/glob_walk.ts'
import { relativeSpec } from './relative.ts'

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
  // Whether the word globs is read off the marks, but whether it looks
  // like a path at all is a question about the name itself, so the shape
  // tests below read the literal spelling.
  const wordHasGlob = hasGlob(word)
  const shape = wordHasGlob && extglobActive() ? patternShape(word) : unmarkGlobs(word)

  if (word.startsWith('/')) {
    // A quoted character names the mount literally (`'/team+'/*`).
    const mount = registry.tryMountFor(unmarkGlobs(word))
    if (mount === null) return word
    let isDir = word.endsWith('/')
    const path = posixNormpath(word)
    if (!isDir && `${unmarkGlobs(path)}/` === mount.prefix) {
      isDir = true
    }
    // `rawPath` keeps the spelling as typed, the way relativeSpec does:
    // `virtual` has already lost any `..`, and `cd -P` has to resolve the
    // link a `..` follows before applying it. `dotted` keeps it for the
    // walk that proves each `..` a directory, and a pattern's for the head
    // its listing walks.
    if (wordHasGlob) {
      const lastSlash = path.lastIndexOf('/')
      return new PathSpec({
        vfsPath: stripSlash(path),
        virtual: path,
        directory: path.slice(0, lastSlash + 1),
        pattern: path.slice(lastSlash + 1),
        rawPath: word,
        resolved: false,
        dotted: dottedSpelling(word),
      })
    }
    if (isDir) {
      return new PathSpec({
        vfsPath: stripSlash(path),
        virtual: path,
        directory: `${path}/`,
        rawPath: word,
        resolved: false,
        dotted: dottedSpelling(word),
      })
    }
    const lastSlash = path.lastIndexOf('/')
    return new PathSpec({
      vfsPath: stripSlash(path),
      virtual: path,
      directory: path.slice(0, lastSlash + 1),
      rawPath: word,
      resolved: true,
      dotted: dottedSpelling(word),
    })
  }

  // Relative glob: a pattern under cwd, a bare `*`, `?` or `[a-z]`
  // included, because bash expands every unquoted glob word (`echo *`
  // lists the directory, and `expr 4 * 3` is the classic mistake). A
  // quoted glob arrives with no marks and stays text. A word carrying
  // shell syntax beside the glob (`x=*`) is an argument, not a path.
  if (wordHasGlob && (word.includes('/') || !shape.startsWith('.'))) {
    if (NON_PATH_CHAR.test(shape)) return word
    return relativeSpec(word, registry, cwd)
  }

  if (!wordHasGlob && word.includes('/') && RELATIVE_PATH.test(shape)) {
    return relativeSpec(word, registry, cwd)
  }

  return word
}
