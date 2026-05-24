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

import git from 'isomorphic-git'
import type { FsClient, GitRepo, VersionBackend } from './backend.ts'
import { HeadMovedError } from './errors.ts'

const AUTHOR = { name: 'mirage', email: 'mirage@local', timestamp: 0, timezoneOffset: 0 }

interface TreeEntry {
  mode: string
  path: string
  oid: string
  type: 'blob' | 'tree' | 'commit'
}

export interface DiffResult {
  added: string[]
  modified: string[]
  deleted: string[]
}

export interface CommitInfo {
  tree: string
  parents: string[]
  message: string
}

export class VersionStore {
  private readonly fs: FsClient
  private readonly gitdir: string

  constructor(repo: GitRepo) {
    this.fs = repo.fs
    this.gitdir = repo.gitdir
  }

  static async open(backend: VersionBackend, workspaceId: string): Promise<VersionStore> {
    return new VersionStore(await backend.openRepo(workspaceId))
  }

  async writeBlob(data: Uint8Array): Promise<string> {
    return git.writeBlob({ fs: this.fs, gitdir: this.gitdir, blob: data })
  }

  async readBlob(oid: string): Promise<Uint8Array> {
    const { blob } = await git.readBlob({ fs: this.fs, gitdir: this.gitdir, oid })
    return blob
  }

  async writeTree(entries: Record<string, string>): Promise<string> {
    return this.buildTree(entries)
  }

  private async buildTree(entries: Record<string, string>): Promise<string> {
    const blobs: Record<string, string> = {}
    const subdirs: Record<string, Record<string, string>> = {}
    for (const [path, oid] of Object.entries(entries)) {
      const slash = path.indexOf('/')
      if (slash === -1) {
        blobs[path] = oid
      } else {
        const head = path.slice(0, slash)
        const rest = path.slice(slash + 1)
        ;(subdirs[head] ??= {})[rest] = oid
      }
    }
    const tree: TreeEntry[] = []
    for (const [name, oid] of Object.entries(blobs)) {
      tree.push({ mode: '100644', path: name, oid, type: 'blob' })
    }
    for (const [name, sub] of Object.entries(subdirs)) {
      tree.push({ mode: '040000', path: name, oid: await this.buildTree(sub), type: 'tree' })
    }
    return git.writeTree({ fs: this.fs, gitdir: this.gitdir, tree })
  }

  async readTree(oid: string, prefix = ''): Promise<Record<string, string>> {
    const { tree } = await git.readTree({ fs: this.fs, gitdir: this.gitdir, oid })
    const out: Record<string, string> = {}
    for (const e of tree) {
      const p = prefix === '' ? e.path : `${prefix}/${e.path}`
      if (e.type === 'tree') {
        Object.assign(out, await this.readTree(e.oid, p))
      } else {
        out[p] = e.oid
      }
    }
    return out
  }

  async branches(): Promise<string[]> {
    return git.listBranches({ fs: this.fs, gitdir: this.gitdir })
  }

  async head(branch: string): Promise<string> {
    return git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref: `refs/heads/${branch}` })
  }

  async setBranch(name: string, oid: string): Promise<void> {
    await git.writeRef({
      fs: this.fs,
      gitdir: this.gitdir,
      ref: `refs/heads/${name}`,
      value: oid,
      force: true,
    })
  }

  async commit(
    treeOid: string,
    parents: string[],
    branch: string,
    message: string,
  ): Promise<string> {
    if ((await this.branches()).includes(branch)) {
      const current = await this.head(branch)
      if (current !== parents[0]) throw new HeadMovedError(branch)
    }
    const author = { ...AUTHOR, timestamp: Math.floor(Date.now() / 1000) }
    const oid = await git.writeCommit({
      fs: this.fs,
      gitdir: this.gitdir,
      commit: { message, tree: treeOid, parent: parents, author, committer: author },
    })
    await this.setBranch(branch, oid)
    return oid
  }

  async readCommit(oid: string): Promise<CommitInfo> {
    const { commit } = await git.readCommit({ fs: this.fs, gitdir: this.gitdir, oid })
    return { tree: commit.tree, parents: commit.parent, message: commit.message }
  }

  async log(branch: string): Promise<string[]> {
    const commits = await git.log({
      fs: this.fs,
      gitdir: this.gitdir,
      ref: `refs/heads/${branch}`,
    })
    return commits.map((c) => c.oid)
  }

  async diff(treeA: string, treeB: string): Promise<DiffResult> {
    const a = await this.readTree(treeA)
    const b = await this.readTree(treeB)
    const added: string[] = []
    const modified: string[] = []
    const deleted: string[] = []
    for (const [path, oid] of Object.entries(b)) {
      if (!(path in a)) added.push(path)
      else if (a[path] !== oid) modified.push(path)
    }
    for (const path of Object.keys(a)) {
      if (!(path in b)) deleted.push(path)
    }
    added.sort()
    modified.sort()
    deleted.sort()
    return { added, modified, deleted }
  }
}
