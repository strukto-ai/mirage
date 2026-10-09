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

import { searchSpec } from './search.ts'
import { GhConfigSchema } from '../../../../core/github/config.ts'
import { BOOLEAN, HELP_TOPICS, REPO_EDIT_FIELDS } from './constants.ts'
import type { RepoEditField } from './types.ts'
import { CLISpec, type CLIInvocation } from '../../types.ts'
import { findChild, nodeHelp } from '../../walk.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { Operand, Option } from '../../../spec/types.ts'
import { api } from './api.ts'
import { status as authStatus, token as authToken } from './auth.ts'
import { version } from './version.ts'
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
  cloneCmd as repoClone,
  createCmd as repoCreate,
  deleteCmd as repoDelete,
  editCmd as repoEdit,
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

// gh's boolean flags are pflag's: a bare `--draft` is true, and `--draft=true`
// or `--draft=false` spells the value out, which is how a script turns one
// off. Their shorts still cluster (`-sd`). Read one with `ghBool`.
function flag(init: { short?: string; long: string; description?: string }): Option {
  return new Option({
    ...init,
    type: 'str',
    valueOptional: true,
    shortValue: false,
    choices: BOOLEAN,
  })
}

// The grammar and request mapping consume the same setting definition.
function repoEditOption(field: RepoEditField): Option {
  return new Option({
    short: field.short ?? null,
    long: field.flag,
    type: 'str',
    valueOptional: field.kind !== 'value',
    choices: field.kind === 'value' ? [...(field.choices ?? [])] : BOOLEAN,
    description: field.description,
  })
}

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
        options: [
          REPO,
          JSON_FIELDS,
          JQ,
          flag({ short: '-c', long: '--comments', description: 'Show comments' }),
        ],
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
        options: [
          REPO,
          JSON_FIELDS,
          JQ,
          flag({ short: '-c', long: '--comments', description: 'Show comments' }),
        ],
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
          flag({ short: '-d', long: '--draft' }),
          flag({ long: '--no-maintainer-edit' }),
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
          flag({ short: '-m', long: '--merge' }),
          flag({ short: '-r', long: '--rebase' }),
          flag({ short: '-s', long: '--squash' }),
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
        options: [
          REPO,
          flag({ long: '--name-only', description: 'Display only names of changed files' }),
        ],
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
        name: 'clone',
        description: 'Clone a repository locally',
        fn: repoClone,
        positional: [
          new Operand({ type: 'str', name: 'REPOSITORY' }),
          new Operand({ type: 'str', name: 'DIRECTORY' }),
        ],
        rest: new Operand({ type: 'str', name: 'GITFLAGS' }),
        options: [
          new Option({
            short: '-u',
            long: '--upstream-remote-name',
            type: 'str',
            description: 'Upstream remote name when cloning a fork',
          }),
          flag({
            long: '--no-upstream',
            description: 'Do not add an upstream remote when cloning a fork',
          }),
        ],
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
          flag({ long: '--public' }),
          flag({ long: '--private' }),
          new Option({ short: '-d', long: '--description', type: 'str' }),
          new Option({ short: '-h', long: '--homepage', type: 'str' }),
          flag({ long: '--add-readme' }),
        ],
      }),
      new CLISpec({
        name: 'fork',
        description: 'Create a fork of a repository',
        fn: fork,
        write: true,
        positional: [new Operand({ type: 'str', name: 'REPOSITORY' })],
        options: [
          flag({ long: '--clone', description: 'Clone the fork' }),
          flag({
            long: '--default-branch-only',
            description: 'Only include the default branch in the fork',
          }),
          new Option({
            long: '--fork-name',
            type: 'str',
            description: 'Rename the forked repository',
          }),
          new Option({
            long: '--org',
            type: 'str',
            description: 'Create the fork in an organization',
          }),
          flag({ long: '--remote', description: 'Add a git remote for the fork' }),
          new Option({
            long: '--remote-name',
            type: 'str',
            description: 'Specify the name for the new remote',
          }),
        ],
      }),
      new CLISpec({
        name: 'rename',
        description: 'Rename a repository',
        fn: rename,
        write: true,
        positional: [new Operand({ type: 'str', name: 'NEW-NAME', required: true })],
        options: [REPO],
      }),
      new CLISpec({
        name: 'edit',
        description: 'Edit repository settings',
        fn: repoEdit,
        write: true,
        positional: [new Operand({ type: 'str', name: 'REPOSITORY' })],
        options: [
          ...REPO_EDIT_FIELDS.map(repoEditOption),
          new Option({
            long: '--add-topic',
            type: 'str',
            multiple: true,
            description: 'Add repository topic',
          }),
          new Option({
            long: '--remove-topic',
            type: 'str',
            multiple: true,
            description: 'Remove repository topic',
          }),
          flag({
            long: '--accept-visibility-change-consequences',
            description: 'Accept the consequences of changing the repository visibility',
          }),
        ],
      }),
      new CLISpec({
        name: 'delete',
        description: 'Delete a repository',
        fn: repoDelete,
        write: true,
        positional: [new Operand({ type: 'str', name: 'REPOSITORY' })],
        options: [
          flag({ long: '--yes', description: 'Confirm deletion without prompting' }),
          flag({ long: '--confirm', description: 'Deprecated: use --yes instead' }),
        ],
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
          flag({ short: '-d', long: '--draft' }),
          flag({ short: '-p', long: '--prerelease' }),
          flag({ long: '--generate-notes' }),
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
        options: [
          REPO,
          JSON_FIELDS,
          JQ,
          flag({ long: '--exit-status' }),
          flag({
            long: '--log',
            description: 'View full log for either a run or specific job',
          }),
          flag({
            long: '--log-failed',
            description: 'View the log for any failed steps in a run or specific job',
          }),
        ],
      }),
      new CLISpec({
        name: 'rerun',
        description: 'Rerun a workflow run',
        fn: runRerunCmd,
        write: true,
        positional: [new Operand({ type: 'str', name: 'RUN-ID', required: true })],
        options: [
          REPO,
          flag({ short: '-d', long: '--debug' }),
          flag({ long: '--failed' }),
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
          flag({ short: '-a', long: '--all' }),
        ],
      }),
      new CLISpec({
        name: 'view',
        description: 'View a workflow',
        fn: workflowViewCmd,
        positional: [new Operand({ type: 'str', name: 'WORKFLOW', required: true })],
        options: [
          REPO,
          flag({ short: '-y', long: '--yaml', description: 'View the workflow yaml file' }),
          new Option({
            short: '-r',
            long: '--ref',
            type: 'str',
            description:
              "The branch or tag name which contains the version of the workflow file you'd like to view",
          }),
        ],
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
          flag({ long: '--json' }),
        ],
      }),
    ],
  })
}

