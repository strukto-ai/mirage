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
ADVICE_IGNORED = ('hint: Disable this message with "git config set '
                  'advice.addIgnoredFile false"')
ADVICE_EMPTY_PATHSPEC = ('hint: Disable this message with "git config '
                         'set advice.addEmptyPathspec false"')
ADVICE_REF_FORMAT = "hint: See `man git check-ref-format`"
ADVICE_REF_SYNTAX = ('hint: Disable this message with "git config set '
                     'advice.refSyntax false"')


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
            super().__init__("not a git repository (or any of the parent "
                             "directories): .git")
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
            f"'git <command> [<revision>...] -- [<file>...]'")


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
        super().__init__(f"invalid date format for {flag}: {value} "
                         f"(expected ISO-8601 or an epoch second)")


class NoWorkspaceError(GitError):
    """The CLI ran with no workspace behind it, so no file is reachable.

    Only possible when a leaf is called directly in a unit test: inside
    a workspace the dispatcher always offers the facts a leaf declares.
    """

    def __init__(self) -> None:
        super().__init__("this operation must be run in a work tree")


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

    def __init__(self,
                 path: str,
                 reason: str = "No such file or directory") -> None:
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
        super().__init__(f"'{start}' is not a commit and a branch '{name}' "
                         f"cannot be created from it")


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
        super().__init__(f"cannot reset to '{revision}': this build resets "
                         f"the index from HEAD only")


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

    ``raw``, ``email``, ``mboxrd`` and ``reference`` are real git
    formats; answering "invalid" for them would gaslight an agent that
    spelled a valid one, so the refusal says unsupported and names what
    exists instead.

    Args:
        value (str): the format value as spelled on the command line.
    """

    def __init__(self, value: str) -> None:
        super().__init__(
            f"unsupported --pretty format: {value} (this build implements "
            f"oneline, short, medium, full, fuller and format:/tformat: "
            f"strings)")


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
        super().__init__(f"{operand}: '{operand}' is outside repository at "
                         f"'{root}'")


class PathspecError(GitError):
    """A path operand that matches nothing in the working tree.

    Args:
        pathspec (str): the operand as the user spelled it.
    """

    def __init__(self, pathspec: str) -> None:
        super().__init__(f"pathspec '{pathspec}' did not match any files")


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
        super().__init__(f"The following paths are ignored by one of your "
                         f".gitignore files:\n{listed}\nhint: Use -f if you "
                         f"really want to add them.\n{ADVICE_IGNORED}")


class NothingSpecifiedError(GitError):
    """``add`` with no pathspec at all.

    Not an error by exit code: git says what it did not do and exits 0,
    because nothing went wrong and nothing happened.
    """

    prefix = None
    code = 0

    def __init__(self) -> None:
        super().__init__("Nothing specified, nothing added.\nhint: Maybe "
                         "you wanted to say 'git add .'?\n"
                         f"{ADVICE_EMPTY_PATHSPEC}")


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
        super().__init__("no commit message supplied (mirage has no editor "
                         "to open; pass -m)")


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
        super().__init__(f"'{name}' is not a valid branch name\n"
                         f"{ADVICE_REF_FORMAT}\n{ADVICE_REF_SYNTAX}")


class BranchNameRequiredError(GitError):
    """``branch -d`` with nothing to delete.

    Args:
        None.
    """

    prefix = "error"
    code = OPTION_EXIT

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
        super().__init__(f"cannot delete branch '{name}' used by worktree at "
                         f"'{worktree}'")


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
        super().__init__(f"the branch '{name}' is not fully merged\n"
                         f"hint: If you are sure you want to delete it, run "
                         f"'git branch -D {name}'")


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
        super().__init__(f"pathspec '{target}' did not match any file(s) "
                         f"known to git")


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

    def __init__(self,
                 local: list[str],
                 untracked: list[str],
                 directories: list[str] | None = None) -> None:
        blocks: list[str] = []
        if local:
            blocks.append(
                _conflict_block(
                    "Your local changes to the following files would be "
                    "overwritten by checkout:", local,
                    "Please commit your changes or stash them before you "
                    "switch branches."))
        if directories:
            blocks.append(
                _conflict_block(
                    "Updating the following directories would lose "
                    "untracked files in them:", directories))
        if untracked:
            blocks.append(
                _conflict_block(
                    "The following untracked working tree files would be "
                    "overwritten by checkout:", untracked,
                    "Please move or remove them before you switch branches."))
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
        self.report = "".join(f"{path}: needs merge\n"
                              for path in sorted(paths))
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
        super().__init__("\nerror: ".join(f"path '{path}' is unmerged"
                                          for path in sorted(paths)))


class UnknownSwitchError(GitError):
    """The wording of git's own option parser, used by most verbs.

    Three verbs word this three ways and git means all of them: ``log``
    and ``show`` say "unrecognized argument" and exit 128, ``diff`` says
    "invalid option" and exits 129, and everything built on
    parse-options (``status``, ``add``, ``branch``, ``reset``,
    ``checkout``, ``commit``) says this and exits 129. Measured on git
    2.47, one verb at a time.

    Args:
        argument (str): the option as the user spelled it.
    """

    prefix = "error"
    code = OPTION_EXIT

    def __init__(self, argument: str) -> None:
        noun = "option" if argument.startswith("--") else "switch"
        super().__init__(f"unknown {noun} `{argument.lstrip('-')}'")


class InvalidOptionError(GitError):
    """``diff``'s wording for an option it does not know.

    Same mistake as UnrecognizedArgumentError and a different sentence,
    because git itself words it differently here and exits 129 rather
    than 128. Pinned against git 2.50.1.

    Args:
        argument (str): the operand as the user spelled it.
    """

    prefix = "error"
    code = OPTION_EXIT

    def __init__(self, argument: str) -> None:
        super().__init__(f"invalid option: {argument}")


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
STAGED_BOTH = ("the following file has staged content different from "
               "both the\nfile and the HEAD:",
               "the following files have staged content different from "
               "both the\nfile and the HEAD:", "(use -f to force removal)")
STAGED_INDEX = ("the following file has changes staged in the index:",
                "the following files have changes staged in the index:",
                "(use --cached to keep the file, or -f to force removal)")
LOCAL_CHANGES = ("the following file has local modifications:",
                 "the following files have local modifications:",
                 "(use --cached to keep the file, or -f to force removal)")


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

    def __init__(self, both: list[str], staged: list[str],
                 local: list[str]) -> None:
        blocks = [
            _removal_block(wording, paths)
            for wording, paths in ((STAGED_BOTH, both), (STAGED_INDEX, staged),
                                   (LOCAL_CHANGES, local)) if paths
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

    def __init__(self,
                 path: str,
                 report: str = "",
                 reason: str = "Is a directory") -> None:
        super().__init__(f"git rm: '{path}': {reason}")
        self.report = report


class MountInWayError(GitError):
    """A working-tree removal that would take a nested mount with it.

    A mount nested inside the repository is served by another resource
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


