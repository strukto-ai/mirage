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

import { fnmatch } from './fnmatch.ts'
import { rstripSlash, stripSlash } from './slash.ts'

export function norm(path: string): string {
  return `/${stripSlash(path)}`
}

// Whether a glob pattern matches `path` or one of its ancestors.
// Segment-wise fnmatch, so `*` does not cross `/` (shell glob semantics,
// not fnmatch's flat matching). An ancestor match covers entries living
// under a matched directory.
export function globPrefixMatch(path: string, pattern: string): boolean {
  const patSegs = stripSlash(pattern).split('/')
  const pathSegs = stripSlash(path).split('/')
  if (pathSegs.length < patSegs.length) return false
  return patSegs.every((pat, i) => fnmatch(pathSegs[i] ?? '', pat))
}

// Resolve a relative path against cwd; absolute paths are only
// normalized. Mirrors the Python utils resolve_path.
export function resolvePath(path: string, cwd: string): string {
  if (path.startsWith('/')) return posixNormpath(path)
  return posixNormpath(`${rstripSlash(cwd)}/${path}`)
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

const DOTS = new Set(['.', '..'])

/**
 * The absolute spelling of a typed path whose dots a walk proves.
 *
 * The kernel resolves `.` and `..` against the directory they sit in, so
 * every component in front of one has to be a directory, while the textual
 * simplification a virtual path gets lets `nope/../f` reach `f` past a
 * missing `nope`. This keeps the spelling a walk needs. A trailing slash is
 * kept too, since `x/` resolves as `x/.` and so names a directory. Null when
 * neither follows a named component: a leading climb (`../x`) only walks up
 * from `base`, a directory already, so the common `cd ..` and `cat ../f`
 * cost nothing. Mirrors Python's dotted_spelling.
 */
export function dottedSpelling(word: string, base = '/'): string | null {
  const parts = word.split('/').filter((part) => part !== '')
  let lead = 0
  while (lead < parts.length && DOTS.has(parts[lead] ?? '')) lead += 1
  const rest = parts.slice(lead)
  const slashed = rest.length > 0 && word.endsWith('/') && !DOTS.has(rest[rest.length - 1] ?? '')
  if (!slashed && !rest.some((part) => DOTS.has(part))) return null
  const start = resolvePath(
    parts.slice(0, lead).join('/') || '.',
    word.startsWith('/') ? '/' : base,
  )
  return `${rstripSlash(start)}/${rest.join('/')}${slashed ? '/' : ''}`
}

/**
 * The directories a walk of `dotted` has to find, in walk order.
 *
 * Whatever stands in front of a `.` or `..` is where it resolves, so it has
 * to be a directory; each is spelled as the walk has simplified it so far,
 * and the root, always one, is left out. Mirrors Python's dot_prefixes.
 */
export function dotPrefixes(
  dotted: string,
  follow: ((path: string) => string) | null = null,
): string[] {
  let current = '/'
  const found: string[] = []
  for (const part of dotted.split('/').filter((p) => p !== '')) {
    if (DOTS.has(part)) {
      if (follow !== null) current = follow(current)
      if (current !== '/' && !found.includes(current)) found.push(current)
      if (part === '..') current = parent(current)
      continue
    }
    current = `${rstripSlash(current)}/${part}`
  }
  return found
}

/**
 * The names a walk of `dotted` enters, each with its spelling in `raw`.
 *
 * What `mkdir -p` creates on the way and names when it cannot: GNU makes each
 * component as it reaches it, so `mkdir -p nope/../m` leaves `nope` behind as
 * well as `m`, and a plain file in the way is quoted as the operand spells it
 * (`'a.txt'`, not the absolute path). Only the typed components are entered:
 * the directory a relative word starts from is there already. Mirrors
 * Python's walk_nodes.
 */
export function walkNodes(
  dotted: string,
  raw: string,
  follow: ((path: string) => string) | null = null,
): [string, string][] {
  const typed = raw.split('/').filter((part) => part !== '')
  let lead = 0
  while (lead < typed.length && DOTS.has(typed[lead] ?? '')) lead += 1
  const parts = dotted.split('/').filter((part) => part !== '')
  const start = parts.slice(0, parts.length - (typed.length - lead))
  let current = `/${start.join('/')}`
  const head = raw.startsWith('/') ? '/' : ''
  const entered: [string, string][] = []
  for (let index = lead; index < typed.length - 1; index++) {
    const part = typed[index] ?? ''
    if (DOTS.has(part)) {
      if (follow !== null) {
        try {
          current = follow(current)
        } catch (err) {
          if (!(err instanceof CycleError)) throw err
          return entered
        }
      }
      if (part === '..') current = parent(current)
      continue
    }
    current = `${rstripSlash(current)}/${part}`
    entered.push([current, head + typed.slice(0, index + 1).join('/')])
  }
  return entered
}

export function expandTilde(word: string, home: string | null): string {
  if (home === null) return word
  if (word === '~') return home
  if (word.startsWith('~/')) return rstripSlash(home) + word.slice(1)
  return word
}

// Rewrite the base of walked output paths (find/grep -r results) to the
// as-typed form (`PathSpec.rawPath`); `raw` equal to `virtual` leaves the
// paths unchanged (the absolute-argument case).
export function respellRaw(paths: string[], virtual: string, raw: string): string[] {
  if (raw === virtual) return paths
  return paths.map((p) => respellOne(p, virtual, raw))
}

// The prefix of `path` with `count` trailing segments removed. The ancestor
// counterpart of respellOne: it names a path above another one while keeping the
// original spelling, so a relative argument stays relative. `count` is clamped
// so the result never loses every segment, which would leave an empty string
// where a path belongs. Mirrors Python's drop_trailing_segments.
export function dropTrailingSegments(path: string, count: number): string {
  if (count <= 0) return path
  if (count >= path.split('/').filter((part) => part !== '').length) return path
  let head = rstripSlash(path)
  for (let i = 0; i < count; i++) head = rstripSlash(head.slice(0, head.lastIndexOf('/')))
  return head === '' ? '/' : head
}

export function respellOne(path: string, virtual: string, raw: string): string {
  if (raw === virtual) return path
  const base = rstripSlash(virtual)
  if (path === base || (base === '' && path === '/')) return raw === '' ? '.' : raw
  if (path.startsWith(base + '/')) {
    // The empty raw is the synthetic no-operand spelling (GNU grep -r
    // with no path): results render as bare names relative to the base.
    if (raw === '') return path.slice(base.length + 1)
    return rstripSlash(raw) + path.slice(base.length)
  }
  return path
}

export function parent(path: string): string {
  const i = path.lastIndexOf('/')
  if (i <= 0) return '/'
  return path.slice(0, i)
}

// The proper ancestors of a normalized key, outermost first: "/a/b/c" ->
// ["/a", "/a/b"]; "/a" and "/" -> []. "/" is left out because every store
// treats the mount root as an existing directory, so it is never a component
// worth probing. Used by the store-backed backends (ram, redis) to walk a
// destination's parent chain the way rename(2) resolves it.
export function ancestors(path: string): string[] {
  const parts = stripSlash(path).split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(`/${parts.slice(0, i).join('/')}`)
  return out
}

export const MAX_SYMLINK_HOPS = 40

// Raised when symlink resolution exceeds the maximum hop count. Mirrors POSIX
// ELOOP (a loop such as `a -> b -> a` or an unbounded expansion such as
// `a -> a/x`). Command boundaries render this as the GNU strerror text
// "Too many levels of symbolic links".
export class CycleError extends Error {
  readonly path: string
  // The condition's name in the shared vocabulary (errors/classify.ts
  // keys on codes), so a loop stops degrading to EIO at the kernel and
  // guest boundaries.
  readonly code = 'ELOOP'

  constructor(path: string) {
    super(`too many levels of symbolic links: ${path}`)
    this.name = 'CycleError'
    this.path = path
  }
}

export function resolveSymlinks(path: string, links: Map<string, string>): string {
  const pending = path.split('/').reverse()
  const resolved: string[] = []
  let hops = 0
  while (pending.length > 0) {
    const part = pending.pop() ?? ''
    if (part === '' || part === '.') continue
    if (part === '..') {
      resolved.pop()
      continue
    }
    const candidate = '/' + [...resolved, part].join('/')
    const target = links.get(candidate)
    if (target === undefined) {
      resolved.push(part)
      continue
    }
    if (++hops > MAX_SYMLINK_HOPS) throw new CycleError(path)
    if (target.startsWith('/')) resolved.length = 0
    pending.push(...target.split('/').reverse())
  }
  const suffix = resolved.length > 0 && path.endsWith('/') ? '/' : ''
  return '/' + resolved.join('/') + suffix
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
