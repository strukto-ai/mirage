# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

# git exits 128 for every fatal, which is neither the argparse usage
# exit (2) nor the generic command failure (1) the CLI dispatcher
# applies to a thrown handler error. Leaves therefore return this
# code themselves rather than raising into the dispatcher's catch-all.
FATAL_EXIT = 128
# git's parse-options refuses a bad option with 129, not the 128 it uses
# for a fatal. Both appear below, which is git's own split rather than
# ours: `git log --zzz` is 128 and `git diff --zzz` is 129.
OPTION_EXIT = 129
# git closes each of these with a line naming the config knob that
# turns it off. Kept verbatim so the advice reads the same whether an
# agent hit real git or this one.
ADVICE_IGNORED = (
    'hint: Disable this message with "git config set '
    'advice.addIgnoredFile false"'
)
ADVICE_EMPTY_PATHSPEC = (
    'hint: Disable this message with "git config '
    'set advice.addEmptyPathspec false"'
)
ADVICE_REF_FORMAT = "hint: See `man git check-ref-format`"
ADVICE_REF_SYNTAX = (
    'hint: Disable this message with "git config set advice.refSyntax false"'
)


class GitError(Exception):
    """Base for a git fatal: rendered as ``fatal: <message>``, exit 128.

    Subclasses override ``prefix``, ``code`` and ``stream`` when git
    words their case differently, so every verb can keep one
    ``except GitError`` arm and the rendering stays in one place. A None
    prefix prints the message alone, which is what git does when the
    refusal is a report rather than an error ("nothing to commit"), and
    such a report goes to stdout because that is where the report it
    replaces would have gone.

    ``report`` is the other half of a refusal git splits across both
    streams: the sentence saying it refused goes to stderr, and the
    per-path diagnosis naming what is in the way goes to stdout, which
    is where the same lines would have gone had the command run.
    """

    prefix: str | None = "fatal"
    code = FATAL_EXIT
    stream = "stderr"
    report = ""


class NotARepositoryError(GitError):
    """No ``.git`` at the start point or above it, up to the mount root.

    Args:
        gitdir (str | None): the git directory that failed to resolve,
            None when discovery walked up from the working directory.
        quoted (bool): whether to quote the path. git quotes one the
            user typed (``--git-dir``, ``GIT_DIR``) and leaves unquoted
            one it read out of a ``.git`` file, pinned against git
            2.50.1.
    """

    def __init__(self, gitdir: str | None = None, quoted: bool = True) -> None:
        if gitdir is None:
            super().__init__(
                "not a git repository (or any of the parent directories): .git"
            )
        elif quoted:
            super().__init__(f"not a git repository: '{gitdir}'")
        else:
            super().__init__(f"not a git repository: {gitdir}")


class InvalidGitFileError(GitError):
    """A ``.git`` file that is not a ``gitdir:`` pointer.

    Args:
        path (str): absolute virtual path of the offending file.
    """

    def __init__(self, path: str) -> None:
        super().__init__(f"invalid gitfile format: {path}")


class AmbiguousArgumentError(GitError):
    """A revision that resolves to nothing.

    git answers every unresolvable revision with one wording, whether
    the ref is unknown, the short sha matches nothing, or an ancestry
    step walked off the end of history (pinned against git 2.47.3 for
    ``show``, ``log`` and ``rev-parse`` alike).

    Args:
        revision (str): the revision as the user spelled it.
    """

    def __init__(self, revision: str) -> None:
        super().__init__(
            f"ambiguous argument '{revision}': unknown revision or path "
            f"not in the working tree.\n"
            f"Use '--' to separate paths from revisions, like this:\n"
            f"'git <command> [<revision>...] -- [<file>...]'"
        )


class BadRevisionError(GitError):
    """A negated revision (``^<rev>``) that resolves to nothing.

    git words this one differently from a plain unknown revision, and
    refuses a negated range (``^A..B``) the same way (pinned against
    git 2.50).

    Args:
        revision (str): the revision as the user spelled it, caret
            included.
    """

    def __init__(self, revision: str) -> None:
        super().__init__(f"bad revision '{revision}'")


class NoMergeBaseError(GitError):
    """``diff A...B`` between two histories that share no commit.

    Args:
        revision (str): the range as the user spelled it.
    """

    def __init__(self, revision: str) -> None:
        super().__init__(f"{revision}: no merge base")


class BadConfigValueError(GitError):
    """A boolean config variable whose value git cannot read as one.

    Args:
        value (str): the value as the config file spells it.
        key (str): the variable, section and name lowercased.
    """

    def __init__(self, value: str, key: str) -> None:
        super().__init__(f"bad boolean config value '{value}' for '{key}'")


class BadDateError(GitError):
    """A date flag whose value could not be read.

    git accepts relative wording (``2 weeks ago``) that mirage does not,
    so an unreadable value is refused rather than ignored: silently
    dropping the flag would widen the window instead of narrowing it.

    Args:
        flag (str): the flag as spelled on the command line.
        value (str): the value that could not be read.
    """

    def __init__(self, flag: str, value: str) -> None:
        super().__init__(
            f"invalid date format for {flag}: {value} "
            f"(expected ISO-8601 or an epoch second)"
        )


class NoWorkspaceError(GitError):
    """The CLI ran with no workspace behind it, so no file is reachable.

    Only possible when a leaf is called directly in a unit test: inside
    a workspace the dispatcher always offers the facts a leaf declares.
    """

    def __init__(self) -> None:
        super().__init__("this operation must be run in a work tree")


class NotAWorkTreeError(GitError):
    """A verb that reads or writes files, run with no work tree to enter.

    git's ``setup_work_tree`` refuses a bare repository and a work tree
    that is not a directory in the same words (pinned against git 2.54),
    so a mistyped ``--work-tree`` is never taken for an empty tree.
    """

    def __init__(self) -> None:
        super().__init__("this operation must be run in a work tree")


class SingleRevisionError(GitError):
    """``rev-parse --verify`` without exactly one revision naming an object.

    ``--short`` implies ``--verify``, so it is refused the same way.
    """

    def __init__(self) -> None:
        super().__init__("Needed a single revision")


class BareResetError(GitError):
    """``git reset`` in a bare repository, refused in its own words."""

    def __init__(self) -> None:
        super().__init__("mixed reset is not allowed in a bare repository")


