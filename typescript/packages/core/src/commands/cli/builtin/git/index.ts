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

import { lsFiles, lsTree } from './ls_files.ts'
import { forEachRef } from './for_each_ref.ts'
import { reflog } from './reflog.ts'
import { fetch, fetchReadOnly } from './fetch.ts'
import { clone, cloneReadOnly } from './clone.ts'
import { Argument, UsageStyle } from '../../../spec/types.ts'
import { type CLIInvocation } from '../../types.ts'
import { add } from './add.ts'
import { init } from './init.ts'
import { fsck } from './fsck.ts'
import { grep } from './grep.ts'
import { hashObject, hashObjectReadOnly } from './hash_object.ts'
import { stashList, stashShow } from './stash.ts'
import { nodeHelp, findNode } from '../../walk.ts'
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
import { revParse, config, mergeBase, remote, revList, version, showRef } from './inspect.ts'
import { shortlog } from './shortlog.ts'
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
const DIRECTORY_OPTION = new Argument('-C', {
  type: 'path',
  default: '.',
  help: 'Run as if git was started in <path>',
})

const REVISION = new Argument('text', { metavar: '', nargs: '*' })

// --pretty and --format set the same variable in git; both take git's
// optional-value form, so a bare --pretty means medium and a detached next
// word is a revision, never a format. A bare --format stays parseable too,
// but only so prettyFormat can answer it with git's own fatal (pretty.c reads
// --format in its =value form alone).
const PRETTY_OPTION = new Argument('--pretty', {
  nargs: '?',
  attachedOnly: true,
  help: 'Commit display format: oneline, short, medium, full, fuller, or a format:/tformat:/%-string',
})
const FORMAT_OPTION = new Argument('--format', {
  nargs: '?',
  attachedOnly: true,
  help: 'Alias of --pretty (requires =value)',
})

// Free text, read by parseDateMode: git names a style it lacks in its own
// fatal, and format:<strftime> is no fixed word.
const DATE_OPTION = new Argument('--date', {
  help:
    'Date display format: default, relative, local, iso, iso-strict, rfc, short, raw, unix, ' +
    'human or format:<strftime>',
})

const DIFF_OPTIONS = [
  new Argument(['-a', '--text'], { action: 'store_true', help: 'Treat binary files as text' }),
  new Argument(['-W', '--function-context'], {
    action: 'store_true',
    help: 'Show whole functions as diff context',
  }),
  new Argument(['-U', '--unified'], { type: 'int', help: 'Number of context lines' }),
  new Argument('--name-status', { action: 'store_true', help: 'Show changed paths and status' }),
  new Argument('--name-only', {
    action: 'store_true',
    help: 'Show changed paths instead of the patch',
  }),
  new Argument('--stat', {
    action: 'store_true',
    help: 'Show the diffstat table instead of the patch',
  }),
  new Argument('--numstat', {
    action: 'store_true',
    help: 'Show added and deleted line counts per path',
  }),
  new Argument('--shortstat', {
    action: 'store_true',
    help: 'Show only the diffstat summary line',
  }),
  new Argument('--summary', {
    action: 'store_true',
    help: 'Summarize creations, deletions and mode changes',
  }),
  new Argument(['-p', '--patch'], { action: 'store_true', help: 'Show the patch' }),
  new Argument(['-s', '--no-patch'], { action: 'store_true', help: 'Suppress all diff output' }),
  new Argument('--no-ext-diff', {
    action: 'store_true',
    help: 'Accepted for compatibility; there are no external diff drivers to disable',
  }),
  new Argument(['-M', '--find-renames'], {
    nargs: '?',
    attachedOnly: true,
    help: 'Detect renames with an optional similarity threshold',
  }),
  new Argument('--no-renames', { action: 'store_true', help: 'Turn off rename detection' }),
  new Argument('--raw', { action: 'store_true', help: 'Show the raw diff format' }),
]

// git's optional-value form: a bare --decorate is short, and a detached next
// word is a revision, never a style.
const DECORATE_OPTIONS = [
  new Argument('--decorate', {
    nargs: '?',
    attachedOnly: true,
    help: 'Print ref names on commits: short (the default), full, auto or no',
  }),
  new Argument('--no-decorate', { action: 'store_true', help: 'Print no ref names on commits' }),
]

const MERGE_OPTIONS = [
  new Argument('-m', {
    action: 'store_true',
    help: 'Show merge diffs separately against each parent',
  }),
  new Argument('-c', { action: 'store_true', help: 'Show combined merge diffs' }),
  new Argument('--cc', { action: 'store_true', help: 'Show dense combined merge diffs' }),
  new Argument('--first-parent', {
    action: 'store_true',
    help: 'Follow and compare only the first parent',
  }),
  new Argument('--diff-merges', { help: 'Select merge diff mode' }),
]

