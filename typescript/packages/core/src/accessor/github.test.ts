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

import { expect, it } from 'vitest'
import { GH } from '../commands/cli/builtin/gh/index.ts'
import { CLIRegistry } from '../workspace/cli/registry.ts'
import { Accessor } from './base.ts'
import { GitHubAccessor, GitHubAccount } from './github.ts'

it('a gh install rides the github mount transport on one token', () => {
  const account = new GitHubAccount({ token: 't' })
  const mount = new GitHubAccessor({ account, owner: 'o', repo: 'r', ref: 'm', defaultBranch: 'm' })
  const clis = new CLIRegistry(() => [mount])
  const same = clis.install('gh', GH, { token: 't' }).accessor as GitHubAccount
  const other = clis.install('w', GH, { token: 'u' }).accessor as GitHubAccount
  expect(same.transport).toBe(account.transport)
  expect(other.transport).not.toBe(account.transport)
})

it('a gh write reaches github mounts on its API base alone', () => {
  // Whatever token a mount reads with: two tokens can reach one repository,
  // so narrowing by token would leave a mount stale.
  const repo = (account: GitHubAccount): GitHubAccessor =>
    new GitHubAccessor({ account, owner: 'o', repo: 'r', ref: 'm', defaultBranch: 'm' })
  const mine = repo(new GitHubAccount({ token: 't' }))
  const theirs = repo(new GitHubAccount({ token: 'u' }))
  const elsewhere = repo(new GitHubAccount({ token: 't', baseUrl: 'https://ghe.test/api' }))
  const gh = new GitHubAccount({ token: 't' })
  expect(gh.reaches(mine) && gh.reaches(theirs)).toBe(true)
  expect(gh.reaches(elsewhere)).toBe(false)
  expect(gh.reaches(new Accessor())).toBe(false)
})

it('an explicit github API base is the default one', () => {
  // A gh install naming github.com's API reaches, and shares with, a mount
  // that leaves the base unset: both call the same API.
  const account = new GitHubAccount({ token: 't' })
  const mount = new GitHubAccessor({ account, owner: 'o', repo: 'r', ref: 'm', defaultBranch: 'm' })
  const clis = new CLIRegistry(() => [mount])
  const gh = clis.install('gh', GH, { token: 't', baseUrl: 'https://api.github.com/' })
    .accessor as GitHubAccount
  expect(gh.reaches(mount)).toBe(true)
  expect(gh.transport).toBe(account.transport)
})
