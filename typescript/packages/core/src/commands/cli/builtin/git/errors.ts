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

import { compareCodePoints } from '../../../../utils/sort.ts'

// git exits 128 for every fatal, which is neither the argparse usage exit (2)
// nor the generic command failure (1) the CLI dispatcher applies to a thrown
// handler error. Leaves therefore return this code themselves rather than
// throwing into the dispatcher's catch-all.
const FATAL_EXIT = 128
// git's parse-options refuses a bad option with 129, not the 128 it uses for a
// fatal. Both appear below, which is git's own split rather than ours:
// `git log --zzz` is 128 and `git diff --zzz` is 129.
const OPTION_EXIT = 129

// git closes each of these with a line naming the config knob that turns it
// off. Kept verbatim so the advice reads the same whether an agent hit real git
// or this one.
const ADVICE_IGNORED =
  'hint: Disable this message with "git config set advice.addIgnoredFile false"'
const ADVICE_EMPTY_PATHSPEC =
  'hint: Disable this message with "git config set advice.addEmptyPathspec false"'
const ADVICE_REF_FORMAT = 'hint: See `man git check-ref-format`'
const ADVICE_REF_SYNTAX = 'hint: Disable this message with "git config set advice.refSyntax false"'

/**
 * Base for a git fatal: rendered as `fatal: <message>`, exit 128.
 *
 * Subclasses override `prefix`, `code` and `stream` when git words their case
 * differently, so every verb can keep one `instanceof GitError` arm and the
 * rendering stays in one place. A null prefix prints the message alone, which is
 * what git does when the refusal is a report rather than an error ("nothing to
 * commit"), and such a report goes to stdout because that is where the report it
 * replaces would have gone.
 *
 * `report` is the other half of a refusal git splits across both streams: the
 * sentence saying it refused goes to stderr, and the per-path diagnosis naming
 * what is in the way goes to stdout, which is where the same lines would have
 * gone had the command run.
 */
export class GitError extends Error {
  readonly prefix: string | null = 'fatal'
  readonly code: number = FATAL_EXIT
  readonly stream: 'stdout' | 'stderr' = 'stderr'
  readonly report: string = ''
}

/**
 * No `.git` at the start point or above it, up to the mount root.
 *
 * git quotes a path the user typed (`--git-dir`, `GIT_DIR`) and leaves unquoted
 * one it read out of a `.git` file, pinned against git 2.50.1.
 */
export class NotARepositoryError extends GitError {
  constructor(gitdir: string | null = null, quoted = true) {
    if (gitdir === null) {
      super('not a git repository (or any of the parent directories): .git')
    } else if (quoted) {
      super(`not a git repository: '${gitdir}'`)
    } else {
      super(`not a git repository: ${gitdir}`)
    }
  }
}

/** A `.git` file that is not a `gitdir:` pointer. */
export class InvalidGitFileError extends GitError {
  constructor(path: string) {
    super(`invalid gitfile format: ${path}`)
  }
}

/**
 * A revision that resolves to nothing.
 *
 * git answers every unresolvable revision with one wording, whether the ref is
 * unknown, the short sha matches nothing, or an ancestry step walked off the end
 * of history (pinned against git 2.47.3 for `show`, `log` and `rev-parse`
 * alike).
 */
export class AmbiguousArgumentError extends GitError {
  constructor(revision: string) {
    super(
      `ambiguous argument '${revision}': unknown revision or path not in the ` +
        `working tree.\nUse '--' to separate paths from revisions, like this:\n` +
        `'git <command> [<revision>...] -- [<file>...]'`,
    )
  }
}

/**
 * A date flag whose value could not be read.
 *
 * git accepts relative wording (`2 weeks ago`) that mirage does not, so an
 * unreadable value is refused rather than ignored: silently dropping the flag
 * would widen the window instead of narrowing it.
 */
export class BadDateError extends GitError {
  constructor(flag: string, value: string) {
    super(`invalid date format for ${flag}: ${value} (expected ISO-8601 or an epoch second)`)
  }
}

/**
 * The CLI ran with no workspace behind it, so no file is reachable.
 *
 * Only possible when a leaf is called directly in a unit test: inside a
 * workspace the dispatcher always offers the facts a leaf declares.
 */
export class NoWorkspaceError extends GitError {
  constructor() {
    super('this operation must be run in a work tree')
  }
}