const LOG_OPTIONS = [
  new Argument(['-E', '--extended-regexp'], {
    action: 'store_true',
    help: 'Use extended regular expressions',
  }),
  new Argument(['-F', '--fixed-strings'], {
    action: 'store_true',
    help: 'Match patterns literally',
  }),
  new Argument(['-P', '--perl-regexp'], {
    action: 'store_true',
    help: 'Use Perl-compatible regular expressions',
  }),
  new Argument('--basic-regexp', { action: 'store_true', help: 'Use basic regular expressions' }),
  new Argument('--committer', { action: 'append', help: 'Limit commits to matching committers' }),
  new Argument('--author', { action: 'append', help: 'Limit commits to matching authors' }),
  new Argument('--grep', {
    action: 'append',
    help: 'Limit commits to ones with a message line that matches',
  }),
  new Argument(['-i', '--regexp-ignore-case'], {
    action: 'store_true',
    help: 'Match --grep, --author and -S without regard to case',
  }),
  ...MERGE_OPTIONS,
  new Argument('--after', { help: 'Commits more recent than a date, like --since' }),
  new Argument('--before', { help: 'Commits older than a date, like --until' }),
  new Argument('--max-parents', {
    type: 'int',
    help: 'Show only commits with at most this many parents',
  }),
  new Argument('--min-parents', {
    type: 'int',
    help: 'Show only commits with at least this many parents',
  }),
  new Argument('--merges', { action: 'store_true', help: 'Show only merge commits' }),
  new Argument('--no-merges', { action: 'store_true', help: 'Leave out merge commits' }),

  DATE_OPTION,
  ...DECORATE_OPTIONS,
  new Argument(['-n', '--max-count'], {
    type: 'int',
    numericShorthand: true,
    help: 'Limit the number of commits shown',
  }),
  new Argument('--oneline', { action: 'store_true', help: 'One abbreviated line per commit' }),
  new Argument('--reverse', { action: 'store_true', help: 'Print commits oldest first' }),
  new Argument('--graph', {
    action: 'store_true',
    help: 'Draw the commit history beside the log (implies --topo-order)',
  }),
  new Argument('--topo-order', {
    action: 'store_true',
    help: 'Show no parent before all its children, one line of history at a time',
  }),
  new Argument('--date-order', {
    action: 'store_true',
    help: 'Show no parent before all its children, otherwise newest first',
  }),
  new Argument('--all', {
    action: 'store_true',
    help: 'Start from every ref as well as the revision',
  }),
  PRETTY_OPTION,
  FORMAT_OPTION,
  // The pickaxe, and the reason `git log -S <name> --reverse` answers "which
  // commit introduced this": it selects commits that changed how many times the
  // string occurs, not commits that mention it.
  new Argument('-S', { help: 'Show commits that change the number of occurrences of the string' }),
  new Argument('-G', {
    help: 'Show commits whose diff adds or removes a line that matches the extended regular expression',
  }),
  new Argument('--pickaxe-regex', {
    action: 'store_true',
    help: 'Treat the -S string as an extended regular expression',
  }),
  new Argument('--since', { help: 'Commits more recent than a date (ISO-8601 or epoch)' }),
  new Argument('--until', { help: 'Commits older than a date (ISO-8601 or epoch)' }),
]

const MAILMAP_OPTIONS = [
  new Argument('--mailmap', { action: 'store_true', help: 'Apply mailmap to identities' }),
  new Argument('--use-mailmap', { action: 'store_true', help: 'Apply mailmap to identities' }),
  new Argument('--no-mailmap', { action: 'store_true', help: 'Use recorded identities' }),
  new Argument('--no-use-mailmap', { action: 'store_true', help: 'Use recorded identities' }),
]

const SHOW_OPTIONS = [
  ...MAILMAP_OPTIONS,
  new Argument('--oneline', { action: 'store_true', help: 'One abbreviated line per commit' }),
  ...DIFF_OPTIONS,
  ...MERGE_OPTIONS,
  DATE_OPTION,
  PRETTY_OPTION,
  FORMAT_OPTION,
]

const STATUS_OPTIONS = [
  new Argument('--ignored', { action: 'store_true', help: 'Show ignored files' }),
  new Argument('--porcelain', {
    nargs: '?',
    attachedOnly: true,
    help: 'Machine-readable output, stable across versions',
  }),
  new Argument(['-s', '--short'], {
    action: 'store_true',
    help: 'Give the output in the short format',
  }),
  new Argument(['-b', '--branch'], {
    action: 'store_true',
    help: 'Show the branch line even in short format',
  }),
  // git spells the mode attached (`-uall`) or not at all, never as a separate
  // token, which is what valueOptional says: a bare -u means "all" and the next
  // word is left alone to be an operand.
  new Argument(['-u', '--untracked-files'], {
    nargs: '?',
    attachedOnly: true,
    choices: ['no', 'normal', 'all'],
    help: 'Show untracked files: no, normal or all',
  }),
]

