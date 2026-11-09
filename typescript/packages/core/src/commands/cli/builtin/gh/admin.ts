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

// Commands, flags and help lines from gh 2.85.0 (MIT; see
// licenses/third_party/gh.txt).

import { Argument, CommandSpec } from '../../../spec/types.ts'
import { flag, JQ, JSON as JSON_FIELDS, REPO, TEMPLATE } from './args.ts'

export function adminSpecs(): readonly CommandSpec[] {
  return [
    new CommandSpec({
      name: 'cache',
      description: 'Manage GitHub Actions caches',
      subcommands: [
        new CommandSpec({
          name: 'delete',
          description: 'Delete GitHub Actions caches',
          arguments: [
            REPO,
            flag({ short: '-a', long: '--all', description: 'Delete all caches' }),
            new Argument(['-r', '--ref'], {
              help: 'Delete by cache key and ref, formatted as refs/heads/<branch name> or refs/pull/<number>/merge',
            }),
            flag({
              long: '--succeed-on-no-caches',
              metavar: '--all',
              description:
                'Return exit code 0 if no caches found. Must be used in conjunction with --all',
            }),
            new Argument('CACHE-ID', { nargs: '*', metavar: '[<cache-id> | <cache-key> | --all]' }),
          ],
        }),
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'List GitHub Actions caches',
          arguments: [
            REPO,
            JQ,
            JSON_FIELDS,
            new Argument(['-k', '--key'], { help: 'Filter by cache key prefix' }),
            new Argument(['-L', '--limit'], {
              type: 'int',
              default: '30',
              help: 'Maximum number of caches to fetch',
            }),
            new Argument(['-O', '--order'], {
              choices: ['asc', 'desc'],
              default: 'desc',
              help: 'Order of caches returned',
            }),
            new Argument(['-r', '--ref'], {
              help: 'Filter by ref, formatted as refs/heads/<branch name> or refs/pull/<number>/merge',
            }),
            new Argument(['-S', '--sort'], {
              choices: ['created_at', 'last_accessed_at', 'size_in_bytes'],
              default: 'last_accessed_at',
              help: 'Sort fetched caches',
            }),
            TEMPLATE,
          ],
        }),
      ],
    }),
    new CommandSpec({
      name: 'gist',
      description: 'Manage gists',
      subcommands: [
        new CommandSpec({
          name: 'create',
          aliases: ['new'],
          description: 'Create a new GitHub gist with given contents',
          arguments: [
            new Argument(['-d', '--desc'], { help: 'A description for this gist' }),
            new Argument(['-f', '--filename'], {
              help: 'Provide a filename to be used when reading from standard input',
            }),
            flag({
              short: '-p',
              long: '--public',
              description: 'List the gist publicly (default "secret")',
            }),
            new Argument('FILENAME', { nargs: '*', metavar: '[<filename>... | <pattern>... | -]' }),
          ],
        }),
        new CommandSpec({
          name: 'delete',
          description: 'Delete a GitHub gist',
          arguments: [
            flag({ long: '--yes', description: 'Confirm deletion without prompting' }),
            new Argument('ID', { nargs: '*', metavar: '{<id> | <url>}' }),
          ],
        }),
        new CommandSpec({
          name: 'edit',
          description: 'Edit one of your gists',
          arguments: [
            new Argument(['-a', '--add'], { help: 'Add a new file to the gist' }),
            new Argument(['-d', '--desc'], { help: 'New description for the gist' }),
            new Argument(['-f', '--filename'], { help: 'Select a file to edit' }),
            new Argument(['-r', '--remove'], { help: 'Remove a file from the gist' }),
            new Argument('ID', { nargs: '*', metavar: '{<id> | <url>} [<filename>]' }),
          ],
        }),
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'List gists from your user account',
          arguments: [
            new Argument('--filter', {
              metavar: 'expression',
              help: 'Filter gists using a regular expression',
            }),
            flag({
              long: '--include-content',
              description: "Include gists' file content when filtering",
            }),
            new Argument(['-L', '--limit'], {
              type: 'int',
              default: '10',
              help: 'Maximum number of gists to fetch',
            }),
            flag({ long: '--public', description: 'Show only public gists' }),
            flag({ long: '--secret', description: 'Show only secret gists' }),
          ],
        }),
        new CommandSpec({
          name: 'rename',
          description: 'Rename a file in the given gist ID / URL',
          arguments: [
            new Argument('ID', {
              nargs: '*',
              metavar: '{<id> | <url>} <old-filename> <new-filename>',
            }),
          ],
        }),
        new CommandSpec({
          name: 'view',
          description: 'View the given gist or select from recent gists',
          arguments: [
            new Argument(['-f', '--filename'], { help: 'Display a single file from the gist' }),
            flag({ long: '--files', description: 'List file names from the gist' }),
            flag({
              short: '-r',
              long: '--raw',
              description: 'Print raw instead of rendered gist contents',
            }),
            new Argument('ID', { nargs: '*', metavar: '[<id> | <url>]' }),
          ],
        }),
        new CommandSpec({
          name: 'clone',
          description: 'Clone a GitHub gist locally',
          arguments: [
            new Argument('GIST', {
              nargs: '*',
              metavar: '<gist> [<directory>] [-- <gitflags>...]',
            }),
          ],
        }),
      ],
    }),
    new CommandSpec({
      name: 'label',
      description: 'Manage labels',
      subcommands: [
        new CommandSpec({
          name: 'clone',
          description:
            'Clones labels from a source repository to a destination repository on GitHub',
          arguments: [
            REPO,
            flag({
              short: '-f',
              long: '--force',
              description: 'Overwrite labels in the destination repository',
            }),
            new Argument('SOURCE-REPOSITORY', { nargs: '*', metavar: '<source-repository>' }),
          ],
        }),
        new CommandSpec({
          name: 'create',
          description: 'Create a new label on GitHub, or update an existing one with `--force`',
          arguments: [
            REPO,
            new Argument(['-c', '--color'], { help: 'Color of the label' }),
            new Argument(['-d', '--description'], { help: 'Description of the label' }),
            flag({
              short: '-f',
              long: '--force',
              description: 'Update the label color and description if label already exists',
            }),
            new Argument('NAME', { nargs: '*', metavar: '<name>' }),
          ],
        }),
        new CommandSpec({
          name: 'delete',
          description: 'Delete a label from a repository',
          arguments: [
            REPO,
            flag({ long: '--yes', description: 'Confirm deletion without prompting' }),
            new Argument('NAME', { nargs: '*', metavar: '<name>' }),
          ],
        }),
        new CommandSpec({
          name: 'edit',
          description: 'Update a label on GitHub',
          arguments: [
            REPO,
            new Argument(['-c', '--color'], { help: 'Color of the label' }),
            new Argument(['-d', '--description'], { help: 'Description of the label' }),
            new Argument(['-n', '--name'], { help: 'New name of the label' }),
            new Argument('NAME', { nargs: '*', metavar: '<name>' }),
          ],
        }),
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'Display labels in a GitHub repository',
          arguments: [
            REPO,
            JQ,
            JSON_FIELDS,
            new Argument(['-L', '--limit'], {
              type: 'int',
              default: '30',
              help: 'Maximum number of labels to fetch',
            }),
            new Argument('--order', {
              choices: ['asc', 'desc'],
              default: 'asc',
              help: 'Order of labels returned',
            }),
            new Argument(['-S', '--search'], { help: 'Search label names and descriptions' }),
            new Argument('--sort', {
              choices: ['created', 'name'],
              default: 'created',
              help: 'Sort fetched labels',
            }),
            TEMPLATE,
          ],
        }),
      ],
    }),
    new CommandSpec({
      name: 'org',
      description: 'Manage organizations',
      subcommands: [
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'List organizations for the authenticated user',
          arguments: [
            new Argument(['-L', '--limit'], {
              type: 'int',
              default: '30',
              help: 'Maximum number of organizations to list',
            }),
          ],
        }),
      ],
    }),
    new CommandSpec({
      name: 'ruleset',
      description: 'View info about repo rulesets',
      subcommands: [
        new CommandSpec({
          name: 'check',
          description: 'View information about GitHub rules that apply to a given branch',
          arguments: [
            REPO,
            flag({ long: '--default', description: 'Check rules on default branch' }),
            new Argument('BRANCH', { nargs: '*', metavar: '[<branch>]' }),
          ],
        }),
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'List GitHub rulesets for a repository or organization',
          arguments: [
            REPO,
            new Argument(['-L', '--limit'], {
              type: 'int',
              default: '30',
              help: 'Maximum number of rulesets to list',
            }),
            new Argument(['-o', '--org'], {
              help: 'List organization-wide rulesets for the provided organization',
            }),
            flag({
              short: '-p',
              long: '--parents',
              description:
                'Whether to include rulesets configured at higher levels that also apply (default true)',
            }),
          ],
        }),
        new CommandSpec({
          name: 'view',
          description: 'View information about a GitHub ruleset',
          arguments: [
            REPO,
            new Argument(['-o', '--org'], {
              help: 'Organization name if the provided ID is an organization-level ruleset',
            }),
            flag({
              short: '-p',
              long: '--parents',
              description:
                'Whether to include rulesets configured at higher levels that also apply (default true)',
            }),
            new Argument('RULESET-ID', { nargs: '*', metavar: '[<ruleset-id>]' }),
          ],
        }),
      ],
    }),
    new CommandSpec({
      name: 'secret',
      description: 'Manage GitHub secrets',
      subcommands: [
        new CommandSpec({
          name: 'delete',
          aliases: ['remove'],
          description: 'Delete a secret on one of the following levels:',
          arguments: [
            REPO,
            new Argument(['-a', '--app'], {
              choices: ['actions', 'codespaces', 'dependabot'],
              help: 'Delete a secret for a specific application',
            }),
            new Argument(['-e', '--env'], { help: 'Delete a secret for an environment' }),
            new Argument(['-o', '--org'], { help: 'Delete a secret for an organization' }),
            flag({ short: '-u', long: '--user', description: 'Delete a secret for your user' }),
            new Argument('SECRET-NAME', { nargs: '*', metavar: '<secret-name>' }),
          ],
        }),
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'List secrets on one of the following levels:',
          arguments: [
            REPO,
            new Argument(['-a', '--app'], {
              choices: ['actions', 'codespaces', 'dependabot'],
              help: 'List secrets for a specific application',
            }),
            new Argument(['-e', '--env'], { help: 'List secrets for an environment' }),
            JQ,
            JSON_FIELDS,
            new Argument(['-o', '--org'], { help: 'List secrets for an organization' }),
            TEMPLATE,
            flag({ short: '-u', long: '--user', description: 'List a secret for your user' }),
          ],
        }),
      ],
    }),
    new CommandSpec({
      name: 'variable',
      description: 'Manage GitHub Actions variables',
      subcommands: [
        new CommandSpec({
          name: 'delete',
          aliases: ['remove'],
          description: 'Delete a variable on one of the following levels:',
          arguments: [
            REPO,
            new Argument(['-e', '--env'], { help: 'Delete a variable for an environment' }),
            new Argument(['-o', '--org'], { help: 'Delete a variable for an organization' }),
            new Argument('VARIABLE-NAME', { nargs: '*', metavar: '<variable-name>' }),
          ],
        }),
        new CommandSpec({
          name: 'get',
          description: 'Get a variable on one of the following levels:',
          arguments: [
            REPO,
            new Argument(['-e', '--env'], { help: 'Get a variable for an environment' }),
            JQ,
            JSON_FIELDS,
            new Argument(['-o', '--org'], { help: 'Get a variable for an organization' }),
            TEMPLATE,
            new Argument('VARIABLE-NAME', { nargs: '*', metavar: '<variable-name>' }),
          ],
        }),
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'List variables on one of the following levels:',
          arguments: [
            REPO,
            new Argument(['-e', '--env'], { help: 'List variables for an environment' }),
            JQ,
            JSON_FIELDS,
            new Argument(['-o', '--org'], { help: 'List variables for an organization' }),
            TEMPLATE,
          ],
        }),
        new CommandSpec({
          name: 'set',
          description: 'Set a value for a variable on one of the following levels:',
          arguments: [
            REPO,
            new Argument(['-b', '--body'], {
              help: 'The value for the variable (reads from standard input if not specified)',
            }),
            new Argument(['-e', '--env'], {
              metavar: 'environment',
              help: 'Set deployment environment variable',
            }),
            new Argument(['-f', '--env-file'], {
              type: 'path',
              metavar: 'file',
              help: 'Load variable names and values from a dotenv-formatted file',
            }),
            new Argument(['-o', '--org'], {
              metavar: 'organization',
              help: 'Set organization variable',
            }),
            new Argument(['-r', '--repos'], {
              action: 'append',
              metavar: 'repositories',
              help: 'List of repositories that can access an organization variable',
            }),
            new Argument(['-v', '--visibility'], {
              choices: ['all', 'private', 'selected'],
              default: 'private',
              help: 'Set visibility for an organization variable',
            }),
            new Argument('VARIABLE-NAME', { nargs: '*', metavar: '<variable-name>' }),
          ],
        }),
      ],
    }),
  ]
}

