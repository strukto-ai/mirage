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
import { CLISpec } from '../../types.ts'
import { Operand, Option } from '../../../spec/types.ts'
import { api } from './api.ts'
import {
  closeCmd as issueClose,
  commentCmd as issueComment,
  createCmd as issueCreate,
  editCmd as issueEdit,
  listCmd as issueList,
  reopenCmd as issueReopen,
  viewCmd as issueView,
} from './issue.ts'
import {
  checksCmd as prChecks,
  closeCmd as prClose,
  commentCmd as prComment,
  createCmd as prCreate,
  diffCmd as prDiff,
  editCmd as prEdit,
  listCmd as prList,
  mergeCmd as prMerge,
  viewCmd as prView,
} from './pull.ts'
import {
  createCmd as repoCreate,
  fork,
  listCmd as repoList,
  rename,
  view as repoView,
} from './repo.ts'
import {
  createCmd as releaseCreate,
  listCmd as releaseList,
  viewCmd as releaseView,
} from './release.ts'
import {
  runListCmd,
  runRerunCmd,
  runViewCmd,
  workflowListCmd,
  workflowRunCmd,
  workflowViewCmd,
} from './actions.ts'

const REPO = new Option({
  short: '-R',
  long: '--repo',
  type: 'str',
  description: 'Select another repository, as [HOST/]OWNER/REPO',
})
const JSON_FIELDS = new Option({
  long: '--json',
  type: 'str',
  description: 'Output selected JSON fields',
})
const JQ = new Option({ short: '-q', long: '--jq', type: 'str', description: 'Filter JSON output' })
const LIMIT_30 = new Option({ short: '-L', long: '--limit', type: 'int', default: '30' })
const BODY = new Option({ short: '-b', long: '--body', type: 'str' })
const BODY_FILE = new Option({ short: '-F', long: '--body-file', type: 'path' })
const TITLE = new Option({ short: '-t', long: '--title', type: 'str' })
const NUMBER = new Operand({ type: 'str', name: 'NUMBER', required: true })

function issue(): CLISpec {
  return new CLISpec({
    name: 'issue',
    description: 'Manage issues',
    subcommands: [
      new CLISpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List issues',
        fn: issueList,
        options: [
          REPO,
          JSON_FIELDS,
          JQ,
          LIMIT_30,
          new Option({
            short: '-s',
            long: '--state',
            type: 'str',
            choices: ['open', 'closed', 'all'],
            default: 'open',
          }),
          new Option({ short: '-a', long: '--assignee', type: 'str' }),
          new Option({ short: '-A', long: '--author', type: 'str' }),
          new Option({ short: '-l', long: '--label', type: 'str', multiple: true }),
        ],
      }),
      new CLISpec({
        name: 'view',
        description: 'View an issue',
        fn: issueView,
        positional: [NUMBER],
        options: [REPO, JSON_FIELDS, JQ],
      }),
      new CLISpec({
        name: 'create',
        aliases: ['new'],
        description: 'Create an issue',
        fn: issueCreate,
        write: true,
        options: [
          REPO,
          TITLE,
          BODY,
          BODY_FILE,
          new Option({ short: '-a', long: '--assignee', type: 'str', multiple: true }),
          new Option({ short: '-l', long: '--label', type: 'str', multiple: true }),
        ],
      }),
      new CLISpec({
        name: 'edit',
        description: 'Edit an issue',
        fn: issueEdit,
        write: true,
        positional: [NUMBER],
        options: [
          REPO,
          TITLE,
          BODY,
          BODY_FILE,
          new Option({ long: '--add-assignee', type: 'str', multiple: true }),
          new Option({ long: '--remove-assignee', type: 'str', multiple: true }),
          new Option({ long: '--add-label', type: 'str', multiple: true }),
          new Option({ long: '--remove-label', type: 'str', multiple: true }),
        ],
      }),
      new CLISpec({
        name: 'close',
        description: 'Close an issue',
        fn: issueClose,
        write: true,
        positional: [NUMBER],
        options: [REPO],
      }),
      new CLISpec({
        name: 'reopen',
        description: 'Reopen an issue',
        fn: issueReopen,
        write: true,
        positional: [NUMBER],
        options: [REPO],
      }),
      new CLISpec({
        name: 'comment',
        description: 'Add a comment to an issue',
        fn: issueComment,
        write: true,
        positional: [NUMBER],
        options: [REPO, BODY, BODY_FILE],
      }),
    ],
  })
}