const PATHSPEC = new Argument('text', { metavar: '', nargs: '*' })

const ADD_OPTIONS = [
  new Argument(['-A', '--all'], { action: 'store_true', help: 'Stage every change' }),
  new Argument(['-u', '--update'], {
    action: 'store_true',
    help: 'Stage changes to tracked files only',
  }),
  new Argument(['-f', '--force'], {
    action: 'store_true',
    help: 'Stage paths an ignore rule covers',
  }),
  new Argument(['-v', '--verbose'], {
    action: 'store_true',
    help: 'Name each path as it is added or removed',
  }),
]

const COMMIT_OPTIONS = [
  new Argument(['-q', '--quiet'], { action: 'store_true', help: 'Suppress feedback messages' }),
  new Argument(['-a', '--all'], {
    action: 'store_true',
    help: 'Stage modified and deleted tracked files first',
  }),
  // Required, not defaulted: git would open an editor without it, and a mount
  // has none to open.
  new Argument(['-m', '--message'], { help: 'Commit message' }),
  new Argument('--author', { help: 'Override the recorded author' }),
  new Argument('--allow-empty', {
    action: 'store_true',
    help: 'Record a commit that changes nothing from its parent',
  }),
]

const CHECKOUT_OPTIONS = [
  new Argument('-b', { action: 'store_true', help: 'Create the branch and switch to it' }),
  new Argument('--detach', { action: 'store_true', help: 'Leave HEAD on the commit itself' }),
  new Argument(['-q', '--quiet'], { action: 'store_true', help: 'Suppress feedback messages' }),
]

const SWITCH_OPTIONS = [
  new Argument(['-q', '--quiet'], { action: 'store_true', help: 'Suppress feedback messages' }),
  new Argument(['-c', '--create'], { help: 'Create the branch and switch to it' }),
  new Argument(['-d', '--detach'], {
    action: 'store_true',
    help: 'Detach HEAD at the named commit',
  }),
]

const RESTORE_OPTIONS = [
  new Argument(['-S', '--staged'], { action: 'store_true', help: 'Restore the index' }),
  new Argument(['-W', '--worktree'], {
    action: 'store_true',
    help: 'Restore the working tree (default)',
  }),
  new Argument(['-s', '--source'], { help: 'Which tree-ish to restore from' }),
]

const RM_OPTIONS = [
  new Argument('-r', { action: 'store_true', help: 'Allow recursive removal' }),
  new Argument('--cached', {
    action: 'store_true',
    help: 'Only remove from the index, keeping the file',
  }),
  new Argument(['-f', '--force'], { action: 'store_true', help: 'Override the up-to-date check' }),
  new Argument(['-q', '--quiet'], { action: 'store_true', help: 'Do not list removed files' }),
  new Argument('--ignore-unmatch', {
    action: 'store_true',
    help: 'Exit with a zero status even if nothing matched',
  }),
]

const MV_OPTIONS = [
  new Argument(['-f', '--force'], {
    action: 'store_true',
    help: 'Force move/rename even if target exists',
  }),
  new Argument('-k', { action: 'store_true', help: 'Skip move/rename errors' }),
  new Argument(['-n', '--dry-run'], { action: 'store_true', help: 'Dry run' }),
  new Argument(['-v', '--verbose'], { action: 'store_true', help: 'Be verbose' }),
]

// git's ref-filter options, which `branch` and `tag` share. The four commit
// filters take the next word as their commit, whatever it looks like
// (`--merged --no-merged` names a commit called `--no-merged`), except as the
// line's last word, where they read HEAD: parse-options' LASTARG_DEFAULT. The
// spec has no word for that, so they are declared with an optional value (a
// bare one is HEAD, `--merged=main` is main) and `filterWords` reattaches a
// detached value from the verbatim argv. `--points-at` always takes a value.
const REF_FILTER_OPTIONS = [
  new Argument('--contains', {
    action: 'append',
    nargs: '?',
    attachedOnly: true,
    metavar: 'commit',
    help: 'List only refs that contain the commit (HEAD if omitted)',
  }),
  new Argument('--no-contains', {
    action: 'append',
    nargs: '?',
    attachedOnly: true,
    metavar: 'commit',
    help: "List only refs that don't contain the commit (HEAD if omitted)",
  }),
  new Argument('--merged', {
    action: 'append',
    nargs: '?',
    attachedOnly: true,
    metavar: 'commit',
    help: 'List only refs reachable from the commit (HEAD if omitted)',
  }),
  new Argument('--no-merged', {
    action: 'append',
    nargs: '?',
    attachedOnly: true,
    metavar: 'commit',
    help: 'List only refs not reachable from the commit (HEAD if omitted)',
  }),
  new Argument('--points-at', {
    action: 'append',
    metavar: 'object',
    help: 'List only refs that point at the object',
  }),
]