const ENC = new TextEncoder()

/**
 * `gh help [<command>...]`, as cobra answers it: the help of the deepest
 * command the words name (words past it are ignored), a help topic when the
 * first word names one, and otherwise gh's unknown-topic answer, which goes to
 * stderr with the list of commands and still exits 0.
 */
function helpCmd(inv: CLIInvocation): CommandFnResult {
  let node: CLISpec = GH
  const path: string[] = []
  for (const word of inv.texts) {
    const child = findChild(node, word)
    if (child === null) break
    node = child
    path.push(child.name)
  }
  const first = inv.texts[0]
  if (first !== undefined && path.length === 0) {
    const topic = HELP_TOPICS[first]
    if (topic !== undefined) return [ENC.encode(topic), new IOResult()]
    const names = GH.subcommands
      .filter((child) => child.name !== 'help')
      .map((child) => `  ${child.name}\n`)
      .sort(compareCodePoints)
    const asked = inv.texts.map((word) => `\`${word}\``).join(' ')
    const usage = `Usage:  gh <command> <subcommand> [flags]\n\nAvailable commands:\n${names.join('')}`
    return [null, new IOResult({ stderr: ENC.encode(`Unknown help topic [${asked}]\n${usage}`) })]
  }
  return [ENC.encode(nodeHelp(['gh', ...path].join(' '), node, GH.usageStyle)), new IOResult()]
}

export const GH = new CLISpec({
  name: 'gh',
  description: 'GitHub CLI',
  configModel: GhConfigSchema,
  subcommands: [
    new CLISpec({
      name: 'auth',
      description: 'Manage authentication',
      subcommands: [
        new CLISpec({ name: 'status', description: 'Check the configured token', fn: authStatus }),
        new CLISpec({
          name: 'token',
          description: 'Token display is unavailable in Mirage',
          fn: authToken,
          options: [
            new Option({
              long: '--hostname',
              type: 'str',
              description: 'The hostname of the GitHub instance authenticated with',
            }),
            new Option({
              short: '-u',
              long: '--user',
              type: 'str',
              description: 'The account selector; tokens are never printed',
            }),
          ],
        }),
      ],
    }),
    new CLISpec({
      name: 'help',
      fn: helpCmd,
      description: 'Help about any command',
      rest: new Operand({ type: 'str' }),
    }),
    new CLISpec({
      name: 'version',
      aliases: ['--version'],
      fn: version,
      description: 'Show the Mirage GitHub CLI implementation version',
    }),
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
        flag({
          short: '-i',
          long: '--include',
          description: 'Include HTTP response status line and headers in the output',
        }),
        new Option({ long: '--input', type: 'path' }),
        JQ,
        flag({ long: '--paginate' }),
        flag({ long: '--slurp' }),
        flag({ long: '--silent' }),
      ],
    }),
    issue(),
    pr(),
    repo(),
    release(),
    run(),
    workflow(),
    searchSpec(),
  ],
})
