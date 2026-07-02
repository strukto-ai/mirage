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

import { lstripSlash, rstripSlash, stripSlash } from '../utils/slash.ts'

/** Normalize a key prefix: empty/undefined → '', strip leading /, ensure trailing /. */
export function normalize(raw: string | undefined): string {
  if (raw === undefined || raw === '') return ''
  const stripped = lstripSlash(raw)
  return stripped.endsWith('/') ? stripped : `${stripped}/`
}

/** Prepend a normalized prefix to a virtual path. */
export function apply(prefix: string, path: string): string {
  return prefix + lstripSlash(path)
}

/** Same as apply() but guarantees a trailing slash for LIST-style ops. */
export function applyDir(prefix: string, path: string): string {
  const key = apply(prefix, path)
  if (key === '' || key.endsWith('/')) return key
  return `${key}/`
}

/** Strip a normalized prefix from a backend-returned key. */
export function strip(prefix: string, key: string): string {
  if (prefix !== '' && key.startsWith(prefix)) return key.slice(prefix.length)
  return key
}

/**
 * Remove a mount prefix from a virtual path at a path boundary.
 *
 * A sibling that only shares the prefix as a string (`/database` vs a
 * `/data` prefix) is left untouched.
 *
 * Example:
 *   stripMount('/data/sub/x.txt', '/data')  -> '/sub/x.txt'
 *   stripMount('/database/x.txt', '/data')  -> '/database/x.txt'
 *   stripMount('/data', '/data')            -> '/'
 *   stripMount('/x.txt', '')                -> '/x.txt'
 */
export function stripMount(virtual: string, prefix: string): string {
  if (prefix !== '' && virtual.startsWith(prefix)) {
    const rest = virtual.slice(prefix.length)
    if (prefix.endsWith('/') || rest === '' || rest.startsWith('/')) {
      return rest === '' ? '/' : rest
    }
  }
  return virtual
}

/**
 * Backend key for a virtual path under a mount prefix.
 *
 * Example:
 *   mountKey('/data/sub/x.txt', '/data')  -> 'sub/x.txt'
 *   mountKey('/data', '/data')            -> ''
 *   mountKey('/x.txt', '')                -> 'x.txt'
 */
export function mountKey(virtual: string, prefix: string): string {
  return stripSlash(stripMount(virtual, prefix))
}

/**
 * Backend key for a child virtual path, derived from its parent.
 *
 * A child shares the parent's mount prefix, so its key is the child
 * virtual path with the same prefix removed. The prefix length is
 * recovered from the parent's `virtual`/`resourcePath` pair, so no mount
 * context is needed.
 *
 * Example:
 *   rekey('/data/sub', 'sub', '/data/sub/x.txt')  -> 'sub/x.txt'
 *   rekey('/data', '', '/data/x.txt')             -> 'x.txt'
 */
export function rekey(parentVirtual: string, parentResourcePath: string, child: string): string {
  const prefixLen = rstripSlash(parentVirtual).length - parentResourcePath.length
  return stripSlash(child.slice(prefixLen))
}

/**
 * Recover a mount prefix from a virtual path and its backend key.
 *
 * The inverse of stamping: given a path's virtual form and the key the
 * mount stamped, return the mount prefix that was stripped off.
 *
 * Example:
 *   mountPrefixOf('/data/sub', 'sub')  -> '/data'
 *   mountPrefixOf('/data', '')         -> '/data'
 *   mountPrefixOf('/x.txt', 'x.txt')   -> ''
 */
export function mountPrefixOf(virtual: string, resourcePath: string): string {
  const prefixLen = rstripSlash(virtual).length - resourcePath.length
  return rstripSlash(virtual.slice(0, prefixLen))
}
