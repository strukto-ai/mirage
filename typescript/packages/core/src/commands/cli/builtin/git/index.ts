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
import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { CommandSpec } from '../../../spec/types.ts'
import { CLI } from '../../types.ts'
import { CLIHandler } from '../../types.ts'

import { lsFiles, lsTree } from './ls_files.ts'
import { forEachRef } from './for_each_ref.ts'
import { reflog } from './reflog.ts'
import { fetch, fetchReadOnly } from './fetch.ts'
import { clone, cloneReadOnly } from './clone.ts'
import { Argument, UsageStyle } from '../../../spec/types.ts'
import { add } from './add.ts'
import { init } from './init.ts'
import { fsck } from './fsck.ts'
import { grep } from './grep.ts'
import { hashObject, hashObjectReadOnly } from './hash_object.ts'
import { stashList, stashShow } from './stash.ts'
import { nodeHelp, findNode } from '../../walk.ts'
import { IOResult } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { branch, branchReadOnly } from './branch.ts'
import { catFile } from './cat_file.ts'
import { checkout, checkoutReadOnly } from './checkout.ts'
import { commit } from './commit.ts'
import { checkIgnore } from './check_ignore.ts'
import { lsRemote } from './ls_remote.ts'
import { describe } from './describe.ts'
import { diff, diffFiles, diffIndex } from './diff.ts'
import { log } from './log.ts'
import { mv } from './mv.ts'
import { reset } from './reset.ts'
import { restore } from './restore.ts'
import { rm } from './rm.ts'
import { config } from './config.ts'
import {
  checkRefFormat,
  revParse,
  mergeBase,
  remote,
  revList,
  version,
  showRef,
} from './inspect.ts'
import { shortlog } from './shortlog.ts'
import { symbolicRef, symbolicRefReadOnly } from './symbolic_ref.ts'
import { indexLocked, verb } from './session.ts'
import { show, diffTree } from './show.ts'
import { status } from './status.ts'
import { switchBranch, switchReadOnly } from './switch.ts'
import { tag, tagReadOnly } from './tag.ts'
import { checkSwitches } from './util.ts'

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

// --pretty and --format choose the same format in git; both take git's
// optional-value form, so a bare --pretty means medium and a detached next
// word is a revision, never a format. A bare --format stays parseable too,
// but only so prettyFormat can answer it with git's own fatal (git takes
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

// Commands never paint, so these only have to be accepted and checked.
const COLOR_OPTIONS = [
  new Argument('--color', {
    nargs: '?',
    attachedOnly: true,
    metavar: 'when',
    help: 'Accepted; output stays plain',
  }),
  new Argument('--no-color', { action: 'store_true', help: 'Accepted; output stays plain' }),
]

const NO_COLUMN_OPTION = new Argument('--no-column', {
  action: 'store_true',
  help: 'List one entry per line',
})

// Where a comparison answers by exit status, and takes the id width.
const DIFF_RESULT_OPTIONS = [
  new Argument('--quiet', {
    action: 'store_true',
    help: 'Print nothing; exit 1 if there are differences',
  }),
  new Argument('--exit-code', { action: 'store_true', help: 'Exit 1 if there are differences' }),
  new Argument('--abbrev', {
    nargs: '?',
    attachedOnly: true,
    help: 'Abbreviate ids to this many digits',
  }),
  new Argument('--no-abbrev', { action: 'store_true', help: 'Show whole ids in --raw' }),
]