class WorkTreeChdirError(GitError):
    """A relative ``core.worktree`` that git cannot enter.

    git resolves one by entering it before any verb runs, so every verb
    fails, the read-only ones included (pinned against git 2.54).

    Args:
        path (str): the value as the config spells it.
        reason (str): the strerror git names, absence by default.
    """

    def __init__(
        self, path: str, reason: str = "No such file or directory"
    ) -> None:
        super().__init__(f"cannot chdir to '{path}': {reason}")


class NoWorkingDirectoryError(GitError):
    """``-C`` named a path git could not enter.

    Two reasons, both in git's own wording: nothing is there, or
    something is and it is not a directory. The second matters as much as
    the first, because discovery walks upwards from the start point: a
    file operand that is merely tolerated finds the repository above it
    and quietly runs there instead.

    Args:
        path (str): the path as the user spelled it.
        reason (str): the strerror git names, absence by default.
    """

    def __init__(
        self, path: str, reason: str = "No such file or directory"
    ) -> None:
        super().__init__(f"cannot change to '{path}': {reason}")


class BadStartPointError(GitError):
    """``checkout -b`` given a start point that is not a commit.

    git blames the start point rather than the branch name, and says so
    in one sentence naming both, which is more use than the generic
    "ambiguous argument" the same lookup failure produces elsewhere.

    Args:
        start (str): the start point as the user spelled it.
        name (str): the branch that would have been created.
    """

    def __init__(self, start: str, name: str) -> None:
        super().__init__(
            f"'{start}' is not a commit and a branch '{name}' "
            f"cannot be created from it"
        )


class RevisionResetError(GitError):
    """``reset`` given a revision, which this build does not take.

    Real git resets the index to any commit named here. mirage resets it
    from HEAD only, so the operand has nothing to do, and doing nothing
    quietly is the one answer a caller cannot act on: a script reads the
    zero exit as "the index was reset" when it was not. Saying which
    feature is missing beats reusing "unknown revision" for a revision
    that is perfectly well known.

    Args:
        revision (str): the operand as the user spelled it.
    """

    def __init__(self, revision: str) -> None:
        super().__init__(
            f"cannot reset to '{revision}': this build resets "
            f"the index from HEAD only"
        )


class AllWithPathsError(GitError):
    """``commit -a`` given paths as well.

    git refuses the pair before reading anything, naming the first path
    (pinned against git 2.50).

    Args:
        path (str): the first path operand as the user spelled it.
    """

    def __init__(self, path: str) -> None:
        super().__init__(f"paths '{path} ...' with -a does not make sense")


class PartialCommitError(GitError):
    """``commit`` given paths, which this build does not take.

    Real git commits only those paths, from the working tree, and leaves
    the rest of the index staged. mirage commits the whole index, and
    doing that while the caller named a subset would record changes
    they never asked to commit, so the operand is refused instead.

    Args:
        path (str): the first path operand as the user spelled it.
    """

    def __init__(self, path: str) -> None:
        super().__init__(
            f"cannot commit '{path}' alone: this build commits "
            f"the whole index; stage it and commit without paths"
        )


class BadPrettyError(GitError):
    """A --pretty/--format value naming no format at all.

    git's own wording and exit code for a name it has never heard of.

    Args:
        value (str): the format value as spelled on the command line.
    """

    def __init__(self, value: str) -> None:
        super().__init__(f"invalid --pretty format: {value}")


class UnsupportedPrettyError(GitError):
    """A --pretty/--format preset git has but this build does not.

    ``email``, ``mboxrd`` and ``reference`` are real git
    formats; answering "invalid" for them would gaslight an agent that
    spelled a valid one, so the refusal says unsupported and names what
    exists instead.

    Args:
        value (str): the format value as spelled on the command line.
    """

    def __init__(self, value: str) -> None:
        super().__init__(
            f"unsupported --pretty format: {value} (this build implements "
            f"oneline, short, medium, full, fuller, raw and format:/tformat: "
            f"strings)"
        )


class UnrecognizedArgumentError(GitError):
    """A dashed operand, which is a git feature this build does not have.

    mirage implements a subset of every verb, so an undeclared flag is
    rarely a typo: it is a real git option (``-p``, ``--graph``,
    ``--follow``) arriving at a build that lacks it. Left alone it lands
    on the revision operand and comes back as "ambiguous argument",
    which blames the repository for missing a commit rather than mirage
    for missing a feature, and an agent reading that draws the wrong
    conclusion. git words the same mistake this way for ``log`` and
    ``show``.

    Args:
        argument (str): the operand as the user spelled it.
    """

    def __init__(self, argument: str) -> None:
        super().__init__(f"unrecognized argument: {argument}")


class OutsideRepositoryError(GitError):
    """A path operand that resolves outside the working tree.

    Args:
        operand (str): the operand as the user spelled it.
        root (str): absolute virtual path of the working tree.
    """

    def __init__(self, operand: str, root: str) -> None:
        super().__init__(
            f"{operand}: '{operand}' is outside repository at '{root}'"
        )


class PathspecError(GitError):
    """A path operand that matches nothing in the working tree.

    Args:
        pathspec (str): the operand as the user spelled it.
    """

    def __init__(self, pathspec: str) -> None:
        super().__init__(f"pathspec '{pathspec}' did not match any files")


class EmptyPathspecError(GitError):
    """An empty pathspec operand, which git refuses rather than reading
    as everything (pinned against git 2.54)."""

    def __init__(self) -> None:
        super().__init__(
            "empty string is not a valid pathspec. please use . instead if "
            "you meant to match all paths"
        )


class UnsupportedPathspecError(GitError):
    """Pathspec magic git has but this build does not read.

    ``:(top)``, ``:!``, ``:(icase)`` and their kin are real git; matching
    the operand as a plain path would select nothing, or the wrong
    paths, and look like an answer, so the refusal says unsupported and
    names what exists instead.

    Args:
        pathspec (str): the operand as the user spelled it.
    """

    def __init__(self, pathspec: str) -> None:
        super().__init__(
            f"unsupported pathspec magic: {pathspec} (this build implements "
            f"paths, leading directories and wildcard patterns)"
        )


class IgnoredPathsError(GitError):
    """Explicitly named paths that an ignore rule covers.

    git refuses rather than staging them, because naming an ignored path
    is far more often a mistake than an intention, and exits 1 rather
    than its usual 128. Expanding a directory is not the same act: there
    the ignored files are silently skipped, which is why only operands
    that name a file reach this.

    Args:
        paths (list[str]): the refused paths, repository-relative.
    """

    prefix = None
    code = 1

    def __init__(self, paths: list[str]) -> None:
        listed = "\n".join(sorted(paths))
        super().__init__(
            f"The following paths are ignored by one of your "
            f".gitignore files:\n{listed}\nhint: Use -f if you "
            f"really want to add them.\n{ADVICE_IGNORED}"
        )


