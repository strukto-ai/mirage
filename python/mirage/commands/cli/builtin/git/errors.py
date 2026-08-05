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


class GitError(Exception):
    """Base for a git fatal: rendered as ``fatal: <message>``, exit 128.

    Subclasses override ``prefix``, ``code`` and ``stream`` when git
    words their case differently, so every verb can keep one
    ``except GitError`` arm and the rendering stays in one place. A None
    prefix prints the message alone, which is what git does when the
    refusal is a report rather than an error ("nothing to commit"), and
    such a report goes to stdout because that is where the report it
    replaces would have gone.
    """

    prefix: str | None = "fatal"
    code = FATAL_EXIT
    stream = "stderr"


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
    """``-C`` named a path that does not exist.

    Args:
        path (str): the path as the user spelled it.
    """

    def __init__(self, path: str) -> None:
        super().__init__(f"cannot change to '{path}': No such file or "
                         f"directory")


class UnrecognizedArgumentError(GitError):
    """A dashed operand, which is a git feature this build does not have.

    mirage implements a subset of every verb, so an undeclared flag is
    rarely a typo: it is a real git option (``-p``, ``--stat``,
    ``--graph``) arriving at a build that lacks it. Left alone it lands
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
    """``checkout`` naming something that is neither a ref nor a path.

    Args:
        target (str): the operand as the user spelled it.
    """

    prefix = "error"
    code = 1

    def __init__(self, target: str) -> None:
        super().__init__(f"pathspec '{target}' did not match any file(s) "
                         f"known to git")


class CheckoutConflictError(GitError):
    """A checkout that would throw away uncommitted work.

    git refuses and names every file rather than overwriting, which is
    the one safety check that makes checkout usable at all: without it a
    branch switch silently destroys whatever was edited and not staged.

    Args:
        paths (list[str]): the files that would be lost.
    """

    prefix = "error"
    code = 1

    def __init__(self, paths: list[str]) -> None:
        listed = "\n".join(f"\t{path}" for path in sorted(paths))
        super().__init__(
            f"Your local changes to the following files would be "
            f"overwritten by checkout:\n{listed}\nPlease commit your changes "
            f"or stash them before you switch branches.\nAborting")


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
