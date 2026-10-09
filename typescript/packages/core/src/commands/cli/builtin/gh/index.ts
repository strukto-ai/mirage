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
import { CommandSpec } from '../../../spec/types.ts'
import { CLI } from '../../types.ts'
import { CLIHandler } from '../../types.ts'

import { searchHandlers, searchSpec } from './search.ts'
import { GhConfigSchema } from '../../../../core/github/config.ts'
import { BOOLEAN, HELP_TOPICS, REPO_EDIT_FIELDS } from './constants.ts'
import type { RepoEditField } from './types.ts'
import { type CLIInvocation } from '../../types.ts'
import { findChild, nodeHelp } from '../../walk.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { Argument, UsageStyle } from '../../../spec/types.ts'
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

const REPO = new Argument(['-R', '--repo'], {
  help: 'Select another repository, as [HOST/]OWNER/REPO',
})
const JSON_FIELDS = new Argument('--json', { help: 'Output selected JSON fields' })
const JQ = new Argument(['-q', '--jq'], { help: 'Filter JSON output' })
const LIMIT_30 = new Argument(['-L', '--limit'], { type: 'int', default: '30' })
const BODY = new Argument(['-b', '--body'])
const BODY_FILE = new Argument(['-F', '--body-file'], { type: 'path' })
const TITLE = new Argument(['-t', '--title'])
const NUMBER = new Argument('NUMBER')

// gh's boolean flags are pflag's: a bare `--draft` is true, and `--draft=true`
// or `--draft=false` spells the value out, which is how a script turns one
// off. Their shorts still cluster (`-sd`). Read one with `ghBool`.
function flag(init: { short?: string; long: string; description?: string }): Argument {
  return new Argument([...(init.short === undefined ? [] : [init.short]), init.long], {
    nargs: '?',
    attachedOnly: true,
    help: init.description ?? null,
    shortValue: false,
    choices: BOOLEAN,
  })
}

// The grammar and request mapping consume the same setting definition.
function repoEditOption(field: RepoEditField): Argument {
  return new Argument([...(field.short === undefined ? [] : [field.short]), field.flag], {
    nargs: field.kind !== 'value' ? '?' : null,
    attachedOnly: field.kind !== 'value',
    choices: field.kind === 'value' ? [...(field.choices ?? [])] : BOOLEAN,
    help: field.description,
  })
}

function issue(): CommandSpec {
  return new CommandSpec({
    name: 'issue',
    description: 'Manage issues',
    subcommands: [
      new CommandSpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List issues',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          LIMIT_30,
          new Argument(['-s', '--state'], { choices: ['open', 'closed', 'all'], default: 'open' }),
          new Argument(['-a', '--assignee']),
          new Argument(['-A', '--author']),
          new Argument(['-l', '--label'], { action: 'append' }),
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View an issue',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          flag({ short: '-c', long: '--comments', description: 'Show comments' }),
          NUMBER,
        ],
      }),
      new CommandSpec({
        name: 'create',
        aliases: ['new'],
        description: 'Create an issue',
        arguments: [
          REPO,
          TITLE,
          BODY,
          BODY_FILE,
          new Argument(['-a', '--assignee'], { action: 'append' }),
          new Argument(['-l', '--label'], { action: 'append' }),
        ],
      }),
      new CommandSpec({
        name: 'edit',
        description: 'Edit an issue',
        arguments: [
          REPO,
          TITLE,
          BODY,
          BODY_FILE,
          new Argument('--add-assignee', { action: 'append' }),
          new Argument('--remove-assignee', { action: 'append' }),
          new Argument('--add-label', { action: 'append' }),
          new Argument('--remove-label', { action: 'append' }),
          NUMBER,
        ],
      }),
      new CommandSpec({ name: 'close', description: 'Close an issue', arguments: [REPO, NUMBER] }),
      new CommandSpec({
        name: 'reopen',
        description: 'Reopen an issue',
        arguments: [REPO, NUMBER],
      }),
      new CommandSpec({
        name: 'comment',
        description: 'Add a comment to an issue',
        arguments: [REPO, BODY, BODY_FILE, NUMBER],
      }),
    ],
  })
}

