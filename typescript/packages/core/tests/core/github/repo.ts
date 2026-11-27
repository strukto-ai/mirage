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

import { GitHubAccessor, GitHubAccount } from '../../../src/accessor/github.ts'
import { GitHubRepo as KitRepo, TOKEN } from '../../fixtures/github_repo.ts'

export * from '../../fixtures/github_repo.ts'

/** A repository on the GitHub fake, and a Mirage accessor onto it. */
export class GitHubRepo extends KitRepo {
  /**
   * A Mirage accessor on this repository with a token, reading `ref`. Its
   * default branch is the repository's, `main`, whatever `ref` it reads, so
   * a ref off it stays off it.
   */
  accessor(ref = 'main'): GitHubAccessor {
    return new GitHubAccessor({
      account: new GitHubAccount({ token: TOKEN, baseUrl: this.run.url }),
      owner: this.owner,
      repo: this.name,
      ref,
      defaultBranch: 'main',
    })
  }
}
