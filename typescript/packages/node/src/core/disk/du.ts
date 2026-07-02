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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { PathSpec } from '@struktoai/mirage-core'
import { norm, resolveSafe } from './utils.ts'

async function walkSizes(full: string): Promise<number> {
  let total = 0
  let st
  try {
    st = await stat(full)
  } catch {
    return 0
  }
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  const entries = await readdir(full, { withFileTypes: true })
  for (const e of entries) {
    const child = path.join(full, e.name)
    if (e.isDirectory()) total += await walkSizes(child)
    else if (e.isFile()) {
      try {
        const cst = await stat(child)
        total += cst.size
      } catch {
        // ignore
      }
    }
  }
  return total
}

async function walkAll(
  accessor: DiskAccessor,
  full: string,
  entries: [string, number][],
): Promise<number> {
  let total = 0
  let st
  try {
    st = await stat(full)
  } catch {
    return 0
  }
  if (st.isFile()) {
    const rel = '/' + path.relative(accessor.root, full).split(path.sep).join('/')
    entries.push([rel, st.size])
    return st.size
  }
  if (!st.isDirectory()) return 0
  const children = await readdir(full, { withFileTypes: true })
  for (const e of children) {
    const child = path.join(full, e.name)
    if (e.isDirectory()) {
      total += await walkAll(accessor, child, entries)
    } else if (e.isFile()) {
      try {
        const cst = await stat(child)
        const rel = '/' + path.relative(accessor.root, child).split(path.sep).join('/')
        entries.push([rel, cst.size])
        total += cst.size
      } catch {
        // ignore
      }
    }
  }
  return total
}

export async function du(accessor: DiskAccessor, p: PathSpec): Promise<number> {
  const virtual = p.mountPath
  const full = resolveSafe(accessor.root, virtual)
  return walkSizes(full)
}

export async function duAll(
  accessor: DiskAccessor,
  p: PathSpec,
): Promise<[entries: [string, number][], total: number]> {
  const virtual = norm(p.mountPath)
  const full = resolveSafe(accessor.root, virtual)
  const entries: [string, number][] = []
  const total = await walkAll(accessor, full, entries)
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return [entries, total]
}