function pr(): CommandSpec {
  return new CommandSpec({
    name: 'pr',
    description: 'Manage pull requests',
    subcommands: [
      new CommandSpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List pull requests',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          LIMIT_30,
          new Argument(['-s', '--state'], {
            choices: ['open', 'closed', 'merged', 'all'],
            default: 'open',
          }),
          new Argument(['-B', '--base']),
          new Argument(['-H', '--head']),
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View a pull request',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          flag({ short: '-c', long: '--comments', description: 'Show comments' }),
          NUMBER,
        ],
      }),
      new CommandSpec({
        name: 'create',
        aliases: ['new'],
        description: 'Create a pull request',
        arguments: [
          REPO,
          TITLE,
          BODY,
          BODY_FILE,
          new Argument(['-H', '--head']),
          new Argument(['-B', '--base']),
          flag({ short: '-d', long: '--draft' }),
          flag({ long: '--no-maintainer-edit' }),
        ],
      }),
      new CommandSpec({
        name: 'edit',
        description: 'Edit a pull request',
        arguments: [REPO, TITLE, BODY, BODY_FILE, new Argument(['-B', '--base']), NUMBER],
      }),
      new CommandSpec({
        name: 'merge',
        description: 'Merge a pull request',
        arguments: [
          REPO,
          BODY,
          BODY_FILE,
          flag({ short: '-m', long: '--merge' }),
          flag({ short: '-r', long: '--rebase' }),
          flag({ short: '-s', long: '--squash' }),
          new Argument(['-t', '--subject']),
          new Argument('--match-head-commit'),
          NUMBER,
        ],
      }),
      new CommandSpec({
        name: 'close',
        description: 'Close a pull request',
        arguments: [REPO, NUMBER],
      }),
      new CommandSpec({
        name: 'comment',
        description: 'Add a comment to a pull request',
        arguments: [REPO, BODY, BODY_FILE, NUMBER],
      }),
      new CommandSpec({
        name: 'diff',
        description: 'View changes in a pull request',
        arguments: [
          REPO,
          flag({ long: '--name-only', description: 'Display only names of changed files' }),
          NUMBER,
        ],
      }),
      new CommandSpec({
        name: 'checks',
        description: 'Show CI checks for a pull request',
        arguments: [REPO, JSON_FIELDS, JQ, NUMBER],
      }),
    ],
  })
}

function repo(): CommandSpec {
  return new CommandSpec({
    name: 'repo',
    description: 'Manage repositories',
    subcommands: [
      new CommandSpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List repositories',
        arguments: [JSON_FIELDS, JQ, LIMIT_30, new Argument('OWNER', { nargs: '?' })],
      }),
      new CommandSpec({
        name: 'clone',
        description: 'Clone a repository locally',
        arguments: [
          new Argument(['-u', '--upstream-remote-name'], {
            help: 'Upstream remote name when cloning a fork',
          }),
          flag({
            long: '--no-upstream',
            description: 'Do not add an upstream remote when cloning a fork',
          }),
          new Argument('REPOSITORY', { nargs: '?' }),
          new Argument('DIRECTORY', { nargs: '?' }),
          new Argument('GITFLAGS', { nargs: '*' }),
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View a repository',
        arguments: [REPO, JSON_FIELDS, JQ, new Argument('REPOSITORY', { nargs: '?' })],
      }),
      new CommandSpec({
        name: 'create',
        description: 'Create a repository',
        arguments: [
          flag({ long: '--public' }),
          flag({ long: '--private' }),
          new Argument(['-d', '--description']),
          new Argument(['-h', '--homepage']),
          flag({ long: '--add-readme' }),
          new Argument('NAME', { nargs: '?' }),
        ],
      }),
      new CommandSpec({
        name: 'fork',
        description: 'Create a fork of a repository',
        arguments: [
          flag({ long: '--clone', description: 'Clone the fork' }),
          flag({
            long: '--default-branch-only',
            description: 'Only include the default branch in the fork',
          }),
          new Argument('--fork-name', { help: 'Rename the forked repository' }),
          new Argument('--org', { help: 'Create the fork in an organization' }),
          flag({ long: '--remote', description: 'Add a git remote for the fork' }),
          new Argument('--remote-name', { help: 'Specify the name for the new remote' }),
          new Argument('REPOSITORY', { nargs: '?' }),
        ],
      }),
      new CommandSpec({
        name: 'rename',
        description: 'Rename a repository',
        arguments: [REPO, new Argument('NEW-NAME')],
      }),
      new CommandSpec({
        name: 'edit',
        description: 'Edit repository settings',
        arguments: [
          ...REPO_EDIT_FIELDS.map(repoEditOption),
          new Argument('--add-topic', { action: 'append', help: 'Add repository topic' }),
          new Argument('--remove-topic', { action: 'append', help: 'Remove repository topic' }),
          flag({
            long: '--accept-visibility-change-consequences',
            description: 'Accept the consequences of changing the repository visibility',
          }),
          new Argument('REPOSITORY', { nargs: '?' }),
        ],
      }),
      new CommandSpec({
        name: 'delete',
        description: 'Delete a repository',
        arguments: [
          flag({ long: '--yes', description: 'Confirm deletion without prompting' }),
          flag({ long: '--confirm', description: 'Deprecated: use --yes instead' }),
          new Argument('REPOSITORY', { nargs: '?' }),
        ],
      }),
    ],
  })
}

