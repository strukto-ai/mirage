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

import { GitHubAccount } from '../../../../accessor/github.ts'
import { GhConfig } from '../../../../core/github/config.ts'
import { IOResult } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { Argument, CommandSpec, UsageStyle } from '../../../spec/types.ts'
import { CLI, CLIHandler } from '../../types.ts'
import { findChild, nodeHelp } from '../../walk.ts'
import { BOOLEAN, HELP_TOPICS, REPO_EDIT_FIELDS } from './constants.ts'
import { cloneCmd as repoClone, gistCloneCmd } from './repo.ts'
import { adminSpecs, repoGroupSpecs } from './admin.ts'
import { flag, JQ, JSON as JSON_FIELDS, REPO, TEMPLATE } from './args.ts'
import { runLeaf } from './host.ts'
import { searchHandlers, searchSpec } from './search.ts'
import type { RepoEditField } from './types.ts'

const LIMIT_30 = new Argument(['-L', '--limit'], {
  type: 'int',
  default: '30',
  help: 'Maximum number of items to fetch',
})
const BODY = new Argument(['-b', '--body'], { help: 'Set the new body.' })
const BODY_FILE = new Argument(['-F', '--body-file'], {
  type: 'path',
  metavar: 'file',
  help: 'Read body text from file (use "-" to read from standard input)',
})
const TITLE = new Argument(['-t', '--title'], { help: 'Set the new title.' })
const REOPEN_COMMENT = new Argument(['-c', '--comment'], { help: 'Add a reopening comment' })
const NUMBER = new Argument('NUMBER', { metavar: '[<number> | <url> | <branch>]' })