export function repoGroupSpecs(): readonly CommandSpec[] {
  return [
    new CommandSpec({
      name: 'autolink',
      description: 'Manage autolink references',
      subcommands: [
        new CommandSpec({
          name: 'create',
          aliases: ['new'],
          description: 'Create a new autolink reference for a repository',
          arguments: [
            REPO,
            flag({ short: '-n', long: '--numeric', description: 'Mark autolink as numeric' }),
            new Argument('KEYPREFIX', { nargs: '*', metavar: '<keyPrefix> <urlTemplate>' }),
          ],
        }),
        new CommandSpec({
          name: 'delete',
          description: 'Delete an autolink reference for a repository',
          arguments: [
            REPO,
            flag({ long: '--yes', description: 'Confirm deletion without prompting' }),
            new Argument('ID', { nargs: '*', metavar: '<id>' }),
          ],
        }),
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'Gets all autolink references that are configured for a repository',
          arguments: [REPO, JQ, JSON_FIELDS, TEMPLATE],
        }),
        new CommandSpec({
          name: 'view',
          description: 'View an autolink reference for a repository',
          arguments: [
            REPO,
            JQ,
            JSON_FIELDS,
            TEMPLATE,
            new Argument('ID', { nargs: '*', metavar: '<id>' }),
          ],
        }),
      ],
    }),
    new CommandSpec({
      name: 'deploy-key',
      description: 'Manage deploy keys in a repository',
      subcommands: [
        new CommandSpec({
          name: 'add',
          description: 'Add a deploy key to a GitHub repository',
          arguments: [
            REPO,
            flag({
              short: '-w',
              long: '--allow-write',
              description: 'Allow write access for the key',
            }),
            new Argument(['-t', '--title'], { help: 'Title of the new key' }),
            new Argument('KEY-FILE', { nargs: '*', metavar: '<key-file>' }),
          ],
        }),
        new CommandSpec({
          name: 'delete',
          description: 'Delete a deploy key from a GitHub repository',
          arguments: [REPO, new Argument('KEY-ID', { nargs: '*', metavar: '<key-id>' })],
        }),
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'List deploy keys in a GitHub repository',
          arguments: [REPO, JQ, JSON_FIELDS, TEMPLATE],
        }),
      ],
    }),
    new CommandSpec({
      name: 'gitignore',
      description: 'List and view available repository gitignore templates',
      subcommands: [
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'List available repository gitignore templates',
        }),
        new CommandSpec({
          name: 'view',
          description: 'View an available repository `.gitignore` template',
          arguments: [new Argument('TEMPLATE', { nargs: '*', metavar: '<template>' })],
        }),
      ],
    }),
    new CommandSpec({
      name: 'license',
      description: 'Explore repository licenses',
      subcommands: [
        new CommandSpec({
          name: 'list',
          aliases: ['ls'],
          description: 'List common repository licenses',
        }),
        new CommandSpec({
          name: 'view',
          description: 'View a specific repository license by license key or SPDX ID',
          arguments: [
            new Argument('LICENSE-KEY', { nargs: '*', metavar: '{<license-key> | <spdx-id>}' }),
          ],
        }),
      ],
    }),
  ]
}