function release(): CommandSpec {
  return new CommandSpec({
    name: 'release',
    description: 'Manage releases',
    subcommands: [
      new CommandSpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List releases',
        arguments: [REPO, JSON_FIELDS, JQ, LIMIT_30],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View a release',
        arguments: [REPO, JSON_FIELDS, JQ, new Argument('TAG')],
      }),
      new CommandSpec({
        name: 'create',
        description: 'Create a release',
        arguments: [
          REPO,
          new Argument(['-n', '--notes']),
          new Argument(['-F', '--notes-file'], { type: 'path' }),
          TITLE,
          flag({ short: '-d', long: '--draft' }),
          flag({ short: '-p', long: '--prerelease' }),
          flag({ long: '--generate-notes' }),
          new Argument('--target'),
          new Argument('TAG'),
        ],
      }),
    ],
  })
}

function run(): CommandSpec {
  return new CommandSpec({
    name: 'run',
    description: 'View workflow runs',
    subcommands: [
      new CommandSpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List workflow runs',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          new Argument(['-L', '--limit'], { type: 'int', default: '20' }),
          new Argument(['-b', '--branch']),
          new Argument(['-c', '--commit']),
          new Argument('--created'),
          new Argument(['-e', '--event']),
          new Argument(['-s', '--status']),
          new Argument(['-u', '--user']),
          new Argument(['-w', '--workflow']),
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View a workflow run',
        arguments: [
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
          new Argument('RUN-ID'),
        ],
      }),
      new CommandSpec({
        name: 'rerun',
        description: 'Rerun a workflow run',
        arguments: [
          REPO,
          flag({ short: '-d', long: '--debug' }),
          flag({ long: '--failed' }),
          new Argument(['-j', '--job']),
          new Argument('RUN-ID'),
        ],
      }),
    ],
  })
}

