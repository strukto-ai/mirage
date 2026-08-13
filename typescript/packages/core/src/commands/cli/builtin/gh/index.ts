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

import { GhConfigSchema } from '../../../../core/github/config.ts'
import { ResourceName } from '../../../../types.ts'
import { Operand, Option } from '../../../spec/types.ts'
import { registerCliSpec } from '../../specs.ts'
import { CLISpec } from '../../types.ts'
import { api } from './api.ts'
import { fork, rename, view } from './repo.ts'

// The GitHub CLI, spelled as cli.github.com spells it. The `github` mount
// is the read half -- a repository is a tree, so listing and reading it is
// `ls` and `cat` -- and this is the write half plus the account-level
// operations a filesystem has no shape for: forking, renaming, and `api`
// for everything else. Install with a GhConfig; `repo` supplies the
// default repository that real gh reads off the current git remote.
export const GH = new CLISpec({
  name: 'gh',
  description: 'GitHub CLI',
  configModel: GhConfigSchema,
  // A write here lands on the same repository a `github` mount reads, and it
  // lands by name rather than by any vfs path, so the mount cannot invalidate
  // itself: without this, `gh api -X PUT .../contents/f` followed by
  // `cat /repo/f` serves the pre-write bytes, and a delete still lists.
  serves: [ResourceName.GITHUB],
  subcommands: [
    new CLISpec({
      name: 'repo',
      description: 'Manage repositories',
      subcommands: [
        new CLISpec({
          name: 'view',
          description: 'View a repository',
          fn: view,
          positional: [new Operand({ type: 'str', name: 'REPOSITORY' })],
        }),
        new CLISpec({
          name: 'fork',
          description: 'Create a fork of a repository',
          fn: fork,
          write: true,
          positional: [new Operand({ type: 'str', name: 'REPOSITORY' })],
          options: [
            new Option({
              long: '--fork-name',
              type: 'str',
              description: 'Rename the forked repository',
            }),
          ],
        }),
        new CLISpec({
          name: 'rename',
          description: 'Rename a repository',
          fn: rename,
          write: true,
          positional: [new Operand({ type: 'str', name: 'NEW-NAME', required: true })],
          options: [
            new Option({
              short: '-R',
              long: '--repo',
              type: 'str',
              description: 'Select another repository, as [HOST/]OWNER/REPO',
            }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'api',
      description: 'Make an authenticated GitHub API request',
      fn: api,
      write: true,
      positional: [new Operand({ type: 'str', name: 'ENDPOINT', required: true })],
      options: [
        new Option({
          short: '-X',
          long: '--method',
          type: 'str',
          description: 'The HTTP method for the request',
        }),
        new Option({
          short: '-f',
          long: '--raw-field',
          type: 'str',
          multiple: true,
          description: 'Add a string parameter in key=value format',
        }),
        new Option({
          short: '-F',
          long: '--field',
          type: 'str',
          multiple: true,
          description: 'Add a typed parameter in key=value format',
        }),
      ],
    }),
  ],
})

registerCliSpec(GH)