class NothingSpecifiedError(GitError):
    """``add`` with no pathspec at all.

    Not an error by exit code: git says what it did not do and exits 0,
    because nothing went wrong and nothing happened.
    """

    prefix = None
    code = 0

    def __init__(self) -> None:
        super().__init__(
            "Nothing specified, nothing added.\nhint: Maybe "
            "you wanted to say 'git add .'?\n"
            f"{ADVICE_EMPTY_PATHSPEC}"
        )


class NothingToCommitError(GitError):
    """``commit`` with an index that matches HEAD.

    Printed on stdout, where the status report it stands in for would
    have gone, and exits 1.

    Args:
        report (str): the status report to print in place of a commit.
    """

    prefix = None
    code = 1
    stream = "stdout"

    def __init__(self, report: str) -> None:
        super().__init__(report.rstrip("\n"))


class MissingMessageError(GitError):
    """``commit`` with no ``-m``.

    git would open an editor here. A mount has no editor to open and no
    terminal to open it on, and inventing a message would put an
    unreviewed sentence into history, so the flag is required rather
    than defaulted.
    """

    def __init__(self) -> None:
        super().__init__(
            "no commit message supplied (mirage has no editor "
            "to open; pass -m)"
        )


class UnmergedIndexError(GitError):
    """``commit`` while paths are still in conflict.

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__("Exiting because of an unresolved conflict.")


class BranchExistsError(GitError):
    """``branch <name>`` naming a branch that is already there.

    Args:
        name (str): the branch name.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"a branch named '{name}' already exists")


class InvalidBranchNameError(GitError):
    """A branch name git's ref rules refuse.

    Refused before the name reaches a ref file, because a ref is
    written as a path below ``.git``: ``../../config`` would land on
    the repository's own configuration rather than on a branch. git
    closes the refusal with the two hint lines kept here, and words it
    without the full stop its tag twin carries. Pinned against git
    2.50.1.

    Args:
        name (str): the name as the user spelled it.
    """

    def __init__(self, name: str) -> None:
        super().__init__(
            f"'{name}' is not a valid branch name\n"
            f"{ADVICE_REF_FORMAT}\n{ADVICE_REF_SYNTAX}"
        )