function workflow(): CommandSpec {
  return new CommandSpec({
    name: 'workflow',
    description: 'Manage workflows',
    subcommands: [
      new CommandSpec({
        name: 'list',
        aliases: ['ls'],
        description: 'List workflows',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          new Argument(['-L', '--limit'], { type: 'int', default: '50' }),
          flag({ short: '-a', long: '--all' }),
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View a workflow',
        arguments: [
          REPO,
          flag({ short: '-y', long: '--yaml', description: 'View the workflow yaml file' }),
          new Argument(['-r', '--ref'], {
            help: "The branch or tag name which contains the version of the workflow file you'd like to view",
          }),
          new Argument('WORKFLOW'),
        ],
      }),
      new CommandSpec({
        name: 'run',
        description: 'Run a workflow',
        arguments: [
          REPO,
          new Argument(['-r', '--ref']),
          new Argument(['-f', '--raw-field'], { action: 'append' }),
          new Argument(['-F', '--field'], { action: 'append' }),
          flag({ long: '--json' }),
          new Argument('WORKFLOW'),
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
  let node: CommandSpec = GH.spec
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
    const names = GH.spec.subcommands
      .filter((child) => child.name !== 'help')
      .map((child) => `  ${child.name}\n`)
      .sort(compareCodePoints)
    const asked = inv.texts.map((word) => `\`${word}\``).join(' ')
    const usage = `Usage:  gh <command> <subcommand> [flags]\n\nAvailable commands:\n${names.join('')}`
    return [null, new IOResult({ stderr: ENC.encode(`Unknown help topic [${asked}]\n${usage}`) })]
  }
  return [ENC.encode(nodeHelp(['gh', ...path].join(' '), node, GH.spec.usageStyle)), new IOResult()]
}

export const GH = new CLI({
  spec: new CommandSpec({
    name: 'gh',
    description: 'GitHub CLI',
    usageStyle: UsageStyle.COBRA,
    subcommands: [
      new CommandSpec({
        name: 'auth',
        description: 'Manage authentication',
        subcommands: [
          new CommandSpec({ name: 'status', description: 'Check the configured token' }),
          new CommandSpec({
            name: 'token',
            description: 'Token display is unavailable in Mirage',
            arguments: [
              new Argument('--hostname', {
                help: 'The hostname of the GitHub instance authenticated with',
              }),
              new Argument(['-u', '--user'], {
                help: 'The account selector; tokens are never printed',
              }),
            ],
          }),
        ],
      }),
      new CommandSpec({
        name: 'help',
        description: 'Help about any command',
        arguments: [new Argument('texts', { metavar: '', nargs: '*' })],
      }),
      new CommandSpec({
        name: 'version',
        aliases: ['--version'],
        description: 'Show the Mirage GitHub CLI implementation version',
      }),
      new CommandSpec({
        name: 'api',
        description: 'Make an authenticated GitHub API request',
        arguments: [
          new Argument(['-X', '--method']),
          new Argument(['-f', '--raw-field'], { action: 'append' }),
          new Argument(['-F', '--field'], { action: 'append' }),
          new Argument(['-H', '--header'], { action: 'append' }),
          flag({
            short: '-i',
            long: '--include',
            description: 'Include HTTP response status line and headers in the output',
          }),
          new Argument('--input', { type: 'path' }),
          JQ,
          flag({ long: '--paginate' }),
          flag({ long: '--slurp' }),
          flag({ long: '--silent' }),
          new Argument('ENDPOINT'),
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
  }),
  handlers: {
    ...searchHandlers(),
    'auth status': new CLIHandler({ fn: authStatus }),
    'auth token': new CLIHandler({ fn: authToken }),
    help: new CLIHandler({ fn: helpCmd }),
    version: new CLIHandler({ fn: version }),
    api: new CLIHandler({ fn: api, write: true }),
    'issue list': new CLIHandler({ fn: issueList }),
    'issue view': new CLIHandler({ fn: issueView }),
    'issue create': new CLIHandler({ fn: issueCreate, write: true }),
    'issue edit': new CLIHandler({ fn: issueEdit, write: true }),
    'issue close': new CLIHandler({ fn: issueClose, write: true }),
    'issue reopen': new CLIHandler({ fn: issueReopen, write: true }),
    'issue comment': new CLIHandler({ fn: issueComment, write: true }),
    'pr list': new CLIHandler({ fn: prList }),
    'pr view': new CLIHandler({ fn: prView }),
    'pr create': new CLIHandler({ fn: prCreate, write: true }),
    'pr edit': new CLIHandler({ fn: prEdit, write: true }),
    'pr merge': new CLIHandler({ fn: prMerge, write: true }),
    'pr close': new CLIHandler({ fn: prClose, write: true }),
    'pr comment': new CLIHandler({ fn: prComment, write: true }),
    'pr diff': new CLIHandler({ fn: prDiff }),
    'pr checks': new CLIHandler({ fn: prChecks }),
    'repo list': new CLIHandler({ fn: repoList }),
    'repo clone': new CLIHandler({ fn: repoClone }),
    'repo view': new CLIHandler({ fn: repoView }),
    'repo create': new CLIHandler({ fn: repoCreate, write: true }),
    'repo fork': new CLIHandler({ fn: fork, write: true }),
    'repo rename': new CLIHandler({ fn: rename, write: true }),
    'repo edit': new CLIHandler({ fn: repoEdit, write: true }),
    'repo delete': new CLIHandler({ fn: repoDelete, write: true }),
    'release list': new CLIHandler({ fn: releaseList }),
    'release view': new CLIHandler({ fn: releaseView }),
    'release create': new CLIHandler({ fn: releaseCreate, write: true }),
    'run list': new CLIHandler({ fn: runListCmd }),
    'run view': new CLIHandler({ fn: runViewCmd }),
    'run rerun': new CLIHandler({ fn: runRerunCmd, write: true }),
    'workflow list': new CLIHandler({ fn: workflowListCmd }),
    'workflow view': new CLIHandler({ fn: workflowViewCmd }),
    'workflow run': new CLIHandler({ fn: workflowRunCmd, write: true }),
  },
  configModel: GhConfigSchema,
})
