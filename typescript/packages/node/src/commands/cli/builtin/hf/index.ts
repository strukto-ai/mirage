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
import { CLI } from '@struktoai/mirage-core/commands/cli/types'
import { CLIHandler } from '@struktoai/mirage-core/commands/cli/types'

import { registerCliSpec } from '@struktoai/mirage-core/commands/cli/specs'
import { CommandSpec } from '@struktoai/mirage-core/commands/spec/types'
import { Argument } from '@struktoai/mirage-core/commands/spec/index'
import { HfConfigSchema } from '../../../../core/hf_hub/config.ts'
import { listCmd, whoamiCmd } from './auth.ts'
import { downloadCmd } from './download.ts'
import { envCmd, versionCmd } from './env.ts'
import { deleteCmd } from './files.ts'
import { createCmd, tagCreateCmd, tagDeleteCmd, tagListCmd } from './repo.ts'
import { uploadCmd } from './upload.ts'

// Upstream `hf` is argparse, not clap, so the default UsageStyle already
// words its refusals ("hf: error: argument ...: invalid choice: 'x'",
// exit 2). There is no dialect to add for this one.

const REPO_TYPE = new Argument('--repo-type', {
  choices: ['model', 'dataset', 'space'],
  default: 'model',
  metavar: 'REPO_TYPE',
  help: "Type of repo (defaults to 'model')",
})
const REVISION = new Argument('--revision', {
  metavar: 'REVISION',
  help: 'A branch name, a tag, or a commit hash',
})
const INCLUDE = new Argument('--include', {
  action: 'append',
  metavar: 'INCLUDE',
  help: 'Glob patterns to match files',
})
const EXCLUDE = new Argument('--exclude', {
  action: 'append',
  metavar: 'EXCLUDE',
  help: 'Glob patterns to exclude files',
})
const COMMIT_MESSAGE = new Argument('--commit-message', {
  metavar: 'COMMIT_MESSAGE',
  help: 'The summary of the generated commit',
})
const COMMIT_DESCRIPTION = new Argument('--commit-description', {
  metavar: 'COMMIT_DESCRIPTION',
  help: 'The description of the generated commit',
})
const CREATE_PR = new Argument('--create-pr', {
  action: 'store_true',
  help: 'Upload the content as a new Pull Request',
})
const QUIET = new Argument('--quiet', {
  action: 'store_true',
  help: 'Print only the path to the downloaded files',
})
const PRIVATE = new Argument('--private', {
  action: 'store_true',
  help: 'Create a private repo if it does not exist yet',
})

const REPO_ID = new Argument('REPO_ID')

const AUTH = new CommandSpec({
  name: 'auth',
  description: 'Manage authentication (login, logout, etc.).',
  subcommands: [
    new CommandSpec({
      name: 'whoami',
      description: 'Find out which huggingface.co account you are logged in as.',
    }),
    new CommandSpec({ name: 'list', description: 'List all stored access tokens' }),
  ],
})

// Upstream spells this one with an underscore, alone among hf's
// options. Mimicking a program means mimicking its typos.
const SPACE_SDK = new Argument('--space_sdk', {
  choices: ['gradio', 'streamlit', 'docker', 'static'],
  metavar: 'SPACE_SDK',
  help: 'The SDK a Space runs on; required for --repo-type space',
})

const TAG = new Argument('TAG')

const REPO_TAG = new CommandSpec({
  name: 'tag',
  description: 'Manage tags for a repo on the Hub.',
  subcommands: [
    new CommandSpec({
      name: 'create',
      description: 'Create a tag for a repo.',
      arguments: [
        new Argument(['-m', '--message'], {
          metavar: 'MESSAGE',
          help: 'The description of the tag to create',
        }),
        REVISION,
        REPO_TYPE,
        REPO_ID,
        TAG,
      ],
    }),
    new CommandSpec({
      name: 'list',
      description: 'List tags for a repo.',
      arguments: [REPO_TYPE, REPO_ID],
    }),
    new CommandSpec({
      name: 'delete',
      description: 'Delete a tag from a repo.',
      arguments: [
        new Argument(['-y', '--yes'], {
          action: 'store_true',
          help: 'Answer Yes to prompts automatically',
        }),
        REPO_TYPE,
        REPO_ID,
        TAG,
      ],
    }),
  ],
})