class BranchNameRequiredError(GitError):
    """``branch -d`` with nothing to delete: git dies, 128 (pinned against
    git 2.50.1).

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__("branch name required")


class CheckedOutBranchError(GitError):
    """``branch -d`` naming the branch HEAD is on.

    Args:
        name (str): the branch name.
        worktree (str): absolute virtual path of the working tree.
    """

    prefix = "error"
    code = 1

    def __init__(self, name: str, worktree: str) -> None:
        super().__init__(
            f"cannot delete branch '{name}' used by worktree at '{worktree}'"
        )


class UnmergedBranchError(GitError):
    """``-d`` naming a branch whose commits HEAD does not already hold.

    The branch name is the only thing pointing at those commits, so
    deleting it leaves them unreachable and there is no reflog here to
    find them again. git refuses for that reason and reserves ``-D`` for
    a caller who means it, which is why ``-d`` alone would be the wrong
    shape to ship: it would be a delete with no way to say no.

    Only the first of git's two hint lines is kept. The second names the
    config knob that silences the advice, and there is no git config
    here to set.

    Args:
        name (str): the branch name.
    """

    prefix = "error"
    code = 1

    def __init__(self, name: str) -> None:
        super().__init__(
            f"the branch '{name}' is not fully merged\n"
            f"hint: If you are sure you want to delete it, run "
            f"'git branch -D {name}'"
        )


class NoBranchError(GitError):
    """A branch name that resolves to nothing.

    Args:
        name (str): the branch name as the user spelled it.
    """

    prefix = "error"
    code = 1

    def __init__(self, name: str) -> None:
        super().__init__(f"branch '{name}' not found")


class UnknownPathspecError(GitError):
    """An operand that is neither a ref nor a path git has heard of.

    One sentence, two exit codes, which is git's own split rather than
    ours: ``checkout`` refuses with 1, and ``add -u`` treats the same
    sentence as a fatal and exits 128. Measured one verb at a time on
    git 2.50.1.

    Args:
        target (str): the operand as the user spelled it.
        fatal (bool): whether to exit as a fatal rather than with 1.
    """

    prefix = "error"

    def __init__(self, target: str, fatal: bool = False) -> None:
        self.code = FATAL_EXIT if fatal else 1
        super().__init__(
            f"pathspec '{target}' did not match any file(s) known to git"
        )


def _conflict_block(header: str, paths: list[str], advice: str = "") -> str:
    """One named-files paragraph of a checkout refusal.

    The advice line is optional because one of git's three paragraphs
    has none: the directory one ends at its list, which renders as the
    blank line before the next paragraph.

    Args:
        header (str): the line that introduces the list.
        paths (list[str]): the files to name, one per tab-indented line.
        advice (str): the line telling the caller what to do about them,
            empty for a paragraph git words without one.
    """
    listed = "\n".join(f"\t{path}" for path in sorted(paths))
    return f"{header}\n{listed}\n{advice}"


class CheckoutConflictError(GitError):
    """A checkout that would throw away work that is not committed.

    git refuses and names every file rather than overwriting, which is
    the one safety check that makes checkout usable at all: without it a
    branch switch silently destroys whatever was edited and not staged.

    Three kinds of work are at risk and git words them differently: a
    tracked file carrying uncommitted changes, an untracked *directory*
    the target replaces with a file of the same name, and an untracked
    file the target branch would write over. All three are carried here
    rather than raised separately because when several apply git prints
    every paragraph and aborts once, in this order, pinned against git
    2.50.1.

    Args:
        local (list[str]): tracked files with uncommitted changes.
        directories (list[str]): directories holding untracked files
            that the target records a file at.
        untracked (list[str]): untracked files the target branch holds.
    """

    prefix = "error"
    code = 1

    def __init__(
        self,
        local: list[str],
        untracked: list[str],
        directories: list[str] | None = None,
    ) -> None:
        blocks: list[str] = []
        if local:
            blocks.append(
                _conflict_block(
                    "Your local changes to the following files would be "
                    "overwritten by checkout:",
                    local,
                    "Please commit your changes or stash them before you "
                    "switch branches.",
                )
            )
        if directories:
            blocks.append(
                _conflict_block(
                    "Updating the following directories would lose "
                    "untracked files in them:",
                    directories,
                )
            )
        if untracked:
            blocks.append(
                _conflict_block(
                    "The following untracked working tree files would be "
                    "overwritten by checkout:",
                    untracked,
                    "Please move or remove them before you switch branches.",
                )
            )
        # git emits each paragraph as its own error, so the second one
        # carries the prefix inline: the renderer only writes the first.
        joined = "error: ".join(f"{block}\n" for block in blocks)
        super().__init__(f"{joined}Aborting")


class ResolveIndexError(GitError):
    """A branch move while the index still records conflict stages.

    Every collision check a checkout makes reads stage 0, so a path
    held only as stages 1-3 is invisible to all of them: the move would
    clear the stages and delete the working-tree copy, throwing away a
    conflict resolution in progress with no reflog to recover it from.
    git refuses first, before it reads either tree.

    Both streams carry part of it, pinned against git 2.50.1: the
    per-path diagnosis is stdout's, written by the index refresh that
    found the stages, and the sentence saying the command stopped is
    stderr's. Exit 1, not the 128 a fatal takes.

    Args:
        paths (list[str]): every path the index still holds stages for.
    """

    prefix = "error"
    code = 1

    def __init__(self, paths: list[str]) -> None:
        self.report = "".join(
            f"{path}: needs merge\n" for path in sorted(paths)
        )
        super().__init__("you need to resolve your current index first")


class UnmergedPathError(GitError):
    """``restore`` naming a path the source cannot put back.

    A path with conflict stages has no stage-0 content, so restoring
    the working tree from the index has nothing to write and restoring
    the index from a tree that does not hold the path has nothing to
    stage. git names each such path and does none of the work; a path
    the source *does* hold restores normally and the stages go with it.

    One line per path, so several are refused in one answer rather than
    one per run. Pinned against git 2.50.1.

    Args:
        paths (list[str]): the selected paths still in conflict.
    """

    prefix = "error"
    code = 1

    def __init__(self, paths: list[str]) -> None:
        # git emits each path as its own error, so every line after the
        # first carries the prefix inline: the renderer writes one.
        super().__init__(
            "\nerror: ".join(
                f"path '{path}' is unmerged" for path in sorted(paths)
            )
        )


class UsageError(GitError):
    """A refusal parse-options words in full, exit 129.

    Already worded, the verb's usage block included where git prints
    one: after an unknown option on stderr, or alone, on stdout when
    ``-h`` asked for it and on stderr where it stands for the refusal
    itself (``rev-list --nosuch``, ``symbolic-ref`` with no operand).

    Args:
        shown (str): what goes to stdout, empty unless ``-h`` asked.
        refused (str): what goes to stderr.
    """

    prefix = None
    code = OPTION_EXIT

    def __init__(self, shown: str, refused: str) -> None:
        super().__init__((refused or shown).removesuffix("\n"))
        self.stream = "stderr" if refused else "stdout"


class UnknownSubcommandError(UsageError):
    """``remote`` given a word where its subcommand would go.

    This build lists remotes and has none of git's ``remote``
    subcommands, so whatever the word is, it is refused the way git
    refuses one it does not know, with the usage block after it.
    Pinned against git 2.50.1.

    Args:
        word (str): the word as the user spelled it.
        usage (str): the verb's usage block.
    """

    def __init__(self, word: str, usage: str) -> None:
        super().__init__("", f"error: unknown subcommand: `{word}'\n{usage}")


class InvalidOptionError(UsageError):
    """``diff``'s wording for an option it does not know, on a line
    naming neither a revision nor ``--cached``.

    Same mistake as UnrecognizedArgumentError and a different sentence,
    because git itself words it differently here, follows it with the
    usage block and exits 129 rather than 128. A line that names one
    gets the usage block alone. Pinned against git 2.50.1.

    Args:
        argument (str): the operand as the user spelled it.
        usage (str): the verb's usage block.
    """

    def __init__(self, argument: str, usage: str) -> None:
        super().__init__("", f"error: invalid option: {argument}\n{usage}")


class ShortlogOptionError(UsageError):
    """``shortlog``'s wording for an option it does not know.

    parse-options' sentence with the word quoted whole, dashes and all,
    because shortlog hands what it does not know to the revision parser
    and words what that parser leaves; the usage block follows. Pinned
    against git 2.50.1.

    Args:
        argument (str): the operand as the user spelled it.
        usage (str): the verb's usage block.
    """

    def __init__(self, argument: str, usage: str) -> None:
        super().__init__("", f"error: unknown option `{argument}'\n{usage}")


class NoPathspecRemoveError(GitError):
    """``rm`` with no pathspec at all.

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__("No pathspec was given. Which files should I remove?")


class NotRecursiveError(GitError):
    """``rm`` naming a directory without ``-r``.

    Args:
        operand (str): the operand as the user spelled it.
    """

    def __init__(self, operand: str) -> None:
        super().__init__(f"not removing '{operand}' recursively without -r")


# The three refusals ``rm`` groups its paths under, in the order git
# prints them: a path whose staged content matches neither the file
# nor HEAD, a path with a staged change, a path with an unstaged edit.
# Each header comes in a singular and a plural form.
STAGED_BOTH = (
    "the following file has staged content different from "
    "both the\nfile and the HEAD:",
    "the following files have staged content different from "
    "both the\nfile and the HEAD:",
    "(use -f to force removal)",
)
STAGED_INDEX = (
    "the following file has changes staged in the index:",
    "the following files have changes staged in the index:",
    "(use --cached to keep the file, or -f to force removal)",
)
LOCAL_CHANGES = (
    "the following file has local modifications:",
    "the following files have local modifications:",
    "(use --cached to keep the file, or -f to force removal)",
)


def _removal_block(wording: tuple[str, str, str], paths: list[str]) -> str:
    """One paragraph of an ``rm`` refusal.

    Args:
        wording (tuple[str, str, str]): singular header, plural header,
            and the hint line that closes the paragraph.
        paths (list[str]): the paths to name, repository-relative.
    """
    header = wording[0] if len(paths) == 1 else wording[1]
    listed = "\n".join(f"    {path}" for path in sorted(paths))
    return f"{header}\n{listed}\n{wording[2]}"