/**
 * `-C` named a path git could not enter.
 *
 * Two reasons, both in git's own wording: nothing is there, or something is and
 * it is not a directory. The second matters as much as the first, because
 * discovery walks upwards from the start point: a file operand that is merely
 * tolerated finds the repository above it and quietly runs there instead.
 */
export class NoWorkingDirectoryError extends GitError {
  constructor(path: string, reason = 'No such file or directory') {
    super(`cannot change to '${path}': ${reason}`)
  }
}

/**
 * `checkout -b` given a start point that is not a commit.
 *
 * git blames the start point rather than the branch name, and says so in one
 * sentence naming both, which is more use than the generic "ambiguous argument"
 * the same lookup failure produces elsewhere.
 */
export class BadStartPointError extends GitError {
  constructor(start: string, name: string) {
    super(`'${start}' is not a commit and a branch '${name}' cannot be created from it`)
  }
}

/**
 * `reset` given a revision, which this build does not take.
 *
 * Real git resets the index to any commit named here. mirage resets it from
 * HEAD only, so the operand has nothing to do, and doing nothing quietly is the
 * one answer a caller cannot act on: a script reads the zero exit as "the index
 * was reset" when it was not. Saying which feature is missing beats reusing
 * "unknown revision" for a revision that is perfectly well known.
 */
export class RevisionResetError extends GitError {
  constructor(revision: string) {
    super(`cannot reset to '${revision}': this build resets the index from HEAD only`)
  }
}

/**
 * A dashed operand, which is a git feature this build does not have.
 *
 * mirage implements a subset of every verb, so an undeclared flag is rarely a
 * typo: it is a real git option (`-p`, `--graph`, `--follow`) arriving at a
 * build that lacks it. Left alone it lands on the revision operand and comes
 * back as "ambiguous argument", which blames the repository for missing a
 * commit rather than mirage for missing a feature, and an agent reading that
 * draws the wrong conclusion. git words the same mistake this way for `log`
 * and `show`.
 */
export class UnrecognizedArgumentError extends GitError {
  constructor(argument: string) {
    super(`unrecognized argument: ${argument}`)
  }
}

/**
 * A --pretty/--format value naming no format at all.
 *
 * git's own wording and exit code for a name it has never heard of.
 */
export class BadPrettyError extends GitError {
  constructor(value: string) {
    super(`invalid --pretty format: ${value}`)
  }
}

/**
 * A --pretty/--format preset git has but this build does not.
 *
 * `raw`, `email`, `mboxrd` and `reference` are real git formats; answering
 * "invalid" for them would gaslight an agent that spelled a valid one, so the
 * refusal says unsupported and names what exists instead.
 */
export class UnsupportedPrettyError extends GitError {
  constructor(value: string) {
    super(
      `unsupported --pretty format: ${value} (this build implements ` +
        `oneline, short, medium, full, fuller and format:/tformat: strings)`,
    )
  }
}

/** A path operand that resolves outside the working tree. */
export class OutsideRepositoryError extends GitError {
  constructor(operand: string, root: string) {
    super(`${operand}: '${operand}' is outside repository at '${root}'`)
  }
}

/** A path operand that matches nothing in the working tree. */
export class PathspecError extends GitError {
  constructor(pathspec: string) {
    super(`pathspec '${pathspec}' did not match any files`)
  }
}

/**
 * Explicitly named paths that an ignore rule covers.
 *
 * git refuses rather than staging them, because naming an ignored path is far
 * more often a mistake than an intention, and exits 1 rather than its usual 128.
 * Expanding a directory is not the same act: there the ignored files are
 * silently skipped, which is why only operands that name a file reach this.
 */
export class IgnoredPathsError extends GitError {
  override readonly prefix = null
  override readonly code = 1

  constructor(paths: readonly string[]) {
    const listed = [...paths].sort(compareCodePoints).join('\n')
    super(
      `The following paths are ignored by one of your .gitignore files:\n` +
        `${listed}\nhint: Use -f if you really want to add them.\n${ADVICE_IGNORED}`,
    )
  }
}

/**
 * `add` with no pathspec at all. Not an error by exit code: git says what it did
 * not do and exits 0, because nothing went wrong and nothing happened.
 */
export class NothingSpecifiedError extends GitError {
  override readonly prefix = null
  override readonly code = 0