const REPO = new CommandSpec({
  name: 'repo',
  description: 'Manage repos on the Hub.',
  subcommands: [
    new CommandSpec({
      name: 'create',
      description: 'Create a new repo on huggingface.co',
      arguments: [
        REPO_TYPE,
        PRIVATE,
        SPACE_SDK,
        new Argument('--exist-ok', {
          action: 'store_true',
          help: 'Do not raise an error if repo already exists',
        }),
        new Argument('--resource-group-id', {
          metavar: 'RESOURCE_GROUP_ID',
          help: 'Resource group in which to create the repo. Resource groups is only available for Enterprise Hub organizations.',
        }),
        REPO_ID,
      ],
    }),
    REPO_TAG,
  ],
})

const REPO_FILES = new CommandSpec({
  name: 'repo-files',
  description: 'Manage files in a repo on the Hub.',
  subcommands: [
    new CommandSpec({
      name: 'delete',
      description: 'Delete files from a repo on the Hub',
      arguments: [
        REPO_TYPE,
        REVISION,
        COMMIT_MESSAGE,
        COMMIT_DESCRIPTION,
        CREATE_PR,
        REPO_ID,
        new Argument('PATTERNS', { nargs: '+' }),
      ],
    }),
  ],
})

export const HF = new CLI({
  spec: new CommandSpec({
    name: 'hf',
    description: 'hf command helpers',
    subcommands: [
      AUTH,
      REPO,
      REPO_FILES,
      new CommandSpec({
        name: 'download',
        description: 'Download files from the Hub',
        arguments: [
          REPO_TYPE,
          REVISION,
          INCLUDE,
          EXCLUDE,
          new Argument('--cache-dir', {
            type: 'path',
            metavar: 'CACHE_DIR',
            help: 'Workspace directory to hold the cache; defaults to HF_HUB_CACHE or HF_HOME/hub from the session',
          }),
          new Argument('--force-download', {
            action: 'store_true',
            help: 'Download even when the cache already holds the file',
          }),
          new Argument('--local-dir', {
            type: 'path',
            metavar: 'LOCAL_DIR',
            help: 'Download straight into this directory, with no cache in between',
          }),
          new Argument('--max-workers', {
            type: 'int',
            metavar: 'MAX_WORKERS',
            help: 'Maximum number of workers to use for downloading files. Default is 8.',
          }),
          QUIET,
          REPO_ID,
          new Argument('FILENAMES', { nargs: '*' }),
        ],
      }),
      new CommandSpec({
        name: 'upload',
        description: 'Upload a file or a folder to the Hub. Recommended for single-commit uploads.',
        arguments: [
          REPO_TYPE,
          REVISION,
          PRIVATE,
          INCLUDE,
          EXCLUDE,
          new Argument('--delete', {
            action: 'append',
            metavar: 'DELETE',
            help: 'Glob patterns for files to delete from the repo while committing',
          }),
          COMMIT_MESSAGE,
          COMMIT_DESCRIPTION,
          CREATE_PR,
          QUIET,
          REPO_ID,
          new Argument('LOCAL_PATH', { type: 'path', nargs: '?' }),
          new Argument('PATH_IN_REPO', { nargs: '?' }),
        ],
      }),
      new CommandSpec({ name: 'env', description: 'Print information about the environment.' }),
      new CommandSpec({ name: 'version', description: 'Print information about the hf version.' }),
    ],
  }),
  handlers: {
    'auth whoami': new CLIHandler({ fn: whoamiCmd }),
    'auth list': new CLIHandler({ fn: listCmd }),
    'repo create': new CLIHandler({ fn: createCmd, write: true }),
    'repo tag create': new CLIHandler({ fn: tagCreateCmd, write: true }),
    'repo tag list': new CLIHandler({ fn: tagListCmd }),
    'repo tag delete': new CLIHandler({ fn: tagDeleteCmd, write: true }),
    'repo-files delete': new CLIHandler({ fn: deleteCmd, write: true }),
    download: new CLIHandler({ fn: downloadCmd, write: true }),
    upload: new CLIHandler({ fn: uploadCmd, write: true }),
    env: new CLIHandler({ fn: envCmd }),
    version: new CLIHandler({ fn: versionCmd }),
  },
  configModel: HfConfigSchema,
})

registerCliSpec(HF)