function pr(): CLISpec {
  return new CLISpec({
    name: 'pr',
    description: 'Manage pull requests',
    subcommands: [
      new CLISpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List pull requests',
        fn: prList,
        options: [
          REPO,
          JSON_FIELDS,
          JQ,
          LIMIT_30,
          new Option({
            short: '-s',
            long: '--state',
            type: 'str',
            choices: ['open', 'closed', 'merged', 'all'],
            default: 'open',
          }),
          new Option({ short: '-B', long: '--base', type: 'str' }),
          new Option({ short: '-H', long: '--head', type: 'str' }),
        ],
      }),
      new CLISpec({
        name: 'view',
        description: 'View a pull request',
        fn: prView,
        positional: [NUMBER],
        options: [REPO, JSON_FIELDS, JQ],
      }),
      new CLISpec({
        name: 'create',
        aliases: ['new'],
        description: 'Create a pull request',
        fn: prCreate,
        write: true,
        options: [
          REPO,
          TITLE,
          BODY,
          BODY_FILE,
          new Option({ short: '-H', long: '--head', type: 'str' }),
          new Option({ short: '-B', long: '--base', type: 'str' }),
          new Option({ short: '-d', long: '--draft' }),
          new Option({ long: '--no-maintainer-edit' }),
        ],
      }),
      new CLISpec({
        name: 'edit',
        description: 'Edit a pull request',
        fn: prEdit,
        write: true,
        positional: [NUMBER],
        options: [
          REPO,
          TITLE,
          BODY,
          BODY_FILE,
          new Option({ short: '-B', long: '--base', type: 'str' }),
        ],
      }),
      new CLISpec({
        name: 'merge',
        description: 'Merge a pull request',
        fn: prMerge,
        write: true,
        positional: [NUMBER],
        options: [
          REPO,
          BODY,
          BODY_FILE,
          new Option({ short: '-m', long: '--merge' }),
          new Option({ short: '-r', long: '--rebase' }),
          new Option({ short: '-s', long: '--squash' }),
          new Option({ short: '-t', long: '--subject', type: 'str' }),
          new Option({ long: '--match-head-commit', type: 'str' }),
        ],
      }),
      new CLISpec({
        name: 'close',
        description: 'Close a pull request',
        fn: prClose,
        write: true,
        positional: [NUMBER],
        options: [REPO],
      }),
      new CLISpec({
        name: 'comment',
        description: 'Add a comment to a pull request',
        fn: prComment,
        write: true,
        positional: [NUMBER],
        options: [REPO, BODY, BODY_FILE],
      }),
      new CLISpec({
        name: 'diff',
        description: 'View changes in a pull request',
        fn: prDiff,
        positional: [NUMBER],
        options: [REPO],
      }),
      new CLISpec({
        name: 'checks',
        description: 'Show CI checks for a pull request',
        fn: prChecks,
        positional: [NUMBER],
        options: [REPO, JSON_FIELDS, JQ],
      }),
    ],
  })
}

function repo(): CLISpec {
  return new CLISpec({
    name: 'repo',
    description: 'Manage repositories',
    subcommands: [
      new CLISpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List repositories',
        fn: repoList,
        positional: [new Operand({ type: 'str', name: 'OWNER' })],
        options: [JSON_FIELDS, JQ, LIMIT_30],
      }),
      new CLISpec({
        name: 'view',
        description: 'View a repository',
        fn: repoView,
        positional: [new Operand({ type: 'str', name: 'REPOSITORY' })],
        options: [REPO, JSON_FIELDS, JQ],
      }),
      new CLISpec({
        name: 'create',
        description: 'Create a repository',
        fn: repoCreate,
        write: true,
        positional: [new Operand({ type: 'str', name: 'NAME' })],
        options: [
          new Option({ long: '--public' }),
          new Option({ long: '--private' }),
          new Option({ short: '-d', long: '--description', type: 'str' }),
          new Option({ short: '-h', long: '--homepage', type: 'str' }),
          new Option({ long: '--add-readme' }),
        ],
      }),
      new CLISpec({
        name: 'fork',
        description: 'Create a fork of a repository',
        fn: fork,
        write: true,
        positional: [new Operand({ type: 'str', name: 'REPOSITORY' })],
        options: [new Option({ long: '--fork-name', type: 'str' })],
      }),
      new CLISpec({
        name: 'rename',
        description: 'Rename a repository',
        fn: rename,
        write: true,
        positional: [new Operand({ type: 'str', name: 'NEW-NAME', required: true })],
        options: [REPO],
      }),
    ],
  })
}