  constructor() {
    super(
      `Nothing specified, nothing added.\nhint: Maybe you wanted to say ` +
        `'git add .'?\n${ADVICE_EMPTY_PATHSPEC}`,
    )
  }
}

/**
 * `commit` with an index that matches HEAD. Printed on stdout, where the status
 * report it stands in for would have gone, and exits 1.
 */
export class NothingToCommitError extends GitError {
  override readonly prefix = null
  override readonly code = 1
  override readonly stream = 'stdout'

  constructor(report: string) {
    super(report.replace(/\n+$/, ''))
  }
}

/**
 * `commit` with no `-m`.
 *
 * git would open an editor here. A mount has no editor to open and no terminal
 * to open it on, and inventing a message would put an unreviewed sentence into
 * history, so the flag is required rather than defaulted.
 */
export class MissingMessageError extends GitError {
  constructor() {
    super('no commit message supplied (mirage has no editor to open; pass -m)')
  }
}

/** `commit` while paths are still in conflict. */
export class UnmergedIndexError extends GitError {
  constructor() {
    super('Exiting because of an unresolved conflict.')
  }
}

/** `branch <name>` naming a branch that is already there. */
export class BranchExistsError extends GitError {
  constructor(name: string) {
    super(`a branch named '${name}' already exists`)
  }
}

/**
 * A branch name git's ref rules refuse.
 *
 * Refused before the name reaches a ref file, because a ref is written as a path
 * below `.git`: `../../config` would land on the repository's own configuration
 * rather than on a branch. git closes the refusal with the two hint lines kept
 * here, and words it without the full stop its tag twin carries. Pinned against
 * git 2.50.1.
 */
export class InvalidBranchNameError extends GitError {
  constructor(name: string) {
    super(`'${name}' is not a valid branch name\n${ADVICE_REF_FORMAT}\n${ADVICE_REF_SYNTAX}`)
  }
}

/** `branch -d` with nothing to delete. */
export class BranchNameRequiredError extends GitError {
  override readonly prefix = 'error'
  override readonly code = OPTION_EXIT

  constructor() {
    super('branch name required')
  }
}

/** `branch -d` naming the branch HEAD is on. */
export class CheckedOutBranchError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1

  constructor(name: string, worktree: string) {
    super(`cannot delete branch '${name}' used by worktree at '${worktree}'`)
  }
}

/**
 * `-d` naming a branch whose commits HEAD does not already hold.
 *
 * The branch name is the only thing pointing at those commits, so deleting it
 * leaves them unreachable and there is no reflog here to find them again. git
 * refuses for that reason and reserves `-D` for a caller who means it, which is
 * why `-d` alone would be the wrong shape to ship: it would be a delete with no
 * way to say no.
 *
 * Only the first of git's two hint lines is kept. The second names the config
 * knob that silences the advice, and there is no git config here to set.
 */
export class UnmergedBranchError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1

  constructor(name: string) {
    super(
      `the branch '${name}' is not fully merged\nhint: If you are sure you ` +
        `want to delete it, run 'git branch -D ${name}'`,
    )
  }
}

/** A branch name that resolves to nothing. */
export class NoBranchError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1

  constructor(name: string) {
    super(`branch '${name}' not found`)
  }
}

/**
 * An operand that is neither a ref nor a path git has heard of.
 *
 * One sentence, two exit codes, which is git's own split rather than ours:
 * `checkout` refuses with 1, and `add -u` treats the same sentence as a fatal
 * and exits 128. Measured one verb at a time on git 2.50.1.
 */
export class UnknownPathspecError extends GitError {
  override readonly prefix = 'error'
  override readonly code: number

  constructor(target: string, fatal = false) {
    super(`pathspec '${target}' did not match any file(s) known to git`)
    this.code = fatal ? FATAL_EXIT : 1
  }
}

/**
 * One named-files paragraph of a checkout refusal.
 *
 * The advice line is optional because one of git's three paragraphs has none:
 * the directory one ends at its list, which renders as the blank line before
 * the next paragraph.
 */
function conflictBlock(header: string, paths: readonly string[], advice = ''): string {
  const listed = [...paths]
    .sort(compareCodePoints)
    .map((path) => `\t${path}`)
    .join('\n')
  return `${header}\n${listed}\n${advice}`
}

