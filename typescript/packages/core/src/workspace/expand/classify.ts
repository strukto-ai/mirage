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

import { OperandKind } from '../../commands/spec/types.ts'
import { PathSpec } from '../../types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'

const FILENAME_CHAR = /[a-zA-Z0-9_./]/
const NON_PATH_CHAR = /[(){}=;|&<> ]/
const RELATIVE_PATH = /^(?:\.?[a-zA-Z0-9_-]*\/)*[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/

const GLOB_CHARS: readonly string[] = ['*', '?', '[']

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
    const path = posixNormpath(`${rstripSlash(cwd)}/${word}`)
    const mount = registry.mountFor(path)
    if (mount === null) return word
    const lastSlash = path.lastIndexOf('/')
    return new PathSpec({
      resourcePath: stripSlash(path),
      virtual: path,
      directory: path.slice(0, lastSlash + 1),
      pattern: path.slice(lastSlash + 1),
      resolved: false,
      rawPath: word,
    })
  }

  if (!hasGlob && word.includes('/') && RELATIVE_PATH.test(word)) {
    let w = word
    if (w.includes('\\')) w = unescapePath(w)
    const path = posixNormpath(`${rstripSlash(cwd)}/${w}`)
    if (registry.mountFor(path) === null) return word
    return new PathSpec({
      resourcePath: stripSlash(path),
      virtual: path,
      directory: path.slice(0, path.lastIndexOf('/') + 1),
      resolved: true,
      rawPath: w,
    })
  }

  return word
}

export function classifyBarePath(
  word: string,
  registry: MountRegistry,
  cwd: string,
): string | PathSpec {
  const classified = classifyWord(word, registry, cwd)
  if (typeof classified !== 'string') return classified
  const path = posixNormpath(`${rstripSlash(cwd)}/${word}`)
  if (registry.mountFor(path) === null) return word
  const hasGlob = GLOB_CHARS.some((ch) => word.includes(ch))
  if (hasGlob) {
    const lastSlash = path.lastIndexOf('/')
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
    directory: path.slice(0, path.lastIndexOf('/') + 1),
    resolved: true,
    rawPath: word,
  })
}

export function classifyParts(
  parts: string[],
  registry: MountRegistry,
  cwd: string,
  wordKinds: readonly (OperandKind | null)[] | null = null,
): (string | PathSpec)[] {
  if (parts.length === 0) return []
  const result: (string | PathSpec)[] = [parts[0] ?? '']
  for (let i = 1; i < parts.length; i++) {
    const w = parts[i]
    if (w === undefined) continue
    const kind = wordKinds !== null ? (wordKinds[i - 1] ?? null) : null
    if (kind === OperandKind.TEXT) {
      result.push(w)
    } else if (kind === OperandKind.PATH) {
      result.push(classifyBarePath(w, registry, cwd))
    } else {
      result.push(classifyWord(w, registry, cwd))
    }
  }
  return result
}

export function posixNormpath(path: string): string {
  if (path === '') return '.'
  const isAbs = path.startsWith('/')
  const parts = path.split('/').filter((p) => p !== '' && p !== '.')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop()
      } else if (!isAbs) {
        stack.push('..')
      }
    } else {
      stack.push(part)
    }
  }
  const joined = stack.join('/')
  if (isAbs) return `/${joined}`
  return joined === '' ? '.' : joined
}

export function shlexSplit(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let inSingle = false
  let inDouble = false
  let i = 0
  while (i < input.length) {
    const c = input[i]
    if (c === undefined) break
    if (inSingle) {
      if (c === "'") {
        inSingle = false
      } else {
        cur += c
      }
      i++
      continue
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false
      } else if (c === '\\' && i + 1 < input.length) {
        const next = input[i + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          cur += next
          i += 2
          continue
        }
        cur += c
      } else {
        cur += c
      }
      i++
      continue
    }
    if (c === "'") {
      inSingle = true
    } else if (c === '"') {
      inDouble = true
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[i + 1] ?? ''
      i += 2
      continue
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (cur !== '') {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += c
    }
    i++
  }
  if (inSingle || inDouble) {
    throw new Error(`unterminated quote in: ${input}`)
  }
  if (cur !== '') out.push(cur)
  return out
}