class RemovalRefusedError(GitError):
    """``rm`` naming a path whose removal would lose uncommitted work.

    git refuses rather than deleting, and names every path under the
    reason it refused it. Three reasons, printed as three paragraphs in
    a fixed order when more than one applies, pinned against git 2.50.1.

    Args:
        both (list[str]): paths staged with content that matches neither
            the working tree nor HEAD.
        staged (list[str]): paths with a change staged in the index.
        local (list[str]): paths with an unstaged edit.
    """

    prefix = "error"
    code = 1

    def __init__(
        self, both: list[str], staged: list[str], local: list[str]
    ) -> None:
        blocks = [
            _removal_block(wording, paths)
            for wording, paths in (
                (STAGED_BOTH, both),
                (STAGED_INDEX, staged),
                (LOCAL_CHANGES, local),
            )
            if paths
        ]
        # git emits each paragraph as its own error, so the second one
        # carries the prefix inline: the renderer only writes the first.
        super().__init__("\nerror: ".join(blocks))


class RemovePathError(GitError):
    """``rm`` whose working-tree deletion the mount refused.

    git names the path and the strerror. The one reason a mount gives
    is a directory standing where a tracked file was: ``unlink`` refuses
    that, and git reports it rather than removing the tree.

    The ``rm`` lines ride along on stdout because git prints them for
    every selected path before it deletes anything, so the ones printed
    before the failure are printed whether the line goes through or not.

    Args:
        path (str): the path, repository-relative.
        report (str): the ``rm`` lines already printed, empty under
            ``-q``.
        reason (str): the strerror to name.
    """

    def __init__(
        self, path: str, report: str = "", reason: str = "Is a directory"
    ) -> None:
        super().__init__(f"git rm: '{path}': {reason}")
        self.report = report


class MountInWayError(GitError):
    """A working-tree removal that would take a nested mount with it.

    A mount nested inside the repository is served by another VFS
    entirely, so removing the directory it stands in empties that
    backend rather than the repository: the store behind it is gone,
    and no branch ever recorded a line of it. mirage refuses instead,
    which is the rule ``MountRootPolicy`` already enforces for ``rm``
    and ``mv`` at the command tier; a git verb reaches the dispatcher
    directly, so it has to ask for itself.

    The mount is named only when the session may be told about it. A
    hidden one blocks the removal just the same, because avoiding a
    boundary and naming it are two different questions, and naming a
    hidden mount is the one thing the hide exists to prevent.

    Args:
        path (str): absolute virtual path being removed.
        mount (str | None): the mount root in the way, None when the
            session may not be told which one it is.
    """

    def __init__(self, path: str, mount: str | None = None) -> None:
        if mount is None:
            held = "it holds a mount root"
        elif mount == path:
            held = "it is a mount root"
        else:
            held = f"'{mount}' is a mount root"
        super().__init__(f"cannot remove '{path}': {held}")


class MoveRefusedError(GitError):
    """``mv`` refusing one source, in git's ``reason, source, destination``
    shape.

    Args:
        reason (str): git's own wording for what is wrong.
        source (str): the source, repository-relative.
        destination (str): the destination, repository-relative.
    """

    def __init__(self, reason: str, source: str, destination: str) -> None:
        super().__init__(
            f"{reason}, source={source}, destination={destination}"
        )


class MoveOverlapError(GitError):
    """``mv`` given both a directory and something inside it.

    git refuses the whole line rather than one source, and ``-k`` does
    not skip it: the two moves would race for the same bytes, and the
    one that lost would be reported as a rename that failed after the
    other had already changed the working tree. The child is named
    first however the operands were ordered. Pinned against git 2.50.1.

    Args:
        child (str): the source below the other, repository-relative.
        parent (str): the directory source above it.
    """

    def __init__(self, child: str, parent: str) -> None:
        super().__init__(
            f"cannot move both '{child}' and its parent directory '{parent}'"
        )


class NotADirectoryDestinationError(GitError):
    """``mv`` with several sources and a destination that is not a directory.

    Args:
        destination (str): the destination, repository-relative.
    """

    def __init__(self, destination: str) -> None:
        super().__init__(f"destination '{destination}' is not a directory")


class RenameFailedError(GitError):
    """``mv`` whose rename the mount refused.

    git names the source and the strerror. The one reason a mount gives
    is a destination whose directory does not exist: git does not create
    it, and neither does this.

    Args:
        source (str): the source, repository-relative.
        reason (str): the strerror to name.
    """

    def __init__(
        self, source: str, reason: str = "No such file or directory"
    ) -> None:
        super().__init__(f"renaming '{source}' failed: {reason}")


class NoRestorePathsError(GitError):
    """``restore`` with no pathspec at all.

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__("you must specify path(s) to restore")


class UnreadableTreeError(GitError):
    """``restore --source`` naming an object that is no tree.

    A revision that resolves is reported by the id it resolved to
    rather than by the spelling, which is git's own wording: the
    complaint is about the object found, not about the name.

    Args:
        oid (str): hex id of the object the source resolved to.
    """

    def __init__(self, oid: str) -> None:
        super().__init__(f"unable to read tree ({oid})")


class UnresolvableSourceError(GitError):
    """``restore --source`` naming a tree this repository cannot resolve.

    Args:
        source (str): the source as the user spelled it.
    """

    def __init__(self, source: str) -> None:
        super().__init__(f"could not resolve {source}")


class InvalidReferenceError(GitError):
    """``switch`` naming something that is neither a branch nor a commit.

    ``switch`` words the miss differently from ``checkout``, which calls
    the same operand a pathspec: switch never takes a path, so nothing
    it was given could have been one.

    Args:
        name (str): the operand as the user spelled it.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"invalid reference: {name}")


class BranchExpectedError(GitError):
    """``switch`` given a commit, tag or remote branch without ``--detach``.

    git refuses rather than detaching, because a detached HEAD is the
    state an agent loses commits in, and ``switch`` exists to be the
    verb that never gets there by accident.

    Args:
        kind (str): what the operand named: ``commit``, ``tag`` or
            ``remote branch``.
        name (str): the operand as the user spelled it.
    """

    def __init__(self, kind: str, name: str) -> None:
        super().__init__(
            f"a branch is expected, got {kind} '{name}'\n"
            f"hint: If you want to detach HEAD at the commit, "
            f"try again with the --detach option."
        )


class MissingBranchArgumentError(GitError):
    """``switch`` with nothing to switch to.

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__("missing branch or commit argument")


class OneReferenceError(GitError):
    """``switch`` given more than one operand.

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__("only one reference expected")