/**
 * A checkout that would throw away work that is not committed.
 *
 * git refuses and names every file rather than overwriting, which is the one
 * safety check that makes checkout usable at all: without it a branch switch
 * silently destroys whatever was edited and not staged.
 *
 * Two kinds of work are at risk and git words them differently: a tracked file
 * carrying uncommitted changes, an untracked *directory* the target replaces
 * with a file of the same name, and an untracked file the target branch would
 * write over. All three are carried here rather than thrown separately because
 * when several apply git prints every paragraph and aborts once, in this
 * order, pinned against git 2.50.1.
 */
export class CheckoutConflictError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1

  constructor(
    local: readonly string[],
    untracked: readonly string[],
    directories: readonly string[] = [],
  ) {
    const blocks: string[] = []
    if (local.length > 0) {
      blocks.push(
        conflictBlock(
          'Your local changes to the following files would be overwritten by checkout:',
          local,
          'Please commit your changes or stash them before you switch branches.',
        ),
      )
    }
    if (directories.length > 0) {
      blocks.push(
        conflictBlock(
          'Updating the following directories would lose untracked files in them:',
          directories,
        ),
      )
    }
    if (untracked.length > 0) {
      blocks.push(
        conflictBlock(
          'The following untracked working tree files would be overwritten by checkout:',
          untracked,
          'Please move or remove them before you switch branches.',
        ),
      )
    }
    // git emits each paragraph as its own error, so the second one carries the
    // prefix inline: the renderer only writes the first.
    super(`${blocks.map((block) => `${block}\n`).join('error: ')}Aborting`)
  }
}

/**
 * A branch move while the index still records conflict stages.
 *
 * Every collision check a checkout makes reads stage 0, so a path held only as
 * stages 1-3 is invisible to all of them: the move would clear the stages and
 * delete the working-tree copy, throwing away a conflict resolution in progress
 * with no reflog to recover it from. git refuses first, before it reads either
 * tree.
 *
 * Both streams carry part of it, pinned against git 2.50.1: the per-path
 * diagnosis is stdout's, written by the index refresh that found the stages, and
 * the sentence saying the command stopped is stderr's. Exit 1, not the 128 a
 * fatal takes.
 */
export class ResolveIndexError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1
  override readonly report: string

  constructor(paths: readonly string[]) {
    super('you need to resolve your current index first')
    this.report = [...paths]
      .sort(compareCodePoints)
      .map((path) => `${path}: needs merge\n`)
      .join('')
  }
}

/**
 * `restore` naming a path the source cannot put back.
 *
 * A path with conflict stages has no stage-0 content, so restoring the working
 * tree from the index has nothing to write and restoring the index from a tree
 * that does not hold the path has nothing to stage. git names each such path and
 * does none of the work; a path the source *does* hold restores normally and the
 * stages go with it.
 *
 * One line per path, so several are refused in one answer rather than one per
 * run. Pinned against git 2.50.1.
 */
export class UnmergedPathError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1

  constructor(paths: readonly string[]) {
    // git emits each path as its own error, so every line after the first
    // carries the prefix inline: the renderer writes one.
    super(
      [...paths]
        .sort(compareCodePoints)
        .map((path) => `path '${path}' is unmerged`)
        .join('\nerror: '),
    )
  }
}

/**
 * The wording of git's own option parser, used by most verbs.
 *
 * Three verbs word this three ways and git means all of them: `log` and `show`
 * say "unrecognized argument" and exit 128, `diff` says "invalid option" and
 * exits 129, and everything built on parse-options (`status`, `add`, `branch`,
 * `reset`, `checkout`, `commit`) says this and exits 129. Measured on git 2.47,
 * one verb at a time.
 */
export class UnknownSwitchError extends GitError {
  override readonly prefix = 'error'
  override readonly code = OPTION_EXIT

  constructor(argument: string) {
    const noun = argument.startsWith('--') ? 'option' : 'switch'
    super(`unknown ${noun} \`${argument.replace(/^-+/, '')}'`)
  }
}

/**
 * `diff`'s wording for an option it does not know.
 *
 * Same mistake as UnrecognizedArgumentError and a different sentence, because
 * git itself words it differently here and exits 129 rather than 128. Pinned
 * against git 2.50.1.
 */
export class InvalidOptionError extends GitError {
  override readonly prefix = 'error'
  override readonly code = OPTION_EXIT

  constructor(argument: string) {
    super(`invalid option: ${argument}`)
  }
}

