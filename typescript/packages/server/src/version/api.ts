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

import type { Workspace as CoreWorkspace } from '@struktoai/mirage-core'
import { NoSuchBranchError } from './errors.ts'
import {
  blobToMeta,
  CACHE_PREFIX,
  META_PATH,
  metaToBlob,
  toState,
  treeInputsFromState,
  type VersionMeta,
  type WorkspaceStateDict,
} from './stateTree.ts'
import type { DiffResult, VersionStore } from './store.ts'

export interface VersionLogItem {
  id: string
  message: string
}

const EMPTY_META: VersionMeta = {
  version: 1,
  mounts: [],
  cache: { limit: 0, entries: [] },
  fingerprints: [],
  liveOnlyMounts: [],
}

function stripMeta(d: DiffResult): DiffResult {
  const keep = (xs: string[]): string[] =>
    xs.filter((p) => p !== META_PATH && !p.startsWith(CACHE_PREFIX))
  return { added: keep(d.added), modified: keep(d.modified), deleted: keep(d.deleted) }
}

export async function snapshotTreeFromState(
  store: VersionStore,
  state: WorkspaceStateDict,
): Promise<string> {
  const { entries, meta } = treeInputsFromState(state)
  const treeEntries: Record<string, string> = {}
  for (const [path, data] of Object.entries(entries)) {
    treeEntries[path] = await store.writeBlob(data)
  }
  treeEntries[META_PATH] = await store.writeBlob(metaToBlob(meta))
  return store.writeTree(treeEntries)
}

export async function commitState(
  store: VersionStore,
  state: WorkspaceStateDict,
  branch = 'main',
  message = '',
): Promise<string> {
  const tree = await snapshotTreeFromState(store, state)
  const branches = await store.branches()
  let parents: string[] = []
  if (branches.includes(branch)) {
    parents = [await store.head(branch)]
  } else if (branches.length > 0) {
    throw new NoSuchBranchError(branch)
  }
  return store.commit(tree, parents, branch, message)
}

export async function createBranch(
  store: VersionStore,
  name: string,
  fromBranch = 'main',
): Promise<string> {
  const head = await store.head(fromBranch)
  await store.setBranch(name, head)
  return head
}

export async function readVersion(
  store: VersionStore,
  version: string,
): Promise<{ entries: Record<string, Uint8Array>; meta: VersionMeta }> {
  const commit = await store.readCommit(version)
  const contents = await store.readTree(commit.tree)
  const metaOid = contents[META_PATH]
  const meta = metaOid !== undefined ? blobToMeta(await store.readBlob(metaOid)) : EMPTY_META
  const entries: Record<string, Uint8Array> = {}
  for (const [path, oid] of Object.entries(contents)) {
    if (path === META_PATH) continue
    entries[path] = await store.readBlob(oid)
  }
  return { entries, meta }
}

export async function resolveRef(store: VersionStore, ref: string): Promise<string> {
  if ((await store.branches()).includes(ref)) return store.head(ref)
  return ref
}

export async function versionLog(store: VersionStore, branch: string): Promise<VersionLogItem[]> {
  const out: VersionLogItem[] = []
  for (const oid of await store.log(branch)) {
    const commit = await store.readCommit(oid)
    out.push({ id: oid, message: commit.message.replace(/\n+$/, '') })
  }
  return out
}

export async function versionDiff(
  store: VersionStore,
  versionA: string,
  versionB: string,
): Promise<DiffResult> {
  const treeA = (await store.readCommit(versionA)).tree
  const treeB = (await store.readCommit(versionB)).tree
  return stripMeta(await store.diff(treeA, treeB))
}

export async function diffLiveVsRef(
  store: VersionStore,
  state: WorkspaceStateDict,
  ref: string,
): Promise<DiffResult> {
  const liveTree = await snapshotTreeFromState(store, state)
  const version = await resolveRef(store, ref)
  const refTree = (await store.readCommit(version)).tree
  return stripMeta(await store.diff(refTree, liveTree))
}

export async function statusState(
  store: VersionStore,
  state: WorkspaceStateDict,
  branch = 'main',
): Promise<DiffResult> {
  const liveTree = await snapshotTreeFromState(store, state)
  const branches = await store.branches()
  const headTree = branches.includes(branch)
    ? (await store.readCommit(await store.head(branch))).tree
    : await store.writeTree({})
  return stripMeta(await store.diff(headTree, liveTree))
}

export async function checkout(store: VersionStore, ws: CoreWorkspace, ref: string): Promise<void> {
  const version = await resolveRef(store, ref)
  const { entries, meta } = await readVersion(store, version)
  const cache = ws.cache as { clear?: () => Promise<void> }
  if (typeof cache.clear === 'function') await cache.clear()
  await ws.restore(toState(entries, meta))
}