const DIFF_OPTIONS = [
  ...COLOR_OPTIONS,
  new Argument('--diff-filter', {
    metavar: '[ACDMRTUXB*]',
    help: 'Show only the paths with these change classes',
  }),
  new Argument('--no-prefix', {
    action: 'store_true',
    help: 'Show no source or destination prefix',
  }),
  new Argument('--default-prefix', { action: 'store_true', help: 'Use the a/ and b/ prefixes' }),
  new Argument('--src-prefix', { help: 'Show this source prefix' }),
  new Argument('--dst-prefix', { help: 'Show this destination prefix' }),
  new Argument('--full-index', {
    action: 'store_true',
    help: 'Show whole blob ids on the index line',
  }),
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
  new Argument('--boundary', {
    action: 'store_true',
    help: 'Also show the excluded commits the history stops at',
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
  new Argument('--pickaxe-all', {
    action: 'store_true',
    help: 'Show every file a matching commit changed, not only the files -S or -G matched',
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
  NO_COLUMN_OPTION,
  new Argument(['-z', '--null'], {
    action: 'store_true',
    help: 'End each entry with NUL; implies --porcelain',
  }),
  new Argument('--long', { action: 'store_true', help: 'Give the output in the long format' }),
  new Argument('--show-stash', { action: 'store_true', help: 'Say how many stashes there are' }),
  new Argument('--no-show-stash', { action: 'store_true' }),
  new Argument('--ahead-behind', {
    action: 'store_true',
    help: 'Count how far the branch and its upstream have moved',
  }),
  new Argument('--no-ahead-behind', { action: 'store_true' }),
  new Argument('--renames', { action: 'store_true', help: 'Pair renamed files' }),
  new Argument('--no-renames', { action: 'store_true' }),
  new Argument('--find-renames', {
    nargs: '?',
    attachedOnly: true,
    help: 'Pair renames with an optional similarity threshold',
  }),
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
  new Argument('-b', { metavar: 'branch', help: 'Create the branch and switch to it' }),
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
  ...COLOR_OPTIONS,
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
  ...COLOR_OPTIONS,
  NO_COLUMN_OPTION,
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
  ...COLOR_OPTIONS,
  NO_COLUMN_OPTION,
  new Argument('--show-current', { action: 'store_true', help: 'Show the current branch name' }),
  new Argument(['-q', '--quiet'], { action: 'store_true', help: 'Suppress feedback messages' }),
  new Argument(['-v', '--verbose'], { action: 'count', help: 'Show commit and upstream details' }),
  new Argument(['-a', '--all'], {
    action: 'store_true',
    help: 'List local and remote-tracking branches',
  }),
  new Argument(['-r', '--remotes'], {
    action: 'store_true',
    help: 'List remote-tracking branches',
  }),
  new Argument(['-d', '--delete'], { action: 'store_true', help: 'Delete a fully merged branch' }),
  new Argument('-D', { action: 'store_true', help: 'Delete a branch even if not merged' }),
  new Argument('--delete-merged', {
    action: 'append',
    metavar: 'pattern',
    help: 'Delete merged branches whose upstream matches (repeatable)',
  }),
  new Argument('--dry-run', {
    action: 'store_true',
    help: 'With --delete-merged, only print what would be deleted',
  }),
  new Argument('--no-dry-run', { action: 'store_true' }),
  new Argument(['-l', '--list'], {
    action: 'store_true',
    help: 'List branches matching the patterns',
  }),
  ...REF_FILTER_OPTIONS,
  new Argument('--forked', {
    action: 'append',
    metavar: 'branch',
    help: 'List branches whose upstream matches (repeatable)',
  }),
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
function helpCmd(
  _accessor: NOOPAccessor,
  paths: PathSpec[],
  texts: string[],
  ctx: Context,
): CommandFnResult {
  checkSwitches(ctx, texts)
  const found = findNode(GIT.spec, texts)
  if (found === null)
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: new TextEncoder().encode(
          `git: '${texts.join(' ')}' is not a git command. See 'git --help'.\n`,
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
      new Argument(['--config-env', '-c'], {
        action: 'append',
        metavar: 'name=value',
        help: 'Set a config variable for this one command',
      }),
      new Argument(['-p', '--paginate'], {
        action: 'store_true',
        help: 'Accepted; there is no pager to run',
      }),
      new Argument(['-P', '--no-pager'], {
        action: 'store_true',
        help: 'Accepted; there is no pager to run',
      }),
      new Argument('--no-optional-locks', {
        action: 'store_true',
        help: 'Accepted; only the locks a write needs are taken',
      }),
      new Argument('--no-replace-objects', {
        action: 'store_true',
        help: 'Accepted; replace refs are not followed',
      }),
      new Argument('--no-lazy-fetch', {
        action: 'store_true',
        help: 'Accepted; objects are never fetched lazily',
      }),
      new Argument('--no-advice', {
        action: 'store_true',
        help: 'Accepted; hints stay as they are',
      }),
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
          ...COLOR_OPTIONS,
          new Argument(['-A', '--after-context'], {
            type: 'int',
            help: 'Print this many lines after each match',
          }),
          new Argument(['-B', '--before-context'], {
            type: 'int',
            help: 'Print this many lines before each match',
          }),
          new Argument(['-C', '--context'], {
            type: 'int',
            numericShorthand: true,
            help: 'Print this many lines around each match',
          }),
          new Argument(['-m', '--max-count'], {
            type: 'int',
            help: 'Stop after this many matches in a file',
          }),
          new Argument('--threads', {
            type: 'int',
            help: 'Accepted; files are searched in order',
          }),
          new Argument('--heading', {
            action: 'store_true',
            help: "Print each file's name once, above its matches",
          }),
          new Argument('--break', {
            action: 'store_true',
            help: 'Print a blank line between files',
          }),
          new Argument('--full-name', {
            action: 'store_true',
            help: 'Name paths from the top of the work tree',
          }),
          new Argument('--untracked', {
            action: 'store_true',
            help: 'Also search untracked files',
          }),
          new Argument('--exclude-standard', {
            action: 'store_true',
            help: 'With --untracked, skip ignored files',
          }),
          new Argument('--no-exclude-standard', {
            action: 'store_true',
            help: 'With --untracked, search ignored files too',
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
          new Argument(['-l', '--long'], { action: 'store_true', help: "Show each blob's size" }),
          new Argument('--object-only', {
            action: 'store_true',
            help: 'Print only each object id',
          }),
          new Argument('--abbrev', {
            nargs: '?',
            attachedOnly: true,
            help: 'Abbreviate ids to this many digits',
          }),
          new Argument('--format', { help: 'Format each row: %(atom) placeholders' }),
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
          new Argument(['-o', '--others'], { action: 'store_true', help: 'Show untracked files' }),
          new Argument(['-m', '--modified'], {
            action: 'store_true',
            help: 'Show files that differ from the index',
          }),
          new Argument(['-d', '--deleted'], {
            action: 'store_true',
            help: 'Show files missing from the work tree',
          }),
          new Argument(['-i', '--ignored'], {
            action: 'store_true',
            help: 'Show only excluded files; needs -o or -c',
          }),
          new Argument(['-u', '--unmerged'], {
            action: 'store_true',
            help: 'Show only unmerged entries',
          }),
          new Argument('-t', { action: 'store_true', help: 'Prefix each row with its status' }),
          new Argument('-v', { action: 'store_true', help: 'Same as -t' }),
          new Argument('-f', { action: 'store_true', help: 'Same as -t' }),
          new Argument('--directory', {
            action: 'store_true',
            help: 'Show an untracked directory by its name',
          }),
          new Argument('--no-empty-directory', {
            action: 'store_true',
            help: 'Leave out empty directories',
          }),
          new Argument('--exclude-standard', {
            action: 'store_true',
            help: "Apply the repository's ignore files",
          }),
          new Argument(['-x', '--exclude'], {
            action: 'append',
            help: 'Leave out what matches this pattern',
          }),
          new Argument(['-X', '--exclude-from'], {
            action: 'append',
            help: 'Read exclude patterns from a file',
          }),
          new Argument('--exclude-per-directory', {
            help: 'Read this exclude file in each directory',
          }),
          new Argument('--error-unmatch', {
            action: 'store_true',
            help: 'Fail for a pathspec that matches nothing',
          }),
          new Argument('--full-name', {
            action: 'store_true',
            help: 'Name paths from the top of the work tree',
          }),
          new Argument('--deduplicate', { action: 'store_true', help: 'List each path once' }),
          new Argument('--abbrev', {
            nargs: '?',
            attachedOnly: true,
            help: 'Abbreviate ids to this many digits',
          }),
          new Argument('--format', { help: 'Format each row: %(atom) placeholders' }),
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
          new Argument('--system', {
            action: 'store_true',
            help: 'Read the machine-wide configuration',
          }),
          new Argument('--local', {
            action: 'store_true',
            help: "Read the repository's configuration",
          }),
          new Argument('--worktree', {
            action: 'store_true',
            help: "Read the work tree's configuration",
          }),
          new Argument(['-f', '--file'], { help: 'Read the named config file' }),
          new Argument('--get', { action: 'store_true', help: 'Get a configuration value' }),
          new Argument('--get-all', {
            action: 'store_true',
            help: 'Get every value of a variable',
          }),
          new Argument('--all', { action: 'store_true', help: 'With get, print every value' }),
          new Argument('--regexp', {
            action: 'store_true',
            help: 'With get, read the name as a pattern',
          }),
          new Argument('--value', { help: 'With get, keep values that match' }),
          new Argument('--fixed-value', {
            action: 'store_true',
            help: 'Compare the value pattern literally',
          }),
          new Argument('--show-names', {
            action: 'store_true',
            help: 'With get, print names too',
          }),
          new Argument('--default', { help: 'Answer when the variable is unset' }),
          new Argument('--type', { help: 'Print as bool, int, bool-or-int or path' }),
          new Argument('--bool', { action: 'store_true', help: 'Print as a boolean' }),
          new Argument('--int', { action: 'store_true', help: 'Print as an integer' }),
          new Argument('--bool-or-int', {
            action: 'store_true',
            help: 'Print as a boolean or an integer',
          }),
          new Argument('--path', { action: 'store_true', help: 'Expand a leading ~/' }),
          new Argument(['-z', '--null'], { action: 'store_true', help: 'End each value with NUL' }),
          new Argument('--name-only', {
            action: 'store_true',
            help: 'Print names without values',
          }),
          new Argument('--show-scope', {
            action: 'store_true',
            help: 'Show the scope of each value',
          }),
          new Argument('--includes', {
            action: 'store_true',
            help: 'Accepted; include files are not followed',
          }),
          new Argument('--no-includes', {
            action: 'store_true',
            help: 'Accepted; include files are not followed',
          }),
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
          new Argument('--octopus', {
            action: 'store_true',
            help: 'Find the common ancestor of all the commits',
          }),
          new Argument('--independent', {
            action: 'store_true',
            help: 'List the commits no other commit reaches',
          }),
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
      new CommandSpec({
        name: 'show-ref',
        description: 'List references',
        arguments: [
          new Argument('--heads', { action: 'store_true', help: 'Only list branches' }),
          new Argument('--branches', { action: 'store_true', help: 'Only list branches' }),
          new Argument('--tags', { action: 'store_true', help: 'Only list tags' }),
          new Argument('--head', { action: 'store_true', help: 'List HEAD first' }),
          new Argument(['-d', '--dereference'], {
            action: 'store_true',
            help: 'Also list what an annotated tag points at',
          }),
          new Argument(['-s', '--hash'], {
            nargs: '?',
            attachedOnly: true,
            help: 'Print only the id, of this many digits',
          }),
          new Argument('--abbrev', {
            nargs: '?',
            attachedOnly: true,
            help: 'Abbreviate the id to this many digits',
          }),
          new Argument(['-q', '--quiet'], {
            action: 'store_true',
            help: 'Print nothing; the exit status answers',
          }),
          new Argument('--verify', {
            action: 'store_true',
            help: 'Each operand must be a whole ref name',
          }),
          new Argument('--exists', { action: 'store_true', help: 'Test whether one ref exists' }),
          REVISION,
        ],
      }),
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
          ...COLOR_OPTIONS,
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
          new Argument('--is-inside-git-dir', {
            action: 'store_true',
            help: 'Print whether the current directory is inside the git directory',
          }),
          new Argument('--is-bare-repository', {
            action: 'store_true',
            help: 'Print whether the repository is bare',
          }),
          new Argument('--show-cdup', {
            action: 'store_true',
            help: 'Show the way up to the worktree root',
          }),
          new Argument('--absolute-git-dir', {
            action: 'store_true',
            help: "Show the git directory's absolute path",
          }),
          new Argument('--git-common-dir', {
            action: 'store_true',
            help: 'Show the directory shared by linked worktrees',
          }),
          new Argument('--git-path', {
            nargs: '?',
            metavar: 'path',
            help: 'Show where a file of the git directory lives',
          }),
          new Argument('--path-format', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'absolute|relative',
            help: 'Print later paths in this form',
          }),
          new Argument('--show-object-format', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'mode',
            help: 'Show the hash the repository uses',
          }),
          new Argument('--show-ref-format', {
            action: 'store_true',
            help: 'Show how the repository stores refs',
          }),
          new Argument('--symbolic', {
            action: 'store_true',
            help: 'Print later revisions as they were typed',
          }),
          new Argument('--symbolic-full-name', {
            action: 'store_true',
            help: 'Print later revisions as whole ref names, dropping what names no ref',
          }),
          new Argument('--not', {
            action: 'store_true',
            help: 'Print later revisions with their sign flipped',
          }),
          new Argument('--default', {
            nargs: '?',
            metavar: 'revision',
            help: 'Use this revision if the line gives none',
          }),
          new Argument('--all', {
            action: 'store_true',
            help: 'List every ref under refs/',
          }),
          new Argument('--branches', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'pattern',
            help: 'List branches, or those matching a pattern',
          }),
          new Argument('--tags', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'pattern',
            help: 'List tags, or those matching a pattern',
          }),
          new Argument('--remotes', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'pattern',
            help: 'List remote-tracking branches, or those matching a pattern',
          }),
          new Argument('--glob', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'pattern',
            help: 'List the refs a pattern matches',
          }),
          new Argument('--exclude', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'pattern',
            help: 'Leave matching refs out of the next listing',
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
          ...COLOR_OPTIONS,
          new Argument('--count', { action: 'store_true', help: 'Print commit count' }),
          REVISION,
        ],
      }),
      new CommandSpec({
        name: 'diff-tree',
        description: 'Compare a commit with its parent, or two trees',
        arguments: [
          ...SHOW_OPTIONS,
          ...DIFF_RESULT_OPTIONS,
          new Argument('--no-commit-id', { action: 'store_true', help: 'Suppress commit ID' }),
          new Argument('-r', { action: 'store_true', help: 'Recurse into subtrees' }),
          new Argument('--root', {
            action: 'store_true',
            help: 'Show a root commit as all additions',
          }),
          new Argument('commit'),
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'diff-files',
        description: 'Compare the index with the working tree',
        arguments: [
          ...DIFF_OPTIONS,
          ...DIFF_RESULT_OPTIONS,
          new Argument('-q', { action: 'store_true', help: 'Stay silent about missing files' }),
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'diff-index',
        description: 'Compare a tree with the working tree or index',
        arguments: [
          ...DIFF_OPTIONS,
          ...DIFF_RESULT_OPTIONS,
          new Argument('--cached', { action: 'store_true', help: 'Compare with the index' }),
          new Argument('-m', {
            action: 'store_true',
            help: 'Count missing files as unchanged',
          }),
          new Argument('tree-ish', { nargs: '?' }),
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'check-ref-format',
        description: 'Check that a ref name is well formed',
        arguments: [
          new Argument('--normalize', {
            action: 'store_true',
            help: 'Print the name with redundant slashes removed',
          }),
          new Argument('--print', { action: 'store_true', help: 'Alias of --normalize' }),
          new Argument('--allow-onelevel', {
            action: 'store_true',
            help: 'Take a name with one component',
          }),
          new Argument('--no-allow-onelevel', {
            action: 'store_true',
            help: 'Need more than one component',
          }),
          new Argument('--refspec-pattern', {
            action: 'store_true',
            help: 'Take a name holding one *',
          }),
          new Argument('--branch', {
            action: 'store_true',
            help: 'Check a branch name and print it',
          }),
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'ls-remote',
        description: 'List the refs another repository publishes',
        arguments: [
          new Argument(['-h', '--heads'], { action: 'store_true', help: 'Only list branches' }),
          new Argument(['-b', '--branches'], { action: 'store_true', help: 'Only list branches' }),
          new Argument(['-t', '--tags'], { action: 'store_true', help: 'Only list tags' }),
          new Argument('--refs', {
            action: 'store_true',
            help: 'Leave out pseudorefs and peeled tags',
          }),
          new Argument('--symref', {
            action: 'store_true',
            help: 'Show what symbolic refs point at',
          }),
          new Argument(['-q', '--quiet'], {
            action: 'store_true',
            help: 'Do not print the remote URL',
          }),
          new Argument('--exit-code', {
            action: 'store_true',
            help: 'Exit 2 when nothing is listed',
          }),
          new Argument('--get-url', {
            action: 'store_true',
            help: "Print the remote's URL and stop",
          }),
          ...SORT_OPTIONS,
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'check-ignore',
        description: 'Show which paths the ignore rules cover',
        arguments: [
          new Argument(['-q', '--quiet'], {
            action: 'store_true',
            help: 'Answer by exit status alone',
          }),
          new Argument(['-v', '--verbose'], {
            action: 'store_true',
            help: 'Show the rule that decided each path',
          }),
          new Argument('--stdin', {
            action: 'store_true',
            help: 'Read the paths from standard input',
          }),
          new Argument('-z', { action: 'store_true', help: 'Separate input and output with NUL' }),
          new Argument(['-n', '--non-matching'], {
            action: 'store_true',
            help: 'Also show paths no rule matches',
          }),
          new Argument('--no-index', {
            action: 'store_true',
            help: 'Apply the rules to tracked paths too',
          }),
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'describe',
        description: 'Name a commit after the nearest tag',
        arguments: [
          new Argument('--all', { action: 'store_true', help: 'Use any ref' }),
          new Argument('--tags', { action: 'store_true', help: 'Use lightweight tags too' }),
          new Argument('--always', {
            action: 'store_true',
            help: 'Fall back to the abbreviated id',
          }),
          new Argument('--long', { action: 'store_true', help: 'Always print the long form' }),
          new Argument('--exact-match', {
            action: 'store_true',
            help: 'Only a tag on the commit itself',
          }),
          new Argument('--first-parent', {
            action: 'store_true',
            help: 'Follow first parents only',
          }),
          new Argument('--abbrev', {
            nargs: '?',
            attachedOnly: true,
            help: 'Digits of the commit id; 0 drops the suffix',
          }),
          new Argument('--candidates', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'n',
            help: 'How many tags to weigh',
          }),
          new Argument('--match', {
            action: 'append',
            metavar: 'pattern',
            help: 'Only names matching this glob',
          }),
          new Argument('--exclude', {
            action: 'append',
            metavar: 'pattern',
            help: 'Leave out names matching this glob',
          }),
          new Argument('--dirty', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'mark',
            help: 'Add a mark when the work tree differs',
          }),
          new Argument('--broken', {
            nargs: '?',
            attachedOnly: true,
            metavar: 'mark',
            help: 'Like --dirty',
          }),
          PATHSPEC,
        ],
      }),
      new CommandSpec({
        name: 'status',
        description: 'Show the working tree status',
        arguments: [...STATUS_OPTIONS, PATHSPEC],
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
          ...DIFF_RESULT_OPTIONS,
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
    'hash-object': new CLIHandler({ fn: verb(hashObject, hashObjectReadOnly), write: true }),
    grep: new CLIHandler({ fn: verb(grep) }),
    'ls-tree': new CLIHandler({ fn: verb(lsTree) }),
    'ls-files': new CLIHandler({ fn: verb(lsFiles) }),
    fetch: new CLIHandler({ fn: verb(fetch, fetchReadOnly), write: true }),
    clone: new CLIHandler({ fn: verb(clone, cloneReadOnly), write: true }),
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
    'diff-files': new CLIHandler({ fn: verb(diffFiles) }),
    'diff-index': new CLIHandler({ fn: verb(diffIndex) }),
    'ls-remote': new CLIHandler({ fn: verb(lsRemote) }),
    'check-ignore': new CLIHandler({ fn: verb(checkIgnore) }),
    'check-ref-format': new CLIHandler({ fn: verb(checkRefFormat) }),
    describe: new CLIHandler({ fn: verb(describe) }),
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