/** `rm` with no pathspec at all. */
export class NoPathspecRemoveError extends GitError {
  constructor() {
    super('No pathspec was given. Which files should I remove?')
  }
}

/** `rm` naming a directory without `-r`. */
export class NotRecursiveError extends GitError {
  constructor(operand: string) {
    super(`not removing '${operand}' recursively without -r`)
  }
}

// The three refusals `rm` groups its paths under, in the order git prints
// them: a path whose staged content matches neither the file nor HEAD, a path
// with a staged change, a path with an unstaged edit. Each header comes in a
// singular and a plural form.
const STAGED_BOTH: [string, string, string] = [
  'the following file has staged content different from both the\nfile and the HEAD:',
  'the following files have staged content different from both the\nfile and the HEAD:',
  '(use -f to force removal)',
]
const STAGED_INDEX: [string, string, string] = [
  'the following file has changes staged in the index:',
  'the following files have changes staged in the index:',
  '(use --cached to keep the file, or -f to force removal)',
]
const LOCAL_CHANGES: [string, string, string] = [
  'the following file has local modifications:',
  'the following files have local modifications:',
  '(use --cached to keep the file, or -f to force removal)',
]

/** One paragraph of an `rm` refusal. */
function removalBlock(wording: [string, string, string], paths: readonly string[]): string {
  const header = paths.length === 1 ? wording[0] : wording[1]
  const listed = [...paths]
    .sort(compareCodePoints)
    .map((path) => `    ${path}`)
    .join('\n')
  return `${header}\n${listed}\n${wording[2]}`
}

/**
 * `rm` naming a path whose removal would lose uncommitted work.
 *
 * git refuses rather than deleting, and names every path under the reason it
 * refused it. Three reasons, printed as three paragraphs in a fixed order when
 * more than one applies, pinned against git 2.50.1.
 */
export class RemovalRefusedError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1

  constructor(both: readonly string[], staged: readonly string[], local: readonly string[]) {
    const blocks: string[] = []
    if (both.length > 0) blocks.push(removalBlock(STAGED_BOTH, both))
    if (staged.length > 0) blocks.push(removalBlock(STAGED_INDEX, staged))
    if (local.length > 0) blocks.push(removalBlock(LOCAL_CHANGES, local))
    // git emits each paragraph as its own error, so the second one carries the
    // prefix inline: the renderer only writes the first.
    super(blocks.join('\nerror: '))
  }
}

/**
 * `rm` whose working-tree deletion the mount refused.
 *
 * git names the path and the strerror. The one reason a mount gives is a
 * directory standing where a tracked file was: `unlink` refuses that, and git
 * reports it rather than removing the tree.
 *
 * The `rm` lines ride along on stdout because git prints them for every
 * selected path before it deletes anything, so the ones printed before the
 * failure are printed whether the line goes through or not.
 */
export class RemovePathError extends GitError {
  override readonly report: string

  constructor(path: string, report = '', reason = 'Is a directory') {
    super(`git rm: '${path}': ${reason}`)
    this.report = report
  }
}

/**
 * A working-tree removal that would take a nested mount with it.
 *
 * A mount nested inside the repository is served by another resource entirely,
 * so removing the directory it stands in empties that backend rather than the
 * repository: the store behind it is gone, and no branch ever recorded a line
 * of it. mirage refuses instead, which is the rule `MountRootPolicy` already
 * enforces for `rm` and `mv` at the command tier; a git verb reaches the
 * dispatcher directly, so it has to ask for itself.
 *
 * The mount is named only when the session may be told about it. A hidden one
 * blocks the removal just the same, because avoiding a boundary and naming it
 * are two different questions, and naming a hidden mount is the one thing the
 * hide exists to prevent.
 */
export class MountInWayError extends GitError {
  constructor(path: string, mount: string | null = null) {
    const held =
      mount === null
        ? 'it holds a mount root'
        : mount === path
          ? 'it is a mount root'
          : `'${mount}' is a mount root`
    super(`cannot remove '${path}': ${held}`)
  }
}

/**
 * `mv` with fewer than two operands.
 *
 * git prints its usage and exits 129. Only the two synopsis lines are kept: the
 * option list below them describes flags this build does not all have.
 */
export class MoveUsageError extends GitError {
  override readonly prefix = null
  override readonly code = OPTION_EXIT

