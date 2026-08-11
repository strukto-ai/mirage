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

/**
 * Base for a git fatal: rendered as `fatal: <message>`, exit 128.
 *
 * Subclasses override `prefix`, `code` and `stream` when git words their case
 * differently, so every verb can keep one `instanceof GitError` arm and the
 * rendering stays in one place. A null prefix prints the message alone, which is
 * what git does when the refusal is a report rather than an error ("nothing to
 * commit"), and such a report goes to stdout because that is where the report it
 * replaces would have gone.
 */
export class GitError extends Error {
  readonly prefix: string | null = 'fatal'
  readonly code: number = FATAL_EXIT
  readonly stream: 'stdout' | 'stderr' = 'stderr'
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
    const listed = [...paths].sort().join('\n')
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
 */
function conflictBlock(header: string, paths: readonly string[], advice: string): string {
  const listed = [...paths]
    .sort()
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
 * carrying uncommitted changes, and an untracked file the target branch would
 * write over. Both are carried here rather than thrown separately because when
 * both apply git prints both paragraphs and aborts once, pinned against git
 * 2.50.
 */
export class CheckoutConflictError extends GitError {
  override readonly prefix = 'error'
  override readonly code = 1

  constructor(local: readonly string[], untracked: readonly string[]) {
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