class DetachWithCreateError(GitError):
    """``switch -c`` together with ``--detach``.

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__("'--detach' cannot be used with '-b/-B/--orphan'")


class TagExistsError(GitError):
    """``tag <name>`` naming a tag that is already there.

    Args:
        name (str): the tag name.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"tag '{name}' already exists")


class TagNotFoundError(GitError):
    """``tag -d`` naming a tag that is not there.

    Reported and moved past: git deletes the other names on the line and
    exits 1 at the end, so this is rendered per name rather than raised.

    Args:
        name (str): the tag name as the user spelled it.
    """

    prefix = "error"
    code = 1

    def __init__(self, name: str) -> None:
        super().__init__(f"tag '{name}' not found.")


class ListModeOnlyError(GitError):
    """A listing option on a ``tag`` line that deletes rather than lists.

    ``-n`` asks for message lines beside each name and ``--contains``
    and its kin narrow which names are listed, all of which only a
    listing does, and git makes each *imply* a listing rather than
    refuse it: ``git tag -n1 nosuch`` is a listing whose pattern matches
    nothing and exits 0. The implication is what cannot happen once
    ``-d`` has already said what mode the line is in, so git dies there
    instead, with the tags untouched, naming the first of ``-n``,
    ``--contains``, ``--no-contains``, ``--points-at``, ``--merged``,
    ``--no-merged`` the line holds. Refusing it matters more here than
    the wording does: read as a listing flag and dropped, the line went
    on to delete the refs its operands named. Pinned against git 2.50.1.

    Args:
        option (str): the listing option the line holds.
    """

    def __init__(self, option: str = "-n") -> None:
        super().__init__(f"the '{option}' option is only allowed in list mode")


class RefUpdateConflictError(GitError):
    """``tag -d`` naming one tag twice.

    git stages every deletion on the line as one ref transaction, and a
    transaction holding two updates for the same ref is refused before
    any of them applies, so the whole line is a no-op: the repeated tag
    survives, and so does every other tag the line named. The ref it
    blames is the first in ref order rather than the first typed, since
    the transaction sorts before it looks for the repeat. Reported the
    way git reports it, as an ``error`` exiting 1 rather than a fatal.

    Args:
        ref (str): the full ref name given twice (``refs/tags/v``).
    """

    prefix = "error"
    code = 1

    def __init__(self, ref: str) -> None:
        super().__init__(
            "could not delete references: multiple updates "
            f"for ref '{ref}' not allowed"
        )


class RefLockError(GitError):
    """A ref that cannot be written because another one holds its path.

    git reports this as a failure to take the lock rather than as a
    name that is already taken, and names the ref standing in the way.
    ``-f`` does not help: the obstacle is the path, not the value.
    Pinned against git 2.50.1.

    Args:
        ref (str): the full ref name that cannot be written.
        held (str): the full ref name already there.
    """

    def __init__(self, ref: str, held: str) -> None:
        super().__init__(
            f"cannot lock ref '{ref}': '{held}' exists; cannot create '{ref}'"
        )


class SymbolicRefLockError(RefLockError):
    """``symbolic-ref`` writing a ref whose path another ref holds.

    The same lock failure as RefLockError, which ``refs_update_symref``
    reports as an ``error`` exiting 1 rather than a fatal (pinned
    against git 2.47.3).

    Args:
        ref (str): the full ref name that cannot be written.
        held (str): the full ref name already there.
    """

    prefix = "error"
    code = 1


class NotASymbolicRefError(GitError):
    """``symbolic-ref`` naming a ref that holds an object id, or nothing.

    Args:
        name (str): the ref as typed.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"ref {name} is not a symbolic ref")


class NoSuchRefError(GitError):
    """``symbolic-ref`` naming a ref git cannot resolve at all.

    A name its ref rules refuse, or a chain of symbolic refs more than
    five deep.

    Args:
        name (str): the ref as typed.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"No such ref: {name}")


class NotSymbolicDeleteError(GitError):
    """``symbolic-ref -d`` naming a ref that is not symbolic; ``-q``
    does not quiet it.

    Args:
        name (str): the ref as typed.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"Cannot delete {name}, not a symbolic ref")


class DeleteHeadError(GitError):
    """``symbolic-ref -d HEAD``, which git refuses outright."""

    def __init__(self) -> None:
        super().__init__("deleting 'HEAD' is not allowed")


class HeadOutsideRefsError(GitError):
    """``symbolic-ref HEAD <ref>`` with a target outside ``refs/``."""

    def __init__(self) -> None:
        super().__init__("Refusing to point HEAD outside of refs/")


class InvalidSymbolicTargetError(GitError):
    """``symbolic-ref <name> <ref>`` with a target git's ref rules
    refuse.

    Args:
        name (str): the ref being written.
        target (str): the target as typed.
    """

    def __init__(self, name: str, target: str) -> None:
        super().__init__(f"Refusing to set '{name}' to invalid ref '{target}'")


class EmptyUpdateMessageError(GitError):
    """``symbolic-ref -m ''``, refused before anything else is read."""

    def __init__(self) -> None:
        super().__init__("Refusing to perform update with empty message")


class BadRefNameUpdateError(GitError):
    """``symbolic-ref <name> <ref>`` with a name git's ref rules refuse,
    which the ref transaction reports as an ``error`` exiting 1.

    Args:
        name (str): the ref as typed.
    """

    prefix = "error"
    code = 1

    def __init__(self, name: str) -> None:
        super().__init__(f"refusing to update ref with bad name '{name}'")


class InvalidTagNameError(GitError):
    """A tag name git's ref rules refuse.

    Args:
        name (str): the name as the user spelled it.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"'{name}' is not a valid tag name.")


class UnresolvedRefError(GitError):
    """``tag`` given an object it cannot resolve.

    Args:
        revision (str): the operand as the user spelled it.
    """

    def __init__(self, revision: str) -> None:
        super().__init__(f"Failed to resolve '{revision}' as a valid ref.")


class TooManyArgumentsError(GitError):
    """``tag`` given more operands than a name and an object.

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__("too many arguments")


class MissingTagMessageError(GitError):
    """``tag -a`` with no ``-m``.

    git would open an editor here, exactly as ``commit`` would, and the
    same answer applies: a mount has no editor, and inventing a message
    would put an unreviewed one into the repository.

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__(
            "no tag message supplied (mirage has no editor to open; pass -m)"
        )