function release(): CLISpec {
  return new CLISpec({
    name: 'release',
    description: 'Manage releases',
    subcommands: [
      new CLISpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List releases',
        fn: releaseList,
        options: [REPO, JSON_FIELDS, JQ, LIMIT_30],
      }),
      new CLISpec({
        name: 'view',
        description: 'View a release',
        fn: releaseView,
        positional: [new Operand({ type: 'str', name: 'TAG', required: true })],
        options: [REPO, JSON_FIELDS, JQ],
      }),
      new CLISpec({
        name: 'create',
        description: 'Create a release',
        fn: releaseCreate,
        write: true,
        positional: [new Operand({ type: 'str', name: 'TAG', required: true })],
        options: [
          REPO,
          new Option({ short: '-n', long: '--notes', type: 'str' }),
          new Option({ short: '-F', long: '--notes-file', type: 'path' }),
          TITLE,
          new Option({ short: '-d', long: '--draft' }),
          new Option({ short: '-p', long: '--prerelease' }),
          new Option({ long: '--generate-notes' }),
          new Option({ long: '--target', type: 'str' }),
        ],
      }),
    ],
  })
}

function run(): CLISpec {
  return new CLISpec({
    name: 'run',
    description: 'View workflow runs',
    subcommands: [
      new CLISpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List workflow runs',
        fn: runListCmd,
        options: [
          REPO,
          JSON_FIELDS,
          JQ,
          new Option({ short: '-L', long: '--limit', type: 'int', default: '20' }),
          new Option({ short: '-b', long: '--branch', type: 'str' }),
          new Option({ short: '-c', long: '--commit', type: 'str' }),
          new Option({ long: '--created', type: 'str' }),
          new Option({ short: '-e', long: '--event', type: 'str' }),
          new Option({ short: '-s', long: '--status', type: 'str' }),
          new Option({ short: '-u', long: '--user', type: 'str' }),
          new Option({ short: '-w', long: '--workflow', type: 'str' }),
        ],
      }),
      new CLISpec({
        name: 'view',
        description: 'View a workflow run',
        fn: runViewCmd,
        positional: [new Operand({ type: 'str', name: 'RUN-ID', required: true })],
        options: [REPO, JSON_FIELDS, JQ, new Option({ long: '--exit-status' })],
      }),
      new CLISpec({
        name: 'rerun',
        description: 'Rerun a workflow run',
        fn: runRerunCmd,
        write: true,
        positional: [new Operand({ type: 'str', name: 'RUN-ID', required: true })],
        options: [
          REPO,
          new Option({ short: '-d', long: '--debug' }),
          new Option({ long: '--failed' }),
          new Option({ short: '-j', long: '--job', type: 'str' }),
        ],
      }),
    ],
  })
}

function workflow(): CLISpec {
  return new CLISpec({
    name: 'workflow',
    description: 'Manage workflows',
    subcommands: [
      new CLISpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List workflows',
        fn: workflowListCmd,
        options: [
          REPO,
          JSON_FIELDS,
          JQ,
          new Option({ short: '-L', long: '--limit', type: 'int', default: '50' }),
          new Option({ short: '-a', long: '--all' }),
        ],
      }),
      new CLISpec({
        name: 'view',
        description: 'View a workflow',
        fn: workflowViewCmd,
        positional: [new Operand({ type: 'str', name: 'WORKFLOW', required: true })],
        options: [REPO],
      }),
      new CLISpec({
        name: 'run',
        description: 'Run a workflow',
        fn: workflowRunCmd,
        write: true,
        positional: [new Operand({ type: 'str', name: 'WORKFLOW', required: true })],
        options: [
          REPO,
          new Option({ short: '-r', long: '--ref', type: 'str' }),
          new Option({ short: '-f', long: '--raw-field', type: 'str', multiple: true }),
          new Option({ short: '-F', long: '--field', type: 'str', multiple: true }),
          new Option({ long: '--json' }),
        ],
      }),
    ],
  })
}

export const GH = new CLISpec({
  name: 'gh',
  description: 'GitHub CLI',
  configModel: GhConfigSchema,
  subcommands: [
    new CLISpec({
      name: 'api',
      description: 'Make an authenticated GitHub API request',
      fn: api,
      write: true,
      positional: [new Operand({ type: 'str', name: 'ENDPOINT', required: true })],
      options: [
        new Option({ short: '-X', long: '--method', type: 'str' }),
        new Option({ short: '-f', long: '--raw-field', type: 'str', multiple: true }),
        new Option({ short: '-F', long: '--field', type: 'str', multiple: true }),
        new Option({ short: '-H', long: '--header', type: 'str', multiple: true }),
        new Option({ long: '--input', type: 'path' }),
        JQ,
        new Option({ long: '--paginate' }),
        new Option({ long: '--slurp' }),
        new Option({ long: '--silent' }),
      ],
    }),
    issue(),
    pr(),
    repo(),
    release(),
    run(),
    workflow(),
  ],
})
