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

import { fnmatch } from '../../utils/fnmatch.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { PathSpec } from '../../types.ts'
import type { TreeEntry } from './tree_entry.ts'

export function scopeRelativeKey(path: PathSpec): string {
  const prefix = path.prefix
  let key = path.original
  if (prefix !== '' && key.startsWith(prefix)) {
    key = key.slice(prefix.length) || '/'
  }
  return key
}

export function isRepoRoot(key: string): boolean {
  return key === '' || key === '/'
}

export function countScopeFiles(tree: Record<string, TreeEntry>, key: string): number {
  // tree keys are repo-relative without a leading slash
  if (isRepoRoot(key)) {
    let count = 0
    for (const entry of Object.values(tree)) if (entry.type === 'blob') count += 1
    return count
  }
  const norm = stripSlash(key)
  const prefix = `${norm}/`
  let count = 0
  for (const [p, entry] of Object.entries(tree)) {
    if (entry.type !== 'blob') continue
    if (p === norm || p.startsWith(prefix)) count += 1
  }
  return count
}

export function shouldUseSearch(recursive: boolean, onDefaultBranch: boolean): boolean {
  // Search only helps recursive scans on the default branch (code search only
  // indexes the default branch). Whether a usable literal exists, and whether
  // the scope is large enough to bother, is decided by the caller.
  return recursive && onDefaultBranch
}

export function estimateScope(
  tree: Record<string, TreeEntry>,
  directory: string,
  pattern: string,
): { fileCount: number; totalBytes: number } {
  const key = directory
  const prefix = key !== '' ? `${key}/` : ''
  let fileCount = 0
  let totalBytes = 0
  for (const [p, entry] of Object.entries(tree)) {
    if (!p.startsWith(prefix)) continue
    const remainder = p.slice(prefix.length)
    if (entry.type === 'blob' && fnmatch(remainder, pattern)) {
      fileCount += 1
      totalBytes += entry.size ?? 0
    }
  }
  return { fileCount, totalBytes }
}