class IncompatibleOptionsError(GitError):
    """Two options git refuses to take together.

    Args:
        first (str): the first option as spelled on the command line.
        second (str): the second.
    """

    prefix = "error"
    code = OPTION_EXIT

    def __init__(self, first: str, second: str) -> None:
        super().__init__(
            f"options '{first}' and '{second}' cannot be used together"
        )


class IncompatibleLogOptionsError(GitError):
    """Two revision-walk options git refuses to take together.

    The same sentence as IncompatibleOptionsError, from the revision
    parser rather than parse-options, so git dies with 128 instead of
    refusing with 129: ``log --graph --reverse`` (pinned against git
    2.50.1).

    Args:
        first (str): the first option as git names it.
        second (str): the second.
    """

    def __init__(self, first: str, second: str) -> None:
        super().__init__(
            f"options '{first}' and '{second}' cannot be used together"
        )


class AmbiguousObjectNameError(GitError):
    """A branch started from a name two refs answer to.

    git refuses it rather than picking one while
    ``core.warnAmbiguousRefs`` is on (pinned against git 2.47.3).

    Args:
        name (str): the start point as typed.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"ambiguous object name: '{name}'")


class AbbrevModeError(GitError):
    """``rev-parse --abbrev-ref=<mode>`` with a mode other than ``strict``
    or ``loose``.

    Args:
        mode (str): the mode as typed.
    """

    def __init__(self, mode: str) -> None:
        super().__init__(f"unknown mode for --abbrev-ref: {mode}")


class InvalidObjectNameError(GitError):
    """A branch start point that names nothing (pinned against git
    2.50.1).

    Args:
        name (str): the start point as typed.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"not a valid object name: '{name}'")


class BranchPointError(GitError):
    """A branch start point that names something other than a commit.

    git names the object and its type, then refuses the start point
    (pinned against git 2.50.1).

    Args:
        oid (str): the object's id.
        kind (str): its type.
        name (str): the start point as typed.
    """

    prefix = "error"

    def __init__(self, oid: str, kind: str, name: str) -> None:
        super().__init__(
            f"object {oid} is a {kind}, not a commit\n"
            f"fatal: not a valid branch point: '{name}'"
        )


class InvalidRevisionNameError(GitError):
    """``<rev>:<path>`` whose revision names nothing (pinned against git
    2.50.1).

    Args:
        rev (str): the revision as typed.
    """

    def __init__(self, rev: str) -> None:
        super().__init__(f"invalid object name '{rev}'.")


class PathNotInRevisionError(GitError):
    """``<rev>:<path>`` whose tree has no such path.

    Said differently when the working tree has one (pinned against git
    2.50.1).

    Args:
        path (str): the path as typed.
        rev (str): the revision as typed.
        on_disk (bool): whether the working tree holds the path.
    """

    def __init__(self, path: str, rev: str, on_disk: bool) -> None:
        super().__init__(
            f"path '{path}' exists on disk, but not in '{rev}'"
            if on_disk
            else f"path '{path}' does not exist in '{rev}'"
        )


class PathNotInIndexError(GitError):
    """``:<path>`` the index does not hold.

    Said differently when the working tree does.

    Args:
        path (str): the path as typed.
        on_disk (bool): whether the working tree holds the path.
    """

    def __init__(self, path: str, on_disk: bool) -> None:
        super().__init__(
            f"path '{path}' exists on disk, but not in the index"
            if on_disk
            else f"path '{path}' does not exist "
            "(neither on disk nor in the index)"
        )


class PathNotAtStageError(GitError):
    """``:<n>:<path>`` the index holds at another stage, with git's hint
    at that one.

    Args:
        path (str): the path as typed.
        stage (int): the stage asked for.
        held (int): a stage the index holds it at.
    """

    def __init__(self, path: str, stage: int, held: int) -> None:
        super().__init__(
            f"path '{path}' is in the index, but not at stage {stage}\n"
            f"hint: Did you mean ':{held}:{path}'?"
        )


class DetachPathError(GitError):
    """``checkout --detach`` given more than a commit.

    Whatever is not one is read as a path, which a detach does not take
    (pinned against git 2.50.1).

    Args:
        path (str): the operand as typed.
    """

    def __init__(self, path: str) -> None:
        super().__init__(
            f"git checkout: --detach does not take a path argument '{path}'"
        )


class PathsWithBranchError(GitError):
    """``checkout -b`` given paths as well as a start point (pinned
    against git 2.50.1).

    Args:
        branch (str): the branch being created.
    """

    def __init__(self, branch: str) -> None:
        super().__init__(
            f"Cannot update paths and switch to branch '{branch}' at the "
            "same time."
        )


class IndexLockError(GitError):
    """A verb that writes the index refused by a read-only mount.

    git takes the index lock before anything else and dies naming it
    (pinned against git 2.47.3).

    Args:
        gitdir (str): the git directory.
    """

    def __init__(self, gitdir: str) -> None:
        super().__init__(
            f"Unable to create '{gitdir}/index.lock': Read-only file system"
        )


class RefReadOnlyError(GitError):
    """A ref a read-only mount will not let a verb write.

    git names the ref and the lock it could not take (pinned against git
    2.47.3).

    Args:
        ref (str): the full ref name.
        path (str): where the ref lives.
    """

    def __init__(self, ref: str, path: str) -> None:
        super().__init__(
            f"cannot lock ref '{ref}': Unable to create '{path}.lock': "
            "Read-only file system"
        )


class SymbolicRefReadOnlyError(RefReadOnlyError):
    """``symbolic-ref``'s ref transaction refused by a read-only mount, an
    ``error`` exiting 1.

    Args:
        ref (str): the full ref name.
        path (str): where the ref lives.
    """

    prefix = "error"
    code = 1


class RefDeleteReadOnlyError(GitError):
    """A ref a read-only mount will not let ``branch -d`` or ``tag -d``
    delete.

    Args:
        ref (str): the full ref name.
        path (str): where the ref lives.
    """

    prefix = "error"
    code = 1

    def __init__(self, ref: str, path: str) -> None:
        super().__init__(
            f"could not delete reference {ref}: cannot lock ref '{ref}': "
            f"Unable to create '{path}.lock': Read-only file system"
        )


class TagWriteReadOnlyError(GitError):
    """An annotated tag a read-only mount will not let ``tag -a`` write."""

    prefix = None

    def __init__(self) -> None:
        super().__init__(
            "error: unable to create temporary file: Read-only file system\n"
            "error: unable to write tag file\n"
            "The tag message has been left in .git/TAG_EDITMSG"
        )