// git's ref-format options, which `for-each-ref`, `branch` and `tag` share.
// --sort repeats, the last key given sorting first, and --no-sort drops every
// key before it, the default refname included.
const FORMAT_OPTION_REF = new Argument('--format', {
  metavar: 'format',
  help: 'Format each ref: %(fieldname) placeholders, as git for-each-ref',
})
const SORT_OPTIONS = [
  new Argument('--sort', {
    action: 'append',
    metavar: 'key',
    help: 'Sort on a field, - reversing it and version: comparing as versions',
  }),
  new Argument('--no-sort', { action: 'store_true', help: 'Drop the sort keys given so far' }),
]
const OMIT_EMPTY_OPTION = new Argument('--omit-empty', {
  action: 'store_true',
  help: 'Print nothing, not even a newline, for an empty row',
})
const IGNORE_CASE_OPTION = new Argument(['-i', '--ignore-case'], {
  action: 'store_true',
  help: 'Sort and match patterns case-insensitively',
})

const FOR_EACH_REF_OPTIONS = [
  new Argument(['-s', '--shell'], {
    action: 'store_true',
    help: 'Quote fields suitably for shells',
  }),
  new Argument(['-p', '--perl'], { action: 'store_true', help: 'Quote fields suitably for perl' }),
  new Argument('--python', { action: 'store_true', help: 'Quote fields suitably for python' }),
  new Argument('--tcl', { action: 'store_true', help: 'Quote fields suitably for Tcl' }),
  OMIT_EMPTY_OPTION,
  new Argument('--count', { type: 'int', metavar: 'n', help: 'Show only the first <n> refs' }),
  FORMAT_OPTION_REF,
  new Argument('--exclude', {
    action: 'append',
    metavar: 'pattern',
    help: 'Leave out refs matching the pattern',
  }),
  ...SORT_OPTIONS,
  ...REF_FILTER_OPTIONS,
  new Argument('--ignore-case', {
    action: 'store_true',
    help: 'Sort and match patterns case-insensitively',
  }),
  new Argument('--stdin', { action: 'store_true', help: 'Read ref patterns from stdin' }),
  new Argument('--include-root-refs', {
    action: 'store_true',
    help: 'Also list HEAD and the other root refs',
  }),
]

const TAG_OPTIONS = [
  new Argument(['-l', '--list'], { action: 'store_true', help: 'List tag names' }),
  // git spells the count attached (`-n2`) or not at all, never as a separate
  // token, which is what valueOptional says: a bare -n means one line and the
  // next word is left alone to be a pattern.
  new Argument('-n', {
    type: 'int',
    nargs: '?',
    attachedOnly: true,
    help: 'Print <n> lines of each tag message',
  }),
  new Argument(['-d', '--delete'], { action: 'store_true', help: 'Delete tags' }),
  new Argument(['-a', '--annotate'], {
    action: 'store_true',
    help: 'Annotated tag, needs a message',
  }),
  new Argument(['-m', '--message'], {
    action: 'append',
    help: 'Tag message (repeatable, one paragraph each)',
  }),
  new Argument(['-f', '--force'], { action: 'store_true', help: 'Replace the tag if exists' }),
  ...REF_FILTER_OPTIONS,
  ...SORT_OPTIONS,
  FORMAT_OPTION_REF,
  OMIT_EMPTY_OPTION,
  IGNORE_CASE_OPTION,
]

const BRANCH_OPTIONS = [
  new Argument('--show-current', { action: 'store_true', help: 'Show the current branch name' }),
  new Argument(['-q', '--quiet'], { action: 'store_true', help: 'Suppress feedback messages' }),
  new Argument(['-v', '--verbose'], { action: 'count', help: 'Show commit and upstream details' }),
  new Argument('-a', { action: 'store_true', help: 'List local and remote-tracking branches' }),
  new Argument('-r', { action: 'store_true', help: 'List remote-tracking branches' }),
  new Argument(['-d', '--delete'], { action: 'store_true', help: 'Delete a fully merged branch' }),
  new Argument('-D', { action: 'store_true', help: 'Delete a branch even if not merged' }),
  new Argument(['-l', '--list'], {
    action: 'store_true',
    help: 'List branches matching the patterns',
  }),
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
  const found = findNode(GIT.spec, inv.texts)
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
      nodeHelp(['git', ...found.path].join(' '), found.node, GIT.spec.usageStyle),
    ),
    new IOResult(),
  ]
}