  constructor() {
    super(
      'usage: git mv [-v] [-f] [-n] [-k] <source> <destination>\n' +
        '   or: git mv [-v] [-f] [-n] [-k] <source>... <destination-directory>',
    )
  }
}

/** `mv` refusing one source, in git's `reason, source, destination` shape. */
export class MoveRefusedError extends GitError {
  constructor(reason: string, source: string, destination: string) {
    super(`${reason}, source=${source}, destination=${destination}`)
  }
}

/**
 * `mv` given both a directory and something inside it.
 *
 * git refuses the whole line rather than one source, and `-k` does not skip it:
 * the two moves would race for the same bytes, and the one that lost would be
 * reported as a rename that failed after the other had already changed the
 * working tree. The child is named first however the operands were ordered.
 * Pinned against git 2.50.1.
 */
export class MoveOverlapError extends GitError {
  constructor(child: string, parent: string) {
    super(`cannot move both '${child}' and its parent directory '${parent}'`)
  }
}

/** `mv` with several sources and a destination that is not a directory. */
export class NotADirectoryDestinationError extends GitError {
  constructor(destination: string) {
    super(`destination '${destination}' is not a directory`)
  }
}

/**
 * `mv` whose rename the mount refused.
 *
 * git names the source and the strerror. The one reason a mount gives is a
 * destination whose directory does not exist: git does not create it, and
 * neither does this.
 */
export class RenameFailedError extends GitError {
  constructor(source: string, reason = 'No such file or directory') {
    super(`renaming '${source}' failed: ${reason}`)
  }
}

/** `restore` with no pathspec at all. */
export class NoRestorePathsError extends GitError {
  constructor() {
    super('you must specify path(s) to restore')
  }
}

/**
 * `restore --source` naming an object that is no tree.
 *
 * A revision that resolves is reported by the id it resolved to rather than by
 * the spelling, which is git's own wording: the complaint is about the object
 * found, not about the name.
 */
export class UnreadableTreeError extends GitError {
  constructor(oid: string) {
    super(`unable to read tree (${oid})`)
  }
}

/** `restore --source` naming a tree this repository cannot resolve. */
export class UnresolvableSourceError extends GitError {
  constructor(source: string) {
    super(`could not resolve ${source}`)
  }
}

/**
 * `switch` naming something that is neither a branch nor a commit.
 *
 * `switch` words the miss differently from `checkout`, which calls the same
 * operand a pathspec: switch never takes a path, so nothing it was given could
 * have been one.
 */
export class InvalidReferenceError extends GitError {
  constructor(name: string) {
    super(`invalid reference: ${name}`)
  }
}

/**
 * `switch` given a commit, tag or remote branch without `--detach`.
 *
 * git refuses rather than detaching, because a detached HEAD is the state an
 * agent loses commits in, and `switch` exists to be the verb that never gets
 * there by accident.
 */
export class BranchExpectedError extends GitError {
  constructor(kind: string, name: string) {
    super(
      `a branch is expected, got ${kind} '${name}'\n` +
        `hint: If you want to detach HEAD at the commit, try again with the --detach option.`,
    )
  }
}

/** `switch` with nothing to switch to. */
export class MissingBranchArgumentError extends GitError {
  constructor() {
    super('missing branch or commit argument')
  }
}

/** `switch` given more than one operand. */
export class OneReferenceError extends GitError {
  constructor() {
    super('only one reference expected')
  }
}

/** `switch -c` together with `--detach`. */
export class DetachWithCreateError extends GitError {
  constructor() {
    super(`'--detach' cannot be used with '-b/-B/--orphan'`)
  }
}

/** `tag <name>` naming a tag that is already there. */
export class TagExistsError extends GitError {
  constructor(name: string) {
    super(`tag '${name}' already exists`)
  }
}

/**
 * `tag -d` naming a tag that is not there.
 *
 * Reported and moved past: git deletes the other names on the line and exits 1
 * at the end, so this is rendered per name rather than thrown.
 */
export class TagNotFoundError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1

  constructor(name: string) {
    super(`tag '${name}' not found.`)
  }
}

/**
 * `-n` on a `tag` line that deletes rather than lists.
 *
 * `-n` asks for message lines beside each name, which only a listing prints,
 * and git makes it *imply* a listing rather than refuse it: `git tag -n1
 * nosuch` is a listing whose pattern matches nothing and exits 0. The
 * implication is what cannot happen once `-d` has already said what mode the
 * line is in, so git dies there instead, with the tags untouched. Refusing it
 * matters more here than the wording does: read as a listing flag and dropped,
 * the line went on to delete the refs its operands named. Pinned against git
 * 2.50.1.
 */