class CloneReadOnlyError(GitError):
    """``clone`` into a directory a read-only mount will not let it make.

    Args:
        directory (str): the directory as typed or derived.
    """

    def __init__(self, directory: str) -> None:
        super().__init__(
            f"could not create work tree dir '{directory}': "
            "Read-only file system"
        )


class FetchHeadReadOnlyError(GitError):
    """``fetch`` refused by a read-only mount, at FETCH_HEAD; git exits
    255.

    Args:
        path (str): FETCH_HEAD as git names it.
    """

    prefix = "error"
    code = 255

    def __init__(self, path: str) -> None:
        super().__init__(f"cannot open '{path}': Read-only file system")


class InitReadOnlyError(GitError):
    """``init`` refused a directory it makes by a read-only mount.

    git's ``perror`` of the directory and exit 1, with no prefix.

    Args:
        path (str): the directory it could not make.
    """

    prefix = None
    code = 1

    def __init__(self, path: str) -> None:
        super().__init__(f"{path}: Read-only file system")


class CannotMkdirError(GitError):
    """``init`` could not create the directory its operand names.

    Args:
        path (str): the directory as typed.
        reason (str): filesystem failure, read-only by default.
    """

    def __init__(
        self, path: str, reason: str = "Read-only file system"
    ) -> None:
        super().__init__(f"cannot mkdir {path}: {reason}")


class ConfigLockError(GitError):
    """A re-``init`` that cannot take the config's lock: a read-only
    mount, or a lock another writer holds.

    git's lock error, then the setting it could not make (pinned against
    git 2.47.3).

    Args:
        path (str): the config file.
        reason (str): why the lock could not be made.
    """

    prefix = None

    def __init__(self, path: str, reason: str) -> None:
        super().__init__(
            f"error: could not lock config file {path}: {reason}\n"
            "fatal: could not set 'core.repositoryformatversion' to '0'"
        )


class LockExistsError(GitError):
    """A lock another writer holds, in git's words for every lock file.

    Args:
        lock (str): the lock file.
    """

    def __init__(self, lock: str) -> None:
        super().__init__(
            f"Unable to create '{lock}': File exists.\n\n"
            "Another git process seems to be running in this repository, "
            "e.g.\nan editor opened by 'git commit'. Please make sure all "
            "processes\nare terminated then try again. If it still fails, "
            "a git process\nmay have crashed in this repository earlier:\n"
            "remove the file manually to continue."
        )


class InvalidDecorateError(GitError):
    """A ``--decorate`` value that names no decoration style (pinned
    against git 2.47.3).

    Args:
        value (str): the value as typed.
    """

    def __init__(self, value: str) -> None:
        super().__init__(f"invalid --decorate option: {value}")


class MalformedObjectError(GitError):
    """``--contains`` or ``--points-at`` given a name that resolves to
    no object.

    Both refuse while the options are parsed, so the line exits 129 and
    nothing is listed; ``--points-at`` quotes the name and
    ``--contains`` does not, which is git's own inconsistency (pinned
    against git 2.50.1).

    Args:
        name (str): the name as typed.
        quoted (bool): whether git quotes it.
    """

    prefix = "error"
    code = OPTION_EXIT

    def __init__(self, name: str, quoted: bool = False) -> None:
        shown = f"'{name}'" if quoted else name
        super().__init__(f"malformed object name {shown}")


class MalformedMergeFilterError(GitError):
    """``--merged`` or ``--no-merged`` given a name that resolves to no
    object.

    The same mistake ``MalformedObjectError`` reports, and git dies on
    this one instead of refusing the option: exit 128 (pinned against
    git 2.50.1).

    Args:
        name (str): the name as typed.
    """

    def __init__(self, name: str) -> None:
        super().__init__(f"malformed object name {name}")


class NotACommitError(GitError):
    """A commit filter given an object that is no commit, such as a blob.

    git names the object and its type, then says which option could not
    use it: ``--contains`` as ``no such commit <name>`` and ``--merged``
    as the option itself (pinned against git 2.50.1).

    Args:
        sha (str): the object's id.
        kind (str): its type.
        reason (str): git's second line, after its ``error:``.
    """

    prefix = "error"
    code = OPTION_EXIT

    def __init__(self, sha: str, kind: str, reason: str) -> None:
        super().__init__(
            f"object {sha} is a {kind}, not a commit\nerror: {reason}"
        )


class MissingRepositoryError(GitError):
    """A local path that holds no repository, in clone's words.

    Args:
        url (str): the path as typed.
    """

    def __init__(self, url: str) -> None:
        super().__init__(f"repository '{url}' does not exist")


class UnknownDateFormatError(GitError):
    """A ``--date`` value, or a date atom's argument, git has no style
    for.

    Named as git's ``parse_date_format`` names it: the whole value, a
    ``-local`` suffix and all (pinned against git 2.50.1).

    Args:
        value (str): the value as typed.
    """

    def __init__(self, value: str) -> None:
        super().__init__(f"unknown date format {value}")


class DateFormatColonError(GitError):
    """``format`` with no ``:`` before its strftime template.

    Args:
        value (str): the value as typed.
    """

    def __init__(self, value: str) -> None:
        super().__init__(f"date format missing colon separator: {value}")


class UnsupportedFieldError(GitError):
    """A ref field git has but this build does not render.

    ``%(describe)``, ``%(trailers)``, ``%(signature)`` and their kin are
    real git fields; calling one unknown would gaslight an agent that
    spelled it right, so the refusal says unsupported instead.

    Args:
        name (str): the field as typed, e.g. ``contents:trailers``.
    """

    def __init__(self, name: str) -> None:
        super().__init__(
            f"unsupported field name: {name} (this build does not render it)"
        )


class FormatUsageError(GitError):
    """A ref format or option set a verb refuses with its usage.

    git prints the line, then the verb's usage, and exits 129; the usage
    is omitted here as it is for every other verb.

    Args:
        message (str): the line after ``error:``.
    """

    prefix = "error"
    code = OPTION_EXIT


class UnparsableFormatError(GitError):
    """``branch`` and ``tag`` given a format with a ``%(`` left open.

    ``for-each-ref`` answers the same format with its usage; these two
    say it twice instead, once as git's ``error:`` and once as the fatal
    that follows it (pinned against git 2.50.1).

    Args:
        rest (str): the format from the unclosed ``%(`` on.
    """

    prefix = "error"

    def __init__(self, rest: str) -> None:
        super().__init__(
            f"malformed format string {rest}\n"
            "fatal: unable to parse format string"
        )