export const GIT = new CLI({
  spec: new CommandSpec({
    name: 'git',
    description: 'Content tracker',
    usageStyle: UsageStyle.GIT,
    operandBase: '-C',
    arguments: [
      DIRECTORY_OPTION,
      new Argument('--git-dir', {
        type: 'path',
        env: 'GIT_DIR',
        help: 'Use the repository at <path>',
      }),
      new Argument('--work-tree', {
        type: 'path',
        env: 'GIT_WORK_TREE',
        help: 'Use <path> as the working tree',
      }),
    ],
    subcommands: [
      new CommandSpec({
        name: 'reflog',
        description: 'Show reference history',
        arguments: [
          new Argument(['-n', '--max-count'], {
            type: 'int',
            numericShorthand: true,
            help: 'Limit the number of entries',
          }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'for-each-ref',
        description: 'List references with a format',
        arguments: [...FOR_EACH_REF_OPTIONS, REVISION],
      }),
      new CommandSpec({
        name: 'cat-file',
        description: 'Provide contents or details of repository objects',
        arguments: [
          new Argument('-t', { action: 'store_true', help: 'Show the object type' }),
          new Argument('-s', { action: 'store_true', help: 'Show the object size' }),
          new Argument('-e', { action: 'store_true', help: 'Check if <object> exists' }),
          new Argument('-p', { action: 'store_true', help: 'Pretty-print <object> content' }),
          new Argument('--batch', {
            nargs: '?',
            attachedOnly: true,
            help: 'Show full <object> or <rev> contents',
          }),
          new Argument('--batch-check', {
            nargs: '?',
            attachedOnly: true,
            help: "Like --batch, but don't emit <contents>",
          }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'hash-object',
        description: 'Compute object ID and optionally create an object from a file',
        arguments: [
          new Argument('-t', { help: 'Object type' }),
          new Argument('-w', {
            action: 'store_true',
            help: 'Write the object into the object database',
          }),
          new Argument('--stdin', { action: 'store_true', help: 'Read the object from stdin' }),
          new Argument('--stdin-paths', {
            action: 'store_true',
            help: 'Read file names from stdin',
          }),
          new Argument('--no-filters', {
            action: 'store_true',
            help: 'Store file as is without filters',
          }),
          new Argument('--literally', {
            action: 'store_true',
            help: 'Just hash any random garbage to create corrupt objects for debugging Git',
          }),
          new Argument('--path', { help: 'Process file as it were from this path' }),
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'grep',
        description: 'Search tracked files in the working tree, index or named trees',
        arguments: [
          new Argument('--cached', {
            action: 'store_true',
            help: 'Search index blobs instead of working files',
          }),
          new Argument(['-n', '--line-number'], {
            action: 'store_true',
            help: 'Show line numbers',
          }),
          new Argument(['-i', '--ignore-case'], {
            action: 'store_true',
            help: 'Match without regard to case',
          }),
          new Argument(['-F', '--fixed-strings'], {
            action: 'store_true',
            help: 'Match literal strings',
          }),
          new Argument(['-E', '--extended-regexp'], {
            action: 'store_true',
            help: 'Use extended regular expressions',
          }),
          new Argument(['-G', '--basic-regexp'], {
            action: 'store_true',
            help: 'Use basic regular expressions',
          }),
          new Argument(['-w', '--word-regexp'], {
            action: 'store_true',
            help: 'Match at word boundaries',
          }),
          new Argument(['-v', '--invert-match'], {
            action: 'store_true',
            help: 'Select nonmatching lines',
          }),
          new Argument(['-c', '--count'], {
            action: 'store_true',
            help: 'Count selected lines in each matching file',
          }),
          new Argument(['-l', '--files-with-matches'], {
            action: 'store_true',
            help: 'Show only matching filenames',
          }),
          new Argument(['-L', '--files-without-match'], {
            action: 'store_true',
            help: 'Show only nonmatching filenames',
          }),
          new Argument(['-q', '--quiet'], {
            action: 'store_true',
            help: 'Report matches through exit status',
          }),
          new Argument('-e', { action: 'append', help: 'Match an additional pattern' }),
          new Argument(['-a', '--text'], {
            action: 'store_true',
            help: 'Treat binary files as text',
          }),
          new Argument('-I', { action: 'store_true', help: 'Skip binary files' }),
          new Argument(['-z', '--null'], {
            action: 'store_true',
            help: 'Terminate filename fields with NUL',
          }),
          new Argument('-h', { action: 'store_true', help: 'Omit filenames from matching lines' }),
          new Argument('-H', { action: 'store_true', help: 'Show filenames with matching lines' }),
          new Argument('texts', { metavar: '', nargs: 'REMAINDER' }),
        ],
      }),
      new CommandSpec({
        name: 'ls-tree',
        description: 'List the contents of a tree object',
        arguments: [
          new Argument('-r', { action: 'store_true', help: 'Recurse into subtrees' }),
          new Argument('-t', { action: 'store_true', help: 'Show trees when recursing' }),
          new Argument('-d', { action: 'store_true', help: 'Only show trees' }),
          new Argument('-z', { action: 'store_true', help: 'Terminate entries with NUL' }),
          new Argument('--name-only', { action: 'store_true', help: 'Show only filenames' }),
          new Argument('--name-status', { action: 'store_true', help: 'Alias of --name-only' }),
          new Argument('--full-name', {
            action: 'store_true',
            help: 'Show paths relative to the repository root',
          }),
          new Argument('--full-tree', {
            action: 'store_true',
            help: 'List the whole tree, ignoring the current directory',
          }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'ls-files',
        description: 'Show files in the index',
        arguments: [
          new Argument('-z', { action: 'store_true', help: 'Terminate paths with NUL' }),
          new Argument(['-s', '--stage'], {
            action: 'store_true',
            help: 'Show staged object metadata',
          }),
          new Argument(['-c', '--cached'], { action: 'store_true', help: 'Show cached files' }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'fetch',
        description: 'Download objects and refs from another repository',
        arguments: [
          new Argument(['-q', '--quiet'], {
            action: 'store_true',
            help: 'Print nothing but errors',
          }),
          new Argument(['-v', '--verbose'], {
            action: 'store_true',
            help: 'Also list unchanged refs',
          }),
          new Argument(['-p', '--prune'], {
            action: 'store_true',
            help: 'Remove remote-tracking refs the remote no longer has',
          }),
          new Argument(['-t', '--tags'], { action: 'store_true', help: 'Fetch every tag' }),
          new Argument(['-n', '--no-tags'], { action: 'store_true', help: 'Follow no tags' }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'clone',
        description: 'Clone a repository into a new directory',
        arguments: [
          new Argument(['-q', '--quiet'], {
            action: 'store_true',
            help: 'Print nothing but errors',
          }),
          new Argument(['-b', '--branch'], { help: 'Check out this branch or tag' }),
          new Argument(['-o', '--origin'], { help: 'Name the remote this instead of origin' }),
          new Argument(['-n', '--no-checkout'], {
            action: 'store_true',
            help: 'Leave the working tree empty',
          }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'help',
        description: 'Show command help',
        arguments: [new Argument('texts', { metavar: '', nargs: '*' })],
      }),
      new CommandSpec({
        name: 'init',
        description: 'Create an empty Git repository or reinitialize an existing one',
        arguments: [
          new Argument(['-q', '--quiet'], { action: 'store_true' }),
          new Argument('--bare', { action: 'store_true' }),
          new Argument(['-b', '--initial-branch']),
          new Argument('directory', { nargs: '?' }),
        ],
      }),
      new CommandSpec({
        name: 'fsck',
        description: 'Verify object hashes and connectivity',
        arguments: [
          new Argument('--full', { action: 'store_true' }),
          new Argument('--no-dangling', { action: 'store_true' }),
          new Argument('--unreachable', { action: 'store_true' }),
        ],
      }),
      new CommandSpec({
        name: 'stash',
        description: 'Inspect saved working trees',
        subcommands: [
          new CommandSpec({ name: 'list', description: 'List stashed changes' }),
          new CommandSpec({
            name: 'show',
            description: 'Show stashed changes',
            arguments: [...DIFF_OPTIONS, new Argument('stash', { nargs: '?' })],
          }),
        ],
      }),
      new CommandSpec({
        name: 'version',
        aliases: ['--version', '-v'],
        description: 'Show the Mirage Git implementation version',
      }),
      new CommandSpec({
        name: 'remote',
        description: 'List remotes and inspect their URLs',
        arguments: [
          new Argument(['-v', '--verbose'], { action: 'store_true', help: 'Show remote URLs' }),
          new Argument('texts', { metavar: '', nargs: 'REMAINDER' }),
        ],
      }),
      new CommandSpec({
        name: 'config',
        description: 'Read repository configuration',
        arguments: [
          new Argument('--global', { action: 'store_true', help: 'Read global configuration' }),
          new Argument('--get', { action: 'store_true', help: 'Get a configuration value' }),
          new Argument(['-l', '--list'], {
            action: 'store_true',
            help: 'List every variable and value',
          }),
          new Argument('--show-origin', {
            action: 'store_true',
            help: 'Show the file each value comes from',
          }),
          new Argument('--get-regexp', {
            action: 'store_true',
            help: 'Get the variables whose names match a regular expression',
          }),
          new Argument('name', { nargs: '?' }),
          new Argument('value', { nargs: '?' }),
          new Argument('value-pattern', { nargs: '?' }),
        ],
      }),
      new CommandSpec({
        name: 'merge-base',
        description: 'Find best common ancestors of commits',
        arguments: [
          new Argument(['-a', '--all'], {
            action: 'store_true',
            help: 'Show all best common ancestors',
          }),
          new Argument('--is-ancestor', {
            action: 'store_true',
            help: 'Test whether the first commit is an ancestor of the second',
          }),
          REVISION,
        ],
      }),
      new CommandSpec({ name: 'show-ref', description: 'List references', arguments: [REVISION] }),
      // symbolic-ref has every option git's has, so its rows carry git's own
      // help and its usage block reads exactly as git's.
      new CommandSpec({
        name: 'symbolic-ref',
        description: 'Read, change or delete a symbolic ref',
        arguments: [
          new Argument(['-q', '--quiet'], {
            action: 'store_true',
            help: 'suppress error message for non-symbolic (detached) refs',
          }),
          new Argument('--no-quiet', {
            action: 'store_true',
            help: 'Refuse a ref that is not symbolic aloud',
          }),
          new Argument(['-d', '--delete'], { action: 'store_true', help: 'delete symbolic ref' }),
          new Argument('--no-delete', {
            action: 'store_true',
            help: 'Read or change the ref instead',
          }),
          new Argument('--short', { action: 'store_true', help: 'shorten ref output' }),
          new Argument('--no-short', {
            action: 'store_true',
            help: 'Print the full name it points at',
          }),
          new Argument('--recurse', {
            action: 'store_true',
            help: 'recursively dereference (default)',
          }),
          new Argument('--no-recurse', {
            action: 'store_true',
            help: 'Print only the ref this one points at directly',
          }),
          new Argument('-m', { metavar: 'reason', help: 'reason of the update' }),
          new Argument('texts', { metavar: '', nargs: '*' }),
        ],
      }),
      // shortlog's -n is --numbered, so the count keeps only its long spelling.
      new CommandSpec({
        name: 'shortlog',
        description: 'Summarize commit history',
        arguments: [
          ...LOG_OPTIONS.filter((opt) => !opt.names.includes('-n')),
          new Argument('--max-count', { type: 'int', help: 'Limit the number of commits' }),
          new Argument(['-s', '--summary'], {
            action: 'store_true',
            help: 'Show only commit counts',
          }),
          new Argument(['-e', '--email'], {
            action: 'store_true',
            help: 'Show author email addresses',
          }),
          new Argument(['-n', '--numbered'], {
            action: 'store_true',
            help: 'Sort by commit count',
          }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'rev-parse',
        description: 'Resolve revisions',
        arguments: [
          new Argument('--show-toplevel', { action: 'store_true', help: 'Show the worktree root' }),
          new Argument('--abbrev-ref', {
            nargs: '?',
            attachedOnly: true,
            help: 'Show abbreviated reference names, strict or loose',
          }),
          new Argument('--show-prefix', {
            action: 'store_true',
            help: 'Show the current directory relative to the worktree root',
          }),
          new Argument('--is-shallow-repository', {
            action: 'store_true',
            help: 'Print whether the repository is shallow',
          }),
          new Argument('--is-inside-work-tree', {
            action: 'store_true',
            help: 'Print whether the current directory is inside the work tree',
          }),
          new Argument('--verify', {
            action: 'store_true',
            help: 'Require exactly one revision that names an object',
          }),
          new Argument('--short', {
            nargs: '?',
            attachedOnly: true,
            help: 'Abbreviate the object name; implies --verify',
          }),
          new Argument(['-q', '--quiet'], {
            action: 'store_true',
            help: 'With --verify, exit 1 without a message',
          }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'rev-list',
        description: 'List reachable commits',
        arguments: [
          ...LOG_OPTIONS,
          new Argument('--count', { action: 'store_true', help: 'Print commit count' }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'diff-tree',
        description: 'Compare a commit with its parent',
        arguments: [
          ...SHOW_OPTIONS,
          new Argument('--no-commit-id', { action: 'store_true', help: 'Suppress commit ID' }),
          new Argument('-r', { action: 'store_true', help: 'Recurse into subtrees' }),
          new Argument('commit'),
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'status',
        description: 'Show the working tree status',
        arguments: [...STATUS_OPTIONS],
      }),
      new CommandSpec({
        name: 'log',
        description: 'Show commit logs',
        arguments: [...LOG_OPTIONS, ...MAILMAP_OPTIONS, ...DIFF_OPTIONS, REVISION],
      }),
      new CommandSpec({
        name: 'show',
        description: 'Show a commit and its diff',
        arguments: [...SHOW_OPTIONS, ...DECORATE_OPTIONS, REVISION],
      }),
      new CommandSpec({
        name: 'diff',
        description: 'Show changes between commits',
        arguments: [
          ...DIFF_OPTIONS,
          new Argument('--cached', {
            action: 'store_true',
            help: 'Compare the index with a commit',
          }),
          new Argument('--staged', { action: 'store_true', help: 'Alias of --cached' }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'branch',
        description: 'List, create or delete branches',
        arguments: [...BRANCH_OPTIONS, new Argument('texts', { metavar: '', nargs: '*' })],
      }),
      new CommandSpec({
        name: 'add',
        description: 'Stage working tree content',
        arguments: [...ADD_OPTIONS, PATHSPEC],
      }),
      new CommandSpec({
        name: 'reset',
        description: 'Unstage, putting the index back to HEAD',
        arguments: [
          new Argument(['-q', '--quiet'], { action: 'store_true', help: 'Only report errors' }),
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'commit',
        description: 'Record the index as a new commit',
        arguments: [...COMMIT_OPTIONS],
      }),
      new CommandSpec({
        name: 'checkout',
        description: 'Switch branches',
        arguments: [...CHECKOUT_OPTIONS, REVISION],
      }),
      new CommandSpec({
        name: 'switch',
        description: 'Switch branches',
        arguments: [...SWITCH_OPTIONS, REVISION],
      }),
      new CommandSpec({
        name: 'restore',
        description: 'Restore working tree files',
        arguments: [...RESTORE_OPTIONS, PATHSPEC],
      }),
      new CommandSpec({
        name: 'rm',
        description: 'Remove files from the working tree and the index',
        arguments: [...RM_OPTIONS, PATHSPEC],
      }),
      new CommandSpec({
        name: 'mv',
        description: 'Move or rename a file, a directory, or a symlink',
        arguments: [...MV_OPTIONS, PATHSPEC],
      }),
      new CommandSpec({
        name: 'tag',
        description: 'Create, list or delete a tag',
        arguments: [...TAG_OPTIONS, new Argument('texts', { metavar: '', nargs: '*' })],
      }),
    ],
  }),
  handlers: {
    reflog: new CLIHandler({ fn: verb(reflog) }),
    'for-each-ref': new CLIHandler({ fn: verb(forEachRef) }),
    'cat-file': new CLIHandler({ fn: verb(catFile) }),
    'hash-object': new CLIHandler({ fn: verb(hashObject, hashObjectReadOnly) }),
    grep: new CLIHandler({ fn: verb(grep) }),
    'ls-tree': new CLIHandler({ fn: verb(lsTree) }),
    'ls-files': new CLIHandler({ fn: verb(lsFiles) }),
    fetch: new CLIHandler({ fn: verb(fetch, fetchReadOnly) }),
    clone: new CLIHandler({ fn: verb(clone, cloneReadOnly) }),
    help: new CLIHandler({ fn: verb(helpCmd) }),
    init: new CLIHandler({ fn: verb(init), write: true }),
    fsck: new CLIHandler({ fn: verb(fsck) }),
    'stash list': new CLIHandler({ fn: verb(stashList) }),
    'stash show': new CLIHandler({ fn: verb(stashShow) }),
    version: new CLIHandler({ fn: verb(version) }),
    remote: new CLIHandler({ fn: verb(remote) }),
    config: new CLIHandler({ fn: verb(config) }),
    'merge-base': new CLIHandler({ fn: verb(mergeBase) }),
    'show-ref': new CLIHandler({ fn: verb(showRef) }),
    'symbolic-ref': new CLIHandler({ fn: verb(symbolicRef, symbolicRefReadOnly), write: true }),
    shortlog: new CLIHandler({ fn: verb(shortlog) }),
    'rev-parse': new CLIHandler({ fn: verb(revParse) }),
    'rev-list': new CLIHandler({ fn: verb(revList) }),
    'diff-tree': new CLIHandler({ fn: verb(diffTree) }),
    status: new CLIHandler({ fn: verb(status) }),
    log: new CLIHandler({ fn: verb(log) }),
    show: new CLIHandler({ fn: verb(show) }),
    diff: new CLIHandler({ fn: verb(diff) }),
    branch: new CLIHandler({ fn: verb(branch, branchReadOnly), write: true }),
    add: new CLIHandler({ fn: verb(add, indexLocked), write: true }),
    reset: new CLIHandler({ fn: verb(reset, indexLocked), write: true }),
    commit: new CLIHandler({ fn: verb(commit, indexLocked), write: true }),
    checkout: new CLIHandler({ fn: verb(checkout, checkoutReadOnly), write: true }),
    switch: new CLIHandler({ fn: verb(switchBranch, switchReadOnly), write: true }),
    restore: new CLIHandler({ fn: verb(restore, indexLocked), write: true }),
    rm: new CLIHandler({ fn: verb(rm, indexLocked), write: true }),
    mv: new CLIHandler({ fn: verb(mv, indexLocked), write: true }),
    tag: new CLIHandler({ fn: verb(tag, tagReadOnly), write: true }),
  },
})
