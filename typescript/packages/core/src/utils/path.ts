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

import { rstripSlash, stripSlash } from './slash.ts'

export function norm(path: string): string {
  return `/${stripSlash(path)}`
}

// Mirror of Python's posixpath.normpath: resolves . and .. segments and
// collapses redundant slashes without touching the filesystem.
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

export function expandTilde(word: string, home: string | null): string {
  if (home === null) return word
  if (word === '~') return home
  if (word.startsWith('~/')) return rstripSlash(home) + word.slice(1)
  return word
}

export function rebaseDisplay(paths: string[], virtual: string, display: string | null): string[] {
  if (display === null || display === virtual) return paths
  return paths.map((p) => rebaseOne(p, virtual, display))
}

export function rebaseOne(path: string, virtual: string, display: string | null): string {
  if (display === null || display === virtual) return path
  const base = rstripSlash(virtual)
  if (path === base) return display
  if (path.startsWith(base + '/')) return rstripSlash(display) + path.slice(base.length)
  return path
}

export function parent(path: string): string {
  const i = path.lastIndexOf('/')
  if (i <= 0) return '/'
  return path.slice(0, i)
}

export const MAX_SYMLINK_HOPS = 40

// Raised when symlink resolution exceeds the maximum hop count. Mirrors POSIX
// ELOOP (a loop such as `a -> b -> a` or an unbounded expansion such as
// `a -> a/x`). Command boundaries render this as the GNU strerror text
// "Too many levels of symbolic links".
export class CycleError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`too many levels of symbolic links: ${path}`)
    this.name = 'CycleError'
    this.path = path
  }
}

function isLinkPrefix(key: string, path: string): boolean {
  return path === key || path.startsWith(key + '/')
}

// Follow the symlink table over a whole-path lookup: repeatedly substitute the
// longest link prefix that matches `path` until no link applies, resolving
// relative targets lazily against the link's own parent. Throws CycleError
// once the hop count is exceeded (POSIX ELOOP).
export function resolveSymlinks(path: string, links: Map<string, string>): string {
  if (links.size === 0) return path
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    let best: string | null = null
    let bestTarget = ''
    for (const [key, value] of links) {
      if (isLinkPrefix(key, path) && (best === null || key.length > best.length)) {
        best = key
        bestTarget = value
      }
    }
    if (best === null) return path
    let target = bestTarget
    if (!target.startsWith('/')) {
      target = norm(parent(best) + '/' + target)
    }
    path = target + path.slice(best.length)
  }
  throw new CycleError(path)
}

export function gnuBasename(path: string, suffix?: string): string {
  let i = path.length
  while (i > 0 && path[i - 1] === '/') i--
  if (i === 0) return path.length > 0 ? '/' : ''
  const j = path.lastIndexOf('/', i - 1)
  let base = path.slice(j + 1, i)
  if (suffix !== undefined && suffix !== '' && base !== suffix && base.endsWith(suffix)) {
    base = base.slice(0, base.length - suffix.length)
  }
  return base
}

export function gnuDirname(path: string): string {
  if (path === '') return '.'
  let i = path.length
  while (i > 0 && path[i - 1] === '/') i--
  if (i === 0) return '/'
  let j = path.lastIndexOf('/', i - 1)
  if (j === -1) return '.'
  while (j > 0 && path[j - 1] === '/') j--
  if (j === 0) return '/'
  return path.slice(0, j)
}
