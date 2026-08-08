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

import { Operand, Option } from '../../../spec/types.ts'
import { registerCliSpec } from '../../specs.ts'
import { CLISpec, UsageStyle } from '../../types.ts'
import { add } from './add.ts'
import { branch } from './branch.ts'
import { checkout } from './checkout.ts'
import { commit } from './commit.ts'
import { diff } from './diff.ts'
import { log } from './log.ts'
import { reset } from './reset.ts'
import { show } from './show.ts'
import { status } from './status.ts'

// `-C` is git's own before-anything-else option, so it sits on the root and
// every verb inherits it. The "." default is load-bearing: a PATH default lands
// as if typed, so an absent -C resolves to the session cwd and the leaves need
// no separate working-directory fact.
const DIRECTORY_OPTION = new Option({
  short: '-C',
  type: 'path',
  default: '.',
  description: 'Run as if git was started in <path>',
})

const REVISION = new Operand({ type: 'str' })

// --pretty and --format set the same variable in git; both take git's
// optional-value form, so a bare --pretty means medium and a detached next
// word is a revision, never a format. A bare --format stays parseable too,
// but only so prettyValue can answer it with git's own fatal (pretty.c reads
// --format in its =value form alone).
const PRETTY_OPTION = new Option({
  long: '--pretty',
  type: 'str',
  valueOptional: true,
  description:
    'Commit display format: oneline, short, medium, full, fuller, or a format:/tformat:/%-string',
})
const FORMAT_OPTION = new Option({
  long: '--format',
  type: 'str',
  valueOptional: true,
  description: 'Alias of --pretty (requires =value)',
})

const LOG_OPTIONS = [
  new Option({
    short: '-n',
    type: 'int',
    numericShorthand: true,
    description: 'Limit the number of commits shown',
  }),
  new Option({ long: '--oneline', description: 'One abbreviated line per commit' }),
  new Option({ long: '--reverse', description: 'Print commits oldest first' }),
  new Option({ long: '--all', description: 'Start from every ref as well as the revision' }),
  PRETTY_OPTION,
  FORMAT_OPTION,
  // The pickaxe, and the reason `git log -S <name> --reverse` answers "which
  // commit introduced this": it selects commits that changed how many times the
  // string occurs, not commits that mention it.
  new Option({
    short: '-S',
    type: 'str',
    description: 'Show commits that change the number of occurrences of the string',
  }),
  new Option({
    long: '--since',
    type: 'str',
    description: 'Commits more recent than a date (ISO-8601 or epoch)',
  }),
  new Option({
    long: '--until',
    type: 'str',
    description: 'Commits older than a date (ISO-8601 or epoch)',
  }),
]

const SHOW_OPTIONS = [
  new Option({ long: '--stat', description: 'Show the diffstat table instead of the patch' }),
  new Option({ short: '-s', long: '--no-patch', description: 'Suppress all diff output' }),
  new Option({ long: '--name-only', description: 'Show changed paths instead of the patch' }),
  new Option({
    long: '--no-ext-diff',
    description: 'Accepted for compatibility; there are no external diff drivers to disable',
  }),
  PRETTY_OPTION,
  FORMAT_OPTION,
]

const STATUS_OPTIONS = [
  new Option({
    long: '--porcelain',
    description: 'Machine-readable output, stable across versions',
  }),
  new Option({ short: '-s', long: '--short', description: 'Give the output in the short format' }),
  new Option({
    short: '-b',
    long: '--branch',
    description: 'Show the branch line even in short format',
  }),
  // git spells the mode attached (`-uall`) or not at all, never as a separate
  // token, which is what valueOptional says: a bare -u means "all" and the next
  // word is left alone to be an operand.
  new Option({
    short: '-u',
    long: '--untracked-files',
    type: 'str',
    valueOptional: true,
    choices: ['no', 'normal', 'all'],
    description: 'Show untracked files: no, normal or all',
  }),
]

const PATHSPEC = new Operand({ type: 'str' })

const ADD_OPTIONS = [
  new Option({ short: '-A', long: '--all', description: 'Stage every change' }),
  new Option({
    short: '-u',
    long: '--update',
    description: 'Stage changes to tracked files only',
  }),
  new Option({ short: '-f', long: '--force', description: 'Stage paths an ignore rule covers' }),
]

const COMMIT_OPTIONS = [
  // Required, not defaulted: git would open an editor without it, and a mount
  // has none to open.
  new Option({ short: '-m', long: '--message', type: 'str', description: 'Commit message' }),
  new Option({ long: '--author', type: 'str', description: 'Override the recorded author' }),
]

const CHECKOUT_OPTIONS = [
  new Option({ short: '-b', description: 'Create the branch and switch to it' }),
]

const BRANCH_OPTIONS = [
  new Option({ short: '-a', description: 'List local and remote-tracking branches' }),
  new Option({ short: '-r', description: 'List remote-tracking branches' }),
  new Option({ short: '-d', long: '--delete', description: 'Delete a fully merged branch' }),
  new Option({ short: '-D', description: 'Delete a branch even if not merged' }),
]

/**
 * The git program tree. No configModel: local git needs no credentials, which is
 * what makes it installable with a bare `cli: git`.
 *
 * Lives in core rather than node because nothing here touches a runtime API: the
 * verbs read and write through the workspace dispatcher, and isomorphic-git
 * reaches the object database through the same bridge, so a repository mounted
 * in a browser works exactly as one mounted over disk.
 */
export const GIT = new CLISpec({
  name: 'git',
  description: 'Content tracker',
  usageStyle: UsageStyle.GIT,
  options: [DIRECTORY_OPTION],
  subcommands: [
    new CLISpec({
      name: 'status',
      description: 'Show the working tree status',
      fn: status,
      options: STATUS_OPTIONS,
    }),
    new CLISpec({
      name: 'log',
      description: 'Show commit logs',
      fn: log,
      options: LOG_OPTIONS,
      rest: REVISION,
    }),
    new CLISpec({
      name: 'show',
      description: 'Show a commit and its diff',
      fn: show,
      options: SHOW_OPTIONS,
      rest: REVISION,
    }),
    new CLISpec({
      name: 'diff',
      description: 'Show changes between commits',
      fn: diff,
      rest: REVISION,
    }),
    new CLISpec({
      name: 'branch',
      description: 'List, create or delete branches',
      fn: branch,
      options: BRANCH_OPTIONS,
      rest: new Operand({ type: 'str' }),
      write: true,
    }),
    new CLISpec({
      name: 'add',
      description: 'Stage working tree content',
      fn: add,
      options: ADD_OPTIONS,
      rest: PATHSPEC,
      write: true,
    }),
    new CLISpec({
      name: 'reset',
      description: 'Unstage, putting the index back to HEAD',
      fn: reset,
      rest: PATHSPEC,
      write: true,
    }),
    new CLISpec({
      name: 'commit',
      description: 'Record the index as a new commit',
      fn: commit,
      options: COMMIT_OPTIONS,
      write: true,
    }),
    new CLISpec({
      name: 'checkout',
      description: 'Switch branches',
      fn: checkout,
      options: CHECKOUT_OPTIONS,
      rest: REVISION,
      write: true,
    }),
  ],
})

registerCliSpec(GIT)
