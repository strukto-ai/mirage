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

import { Prisma, PrismaClient } from '../../generated/github/index.js'
import type { Dmmf, Fake } from '../kit/typescript/index.ts'
import { config } from './config.ts'
import type { C } from './config.ts'
import { githubRoutes } from './routes.ts'
import { seedRepos } from './seed.ts'
import { forgetKept } from './store.ts'

export const githubFake: Fake<C> = {
  config,
  client: PrismaClient,
  dmmf: Prisma.dmmf as unknown as Dmmf,
  seedRoots: {
    repos: 'GithubRepo',
    settings: 'GithubSetting',
    issues: 'GithubIssue',
    comments: 'GithubComment',
    workflows: 'GithubWorkflow',
    runs: 'GithubRun',
    accounts: 'GithubAccount',
    tags: 'GithubTagRef',
    checks: 'GithubCheck',
    statuses: 'GithubStatus',
  },
  // A repository's files come from the directory its row names, which is not
  // stateable in a fixture, so that happens here, along with registering the
  // workflow files each repository holds.
  afterSeed: seedRepos,
  afterReset: forgetKept,
  routes: githubRoutes,
}