class MoveUsageError(GitError):
    """``mv`` with fewer than two operands.

    git prints its usage and exits 129. Only the two synopsis lines are
    kept: the option list below them describes flags this build does
    not all have.

    Args:
        None.
    """

    prefix = None
    code = OPTION_EXIT

    def __init__(self) -> None:
        super().__init__("usage: git mv [-v] [-f] [-n] [-k] <source> "
                         "<destination>\n   or: git mv [-v] [-f] [-n] [-k] "
                         "<source>... <destination-directory>")


class MoveRefusedError(GitError):
    """``mv`` refusing one source, in git's ``reason, source, destination``
    shape.

    Args:
        reason (str): git's own wording for what is wrong.
        source (str): the source, repository-relative.
        destination (str): the destination, repository-relative.
    """

    def __init__(self, reason: str, source: str, destination: str) -> None:
        super().__init__(f"{reason}, source={source}, "
                         f"destination={destination}")


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
        super().__init__(f"cannot move both '{child}' and its parent "
                         f"directory '{parent}'")


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

    def __init__(self,
                 source: str,
                 reason: str = "No such file or directory") -> None:
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
        super().__init__(f"a branch is expected, got {kind} '{name}'\n"
                         f"hint: If you want to detach HEAD at the commit, "
                         f"try again with the --detach option.")


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
    """``-n`` on a ``tag`` line that deletes rather than lists.

    ``-n`` asks for message lines beside each name, which only a listing
    prints, and git makes it *imply* a listing rather than refuse it:
    ``git tag -n1 nosuch`` is a listing whose pattern matches nothing
    and exits 0. The implication is what cannot happen once ``-d`` has
    already said what mode the line is in, so git dies there instead,
    with the tags untouched. Refusing it matters more here than the
    wording does: read as a listing flag and dropped, the line went on
    to delete the refs its operands named. Pinned against git 2.50.1.

    Args:
        None.
    """

    def __init__(self) -> None:
        super().__init__("the '-n' option is only allowed in list mode")


class TagLinesError(GitError):
    """``tag -n<num>`` with a count below the one git reserves.

    ``-n`` carries an optional count, and git's parser starts that
    count at -1 to mean "not given at all". ``-n-1`` is therefore not a
    listing flag at all: ``git tag -d -n-1 v`` deletes and
    ``git tag -n-1 -a v -m m`` creates, where a real ``-n`` refuses
    both. Anything below -1 is a count, and a count has to be positive,
    which git discovers while parsing the format it lists with rather
    than while parsing the option: the list-mode refusal outranks this
    one, and it fires in a repository holding no tags at all. Pinned
    against git 2.50.1.

    Args:
        lines (int): the count as typed.
    """

    def __init__(self, lines: int) -> None:
        super().__init__(f"positive value expected contents:lines={lines}")


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
        super().__init__("could not delete references: multiple updates "
                         f"for ref '{ref}' not allowed")


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
        super().__init__(f"cannot lock ref '{ref}': '{held}' exists; "
                         f"cannot create '{ref}'")


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


class TagUsageError(GitError):
    """``tag`` given a creation option with no tag name to create.

    ``-a``, ``-m`` and ``-f`` are creation options, so git refuses them
    on a line that lists or deletes instead: no operand at all lists,
    and ``-l`` or ``-d`` says so outright. It prints its usage and
    exits 129, where an operand-free ``git tag`` or ``git tag -d``
    lists and exits 0. The synopsis is trimmed to the options this
    build has, the way ``mv``'s is: git's own lines advertise ``-s``,
    ``-u``, ``-F``, ``-e`` and ``-v``, which would be a promise
    nothing here keeps. Pinned against git 2.50.1.

    Args:
        None.
    """

    prefix = None
    code = OPTION_EXIT

    def __init__(self) -> None:
        super().__init__("usage: git tag [-a] [-f] [-m <msg>] <tagname> "
                         "[<commit> | <object>]\n"
                         "   or: git tag -d <tagname>...\n"
                         "   or: git tag [-n[<num>]] -l [<pattern>...]")


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
        super().__init__("no tag message supplied (mirage has no editor to "
                         "open; pass -m)")


class IncompatibleOptionsError(GitError):
    """Two options git refuses to take together.

    Args:
        first (str): the first option as spelled on the command line.
        second (str): the second.
    """

    prefix = "error"
    code = OPTION_EXIT

    def __init__(self, first: str, second: str) -> None:
        super().__init__(f"options '{first}' and '{second}' cannot be used "
                         f"together")
