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

import { lsFiles } from './ls_files.ts'
import { forEachRef } from './for_each_ref.ts'
import { reflog } from './reflog.ts'
import { fetch, fetchReadOnly } from './fetch.ts'
import { clone, cloneReadOnly } from './clone.ts'
import { Operand, Option } from '../../../spec/types.ts'
import { CLISpec } from '../../types.ts'
import { UsageStyle } from '../../../spec/types.ts'
import { add } from './add.ts'
import { init } from './init.ts'
import { fsck } from './fsck.ts'
import { hashObject, hashObjectReadOnly } from './hash_object.ts'
import { stashList, stashShow } from './stash.ts'
import { nodeHelp, findNode } from '../../walk.ts'
import type { CLIInvocation } from '../../types.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFnResult } from '../../../config.ts'
import { branch, branchReadOnly } from './branch.ts'
import { catFile } from './cat_file.ts'
import { checkout, checkoutReadOnly } from './checkout.ts'
import { commit } from './commit.ts'
import { diff } from './diff.ts'
import { log } from './log.ts'
import { mv } from './mv.ts'
import { reset } from './reset.ts'
import { restore } from './restore.ts'
import { rm } from './rm.ts'
import { revParse } from './inspect.ts'
import { shortlog } from './shortlog.ts'
import { config, remote, revList, version, showRef } from './inspect.ts'
import { symbolicRef, symbolicRefReadOnly } from './symbolic_ref.ts'
import { indexLocked, verb } from './session.ts'
import { show, diffTree } from './show.ts'
import { status } from './status.ts'
import { switchBranch, switchReadOnly } from './switch.ts'
import { tag, tagReadOnly } from './tag.ts'
import { GitError } from './errors.ts'
import { checkSwitches, fatal } from './util.ts'

// `-C` is git's own before-anything-else option, so it sits on the root and
// every verb inherits it. The "." default is load-bearing: a PATH default lands
// as if typed, so an absent -C resolves to the session cwd and the leaves need
// no separate working-directory fact. The root names it its operand base, so a
// later relative -C lands under the one before it.
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
// but only so prettyFormat can answer it with git's own fatal (pretty.c reads
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

// Free text, read by parseDateMode: git names a style it lacks in its own
// fatal, and format:<strftime> is no fixed word.
const DATE_OPTION = new Option({
  long: '--date',
  type: 'str',
  description:
    'Date display format: default, relative, local, iso, iso-strict, rfc, short, raw, unix, ' +
    'human or format:<strftime>',
})

const DIFF_OPTIONS = [
  new Option({
    short: '-W',
    long: '--function-context',
    description: 'Show whole functions as diff context',
  }),
  new Option({
    short: '-U',
    long: '--unified',
    type: 'int',
    description: 'Number of context lines',
  }),
  new Option({ long: '--name-status', description: 'Show changed paths and status' }),
  new Option({ long: '--name-only', description: 'Show changed paths instead of the patch' }),
  new Option({ long: '--stat', description: 'Show the diffstat table instead of the patch' }),
  new Option({ long: '--numstat', description: 'Show added and deleted line counts per path' }),
  new Option({ long: '--shortstat', description: 'Show only the diffstat summary line' }),
  new Option({ long: '--summary', description: 'Summarize creations, deletions and mode changes' }),
  new Option({ short: '-p', long: '--patch', description: 'Show the patch' }),
  new Option({ short: '-s', long: '--no-patch', description: 'Suppress all diff output' }),
  new Option({
    long: '--no-ext-diff',
    description: 'Accepted for compatibility; there are no external diff drivers to disable',
  }),
  new Option({
    short: '-M',
    long: '--find-renames',
    type: 'str',
    valueOptional: true,
    description: 'Detect renames with an optional similarity threshold',
  }),
  new Option({ long: '--no-renames', description: 'Turn off rename detection' }),
  new Option({ long: '--raw', description: 'Show the raw diff format' }),
]

// git's optional-value form: a bare --decorate is short, and a detached next
// word is a revision, never a style.
const DECORATE_OPTIONS = [
  new Option({
    long: '--decorate',
    type: 'str',
    valueOptional: true,
    description: 'Print ref names on commits: short (the default), full, auto or no',
  }),
  new Option({ long: '--no-decorate', description: 'Print no ref names on commits' }),
]