// The grammar and request mapping consume the same setting definition.
function repoEditOption(field: RepoEditField): Argument {
  return new Argument([...(field.short === undefined ? [] : [field.short]), field.flag], {
    nargs: field.kind !== 'value' ? '?' : null,
    attachedOnly: field.kind !== 'value',
    choices: field.kind === 'value' ? [...(field.choices ?? [])] : BOOLEAN,
    metavar: field.metavar ?? null,
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
          new Argument(['-L', '--limit'], {
            type: 'int',
            default: '30',
            help: 'Maximum number of issues to fetch',
          }),
          new Argument(['-s', '--state'], {
            choices: ['open', 'closed', 'all'],
            default: 'open',
            help: 'Filter by state',
          }),
          new Argument(['-a', '--assignee'], { help: 'Filter by assignee' }),
          new Argument(['-A', '--author'], { help: 'Filter by author' }),
          new Argument(['-l', '--label'], { action: 'append', help: 'Filter by label' }),
          new Argument('--app', { help: 'Filter by GitHub App author' }),
          new Argument('--mention', { help: 'Filter by mention' }),
          new Argument(['-m', '--milestone'], { help: 'Filter by milestone number or title' }),
          new Argument(['-S', '--search'], { metavar: 'query', help: 'Search issues with query' }),
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View an issue',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          flag({ short: '-c', long: '--comments', description: 'View issue comments' }),
          new Argument('NUMBER', { metavar: '{<number> | <url>}' }),
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'create',
        aliases: ['new'],
        description: 'Create an issue',
        arguments: [
          REPO,
          new Argument(['-t', '--title'], {
            help: 'Supply a title. Will prompt for one otherwise.',
          }),
          new Argument(['-b', '--body'], { help: 'Supply a body. Will prompt for one otherwise.' }),
          BODY_FILE,
          new Argument(['-a', '--assignee'], {
            action: 'append',
            metavar: 'login',
            help: 'Assign people by their login. Use "@me" to self-assign.',
          }),
          new Argument(['-l', '--label'], {
            action: 'append',
            metavar: 'name',
            help: 'Add labels by name',
          }),
          new Argument(['-m', '--milestone'], {
            metavar: 'name',
            help: 'Add the issue to a milestone by name',
          }),
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
          new Argument('--add-assignee', {
            action: 'append',
            metavar: 'login',
            help: 'Add assigned users by their login. Use "@me" to assign yourself, or "@copilot" to assign Copilot.',
          }),
          new Argument('--remove-assignee', {
            action: 'append',
            metavar: 'login',
            help: 'Remove assigned users by their login. Use "@me" to unassign yourself, or "@copilot" to unassign Copilot.',
          }),
          new Argument('--add-label', {
            action: 'append',
            metavar: 'name',
            help: 'Add labels by name',
          }),
          new Argument('--remove-label', {
            action: 'append',
            metavar: 'name',
            help: 'Remove labels by name',
          }),
          new Argument('NUMBER', { metavar: '{<numbers> | <urls>}' }),
          new Argument(['-m', '--milestone'], {
            metavar: 'name',
            help: 'Edit the milestone the issue belongs to by name',
          }),
          flag({
            long: '--remove-milestone',
            description: 'Remove the milestone association from the issue',
          }),
        ],
      }),
      new CommandSpec({
        name: 'close',
        description: 'Close an issue',
        arguments: [
          REPO,
          new Argument('NUMBER', { metavar: '{<number> | <url>}' }),
          new Argument(['-c', '--comment'], { help: 'Leave a closing comment' }),
          new Argument(['-r', '--reason'], {
            choices: ['completed', 'not planned'],
            help: 'Reason for closing',
          }),
        ],
      }),
      new CommandSpec({
        name: 'reopen',
        description: 'Reopen an issue',
        arguments: [
          REPO,
          REOPEN_COMMENT,
          new Argument('NUMBER', { metavar: '{<number> | <url>}' }),
        ],
      }),
      new CommandSpec({
        name: 'comment',
        description: 'Add a comment to an issue',
        arguments: [
          REPO,
          new Argument(['-b', '--body'], { metavar: 'text', help: 'The comment body text' }),
          BODY_FILE,
          new Argument('NUMBER', { metavar: '{<number> | <url>}' }),
          flag({
            long: '--create-if-none',
            description:
              'Create a new comment if no comments are found. Can be used only with --edit-last',
          }),
          flag({
            long: '--delete-last',
            description: 'Delete the last comment of the current user',
          }),
          flag({ long: '--edit-last', description: 'Edit the last comment of the current user' }),
          flag({
            long: '--yes',
            description: 'Skip the delete confirmation prompt when --delete-last is provided',
          }),
        ],
      }),
      new CommandSpec({
        name: 'delete',
        description: 'Delete issue',
        arguments: [
          REPO,
          flag({ long: '--yes', description: 'Confirm deletion without prompting' }),
          new Argument('NUMBER', { nargs: '*', metavar: '{<number> | <url>}' }),
        ],
      }),
      new CommandSpec({
        name: 'lock',
        description: 'Lock issue conversation',
        arguments: [
          REPO,
          new Argument(['-r', '--reason'], {
            help: 'Optional reason for locking conversation (off_topic, resolved, spam, too_heated).',
          }),
          new Argument('NUMBER', { nargs: '*', metavar: '{<number> | <url>}' }),
        ],
      }),
      new CommandSpec({
        name: 'pin',
        description: 'Pin an issue to a repository',
        arguments: [REPO, new Argument('NUMBER', { nargs: '*', metavar: '{<number> | <url>}' })],
      }),
      new CommandSpec({
        name: 'status',
        description: 'Show status of relevant issues',
        arguments: [REPO, JQ, JSON_FIELDS, TEMPLATE],
      }),
      new CommandSpec({
        name: 'transfer',
        description: 'Transfer issue to another repository',
        arguments: [
          REPO,
          new Argument('NUMBER', { nargs: '*', metavar: '{<number> | <url>} <destination-repo>' }),
        ],
      }),
      new CommandSpec({
        name: 'unlock',
        description: 'Unlock issue conversation',
        arguments: [REPO, new Argument('NUMBER', { nargs: '*', metavar: '{<number> | <url>}' })],
      }),
      new CommandSpec({
        name: 'unpin',
        description: 'Unpin an issue from a repository',
        arguments: [REPO, new Argument('NUMBER', { nargs: '*', metavar: '{<number> | <url>}' })],
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
            help: 'Filter by state',
          }),
          new Argument(['-B', '--base'], { help: 'Filter by base branch' }),
          new Argument(['-H', '--head'], {
            help: 'Filter by head branch ("<owner>:<branch>" syntax not supported)',
          }),
          new Argument('--app', { help: 'Filter by GitHub App author' }),
          new Argument(['-a', '--assignee'], { help: 'Filter by assignee' }),
          new Argument(['-A', '--author'], { help: 'Filter by author' }),
          flag({ short: '-d', long: '--draft', description: 'Filter by draft state' }),
          new Argument(['-l', '--label'], { action: 'append', help: 'Filter by label' }),
          new Argument(['-S', '--search'], {
            metavar: 'query',
            help: 'Search pull requests with query',
          }),
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View a pull request',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          flag({ short: '-c', long: '--comments', description: 'View pull request comments' }),
          NUMBER,
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'create',
        aliases: ['new'],
        description: 'Create a pull request',
        arguments: [
          REPO,
          new Argument(['-t', '--title'], { help: 'Title for the pull request' }),
          new Argument(['-b', '--body'], { help: 'Body for the pull request' }),
          BODY_FILE,
          new Argument(['-H', '--head'], {
            metavar: 'branch',
            help: 'The branch that contains commits for your pull request (default [current branch])',
          }),
          new Argument(['-B', '--base'], {
            metavar: 'branch',
            help: 'The branch into which you want your code merged',
          }),
          flag({ short: '-d', long: '--draft', description: 'Mark pull request as a draft' }),
          flag({
            long: '--no-maintainer-edit',
            description: "Disable maintainer's ability to modify pull request",
          }),
          new Argument(['-a', '--assignee'], {
            action: 'append',
            metavar: 'login',
            help: 'Assign people by their login. Use "@me" to self-assign.',
          }),
          new Argument(['-l', '--label'], {
            action: 'append',
            metavar: 'name',
            help: 'Add labels by name',
          }),
          new Argument(['-m', '--milestone'], {
            metavar: 'name',
            help: 'Add the pull request to a milestone by name',
          }),
          new Argument(['-r', '--reviewer'], {
            action: 'append',
            metavar: 'handle',
            help: 'Request reviews from people or teams by their handle',
          }),
        ],
      }),
      new CommandSpec({
        name: 'edit',
        description: 'Edit a pull request',
        arguments: [
          REPO,
          TITLE,
          BODY,
          BODY_FILE,
          new Argument(['-B', '--base'], {
            metavar: 'branch',
            help: 'Change the base branch for this pull request',
          }),
          NUMBER,
          new Argument('--add-assignee', {
            action: 'append',
            metavar: 'login',
            help: 'Add assigned users by their login. Use "@me" to assign yourself, or "@copilot" to assign Copilot.',
          }),
          new Argument('--add-label', {
            action: 'append',
            metavar: 'name',
            help: 'Add labels by name',
          }),
          new Argument('--add-reviewer', {
            action: 'append',
            metavar: 'login',
            help: 'Add reviewers by their login.',
          }),
          new Argument(['-m', '--milestone'], {
            metavar: 'name',
            help: 'Edit the milestone the pull request belongs to by name',
          }),
          new Argument('--remove-assignee', {
            action: 'append',
            metavar: 'login',
            help: 'Remove assigned users by their login. Use "@me" to unassign yourself, or "@copilot" to unassign Copilot.',
          }),
          new Argument('--remove-label', {
            action: 'append',
            metavar: 'name',
            help: 'Remove labels by name',
          }),
          flag({
            long: '--remove-milestone',
            description: 'Remove the milestone association from the pull request',
          }),
          new Argument('--remove-reviewer', {
            action: 'append',
            metavar: 'login',
            help: 'Remove reviewers by their login.',
          }),
        ],
      }),
      new CommandSpec({
        name: 'merge',
        description: 'Merge a pull request',
        arguments: [
          REPO,
          new Argument(['-b', '--body'], {
            metavar: 'text',
            help: 'Body text for the merge commit',
          }),
          BODY_FILE,
          flag({
            short: '-m',
            long: '--merge',
            description: 'Merge the commits with the base branch',
          }),
          flag({
            short: '-r',
            long: '--rebase',
            description: 'Rebase the commits onto the base branch',
          }),
          flag({
            short: '-s',
            long: '--squash',
            description: 'Squash the commits into one commit and merge it into the base branch',
          }),
          new Argument(['-t', '--subject'], {
            metavar: 'text',
            help: 'Subject text for the merge commit',
          }),
          new Argument('--match-head-commit', {
            metavar: 'SHA',
            help: 'Commit SHA that the pull request head must match to allow merge',
          }),
          NUMBER,
          flag({
            long: '--admin',
            description:
              'Use administrator privileges to merge a pull request that does not meet requirements',
          }),
          new Argument(['-A', '--author-email'], {
            metavar: 'text',
            help: 'Email text for merge commit author',
          }),
          flag({
            long: '--auto',
            description: 'Automatically merge only after necessary requirements are met',
          }),
          flag({
            short: '-d',
            long: '--delete-branch',
            description: 'Delete the local and remote branch after merge',
          }),
          flag({ long: '--disable-auto', description: 'Disable auto-merge for this pull request' }),
        ],
      }),
      new CommandSpec({
        name: 'close',
        description: 'Close a pull request',
        arguments: [
          REPO,
          new Argument('NUMBER', { metavar: '{<number> | <url> | <branch>}' }),
          new Argument(['-c', '--comment'], { help: 'Leave a closing comment' }),
          flag({
            short: '-d',
            long: '--delete-branch',
            description: 'Delete the local and remote branch after close',
          }),
        ],
      }),
      new CommandSpec({
        name: 'reopen',
        description: 'Reopen a pull request',
        arguments: [
          REPO,
          REOPEN_COMMENT,
          new Argument('NUMBER', { metavar: '{<number> | <url> | <branch>}' }),
        ],
      }),
      new CommandSpec({
        name: 'comment',
        description: 'Add a comment to a pull request',
        arguments: [
          REPO,
          new Argument(['-b', '--body'], { metavar: 'text', help: 'The comment body text' }),
          BODY_FILE,
          NUMBER,
          flag({
            long: '--create-if-none',
            description:
              'Create a new comment if no comments are found. Can be used only with --edit-last',
          }),
          flag({
            long: '--delete-last',
            description: 'Delete the last comment of the current user',
          }),
          flag({ long: '--edit-last', description: 'Edit the last comment of the current user' }),
          flag({
            long: '--yes',
            description: 'Skip the delete confirmation prompt when --delete-last is provided',
          }),
        ],
      }),
      new CommandSpec({
        name: 'diff',
        description: 'View changes in a pull request',
        arguments: [
          REPO,
          flag({ long: '--name-only', description: 'Display only names of changed files' }),
          NUMBER,
          new Argument('--color', {
            choices: ['always', 'never', 'auto'],
            default: 'auto',
            help: 'Use color in diff output',
          }),
          flag({ long: '--patch', description: 'Display diff in patch format' }),
        ],
      }),
      new CommandSpec({
        name: 'checks',
        description: 'Show CI checks for a pull request',
        arguments: [REPO, JSON_FIELDS, JQ, NUMBER, TEMPLATE],
      }),
      new CommandSpec({
        name: 'lock',
        description: 'Lock pull request conversation',
        arguments: [
          REPO,
          new Argument(['-r', '--reason'], {
            help: 'Optional reason for locking conversation (off_topic, resolved, spam, too_heated).',
          }),
          new Argument('NUMBER', { nargs: '*', metavar: '{<number> | <url>}' }),
        ],
      }),
      new CommandSpec({
        name: 'ready',
        description: 'Mark a pull request as ready for review',
        arguments: [
          REPO,
          flag({ long: '--undo', description: 'Convert a pull request to "draft"' }),
          new Argument('NUMBER', { nargs: '*', metavar: '[<number> | <url> | <branch>]' }),
        ],
      }),
      new CommandSpec({
        name: 'revert',
        description: 'Revert a pull request',
        arguments: [
          REPO,
          new Argument(['-b', '--body'], { help: 'Body for the revert pull request' }),
          new Argument(['-F', '--body-file'], {
            type: 'path',
            metavar: 'file',
            help: 'Read body text from file (use "-" to read from standard input)',
          }),
          flag({
            short: '-d',
            long: '--draft',
            description: 'Mark revert pull request as a draft',
          }),
          new Argument(['-t', '--title'], { help: 'Title for the revert pull request' }),
          new Argument('NUMBER', { nargs: '*', metavar: '{<number> | <url> | <branch>}' }),
        ],
      }),
      new CommandSpec({
        name: 'review',
        description: 'Add a review to a pull request',
        arguments: [
          REPO,
          flag({ short: '-a', long: '--approve', description: 'Approve pull request' }),
          new Argument(['-b', '--body'], { help: 'Specify the body of a review' }),
          new Argument(['-F', '--body-file'], {
            type: 'path',
            metavar: 'file',
            help: 'Read body text from file (use "-" to read from standard input)',
          }),
          flag({ short: '-c', long: '--comment', description: 'Comment on a pull request' }),
          flag({
            short: '-r',
            long: '--request-changes',
            description: 'Request changes on a pull request',
          }),
          new Argument('NUMBER', { nargs: '*', metavar: '[<number> | <url> | <branch>]' }),
        ],
      }),
      new CommandSpec({
        name: 'status',
        description: 'Show status of relevant pull requests',
        arguments: [
          REPO,
          flag({
            short: '-c',
            long: '--conflict-status',
            description: 'Display the merge conflict status of each pull request',
          }),
          JQ,
          JSON_FIELDS,
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'unlock',
        description: 'Unlock pull request conversation',
        arguments: [REPO, new Argument('NUMBER', { nargs: '*', metavar: '{<number> | <url>}' })],
      }),
      new CommandSpec({
        name: 'update-branch',
        description: 'Update a pull request branch with latest changes of the base branch',
        arguments: [
          REPO,
          flag({
            long: '--rebase',
            description: 'Update PR branch by rebasing on top of latest base branch',
          }),
          new Argument('NUMBER', { nargs: '*', metavar: '[<number> | <url> | <branch>]' }),
        ],
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
        arguments: [
          JSON_FIELDS,
          JQ,
          new Argument(['-L', '--limit'], {
            type: 'int',
            default: '30',
            help: 'Maximum number of repositories to list',
          }),
          new Argument('OWNER', { nargs: '?', metavar: '[<owner>]' }),
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'clone',
        description: 'Clone a repository locally',
        arguments: [
          new Argument(['-u', '--upstream-remote-name'], {
            help: 'Upstream remote name when cloning a fork (default "upstream")',
          }),
          flag({
            long: '--no-upstream',
            description: 'Do not add an upstream remote when cloning a fork',
          }),
          new Argument('REPOSITORY', { nargs: '?', metavar: '<repository>' }),
          new Argument('DIRECTORY', { nargs: '?', metavar: '[<directory>]' }),
          new Argument('GITFLAGS', { nargs: '*', metavar: '[-- <gitflags>...]' }),
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View a repository',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          new Argument('REPOSITORY', { nargs: '?', metavar: '[<repository>]' }),
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'create',
        description: 'Create a repository',
        arguments: [
          flag({ long: '--public', description: 'Make the new repository public' }),
          flag({ long: '--private', description: 'Make the new repository private' }),
          new Argument(['-d', '--description'], { help: 'Description of the repository' }),
          new Argument(['-h', '--homepage'], { metavar: 'URL', help: 'Repository home page URL' }),
          flag({ long: '--add-readme', description: 'Add a README file to the new repository' }),
          new Argument('NAME', { nargs: '?', metavar: '[<name>]' }),
          flag({ long: '--disable-issues', description: 'Disable issues in the new repository' }),
          flag({ long: '--disable-wiki', description: 'Disable wiki in the new repository' }),
          new Argument(['-g', '--gitignore'], {
            help: 'Specify a gitignore template for the repository',
          }),
          flag({ long: '--internal', description: 'Make the new repository internal' }),
          new Argument(['-l', '--license'], {
            help: 'Specify an Open Source License for the repository',
          }),
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
          new Argument('--remote-name', {
            help: 'Specify the name for the new remote (default "origin")',
          }),
          new Argument('REPOSITORY', { nargs: '?', metavar: '[<repository>] [-- <gitflags>...]' }),
        ],
      }),
      new CommandSpec({
        name: 'rename',
        description: 'Rename a repository',
        arguments: [
          new Argument(['-R', '--repo'], {
            metavar: '[HOST/]OWNER/REPO',
            help: 'Select another repository using the [HOST/]OWNER/REPO format',
          }),
          new Argument('NEW-NAME', { metavar: '[<new-name>]' }),
          flag({ short: '-y', long: '--yes', description: 'Skip the confirmation prompt' }),
        ],
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
          new Argument('REPOSITORY', { nargs: '?', metavar: '[<repository>]' }),
        ],
      }),
      new CommandSpec({
        name: 'delete',
        description: 'Delete a repository',
        arguments: [
          flag({ long: '--yes', description: 'Confirm deletion without prompting' }),
          flag({ long: '--confirm', description: 'Deprecated: use --yes instead' }),
          new Argument('REPOSITORY', { nargs: '?', metavar: '[<repository>]' }),
        ],
      }),
      new CommandSpec({
        name: 'archive',
        description: 'Archive a GitHub repository',
        arguments: [
          flag({ short: '-y', long: '--yes', description: 'Skip the confirmation prompt' }),
          new Argument('REPOSITORY', { nargs: '*', metavar: '[<repository>]' }),
        ],
      }),
      new CommandSpec({
        name: 'sync',
        description: 'Sync destination repository from source repository',
        arguments: [
          new Argument(['-b', '--branch'], {
            help: 'Branch to sync (default [default branch])',
          }),
          flag({
            long: '--force',
            description:
              'Hard reset the branch of the destination repository to match the source repository',
          }),
          new Argument(['-s', '--source'], { help: 'Source repository' }),
          new Argument('DESTINATION-REPOSITORY', {
            nargs: '*',
            metavar: '[<destination-repository>]',
          }),
        ],
      }),
      new CommandSpec({
        name: 'unarchive',
        description: 'Unarchive a GitHub repository',
        arguments: [
          flag({ short: '-y', long: '--yes', description: 'Skip the confirmation prompt' }),
          new Argument('REPOSITORY', { nargs: '*', metavar: '[<repository>]' }),
        ],
      }),
      ...repoGroupSpecs(),
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
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          LIMIT_30,
          flag({ long: '--exclude-drafts', description: 'Exclude draft releases' }),
          flag({ long: '--exclude-pre-releases', description: 'Exclude pre-releases' }),
          new Argument(['-O', '--order'], {
            choices: ['asc', 'desc'],
            default: 'desc',
            help: 'Order of releases returned',
          }),
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View a release',
        arguments: [REPO, JSON_FIELDS, JQ, new Argument('TAG', { metavar: '[<tag>]' }), TEMPLATE],
      }),
      new CommandSpec({
        name: 'create',
        description: 'Create a release',
        arguments: [
          REPO,
          new Argument(['-n', '--notes'], { help: 'Release notes' }),
          new Argument(['-F', '--notes-file'], {
            type: 'path',
            metavar: 'file',
            help: 'Read release notes from file (use "-" to read from standard input)',
          }),
          new Argument(['-t', '--title'], { help: 'Release title' }),
          flag({
            short: '-d',
            long: '--draft',
            description: 'Save the release as a draft instead of publishing it',
          }),
          flag({
            short: '-p',
            long: '--prerelease',
            description: 'Mark the release as a prerelease',
          }),
          flag({
            long: '--generate-notes',
            description:
              'Automatically generate title and notes for the release via GitHub Release Notes API',
          }),
          new Argument('--target', {
            metavar: 'branch',
            help: 'Target branch or full commit SHA (default [main branch])',
          }),
          new Argument('TAG', { metavar: '[<tag>] [<filename>... | <pattern>...]' }),
          new Argument('--discussion-category', {
            help: 'Start a discussion in the specified category',
          }),
          flag({
            long: '--latest',
            description:
              'Mark this release as "Latest" (default [automatic based on date and version]). --latest=false to explicitly NOT set as latest',
          }),
        ],
      }),
      new CommandSpec({
        name: 'delete',
        description: 'Delete a release',
        arguments: [
          REPO,
          flag({
            long: '--cleanup-tag',
            description: 'Delete the specified tag in addition to its release',
          }),
          flag({ short: '-y', long: '--yes', description: 'Skip the confirmation prompt' }),
          new Argument('TAG', { nargs: '*', metavar: '<tag>' }),
        ],
      }),
      new CommandSpec({
        name: 'delete-asset',
        description: 'Delete an asset from a release',
        arguments: [
          REPO,
          flag({ short: '-y', long: '--yes', description: 'Skip the confirmation prompt' }),
          new Argument('TAG', { nargs: '*', metavar: '<tag> <asset-name>' }),
        ],
      }),
      new CommandSpec({
        name: 'edit',
        description: 'Edit a release',
        arguments: [
          REPO,
          new Argument('--discussion-category', {
            help: 'Start a discussion in the specified category when publishing a draft',
          }),
          flag({
            long: '--draft',
            description: 'Save the release as a draft instead of publishing it',
          }),
          flag({ long: '--latest', description: 'Explicitly mark the release as "Latest"' }),
          new Argument(['-n', '--notes'], { help: 'Release notes' }),
          new Argument(['-F', '--notes-file'], {
            type: 'path',
            metavar: 'file',
            help: 'Read release notes from file (use "-" to read from standard input)',
          }),
          flag({ long: '--prerelease', description: 'Mark the release as a prerelease' }),
          new Argument('--tag', { help: 'The name of the tag' }),
          new Argument('--target', {
            metavar: 'branch',
            help: 'Target branch or full commit SHA (default [main branch])',
          }),
          new Argument(['-t', '--title'], { help: 'Release title' }),
          flag({
            long: '--verify-tag',
            description: "Abort in case the git tag doesn't already exist in the remote repository",
          }),
          new Argument('TAG', { nargs: '*', metavar: '<tag>' }),
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
          new Argument(['-L', '--limit'], {
            type: 'int',
            default: '20',
            help: 'Maximum number of runs to fetch',
          }),
          new Argument(['-b', '--branch'], { help: 'Filter runs by branch' }),
          new Argument(['-c', '--commit'], {
            metavar: 'SHA',
            help: 'Filter runs by the SHA of the commit',
          }),
          new Argument('--created', {
            metavar: 'date',
            help: 'Filter runs by the date it was created',
          }),
          new Argument(['-e', '--event'], {
            metavar: 'event',
            help: 'Filter runs by which event triggered the run',
          }),
          new Argument(['-s', '--status'], {
            help: 'Filter runs by status: {queued|completed|in_progress|requested|waiting|pending|action_required|cancelled|failure|neutral|skipped|stale|startup_failure|success|timed_out}',
          }),
          new Argument(['-u', '--user'], { help: 'Filter runs by user who triggered the run' }),
          new Argument(['-w', '--workflow'], { help: 'Filter runs by workflow' }),
          flag({ short: '-a', long: '--all', description: 'Include disabled workflows' }),
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'view',
        description: 'View a workflow run',
        arguments: [
          REPO,
          JSON_FIELDS,
          JQ,
          flag({ long: '--exit-status', description: 'Exit with non-zero status if run failed' }),
          flag({ long: '--log', description: 'View full log for either a run or specific job' }),
          flag({
            long: '--log-failed',
            description: 'View the log for any failed steps in a run or specific job',
          }),
          new Argument('RUN-ID', { metavar: '[<run-id>]' }),
          TEMPLATE,
        ],
      }),
      new CommandSpec({
        name: 'rerun',
        description: 'Rerun a workflow run',
        arguments: [
          REPO,
          flag({ short: '-d', long: '--debug', description: 'Rerun with debug logging' }),
          flag({ long: '--failed', description: 'Rerun only failed jobs, including dependencies' }),
          new Argument(['-j', '--job'], {
            help: 'Rerun a specific job ID from a run, including dependencies',
          }),
          new Argument('RUN-ID', { metavar: '[<run-id>]' }),
        ],
      }),
      new CommandSpec({
        name: 'cancel',
        description: 'Cancel a workflow run',
        arguments: [
          REPO,
          flag({ long: '--force', description: 'Force cancel a workflow run' }),
          new Argument('RUN-ID', { nargs: '*', metavar: '[<run-id>]' }),
        ],
      }),
      new CommandSpec({
        name: 'delete',
        description: 'Delete a workflow run',
        arguments: [REPO, new Argument('RUN-ID', { nargs: '*', metavar: '[<run-id>]' })],
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
          new Argument(['-L', '--limit'], {
            type: 'int',
            default: '50',
            help: 'Maximum number of workflows to fetch',
          }),
          flag({ short: '-a', long: '--all', description: 'Include disabled workflows' }),
          TEMPLATE,
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
          new Argument('WORKFLOW', { metavar: '[<workflow-id> | <workflow-name> | <filename>]' }),
        ],
      }),
      new CommandSpec({
        name: 'run',
        description: 'Run a workflow',
        arguments: [
          REPO,
          new Argument(['-r', '--ref'], {
            help: "Branch or tag name which contains the version of the workflow file you'd like to run",
          }),
          new Argument(['-f', '--raw-field'], {
            action: 'append',
            metavar: 'key=value',
            help: 'Add a string parameter in key=value format',
          }),
          new Argument(['-F', '--field'], {
            action: 'append',
            metavar: 'key=value',
            help: 'Add a string parameter in key=value format, respecting @ syntax (see "gh help api").',
          }),
          flag({ long: '--json', description: 'Read workflow inputs as JSON via STDIN' }),
          new Argument('WORKFLOW', { metavar: '[<workflow-id> | <workflow-name>]' }),
        ],
      }),
      new CommandSpec({
        name: 'disable',
        description:
          'Disable a workflow, preventing it from running or showing up when listing workflows',
        arguments: [
          REPO,
          new Argument('WORKFLOW-ID', { nargs: '*', metavar: '[<workflow-id> | <workflow-name>]' }),
        ],
      }),
      new CommandSpec({
        name: 'enable',
        description: 'Enable a workflow, allowing it to be run and show up when listing workflows',
        arguments: [
          REPO,
          new Argument('WORKFLOW-ID', { nargs: '*', metavar: '[<workflow-id> | <workflow-name>]' }),
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
function helpCmd(
  _accessor: GitHubAccount,
  _paths: PathSpec[],
  texts: string[],
  _ctx: Context,
): CommandFnResult {
  let node: CommandSpec = GH.spec
  const path: string[] = []
  for (const word of texts) {
    const child = findChild(node, word)
    if (child === null) break
    node = child
    path.push(child.name)
  }
  const first = texts[0]
  if (first !== undefined && path.length === 0) {
    const topic = HELP_TOPICS[first]
    if (topic !== undefined) return [ENC.encode(topic), new IOResult()]
    const names = GH.spec.subcommands
      .filter((child) => child.name !== 'help')
      .map((child) => `  ${child.name}\n`)
      .sort(compareCodePoints)
    const asked = texts.map((word) => `\`${word}\``).join(' ')
    const usage = `Usage:  gh <command> <subcommand> [flags]\n\nAvailable commands:\n${names.join('')}`
    return [null, new IOResult({ stderr: ENC.encode(`Unknown help topic [${asked}]\n${usage}`) })]
  }
  return [ENC.encode(nodeHelp(['gh', ...path].join(' '), node, GH.spec.usageStyle)), new IOResult()]
}

const READS = [
  'auth status',
  'auth token',
  'version',
  'issue list',
  'issue view',
  'pr list',
  'pr view',
  'pr diff',
  'pr checks',
  'repo list',
  'repo view',
  'release list',
  'release view',
  'run list',
  'run view',
  'workflow list',
  'workflow view',
  'cache list',
  'gist list',
  'gist view',
  'issue status',
  'label list',
  'org list',
  'pr status',
  'repo autolink list',
  'repo autolink view',
  'repo deploy-key list',
  'repo gitignore list',
  'repo gitignore view',
  'repo license list',
  'repo license view',
  'ruleset check',
  'ruleset list',
  'ruleset view',
  'secret list',
  'variable get',
  'variable list',
]
const WRITES = [
  'api',
  'issue create',
  'issue edit',
  'issue close',
  'issue reopen',
  'issue comment',
  'pr create',
  'pr edit',
  'pr merge',
  'pr close',
  'pr reopen',
  'pr comment',
  'repo create',
  'repo fork',
  'repo rename',
  'repo edit',
  'repo delete',
  'release create',
  'run rerun',
  'workflow run',
  'cache delete',
  'gist create',
  'gist delete',
  'gist edit',
  'gist rename',
  'issue delete',
  'issue lock',
  'issue pin',
  'issue transfer',
  'issue unlock',
  'issue unpin',
  'label clone',
  'label create',
  'label delete',
  'label edit',
  'pr lock',
  'pr ready',
  'pr revert',
  'pr review',
  'pr unlock',
  'pr update-branch',
  'release delete',
  'release delete-asset',
  'release edit',
  'repo archive',
  'repo autolink create',
  'repo autolink delete',
  'repo deploy-key add',
  'repo deploy-key delete',
  'repo sync',
  'repo unarchive',
  'run cancel',
  'run delete',
  'secret delete',
  'variable delete',
  'variable set',
  'workflow disable',
  'workflow enable',
]

function leaf(name: string, write = false): CLIHandler {
  return new CLIHandler({
    fn: (accessor, paths, texts, ctx) =>
      runLeaf(name, accessor as GitHubAccount, paths, texts, ctx),
    write,
  })
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
              new Argument(['-h', '--hostname'], {
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
        arguments: [new Argument('texts', { nargs: '*', metavar: '[command]' })],
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
          new Argument(['-X', '--method'], {
            help: 'The HTTP method for the request (default "GET")',
          }),
          new Argument(['-f', '--raw-field'], {
            action: 'append',
            metavar: 'key=value',
            help: 'Add a string parameter in key=value format',
          }),
          new Argument(['-F', '--field'], {
            action: 'append',
            metavar: 'key=value',
            help: 'Add a typed parameter in key=value format (use "@<path>" or "@-" to read value from file or stdin)',
          }),
          new Argument(['-H', '--header'], {
            action: 'append',
            metavar: 'key:value',
            help: 'Add a HTTP request header in key:value format',
          }),
          flag({
            short: '-i',
            long: '--include',
            description: 'Include HTTP response status line and headers in the output',
          }),
          new Argument('--input', {
            type: 'path',
            metavar: 'file',
            help: 'The file to use as body for the HTTP request (use "-" to read from standard input)',
          }),
          new Argument(['-q', '--jq'], {
            help: 'Query to select values from the response using jq syntax',
          }),
          flag({
            long: '--paginate',
            description: 'Make additional HTTP requests to fetch all pages of results',
          }),
          flag({
            long: '--slurp',
            description:
              'Use with "--paginate" to return an array of all pages of either JSON arrays or objects',
          }),
          flag({ long: '--silent', description: 'Do not print the response body' }),
          new Argument('ENDPOINT', { metavar: '<endpoint>' }),
        ],
      }),
      issue(),
      pr(),
      repo(),
      release(),
      run(),
      workflow(),
      searchSpec(),
      ...adminSpecs(),
    ],
  }),
  handlers: {
    ...searchHandlers(),
    ...Object.fromEntries(READS.map((name) => [name, leaf(name)])),
    ...Object.fromEntries(WRITES.map((name) => [name, leaf(name, true)])),
    help: new CLIHandler({ fn: helpCmd }),
    'repo clone': new CLIHandler({ fn: repoClone }),
    'gist clone': new CLIHandler({ fn: gistCloneCmd }),
  },
  configModel: GhConfig,
  accessor: (config) => new GitHubAccount(config as GhConfig),
})
