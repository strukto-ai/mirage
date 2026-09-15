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

import { registerCliSpec } from '@struktoai/mirage-core/commands/cli/specs'
import { CLISpec } from '@struktoai/mirage-core/commands/cli/types'
import { Operand, Option } from '@struktoai/mirage-core/commands/spec/index'
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

const REPO_TYPE = new Option({
  long: '--repo-type',
  type: 'str',
  choices: ['model', 'dataset', 'space'],
  default: 'model',
  metavar: 'REPO_TYPE',
  description: "Type of repo (defaults to 'model')",
})
const REVISION = new Option({
  long: '--revision',
  type: 'str',
  metavar: 'REVISION',
  description: 'A branch name, a tag, or a commit hash',
})
const INCLUDE = new Option({
  long: '--include',
  type: 'str',
  multiple: true,
  metavar: 'INCLUDE',
  description: 'Glob patterns to match files',
})
const EXCLUDE = new Option({
  long: '--exclude',
  type: 'str',
  multiple: true,
  metavar: 'EXCLUDE',
  description: 'Glob patterns to exclude files',
})
const COMMIT_MESSAGE = new Option({
  long: '--commit-message',
  type: 'str',
  metavar: 'COMMIT_MESSAGE',
  description: 'The summary of the generated commit',
})
const COMMIT_DESCRIPTION = new Option({
  long: '--commit-description',
  type: 'str',
  metavar: 'COMMIT_DESCRIPTION',
  description: 'The description of the generated commit',
})
const CREATE_PR = new Option({
  long: '--create-pr',
  description: 'Upload the content as a new Pull Request',
})
const QUIET = new Option({
  long: '--quiet',
  description: 'Print only the path to the downloaded files',
})
const PRIVATE = new Option({
  long: '--private',
  description: 'Create a private repo if it does not exist yet',
})

const REPO_ID = new Operand({ type: 'str', name: 'REPO_ID', required: true })

const AUTH = new CLISpec({
  name: 'auth',
  description: 'Manage authentication (login, logout, etc.).',
  subcommands: [
    new CLISpec({
      name: 'whoami',
      description: 'Find out which huggingface.co account you are logged in as.',
      fn: whoamiCmd,
    }),
    new CLISpec({
      name: 'list',
      description: 'List all stored access tokens',
      fn: listCmd,
    }),
  ],
})

// Upstream spells this one with an underscore, alone among hf's
// options. Mimicking a program means mimicking its typos.
const SPACE_SDK = new Option({
  long: '--space_sdk',
  type: 'str',
  choices: ['gradio', 'streamlit', 'docker', 'static'],
  metavar: 'SPACE_SDK',
  description: 'The SDK a Space runs on; required for --repo-type space',
})

const TAG = new Operand({ type: 'str', name: 'TAG', required: true })

const REPO_TAG = new CLISpec({
  name: 'tag',
  description: 'Manage tags for a repo on the Hub.',
  subcommands: [
    new CLISpec({
      name: 'create',
      description: 'Create a tag for a repo.',
      fn: tagCreateCmd,
      write: true,
      positional: [REPO_ID, TAG],
      options: [
        new Option({
          short: '-m',
          long: '--message',
          type: 'str',
          metavar: 'MESSAGE',
          description: 'The description of the tag to create',
        }),
        REVISION,
        REPO_TYPE,
      ],
    }),
    new CLISpec({
      name: 'list',
      description: 'List tags for a repo.',
      fn: tagListCmd,
      positional: [REPO_ID],
      options: [REPO_TYPE],
    }),
    new CLISpec({
      name: 'delete',
      description: 'Delete a tag from a repo.',
      fn: tagDeleteCmd,
      write: true,
      positional: [REPO_ID, TAG],
      options: [
        new Option({
          short: '-y',
          long: '--yes',
          description: 'Answer Yes to prompts automatically',
        }),
        REPO_TYPE,
      ],
    }),
  ],
})

const REPO = new CLISpec({
  name: 'repo',
  description: 'Manage repos on the Hub.',
  subcommands: [
    new CLISpec({
      name: 'create',
      description: 'Create a new repo on huggingface.co',
      fn: createCmd,
      write: true,
      positional: [REPO_ID],
      options: [
        REPO_TYPE,
        PRIVATE,
        SPACE_SDK,
        new Option({
          long: '--exist-ok',
          description: 'Do not raise an error if repo already exists',
        }),
        new Option({
          long: '--resource-group-id',
          type: 'str',
          metavar: 'RESOURCE_GROUP_ID',
          description:
            'Resource group in which to create the repo. Resource groups is only available for Enterprise Hub organizations.',
        }),
      ],
    }),
    REPO_TAG,
  ],
})

const REPO_FILES = new CLISpec({
  name: 'repo-files',
  description: 'Manage files in a repo on the Hub.',
  subcommands: [
    new CLISpec({
      name: 'delete',
      description: 'Delete files from a repo on the Hub',
      fn: deleteCmd,
      write: true,
      positional: [
        REPO_ID,
        new Operand({ type: 'str', name: 'PATTERNS', required: true, remainder: true }),
      ],
      options: [REPO_TYPE, REVISION, COMMIT_MESSAGE, COMMIT_DESCRIPTION, CREATE_PR],
    }),
  ],
})

export const HF = new CLISpec({
  name: 'hf',
  description: 'hf command helpers',
  configModel: HfConfigSchema,
  subcommands: [
    AUTH,
    REPO,
    REPO_FILES,
    new CLISpec({
      name: 'download',
      description: 'Download files from the Hub',
      fn: downloadCmd,
      write: true,
      positional: [REPO_ID, new Operand({ type: 'str', name: 'FILENAMES', remainder: true })],
      options: [
        REPO_TYPE,
        REVISION,
        INCLUDE,
        EXCLUDE,
        new Option({
          long: '--cache-dir',
          type: 'str',
          metavar: 'CACHE_DIR',
          description:
            'Workspace directory to hold the cache; defaults to HF_HUB_CACHE or HF_HOME/hub from the session',
        }),
        new Option({
          long: '--force-download',
          description: 'Download even when the cache already holds the file',
        }),
        new Option({
          long: '--local-dir',
          type: 'str',
          metavar: 'LOCAL_DIR',
          description: 'Download straight into this directory, with no cache in between',
        }),
        new Option({
          long: '--max-workers',
          type: 'int',
          metavar: 'MAX_WORKERS',
          description: 'Maximum number of workers to use for downloading files. Default is 8.',
        }),
        QUIET,
      ],
    }),
    new CLISpec({
      name: 'upload',
      description: 'Upload a file or a folder to the Hub. Recommended for single-commit uploads.',
      fn: uploadCmd,
      write: true,
      positional: [
        REPO_ID,
        new Operand({ type: 'str', name: 'LOCAL_PATH' }),
        new Operand({ type: 'str', name: 'PATH_IN_REPO' }),
      ],
      options: [
        REPO_TYPE,
        REVISION,
        PRIVATE,
        INCLUDE,
        EXCLUDE,
        new Option({
          long: '--delete',
          type: 'str',
          multiple: true,
          metavar: 'DELETE',
          description: 'Glob patterns for files to delete from the repo while committing',
        }),
        COMMIT_MESSAGE,
        COMMIT_DESCRIPTION,
        CREATE_PR,
        QUIET,
      ],
    }),
    new CLISpec({
      name: 'env',
      description: 'Print information about the environment.',
      fn: envCmd,
    }),
    new CLISpec({
      name: 'version',
      description: 'Print information about the hf version.',
      fn: versionCmd,
    }),
  ],
})

registerCliSpec(HF)