const MERGE_OPTIONS = [
  new Option({ short: '-m', description: 'Show merge diffs separately against each parent' }),
  new Option({ short: '-c', description: 'Show combined merge diffs' }),
  new Option({ long: '--cc', description: 'Show dense combined merge diffs' }),
  new Option({ long: '--first-parent', description: 'Follow and compare only the first parent' }),
  new Option({ long: '--diff-merges', type: 'str', description: 'Select merge diff mode' }),
]

const LOG_OPTIONS = [
  new Option({
    short: '-E',
    long: '--extended-regexp',
    description: 'Use extended regular expressions',
  }),
  new Option({ short: '-F', long: '--fixed-strings', description: 'Match patterns literally' }),
  new Option({
    short: '-P',
    long: '--perl-regexp',
    description: 'Use Perl-compatible regular expressions',
  }),
  new Option({ long: '--basic-regexp', description: 'Use basic regular expressions' }),
  new Option({
    long: '--committer',
    type: 'str',
    multiple: true,
    description: 'Limit commits to matching committers',
  }),
  new Option({
    long: '--author',
    type: 'str',
    multiple: true,
    description: 'Limit commits to matching authors',
  }),
  new Option({
    long: '--grep',
    type: 'str',
    multiple: true,
    description: 'Limit commits to ones with a message line that matches',
  }),
  new Option({
    short: '-i',
    long: '--regexp-ignore-case',
    description: 'Match --grep, --author and -S without regard to case',
  }),
  ...MERGE_OPTIONS,
  new Option({
    long: '--after',
    type: 'str',
    description: 'Commits more recent than a date, like --since',
  }),
  new Option({
    long: '--before',
    type: 'str',
    description: 'Commits older than a date, like --until',
  }),
  new Option({
    long: '--max-parents',
    type: 'int',
    description: 'Show only commits with at most this many parents',
  }),
  new Option({
    long: '--min-parents',
    type: 'int',
    description: 'Show only commits with at least this many parents',
  }),
  new Option({ long: '--merges', description: 'Show only merge commits' }),
  new Option({ long: '--no-merges', description: 'Leave out merge commits' }),

  DATE_OPTION,
  ...DECORATE_OPTIONS,
  new Option({
    short: '-n',
    long: '--max-count',
    type: 'int',
    numericShorthand: true,
    description: 'Limit the number of commits shown',
  }),
  new Option({ long: '--oneline', description: 'One abbreviated line per commit' }),
  new Option({ long: '--reverse', description: 'Print commits oldest first' }),
  new Option({
    long: '--graph',
    description: 'Draw the commit history beside the log (implies --topo-order)',
  }),
  new Option({
    long: '--topo-order',
    description: 'Show no parent before all its children, one line of history at a time',
  }),
  new Option({
    long: '--date-order',
    description: 'Show no parent before all its children, otherwise newest first',
  }),
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
    short: '-G',
    type: 'str',
    description:
      'Show commits whose diff adds or removes a line that matches the extended regular expression',
  }),
  new Option({
    long: '--pickaxe-regex',
    description: 'Treat the -S string as an extended regular expression',
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

const MAILMAP_OPTIONS = [
  new Option({ long: '--mailmap', description: 'Apply mailmap to identities' }),
  new Option({ long: '--use-mailmap', description: 'Apply mailmap to identities' }),
  new Option({ long: '--no-mailmap', description: 'Use recorded identities' }),
  new Option({ long: '--no-use-mailmap', description: 'Use recorded identities' }),
]

const SHOW_OPTIONS = [
  ...MAILMAP_OPTIONS,
  new Option({ long: '--oneline', description: 'One abbreviated line per commit' }),
  ...DIFF_OPTIONS,
  ...MERGE_OPTIONS,
  DATE_OPTION,
  PRETTY_OPTION,
  FORMAT_OPTION,
]

const STATUS_OPTIONS = [
  new Option({ long: '--ignored', description: 'Show ignored files' }),
  new Option({
    long: '--porcelain',
    type: 'str',
    valueOptional: true,
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
  new Option({
    short: '-v',
    long: '--verbose',
    description: 'Name each path as it is added or removed',
  }),
]

const COMMIT_OPTIONS = [
  new Option({ short: '-q', long: '--quiet', description: 'Suppress feedback messages' }),
  new Option({
    short: '-a',
    long: '--all',
    description: 'Stage modified and deleted tracked files first',
  }),
  // Required, not defaulted: git would open an editor without it, and a mount
  // has none to open.
  new Option({ short: '-m', long: '--message', type: 'str', description: 'Commit message' }),
  new Option({ long: '--author', type: 'str', description: 'Override the recorded author' }),
  new Option({
    long: '--allow-empty',
    description: 'Record a commit that changes nothing from its parent',
  }),
]

const CHECKOUT_OPTIONS = [
  new Option({ short: '-b', description: 'Create the branch and switch to it' }),
  new Option({ long: '--detach', description: 'Leave HEAD on the commit itself' }),
  new Option({ short: '-q', long: '--quiet', description: 'Suppress feedback messages' }),
]

const SWITCH_OPTIONS = [
  new Option({ short: '-q', long: '--quiet', description: 'Suppress feedback messages' }),
  new Option({
    short: '-c',
    long: '--create',
    type: 'str',
    description: 'Create the branch and switch to it',
  }),
  new Option({ short: '-d', long: '--detach', description: 'Detach HEAD at the named commit' }),
]

const RESTORE_OPTIONS = [
  new Option({ short: '-S', long: '--staged', description: 'Restore the index' }),
  new Option({
    short: '-W',
    long: '--worktree',
    description: 'Restore the working tree (default)',
  }),
  new Option({
    short: '-s',
    long: '--source',
    type: 'str',
    description: 'Which tree-ish to restore from',
  }),
]

const RM_OPTIONS = [
  new Option({ short: '-r', description: 'Allow recursive removal' }),
  new Option({ long: '--cached', description: 'Only remove from the index, keeping the file' }),
  new Option({ short: '-f', long: '--force', description: 'Override the up-to-date check' }),
  new Option({ short: '-q', long: '--quiet', description: 'Do not list removed files' }),
  new Option({
    long: '--ignore-unmatch',
    description: 'Exit with a zero status even if nothing matched',
  }),
]

const MV_OPTIONS = [
  new Option({
    short: '-f',
    long: '--force',
    description: 'Force move/rename even if target exists',
  }),
  new Option({ short: '-k', description: 'Skip move/rename errors' }),
  new Option({ short: '-n', long: '--dry-run', description: 'Dry run' }),
  new Option({ short: '-v', long: '--verbose', description: 'Be verbose' }),
]

// git's ref-filter options, which `branch` and `tag` share. The four commit
// filters take the next word as their commit, whatever it looks like
// (`--merged --no-merged` names a commit called `--no-merged`), except as the
// line's last word, where they read HEAD: parse-options' LASTARG_DEFAULT. The
// spec has no word for that, so they are declared with an optional value (a
// bare one is HEAD, `--merged=main` is main) and `filterWords` reattaches a
// detached value from the verbatim argv. `--points-at` always takes a value.
const REF_FILTER_OPTIONS = [
  new Option({
    long: '--contains',
    type: 'str',
    valueOptional: true,
    multiple: true,
    metavar: 'commit',
    description: 'List only refs that contain the commit (HEAD if omitted)',
  }),
  new Option({
    long: '--no-contains',
    type: 'str',
    valueOptional: true,
    multiple: true,
    metavar: 'commit',
    description: "List only refs that don't contain the commit (HEAD if omitted)",
  }),
  new Option({
    long: '--merged',
    type: 'str',
    valueOptional: true,
    multiple: true,
    metavar: 'commit',
    description: 'List only refs reachable from the commit (HEAD if omitted)',
  }),
  new Option({
    long: '--no-merged',
    type: 'str',
    valueOptional: true,
    multiple: true,
    metavar: 'commit',
    description: 'List only refs not reachable from the commit (HEAD if omitted)',
  }),
  new Option({
    long: '--points-at',
    type: 'str',
    multiple: true,
    metavar: 'object',
    description: 'List only refs that point at the object',
  }),
]

// git's ref-format options, which `for-each-ref`, `branch` and `tag` share.
// --sort repeats, the last key given sorting first, and --no-sort drops every
// key before it, the default refname included.
const FORMAT_OPTION_REF = new Option({
  long: '--format',
  type: 'str',
  metavar: 'format',
  description: 'Format each ref: %(fieldname) placeholders, as git for-each-ref',
})
const SORT_OPTIONS = [
  new Option({
    long: '--sort',
    type: 'str',
    multiple: true,
    metavar: 'key',
    description: 'Sort on a field, - reversing it and version: comparing as versions',
  }),
  new Option({ long: '--no-sort', description: 'Drop the sort keys given so far' }),
]
const OMIT_EMPTY_OPTION = new Option({
  long: '--omit-empty',
  description: 'Print nothing, not even a newline, for an empty row',
})
const IGNORE_CASE_OPTION = new Option({
  short: '-i',
  long: '--ignore-case',
  description: 'Sort and match patterns case-insensitively',
})

const FOR_EACH_REF_OPTIONS = [
  new Option({ short: '-s', long: '--shell', description: 'Quote fields suitably for shells' }),
  new Option({ short: '-p', long: '--perl', description: 'Quote fields suitably for perl' }),
  new Option({ long: '--python', description: 'Quote fields suitably for python' }),
  new Option({ long: '--tcl', description: 'Quote fields suitably for Tcl' }),
  OMIT_EMPTY_OPTION,
  new Option({
    long: '--count',
    type: 'int',
    metavar: 'n',
    description: 'Show only the first <n> refs',
  }),
  FORMAT_OPTION_REF,
  new Option({
    long: '--exclude',
    type: 'str',
    multiple: true,
    metavar: 'pattern',
    description: 'Leave out refs matching the pattern',
  }),
  ...SORT_OPTIONS,
  ...REF_FILTER_OPTIONS,
  new Option({
    long: '--ignore-case',
    description: 'Sort and match patterns case-insensitively',
  }),
  new Option({ long: '--stdin', description: 'Read ref patterns from stdin' }),
  new Option({
    long: '--include-root-refs',
    description: 'Also list HEAD and the other root refs',
  }),
]

const TAG_OPTIONS = [
  new Option({ short: '-l', long: '--list', description: 'List tag names' }),
  // git spells the count attached (`-n2`) or not at all, never as a separate
  // token, which is what valueOptional says: a bare -n means one line and the
  // next word is left alone to be a pattern.
  new Option({
    short: '-n',
    type: 'int',
    valueOptional: true,
    description: 'Print <n> lines of each tag message',
  }),
  new Option({ short: '-d', long: '--delete', description: 'Delete tags' }),
  new Option({ short: '-a', long: '--annotate', description: 'Annotated tag, needs a message' }),
  new Option({
    short: '-m',
    long: '--message',
    type: 'str',
    multiple: true,
    description: 'Tag message (repeatable, one paragraph each)',
  }),
  new Option({ short: '-f', long: '--force', description: 'Replace the tag if exists' }),
  ...REF_FILTER_OPTIONS,
  ...SORT_OPTIONS,
  FORMAT_OPTION_REF,
  OMIT_EMPTY_OPTION,
  IGNORE_CASE_OPTION,
]

const BRANCH_OPTIONS = [
  new Option({ long: '--show-current', description: 'Show the current branch name' }),
  new Option({ short: '-q', long: '--quiet', description: 'Suppress feedback messages' }),
  new Option({
    short: '-v',
    long: '--verbose',
    count: true,
    description: 'Show commit and upstream details',
  }),
  new Option({ short: '-a', description: 'List local and remote-tracking branches' }),
  new Option({ short: '-r', description: 'List remote-tracking branches' }),
  new Option({ short: '-d', long: '--delete', description: 'Delete a fully merged branch' }),
  new Option({ short: '-D', description: 'Delete a branch even if not merged' }),
  new Option({ short: '-l', long: '--list', description: 'List branches matching the patterns' }),
  ...REF_FILTER_OPTIONS,
  ...SORT_OPTIONS,
  FORMAT_OPTION_REF,
  OMIT_EMPTY_OPTION,
  IGNORE_CASE_OPTION,
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
function helpCmd(inv: CLIInvocation): CommandFnResult {
  try {
    checkSwitches(inv, inv.texts)
  } catch (err) {
    if (err instanceof GitError) return fatal(err)
    throw err
  }
  const found = findNode(GIT, inv.texts)
  if (found === null)
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode(
          `git: '${inv.texts.join(' ')}' is not a git command. See 'git --help'.\n`,
        ),
      }),
    ]
  return [
    new TextEncoder().encode(
      nodeHelp(['git', ...found.path].join(' '), found.node, GIT.usageStyle),
    ),
    new IOResult(),
  ]
}

export const GIT = new CLISpec({
  name: 'git',
  description: 'Content tracker',
  usageStyle: UsageStyle.GIT,
  operandBase: '-C',
  options: [
    DIRECTORY_OPTION,
    new Option({
      long: '--git-dir',
      type: 'str',
      env: 'GIT_DIR',
      description: 'Use the repository at <path>',
    }),
    new Option({
      long: '--work-tree',
      type: 'str',
      env: 'GIT_WORK_TREE',
      description: 'Use <path> as the working tree',
    }),
  ],
  subcommands: [
    new CLISpec({
      name: 'reflog',
      fn: verb(reflog),
      description: 'Show reference history',
      options: [
        new Option({
          short: '-n',
          long: '--max-count',
          type: 'int',
          numericShorthand: true,
          description: 'Limit the number of entries',
        }),
      ],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'for-each-ref',
      fn: verb(forEachRef),
      description: 'List references with a format',
      options: FOR_EACH_REF_OPTIONS,
      rest: REVISION,
    }),
    new CLISpec({
      name: 'cat-file',
      fn: verb(catFile),
      description: 'Provide contents or details of repository objects',
      options: [
        new Option({ short: '-t', description: 'Show the object type' }),
        new Option({ short: '-s', description: 'Show the object size' }),
        new Option({ short: '-e', description: 'Check if <object> exists' }),
        new Option({ short: '-p', description: 'Pretty-print <object> content' }),
        new Option({
          long: '--batch',
          type: 'str',
          valueOptional: true,
          description: 'Show full <object> or <rev> contents',
        }),
        new Option({
          long: '--batch-check',
          type: 'str',
          valueOptional: true,
          description: "Like --batch, but don't emit <contents>",
        }),
      ],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'hash-object',
      fn: verb(hashObject, hashObjectReadOnly),
      description: 'Compute object ID and optionally create an object from a file',
      options: [
        new Option({ short: '-t', type: 'str', description: 'Object type' }),
        new Option({ short: '-w', description: 'Write the object into the object database' }),
        new Option({ long: '--stdin', description: 'Read the object from stdin' }),
        new Option({ long: '--stdin-paths', description: 'Read file names from stdin' }),
        new Option({ long: '--no-filters', description: 'Store file as is without filters' }),
        new Option({
          long: '--literally',
          description: 'Just hash any random garbage to create corrupt objects for debugging Git',
        }),
        new Option({
          long: '--path',
          type: 'str',
          description: 'Process file as it were from this path',
        }),
      ],
      rest: PATHSPEC,
    }),
    new CLISpec({
      name: 'ls-files',
      fn: verb(lsFiles),
      description: 'Show files in the index',
      options: [
        new Option({ short: '-z', description: 'Terminate paths with NUL' }),
        new Option({ short: '-s', long: '--stage', description: 'Show staged object metadata' }),
        new Option({ short: '-c', long: '--cached', description: 'Show cached files' }),
      ],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'fetch',
      fn: verb(fetch, fetchReadOnly),
      description: 'Download objects and refs from another repository',
      options: [
        new Option({ short: '-q', long: '--quiet', description: 'Print nothing but errors' }),
        new Option({ short: '-v', long: '--verbose', description: 'Also list unchanged refs' }),
        new Option({
          short: '-p',
          long: '--prune',
          description: 'Remove remote-tracking refs the remote no longer has',
        }),
        new Option({ short: '-t', long: '--tags', description: 'Fetch every tag' }),
        new Option({ short: '-n', long: '--no-tags', description: 'Follow no tags' }),
      ],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'clone',
      fn: verb(clone, cloneReadOnly),
      description: 'Clone a repository into a new directory',
      options: [
        new Option({ short: '-q', long: '--quiet', description: 'Print nothing but errors' }),
        new Option({
          short: '-b',
          long: '--branch',
          type: 'str',
          description: 'Check out this branch or tag',
        }),
        new Option({
          short: '-o',
          long: '--origin',
          type: 'str',
          description: 'Name the remote this instead of origin',
        }),
        new Option({
          short: '-n',
          long: '--no-checkout',
          description: 'Leave the working tree empty',
        }),
      ],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'help',
      fn: verb(helpCmd),
      description: 'Show command help',
      rest: new Operand({ type: 'str' }),
    }),
    new CLISpec({
      name: 'init',
      fn: verb(init),
      description: 'Create an empty Git repository or reinitialize an existing one',
      write: true,
      options: [
        new Option({ short: '-q', long: '--quiet' }),
        new Option({ long: '--bare' }),
        new Option({ short: '-b', long: '--initial-branch', type: 'str' }),
      ],
      positional: [new Operand({ type: 'str', name: 'directory' })],
    }),
    new CLISpec({
      name: 'fsck',
      fn: verb(fsck),
      description: 'Verify object hashes and connectivity',
      options: [new Option({ long: '--full' }), new Option({ long: '--no-dangling' })],
    }),
    new CLISpec({
      name: 'stash',
      description: 'Inspect saved working trees',
      subcommands: [
        new CLISpec({ name: 'list', fn: verb(stashList), description: 'List stashed changes' }),
        new CLISpec({
          name: 'show',
          fn: verb(stashShow),
          description: 'Show stashed changes',
          options: DIFF_OPTIONS,
          positional: [new Operand({ type: 'str', name: 'stash' })],
        }),
      ],
    }),
    new CLISpec({
      name: 'version',
      aliases: ['--version', '-v'],
      fn: verb(version),
      description: 'Show the Mirage Git implementation version',
    }),
    new CLISpec({
      name: 'remote',
      description: 'List remotes',
      fn: verb(remote),
      options: [new Option({ short: '-v', long: '--verbose', description: 'Show remote URLs' })],
    }),
    new CLISpec({
      name: 'config',
      description: 'Read repository configuration',
      fn: verb(config),
      options: [
        new Option({ long: '--global', description: 'Read global configuration' }),
        new Option({ long: '--get', description: 'Get a configuration value' }),
        new Option({ short: '-l', long: '--list', description: 'List every variable and value' }),
        new Option({ long: '--show-origin', description: 'Show the file each value comes from' }),
        new Option({
          long: '--get-regexp',
          description: 'Get the variables whose names match a regular expression',
        }),
      ],
      positional: [new Operand({ type: 'str', name: 'name' })],
    }),
    new CLISpec({
      name: 'show-ref',
      description: 'List references',
      fn: verb(showRef),
      rest: REVISION,
    }),
    // symbolic-ref has every option git's has, so its rows carry git's own
    // help and its usage block reads exactly as git's.
    new CLISpec({
      name: 'symbolic-ref',
      description: 'Read, change or delete a symbolic ref',
      fn: verb(symbolicRef, symbolicRefReadOnly),
      options: [
        new Option({
          short: '-q',
          long: '--quiet',
          description: 'suppress error message for non-symbolic (detached) refs',
        }),
        new Option({ long: '--no-quiet', description: 'Refuse a ref that is not symbolic aloud' }),
        new Option({ short: '-d', long: '--delete', description: 'delete symbolic ref' }),
        new Option({ long: '--no-delete', description: 'Read or change the ref instead' }),
        new Option({ long: '--short', description: 'shorten ref output' }),
        new Option({ long: '--no-short', description: 'Print the full name it points at' }),
        new Option({ long: '--recurse', description: 'recursively dereference (default)' }),
        new Option({
          long: '--no-recurse',
          description: 'Print only the ref this one points at directly',
        }),
        new Option({
          short: '-m',
          type: 'str',
          metavar: 'reason',
          description: 'reason of the update',
        }),
      ],
      rest: new Operand({ type: 'str' }),
      write: true,
    }),
    // shortlog's -n is --numbered, so the count keeps only its long spelling.
    new CLISpec({
      name: 'shortlog',
      fn: verb(shortlog),
      description: 'Summarize commit history',
      options: [
        ...LOG_OPTIONS.filter((opt) => opt.short !== '-n'),
        new Option({
          long: '--max-count',
          type: 'int',
          description: 'Limit the number of commits',
        }),
        new Option({ short: '-s', long: '--summary', description: 'Show only commit counts' }),
        new Option({ short: '-e', long: '--email', description: 'Show author email addresses' }),
        new Option({ short: '-n', long: '--numbered', description: 'Sort by commit count' }),
      ],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'rev-parse',
      fn: verb(revParse),
      description: 'Resolve revisions',
      options: [
        new Option({ long: '--show-toplevel', description: 'Show the worktree root' }),
        new Option({
          long: '--abbrev-ref',
          type: 'str',
          valueOptional: true,
          description: 'Show abbreviated reference names, strict or loose',
        }),
        new Option({
          long: '--show-prefix',
          description: 'Show the current directory relative to the worktree root',
        }),
        new Option({
          long: '--is-inside-work-tree',
          description: 'Print whether the current directory is inside the work tree',
        }),
        new Option({
          long: '--verify',
          description: 'Require exactly one revision that names an object',
        }),
        new Option({
          long: '--short',
          type: 'str',
          valueOptional: true,
          description: 'Abbreviate the object name; implies --verify',
        }),
        new Option({
          short: '-q',
          long: '--quiet',
          description: 'With --verify, exit 1 without a message',
        }),
      ],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'rev-list',
      description: 'List reachable commits',
      fn: verb(revList),
      options: [...LOG_OPTIONS, new Option({ long: '--count', description: 'Print commit count' })],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'diff-tree',
      description: 'Compare a commit with its parent',
      fn: verb(diffTree),
      options: [
        ...SHOW_OPTIONS,
        new Option({ long: '--no-commit-id', description: 'Suppress commit ID' }),
        new Option({ short: '-r', description: 'Recurse into subtrees' }),
      ],
      positional: [new Operand({ type: 'str', name: 'commit', required: true })],
      rest: PATHSPEC,
    }),
    new CLISpec({
      name: 'status',
      description: 'Show the working tree status',
      fn: verb(status),
      options: STATUS_OPTIONS,
    }),
    new CLISpec({
      name: 'log',
      description: 'Show commit logs',
      fn: verb(log),
      options: [...LOG_OPTIONS, ...MAILMAP_OPTIONS, ...DIFF_OPTIONS],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'show',
      description: 'Show a commit and its diff',
      fn: verb(show),
      options: [...SHOW_OPTIONS, ...DECORATE_OPTIONS],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'diff',
      description: 'Show changes between commits',
      fn: verb(diff),
      options: [
        ...DIFF_OPTIONS,
        new Option({ long: '--cached', description: 'Compare the index with a commit' }),
        new Option({ long: '--staged', description: 'Alias of --cached' }),
      ],
      rest: REVISION,
    }),
    new CLISpec({
      name: 'branch',
      description: 'List, create or delete branches',
      fn: verb(branch, branchReadOnly),
      options: BRANCH_OPTIONS,
      rest: new Operand({ type: 'str' }),
      write: true,
    }),
    new CLISpec({
      name: 'add',
      description: 'Stage working tree content',
      fn: verb(add, indexLocked),
      options: ADD_OPTIONS,
      rest: PATHSPEC,
      write: true,
    }),
    new CLISpec({
      name: 'reset',
      description: 'Unstage, putting the index back to HEAD',
      fn: verb(reset, indexLocked),
      options: [new Option({ short: '-q', long: '--quiet', description: 'Only report errors' })],
      rest: PATHSPEC,
      write: true,
    }),
    new CLISpec({
      name: 'commit',
      description: 'Record the index as a new commit',
      fn: verb(commit, indexLocked),
      options: COMMIT_OPTIONS,
      write: true,
    }),
    new CLISpec({
      name: 'checkout',
      description: 'Switch branches',
      fn: verb(checkout, checkoutReadOnly),
      options: CHECKOUT_OPTIONS,
      rest: REVISION,
      write: true,
    }),
    new CLISpec({
      name: 'switch',
      description: 'Switch branches',
      fn: verb(switchBranch, switchReadOnly),
      options: SWITCH_OPTIONS,
      rest: REVISION,
      write: true,
    }),
    new CLISpec({
      name: 'restore',
      description: 'Restore working tree files',
      fn: verb(restore, indexLocked),
      options: RESTORE_OPTIONS,
      rest: PATHSPEC,
      write: true,
    }),
    new CLISpec({
      name: 'rm',
      description: 'Remove files from the working tree and the index',
      fn: verb(rm, indexLocked),
      options: RM_OPTIONS,
      rest: PATHSPEC,
      write: true,
    }),
    new CLISpec({
      name: 'mv',
      description: 'Move or rename a file, a directory, or a symlink',
      fn: verb(mv, indexLocked),
      options: MV_OPTIONS,
      rest: PATHSPEC,
      write: true,
    }),
    new CLISpec({
      name: 'tag',
      description: 'Create, list or delete a tag',
      fn: verb(tag, tagReadOnly),
      options: TAG_OPTIONS,
      rest: new Operand({ type: 'str' }),
      write: true,
    }),
  ],
})
