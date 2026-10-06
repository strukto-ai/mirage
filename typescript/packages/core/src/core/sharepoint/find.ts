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

import type { SharePointAccessor } from '../../accessor/sharepoint.ts'
import {
  emitStartPath,
  keep,
  optionsTree,
  startBasename,
  type FindEntry,
  type PredNode,
} from '../../commands/builtin/find_eval.ts'
import { FileType, type PathSpec } from '../../types.ts'
import { isEnoent } from '../../errors/fs.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { DIR_SIZE } from '../../utils/stat_view.ts'
import type { FindOptions } from '../../vfs/base.ts'
import { driveRootEmpty, findItems } from '../msgraph/drive.ts'
import { driveEntries, driveLoc, resolve, siteEntries, type ResolvedPath } from './resolve.ts'
import { stat } from './stat.ts'

async function dirExists(accessor: SharePointAccessor, path: PathSpec): Promise<boolean> {
  try {
    return (await stat(accessor, path)).type === FileType.DIRECTORY
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

function pushNamespaceDir(
  results: string[],
  key: string,
  name: string,
  depth: number,
  isEmpty: boolean | null,
  tree: PredNode,
  options: FindOptions,
): void {
  if (options.maxDepth != null && depth > options.maxDepth) return
  const entry: FindEntry = { key, name, kind: 'd', depth, isEmpty }
  if (!keep(entry, tree, options.minDepth)) return
  if (options.minSize != null && DIR_SIZE < options.minSize) return
  if (options.maxSize != null && DIR_SIZE > options.maxSize) return
  results.push(key)
}

// An unscoped SharePoint mount exposes two synthetic directory levels above
// the document libraries (`/<Site>/<Library>/...`). `readdir` walks them, so
// `find` has to as well: delegating straight to findItems would need a
// driveId the namespace levels do not have, and the whole tree would come
// back empty. Each library subtree is walked with a depth offset so
// -maxdepth/-mindepth count from the real start path.
async function findNamespace(
  accessor: SharePointAccessor,
  path: PathSpec,
  resolved: ResolvedPath,
  options: FindOptions,
): Promise<string[]> {
  const tree = optionsTree(options)
  const base = stripSlash(path.vfsPath)
  const atRoot = resolved.level === 'root'
  const offset = atRoot ? 1 : 0
  const sites: [string, string][] = atRoot
    ? await siteEntries(accessor)
    : [[base, resolved.siteId ?? '']]
  const results: string[] = []
  let startEmpty = sites.length === 0
  for (const [siteName, siteId] of sites) {
    const siteKey = atRoot ? siteName : base
    const wantDrives =
      options.empty === true || options.maxDepth == null || options.maxDepth >= offset + 1
    const drives = wantDrives ? await driveEntries(accessor, siteId) : []
    if (atRoot) {
      pushNamespaceDir(results, `/${siteKey}`, siteName, 1, drives.length === 0, tree, options)
    } else {
      startEmpty = drives.length === 0
    }
    for (const [driveName, driveId] of drives) {
      const driveKey = `${siteKey}/${driveName}`
      const loc = driveLoc(
        accessor.config,
        { level: 'drive', siteId, driveId, itemPath: null },
        driveKey,
      )
      const empty = options.empty === true ? await driveRootEmpty(accessor.config, loc) : null
      pushNamespaceDir(results, `/${driveKey}`, driveName, offset + 1, empty, tree, options)
      if (options.maxDepth != null && options.maxDepth <= offset + 1) continue
      results.push(
        ...(await findItems(
          accessor.config,
          loc,
          driveName,
          () => Promise.resolve(false),
          options,
          { depthOffset: offset + 1, emitStart: false },
        )),
      )
    }
  }
  emitStartPath(results, base === '' ? '/' : `/${base}`, startBasename(path.virtual), {
    kind: 'd',
    isEmpty: options.empty === true ? startEmpty : null,
    exists: true,
    tree,
    maxDepth: options.maxDepth,
    minDepth: options.minDepth,
    minSize: options.minSize,
    maxSize: options.maxSize,
  })
  return results.sort(compareCodePoints)
}

export async function find(
  accessor: SharePointAccessor,
  path: PathSpec,
  options: FindOptions = {},
): Promise<string[]> {
  const resolved = await resolve(accessor, path)
  if (resolved.driveId !== null) {
    return findItems(
      accessor.config,
      driveLoc(accessor.config, resolved, path.vfsPath),
      startBasename(path.virtual),
      () => dirExists(accessor, path),
      options,
    )
  }
  if (resolved.level === 'root' || (resolved.level === 'site' && resolved.siteId !== null)) {
    return findNamespace(accessor, path, resolved, options)
  }
  return []
}
