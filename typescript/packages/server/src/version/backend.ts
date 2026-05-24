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

import { existsSync, mkdirSync } from 'node:fs'
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import git from 'isomorphic-git'

export type FsClient = Parameters<typeof git.init>[0]['fs']

export interface GitRepo {
  fs: FsClient
  gitdir: string
}

export interface VersionBackend {
  openRepo(workspaceId: string): Promise<GitRepo>
}

export class LocalBackend implements VersionBackend {
  constructor(private readonly root: string) {}

  async openRepo(workspaceId: string): Promise<GitRepo> {
    const gitdir = join(this.root, workspaceId)
    const fs = nodeFs as unknown as FsClient
    if (!existsSync(join(gitdir, 'objects'))) {
      mkdirSync(gitdir, { recursive: true })
      await git.init({ fs, dir: gitdir, bare: true, defaultBranch: 'main' })
    }
    return { fs, gitdir }
  }
}