export class ListModeOnlyError extends GitError {
  constructor() {
    super("the '-n' option is only allowed in list mode")
  }
}

/**
 * `tag -n<num>` with a count below the one git reserves.
 *
 * `-n` carries an optional count, and git's parser starts that count at -1 to
 * mean "not given at all". `-n-1` is therefore not a listing flag at all:
 * `git tag -d -n-1 v` deletes and `git tag -n-1 -a v -m m` creates, where a
 * real `-n` refuses both. Anything below -1 is a count, and a count has to be
 * positive, which git discovers while parsing the format it lists with rather
 * than while parsing the option: the list-mode refusal outranks this one, and
 * it fires in a repository holding no tags at all. Pinned against git 2.50.1.
 */
export class TagLinesError extends GitError {
  constructor(lines: number) {
    super(`positive value expected contents:lines=${String(lines)}`)
  }
}

/**
 * `tag -d` naming one tag twice.
 *
 * git stages every deletion on the line as one ref transaction, and a
 * transaction holding two updates for the same ref is refused before any of
 * them applies, so the whole line is a no-op: the repeated tag survives, and so
 * does every other tag the line named. The ref it blames is the first in ref
 * order rather than the first typed, since the transaction sorts before it
 * looks for the repeat. Reported the way git reports it, as an `error` exiting
 * 1 rather than a fatal.
 */
export class RefUpdateConflictError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1

  constructor(ref: string) {
    super(`could not delete references: multiple updates for ref '${ref}' not allowed`)
  }
}

/**
 * A ref that cannot be written because another one holds its path.
 *
 * git reports this as a failure to take the lock rather than as a name that is
 * already taken, and names the ref standing in the way. `-f` does not help: the
 * obstacle is the path, not the value. Pinned against git 2.50.1.
 */
export class RefLockError extends GitError {
  constructor(ref: string, held: string) {
    super(`cannot lock ref '${ref}': '${held}' exists; cannot create '${ref}'`)
  }
}

/** A tag name git's ref rules refuse. */
export class InvalidTagNameError extends GitError {
  constructor(name: string) {
    super(`'${name}' is not a valid tag name.`)
  }
}

/** `tag` given an object it cannot resolve. */
export class UnresolvedRefError extends GitError {
  constructor(revision: string) {
    super(`Failed to resolve '${revision}' as a valid ref.`)
  }
}

/**
 * `tag` given a creation option with no tag name to create.
 *
 * `-a`, `-m` and `-f` are creation options, so git refuses them on a line that
 * lists or deletes instead: no operand at all lists, and `-l` or `-d` says so
 * outright. It prints its usage and exits 129, where an operand-free `git tag`
 * or `git tag -d` lists and exits 0. The synopsis is trimmed to the options this
 * build has, the way `mv`'s is: git's own lines advertise `-s`, `-u`, `-F`, `-e`
 * and `-v`, which would be a promise nothing here keeps. Pinned against git
 * 2.50.1.
 */
export class TagUsageError extends GitError {
  override readonly prefix = null
  override readonly code = OPTION_EXIT

  constructor() {
    super(
      'usage: git tag [-a] [-f] [-m <msg>] <tagname> [<commit> | <object>]\n' +
        '   or: git tag -d <tagname>...\n' +
        '   or: git tag [-n[<num>]] -l [<pattern>...]',
    )
  }
}

/** `tag` given more operands than a name and an object. */
export class TooManyArgumentsError extends GitError {
  constructor() {
    super('too many arguments')
  }
}

/**
 * `tag -a` with no `-m`.
 *
 * git would open an editor here, exactly as `commit` would, and the same answer
 * applies: a mount has no editor, and inventing a message would put an
 * unreviewed one into the repository.
 */
export class MissingTagMessageError extends GitError {
  constructor() {
    super('no tag message supplied (mirage has no editor to open; pass -m)')
  }
}

/** Two options git refuses to take together. */
export class IncompatibleOptionsError extends GitError {
  override readonly prefix = 'error'
  override readonly code = OPTION_EXIT

  constructor(first: string, second: string) {
    super(`options '${first}' and '${second}' cannot be used together`)
  }
}
