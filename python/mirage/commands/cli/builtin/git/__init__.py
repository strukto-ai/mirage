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

from mirage.commands.cli.builtin.git.add import add
from mirage.commands.cli.builtin.git.branch import branch, branch_read_only
from mirage.commands.cli.builtin.git.cat_file import cat_file
from mirage.commands.cli.builtin.git.checkout import (
    checkout,
    checkout_read_only,
)
from mirage.commands.cli.builtin.git.clone import clone, clone_read_only
from mirage.commands.cli.builtin.git.commit import commit
from mirage.commands.cli.builtin.git.diff import diff
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.fetch import fetch, fetch_read_only
from mirage.commands.cli.builtin.git.for_each_ref import for_each_ref
from mirage.commands.cli.builtin.git.fsck import fsck
from mirage.commands.cli.builtin.git.grep import grep
from mirage.commands.cli.builtin.git.hash_object import (
    hash_object,
    hash_object_read_only,
)
from mirage.commands.cli.builtin.git.init import init
from mirage.commands.cli.builtin.git.inspect import (
    config,
    merge_base,
    remote,
    rev_list,
    rev_parse,
    show_ref,
    version,
)
from mirage.commands.cli.builtin.git.log import log
from mirage.commands.cli.builtin.git.ls_files import ls_files, ls_tree
from mirage.commands.cli.builtin.git.mv import mv
from mirage.commands.cli.builtin.git.reflog import reflog
from mirage.commands.cli.builtin.git.reset import reset
from mirage.commands.cli.builtin.git.restore import restore
from mirage.commands.cli.builtin.git.rm import rm
from mirage.commands.cli.builtin.git.session import index_locked, verb
from mirage.commands.cli.builtin.git.shortlog import shortlog
from mirage.commands.cli.builtin.git.show import diff_tree, show
from mirage.commands.cli.builtin.git.stash import stash_list, stash_show
from mirage.commands.cli.builtin.git.status import status
from mirage.commands.cli.builtin.git.switch import switch, switch_read_only
from mirage.commands.cli.builtin.git.symbolic_ref import (
    symbolic_ref,
    symbolic_ref_read_only,
)
from mirage.commands.cli.builtin.git.tag import tag, tag_read_only
from mirage.commands.cli.builtin.git.util import check_switches, fatal
from mirage.commands.cli.types import CLI, CLIHandler, CLIInvocation
from mirage.commands.cli.walk import find_node, node_help
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.io.types import ByteSource, IOResult

# `-C` is git's own before-anything-else option, so it sits on the root
# and every verb inherits it. The "." default is load-bearing: a PATH
# default lands as if typed, so an absent -C resolves to the session cwd
# and the leaves need no separate working-directory fact. The root names it
# its operand base, so a later relative -C lands under the one before it.
DIRECTORY_OPTION = Argument(
    "-C", type="path", default=".", help="Run as if git was started in <path>"
)

REVISION = Argument("text", nargs="*", metavar="")

# --pretty and --format set the same variable in git; both take git's
# optional-value form, so a bare --pretty means medium and a detached
# next word is a revision, never a format. A bare --format stays
# parseable too, but only so pretty_format can answer it with git's own
# fatal (pretty.c reads --format in its =value form alone).
PRETTY_OPTION = Argument(
    "--pretty",
    nargs="?",
    attached_only=True,
    help="Commit display format: oneline, short, "
    "medium, full, fuller, or a format:/tformat:/%-string",
)
FORMAT_OPTION = Argument(
    "--format",
    nargs="?",
    attached_only=True,
    help="Alias of --pretty (requires =value)",
)

# Free text, read by parse_date_mode: git names a style it lacks in its
# own fatal, and format:<strftime> is no fixed word.
DATE_OPTION = Argument(
    "--date",
    help="Date display format: default, relative, "
    "local, iso, iso-strict, rfc, short, raw, unix, human "
    "or format:<strftime>",
)

DIFF_OPTIONS = (
    Argument(
        "-a", "--text", action="store_true", help="Treat binary files as text"
    ),
    Argument(
        "-W",
        "--function-context",
        action="store_true",
        help="Show whole functions as diff context",
    ),
    Argument("-U", "--unified", type="int", help="Number of context lines"),
    Argument(
        "--name-status",
        action="store_true",
        help="Show changed paths and status",
    ),
    Argument(
        "--name-only",
        action="store_true",
        help="Show changed paths instead of the patch",
    ),
    Argument(
        "--stat",
        action="store_true",
        help="Show the diffstat table instead of the patch",
    ),
    Argument(
        "--numstat",
        action="store_true",
        help="Show added and deleted line counts per path",
    ),
    Argument(
        "--shortstat",
        action="store_true",
        help="Show only the diffstat summary line",
    ),
    Argument(
        "--summary",
        action="store_true",
        help="Summarize creations, deletions and mode changes",
    ),
    Argument("-p", "--patch", action="store_true", help="Show the patch"),
    Argument(
        "-s",
        "--no-patch",
        action="store_true",
        help="Suppress all diff output",
    ),
    Argument(
        "--no-ext-diff",
        action="store_true",
        help="Accepted for compatibility; there are no external "
        "diff drivers to disable",
    ),
    Argument(
        "-M",
        "--find-renames",
        nargs="?",
        attached_only=True,
        help="Detect renames with an optional similarity threshold",
    ),
    Argument(
        "--no-renames", action="store_true", help="Turn off rename detection"
    ),
    Argument("--raw", action="store_true", help="Show the raw diff format"),
)

# git's optional-value form: a bare --decorate is short, and a detached
# next word is a revision, never a style.
DECORATE_OPTIONS = (
    Argument(
        "--decorate",
        nargs="?",
        attached_only=True,
        help="Print ref names on commits: short (the default), full, "
        "auto or no",
    ),
    Argument(
        "--no-decorate",
        action="store_true",
        help="Print no ref names on commits",
    ),
)

MERGE_OPTIONS = (
    Argument(
        "-m",
        action="store_true",
        help="Show merge diffs separately against each parent",
    ),
    Argument("-c", action="store_true", help="Show combined merge diffs"),
    Argument(
        "--cc", action="store_true", help="Show dense combined merge diffs"
    ),
    Argument(
        "--first-parent",
        action="store_true",
        help="Follow and compare only the first parent",
    ),
    Argument("--diff-merges", help="Select merge diff mode"),
)

LOG_OPTIONS = (
    Argument(
        "-E",
        "--extended-regexp",
        action="store_true",
        help="Use extended regular expressions",
    ),
    Argument(
        "-F",
        "--fixed-strings",
        action="store_true",
        help="Match patterns literally",
    ),
    Argument(
        "-P",
        "--perl-regexp",
        action="store_true",
        help="Use Perl-compatible regular expressions",
    ),
    Argument(
        "--basic-regexp",
        action="store_true",
        help="Use basic regular expressions",
    ),
    Argument(
        "--committer",
        action="append",
        help="Limit commits to matching committers",
    ),
    Argument(
        "--author",
        action="append",
        help="Limit commits to matching authors",
    ),
    Argument(
        "--grep",
        action="append",
        help="Limit commits to ones with a message line that matches",
    ),
    Argument(
        "-i",
        "--regexp-ignore-case",
        action="store_true",
        help="Match --grep, --author and -S without regard to case",
    ),
    *MERGE_OPTIONS,
    Argument(
        "--after",
        help="Commits more recent than a date, like --since",
    ),
    Argument("--before", help="Commits older than a date, like --until"),
    Argument(
        "--max-parents",
        type="int",
        help="Show only commits with at most this many parents",
    ),
    Argument(
        "--min-parents",
        type="int",
        help="Show only commits with at least this many parents",
    ),
    Argument("--merges", action="store_true", help="Show only merge commits"),
    Argument(
        "--no-merges", action="store_true", help="Leave out merge commits"
    ),
    DATE_OPTION,
    *DECORATE_OPTIONS,
    Argument(
        "-n",
        "--max-count",
        type="int",
        numeric_shorthand=True,
        help="Limit the number of commits shown",
    ),
    Argument(
        "--oneline",
        action="store_true",
        help="One abbreviated line per commit",
    ),
    Argument(
        "--reverse", action="store_true", help="Print commits oldest first"
    ),
    Argument(
        "--graph",
        action="store_true",
        help="Draw the commit history beside the log (implies --topo-order)",
    ),
    Argument(
        "--topo-order",
        action="store_true",
        help="Show no parent before all its children, one line "
        "of history at a time",
    ),
    Argument(
        "--date-order",
        action="store_true",
        help="Show no parent before all its children, otherwise newest first",
    ),
    Argument(
        "--all",
        action="store_true",
        help="Start from every ref as well as the revision",
    ),
    PRETTY_OPTION,
    FORMAT_OPTION,
    # The pickaxe, and the reason `git log -S <name> --reverse` answers
    # "which commit introduced this": it selects commits that changed
    # how many times the string occurs, not commits that mention it.
    Argument(
        "-S",
        help="Show commits that change the number of occurrences "
        "of the string",
    ),
    Argument(
        "-G",
        help="Show commits whose diff adds or removes a line that "
        "matches the extended regular expression",
    ),
    Argument(
        "--pickaxe-regex",
        action="store_true",
        help="Treat the -S string as an extended regular expression",
    ),
    Argument(
        "--since",
        help="Commits more recent than a date (ISO-8601 or epoch)",
    ),
    Argument(
        "--until",
        help="Commits older than a date (ISO-8601 or epoch)",
    ),
)

MAILMAP_OPTIONS = (
    Argument(
        "--mailmap", action="store_true", help="Apply mailmap to identities"
    ),
    Argument(
        "--use-mailmap",
        action="store_true",
        help="Apply mailmap to identities",
    ),
    Argument(
        "--no-mailmap", action="store_true", help="Use recorded identities"
    ),
    Argument(
        "--no-use-mailmap", action="store_true", help="Use recorded identities"
    ),
)

SHOW_OPTIONS = (
    *MAILMAP_OPTIONS,
    Argument(
        "--oneline",
        action="store_true",
        help="One abbreviated line per commit",
    ),
    *DIFF_OPTIONS,
    *MERGE_OPTIONS,
    DATE_OPTION,
    PRETTY_OPTION,
    FORMAT_OPTION,
)

# git's ref-filter options, which `branch` and `tag` share. The four
# commit filters take the next word as their commit, whatever it looks
# like (`--merged --no-merged` names a commit called `--no-merged`),
# except as the line's last word, where they read HEAD: parse-options'
# LASTARG_DEFAULT. The spec has no word for that, so they are declared
# with an optional value (a bare one is HEAD, `--merged=main` is main)
# and `filter_words` reattaches a detached value from the verbatim argv.
# `--points-at` always takes a value.
REF_FILTER_OPTIONS = (
    Argument(
        "--contains",
        action="append",
        nargs="?",
        attached_only=True,
        metavar="commit",
        help="List only refs that contain the commit (HEAD if omitted)",
    ),
    Argument(
        "--no-contains",
        action="append",
        nargs="?",
        attached_only=True,
        metavar="commit",
        help="List only refs that don't contain the commit (HEAD if omitted)",
    ),
    Argument(
        "--merged",
        action="append",
        nargs="?",
        attached_only=True,
        metavar="commit",
        help="List only refs reachable from the commit (HEAD if omitted)",
    ),
    Argument(
        "--no-merged",
        action="append",
        nargs="?",
        attached_only=True,
        metavar="commit",
        help="List only refs not reachable from the commit (HEAD if omitted)",
    ),
    Argument(
        "--points-at",
        action="append",
        metavar="object",
        help="List only refs that point at the object",
    ),
)

# git's ref-format options, which `for-each-ref`, `branch` and `tag`
# share. --sort repeats, the last key given sorting first, and --no-sort
# drops every key before it, the default refname included.
FORMAT_OPTION_REF = Argument(
    "--format",
    metavar="format",
    help="Format each ref: %(fieldname) placeholders, as git for-each-ref",
)
SORT_OPTIONS = (
    Argument(
        "--sort",
        action="append",
        metavar="key",
        help="Sort on a field, - reversing it and version: "
        "comparing as versions",
    ),
    Argument(
        "--no-sort",
        action="store_true",
        help="Drop the sort keys given so far",
    ),
)
OMIT_EMPTY_OPTION = Argument(
    "--omit-empty",
    action="store_true",
    help="Print nothing, not even a newline, for an empty row",
)
IGNORE_CASE_OPTION = Argument(
    "-i",
    "--ignore-case",
    action="store_true",
    help="Sort and match patterns case-insensitively",
)

FOR_EACH_REF_OPTIONS = (
    Argument(
        "-s",
        "--shell",
        action="store_true",
        help="Quote fields suitably for shells",
    ),
    Argument(
        "-p",
        "--perl",
        action="store_true",
        help="Quote fields suitably for perl",
    ),
    Argument(
        "--python",
        action="store_true",
        help="Quote fields suitably for python",
    ),
    Argument(
        "--tcl", action="store_true", help="Quote fields suitably for Tcl"
    ),
    OMIT_EMPTY_OPTION,
    Argument(
        "--count", type="int", metavar="n", help="Show only the first <n> refs"
    ),
    FORMAT_OPTION_REF,
    Argument(
        "--exclude",
        action="append",
        metavar="pattern",
        help="Leave out refs matching the pattern",
    ),
    *SORT_OPTIONS,
    *REF_FILTER_OPTIONS,
    Argument(
        "--ignore-case",
        action="store_true",
        help="Sort and match patterns case-insensitively",
    ),
    Argument(
        "--stdin", action="store_true", help="Read ref patterns from stdin"
    ),
    Argument(
        "--include-root-refs",
        action="store_true",
        help="Also list HEAD and the other root refs",
    ),
)

BRANCH_OPTIONS = (
    Argument(
        "--show-current",
        action="store_true",
        help="Show the current branch name",
    ),
    Argument(
        "-q", "--quiet", action="store_true", help="Suppress feedback messages"
    ),
    Argument(
        "-v",
        "--verbose",
        action="count",
        help="Show commit and upstream details",
    ),
    Argument(
        "-a",
        action="store_true",
        help="List local and remote-tracking branches",
    ),
    Argument("-r", action="store_true", help="List remote-tracking branches"),
    Argument(
        "-d",
        "--delete",
        action="store_true",
        help="Delete a fully merged branch",
    ),
    Argument(
        "-D", action="store_true", help="Delete a branch even if not merged"
    ),
    Argument(
        "-l",
        "--list",
        action="store_true",
        help="List branches matching the patterns",
    ),
    *REF_FILTER_OPTIONS,
    *SORT_OPTIONS,
    FORMAT_OPTION_REF,
    OMIT_EMPTY_OPTION,
    IGNORE_CASE_OPTION,
)

PATHSPEC = Argument("text", nargs="*", metavar="")

ADD_OPTIONS = (
    Argument("-A", "--all", action="store_true", help="Stage every change"),
    Argument(
        "-u",
        "--update",
        action="store_true",
        help="Stage changes to tracked files only",
    ),
    Argument(
        "-f",
        "--force",
        action="store_true",
        help="Stage paths an ignore rule covers",
    ),
    Argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Name each path as it is added or removed",
    ),
)

COMMIT_OPTIONS = (
    Argument(
        "-q", "--quiet", action="store_true", help="Suppress feedback messages"
    ),
    Argument(
        "-a",
        "--all",
        action="store_true",
        help="Stage modified and deleted tracked files first",
    ),
    # Required, not defaulted: git would open an editor without it, and
    # a mount has none to open.
    Argument("-m", "--message", help="Commit message"),
    Argument("--author", help="Override the recorded author"),
    Argument(
        "--allow-empty",
        action="store_true",
        help="Record a commit that changes nothing from its parent",
    ),
)

CHECKOUT_OPTIONS = (
    Argument(
        "-b", action="store_true", help="Create the branch and switch to it"
    ),
    Argument(
        "--detach", action="store_true", help="Leave HEAD on the commit itself"
    ),
    Argument(
        "-q", "--quiet", action="store_true", help="Suppress feedback messages"
    ),
)

SWITCH_OPTIONS = (
    Argument(
        "-q", "--quiet", action="store_true", help="Suppress feedback messages"
    ),
    Argument("-c", "--create", help="Create the branch and switch to it"),
    Argument(
        "-d",
        "--detach",
        action="store_true",
        help="Detach HEAD at the named commit",
    ),
)

RESTORE_OPTIONS = (
    Argument("-S", "--staged", action="store_true", help="Restore the index"),
    Argument(
        "-W",
        "--worktree",
        action="store_true",
        help="Restore the working tree (default)",
    ),
    Argument("-s", "--source", help="Which tree-ish to restore from"),
)

RM_OPTIONS = (
    Argument("-r", action="store_true", help="Allow recursive removal"),
    Argument(
        "--cached",
        action="store_true",
        help="Only remove from the index, keeping the file",
    ),
    Argument(
        "-f",
        "--force",
        action="store_true",
        help="Override the up-to-date check",
    ),
    Argument(
        "-q", "--quiet", action="store_true", help="Do not list removed files"
    ),
    Argument(
        "--ignore-unmatch",
        action="store_true",
        help="Exit with a zero status even if nothing matched",
    ),
)

MV_OPTIONS = (
    Argument(
        "-f",
        "--force",
        action="store_true",
        help="Force move/rename even if target exists",
    ),
    Argument("-k", action="store_true", help="Skip move/rename errors"),
    Argument("-n", "--dry-run", action="store_true", help="Dry run"),
    Argument("-v", "--verbose", action="store_true", help="Be verbose"),
)

TAG_OPTIONS = (
    Argument("-l", "--list", action="store_true", help="List tag names"),
    # git spells the count attached (`-n2`) or not at all, never as a
    # separate token, which is what value_optional says: a bare -n means
    # one line and the next word is left alone to be a pattern.
    Argument(
        "-n",
        type="int",
        nargs="?",
        attached_only=True,
        help="Print <n> lines of each tag message",
    ),
    Argument("-d", "--delete", action="store_true", help="Delete tags"),
    Argument(
        "-a",
        "--annotate",
        action="store_true",
        help="Annotated tag, needs a message",
    ),
    Argument(
        "-m",
        "--message",
        action="append",
        help="Tag message (repeatable, one paragraph each)",
    ),
    Argument(
        "-f", "--force", action="store_true", help="Replace the tag if exists"
    ),
    *REF_FILTER_OPTIONS,
    *SORT_OPTIONS,
    FORMAT_OPTION_REF,
    OMIT_EMPTY_OPTION,
    IGNORE_CASE_OPTION,
)

STATUS_OPTIONS = (
    Argument("--ignored", action="store_true", help="Show ignored files"),
    Argument(
        "--porcelain",
        nargs="?",
        attached_only=True,
        help="Machine-readable output, stable across versions",
    ),
    Argument(
        "-s",
        "--short",
        action="store_true",
        help="Give the output in the short format",
    ),
    Argument(
        "-b",
        "--branch",
        action="store_true",
        help="Show the branch line even in short format",
    ),
    # git spells the mode attached (`-uall`) or not at all, never as a
    # separate token, which is what value_optional says: a bare -u means
    # "all" and the next word is left alone to be an operand.
    Argument(
        "-u",
        "--untracked-files",
        nargs="?",
        attached_only=True,
        choices=("no", "normal", "all"),
        help="Show untracked files: no, normal or all",
    ),
)


async def help_cmd(
    inv: CLIInvocation[None],
) -> tuple[ByteSource | None, IOResult]:
    """Render the declared command tree, without needing a repository.

    Args:
        inv (CLIInvocation[None]): optional command to describe.
    """
    try:
        check_switches(inv, inv.texts)
    except GitError as exc:
        return fatal(exc)
    found = find_node(GIT.spec, inv.texts)
    if found is None:
        return None, IOResult(
            exit_code=1,
            stderr=(
                f"git: '{' '.join(inv.texts)}' is not a git command. "
                "See 'git --help'.\n"
            ).encode(),
        )
    node, path = found
    return node_help(
        " ".join(("git", *path)), node, GIT.spec.usage_style
    ).encode(), IOResult()


# The git program tree. No config_model: local git needs no credentials,
# which is what makes it installable with a bare `cli: git`.
GIT = CLI(
    spec=CommandSpec(
        name="git",
        description="Content tracker",
        usage_style=UsageStyle.GIT,
        operand_base="-C",
        subcommands=(
            CommandSpec(
                name="reflog",
                description="Show reference history",
                arguments=(
                    Argument(
                        "-n",
                        "--max-count",
                        type="int",
                        numeric_shorthand=True,
                        help="Limit the number of entries",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="for-each-ref",
                description="List references with a format",
                arguments=(
                    *FOR_EACH_REF_OPTIONS,
                    REVISION,
                ),
            ),
            CommandSpec(
                name="cat-file",
                description="Provide contents or details of repository objects",
                arguments=(
                    Argument(
                        "-t", action="store_true", help="Show the object type"
                    ),
                    Argument(
                        "-s", action="store_true", help="Show the object size"
                    ),
                    Argument(
                        "-e",
                        action="store_true",
                        help="Check if <object> exists",
                    ),
                    Argument(
                        "-p",
                        action="store_true",
                        help="Pretty-print <object> content",
                    ),
                    Argument(
                        "--batch",
                        nargs="?",
                        attached_only=True,
                        help="Show full <object> or <rev> contents",
                    ),
                    Argument(
                        "--batch-check",
                        nargs="?",
                        attached_only=True,
                        help="Like --batch, but don't emit <contents>",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="hash-object",
                description="Compute object ID and optionally create an object "
                "from a file",
                arguments=(
                    Argument("-t", help="Object type"),
                    Argument(
                        "-w",
                        action="store_true",
                        help="Write the object into the object database",
                    ),
                    Argument(
                        "--stdin",
                        action="store_true",
                        help="Read the object from stdin",
                    ),
                    Argument(
                        "--stdin-paths",
                        action="store_true",
                        help="Read file names from stdin",
                    ),
                    Argument(
                        "--no-filters",
                        action="store_true",
                        help="Store file as is without filters",
                    ),
                    Argument(
                        "--literally",
                        action="store_true",
                        help="Just hash any random garbage to create "
                        "corrupt objects for debugging Git",
                    ),
                    Argument(
                        "--path",
                        help="Process file as it were from this path",
                    ),
                    PATHSPEC,
                ),
            ),
            CommandSpec(
                name="grep",
                description=(
                    "Search tracked files in the working tree, "
                    "index or named trees"
                ),
                arguments=(
                    Argument(
                        "--cached",
                        action="store_true",
                        help="Search index blobs instead of working files",
                    ),
                    Argument(
                        "-n",
                        "--line-number",
                        action="store_true",
                        help="Show line numbers",
                    ),
                    Argument(
                        "-i",
                        "--ignore-case",
                        action="store_true",
                        help="Match without regard to case",
                    ),
                    Argument(
                        "-F",
                        "--fixed-strings",
                        action="store_true",
                        help="Match literal strings",
                    ),
                    Argument(
                        "-E",
                        "--extended-regexp",
                        action="store_true",
                        help="Use extended regular expressions",
                    ),
                    Argument(
                        "-G",
                        "--basic-regexp",
                        action="store_true",
                        help="Use basic regular expressions",
                    ),
                    Argument(
                        "-w",
                        "--word-regexp",
                        action="store_true",
                        help="Match at word boundaries",
                    ),
                    Argument(
                        "-v",
                        "--invert-match",
                        action="store_true",
                        help="Select nonmatching lines",
                    ),
                    Argument(
                        "-c",
                        "--count",
                        action="store_true",
                        help="Count selected lines in each matching file",
                    ),
                    Argument(
                        "-l",
                        "--files-with-matches",
                        action="store_true",
                        help="Show only matching filenames",
                    ),
                    Argument(
                        "-L",
                        "--files-without-match",
                        action="store_true",
                        help="Show only nonmatching filenames",
                    ),
                    Argument(
                        "-q",
                        "--quiet",
                        action="store_true",
                        help="Report matches through exit status",
                    ),
                    Argument(
                        "-e",
                        action="append",
                        help="Match an additional pattern",
                    ),
                    Argument(
                        "-a",
                        "--text",
                        action="store_true",
                        help="Treat binary files as text",
                    ),
                    Argument(
                        "-I", action="store_true", help="Skip binary files"
                    ),
                    Argument(
                        "-z",
                        "--null",
                        action="store_true",
                        help="Terminate filename fields with NUL",
                    ),
                    Argument(
                        "-h",
                        action="store_true",
                        help="Omit filenames from matching lines",
                    ),
                    Argument(
                        "-H",
                        action="store_true",
                        help="Show filenames with matching lines",
                    ),
                    Argument("texts", nargs="REMAINDER", metavar=""),
                ),
            ),
            CommandSpec(
                name="ls-tree",
                description="List the contents of a tree object",
                arguments=(
                    Argument(
                        "-r", action="store_true", help="Recurse into subtrees"
                    ),
                    Argument(
                        "-t",
                        action="store_true",
                        help="Show trees when recursing",
                    ),
                    Argument(
                        "-d", action="store_true", help="Only show trees"
                    ),
                    Argument(
                        "-z",
                        action="store_true",
                        help="Terminate entries with NUL",
                    ),
                    Argument(
                        "--name-only",
                        action="store_true",
                        help="Show only filenames",
                    ),
                    Argument(
                        "--name-status",
                        action="store_true",
                        help="Alias of --name-only",
                    ),
                    Argument(
                        "--full-name",
                        action="store_true",
                        help="Show paths relative to the repository root",
                    ),
                    Argument(
                        "--full-tree",
                        action="store_true",
                        help="List the whole tree, ignoring the current directory",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="ls-files",
                description="Show files in the index",
                arguments=(
                    Argument(
                        "-z",
                        action="store_true",
                        help="Terminate paths with NUL",
                    ),
                    Argument(
                        "-s",
                        "--stage",
                        action="store_true",
                        help="Show staged object metadata",
                    ),
                    Argument(
                        "-c",
                        "--cached",
                        action="store_true",
                        help="Show cached files",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="fetch",
                description="Download objects and refs from another repository",
                arguments=(
                    Argument(
                        "-q",
                        "--quiet",
                        action="store_true",
                        help="Print nothing but errors",
                    ),
                    Argument(
                        "-v",
                        "--verbose",
                        action="store_true",
                        help="Also list unchanged refs",
                    ),
                    Argument(
                        "-p",
                        "--prune",
                        action="store_true",
                        help="Remove remote-tracking refs the "
                        "remote no longer has",
                    ),
                    Argument(
                        "-t",
                        "--tags",
                        action="store_true",
                        help="Fetch every tag",
                    ),
                    Argument(
                        "-n",
                        "--no-tags",
                        action="store_true",
                        help="Follow no tags",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="clone",
                description="Clone a repository into a new directory",
                arguments=(
                    Argument(
                        "-q",
                        "--quiet",
                        action="store_true",
                        help="Print nothing but errors",
                    ),
                    Argument(
                        "-b",
                        "--branch",
                        help="Check out this branch or tag",
                    ),
                    Argument(
                        "-o",
                        "--origin",
                        help="Name the remote this instead of origin",
                    ),
                    Argument(
                        "-n",
                        "--no-checkout",
                        action="store_true",
                        help="Leave the working tree empty",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="help",
                description="Show command help",
                arguments=(Argument("texts", nargs="*", metavar=""),),
            ),
            CommandSpec(
                name="init",
                description="Create an empty Git repository or reinitialize an "
                "existing one",
                arguments=(
                    Argument("-q", "--quiet", action="store_true"),
                    Argument("--bare", action="store_true"),
                    Argument("-b", "--initial-branch"),
                    Argument("directory", nargs="?"),
                ),
            ),
            CommandSpec(
                name="fsck",
                description="Verify object hashes and connectivity",
                arguments=(
                    Argument("--full", action="store_true"),
                    Argument("--no-dangling", action="store_true"),
                    Argument("--unreachable", action="store_true"),
                ),
            ),
            CommandSpec(
                name="stash",
                description="Inspect saved working trees",
                subcommands=(
                    CommandSpec(
                        name="list", description="List stashed changes"
                    ),
                    CommandSpec(
                        name="show",
                        description="Show stashed changes",
                        arguments=(
                            *DIFF_OPTIONS,
                            Argument("stash", nargs="?"),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="version",
                aliases=("--version", "-v"),
                description="Show the Mirage Git implementation version",
            ),
            CommandSpec(
                name="remote",
                description="List remotes and inspect their URLs",
                arguments=(
                    Argument("texts", nargs="REMAINDER", metavar=""),
                    Argument(
                        "-v",
                        "--verbose",
                        action="store_true",
                        help="Show remote URLs",
                    ),
                ),
            ),
            CommandSpec(
                name="config",
                description="Read repository configuration",
                arguments=(
                    Argument(
                        "--global",
                        action="store_true",
                        help="Read global configuration",
                    ),
                    Argument(
                        "--get",
                        action="store_true",
                        help="Get a configuration value",
                    ),
                    Argument(
                        "-l",
                        "--list",
                        action="store_true",
                        help="List every variable and value",
                    ),
                    Argument(
                        "--show-origin",
                        action="store_true",
                        help="Show the file each value comes from",
                    ),
                    Argument(
                        "--get-regexp",
                        action="store_true",
                        help="Get the variables whose names "
                        "match a regular expression",
                    ),
                    Argument("name", nargs="?"),
                    Argument("value", nargs="?"),
                    Argument("value-pattern", nargs="?"),
                ),
            ),
            CommandSpec(
                name="merge-base",
                description="Find best common ancestors of commits",
                arguments=(
                    Argument(
                        "-a",
                        "--all",
                        action="store_true",
                        help="Show all best common ancestors",
                    ),
                    Argument(
                        "--is-ancestor",
                        action="store_true",
                        help="Test whether the first commit is an ancestor "
                        "of the second",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="show-ref",
                description="List references",
                arguments=(REVISION,),
            ),
            # symbolic-ref has every option git's has, so its rows carry git's
            # own help and its usage block reads exactly as git's.
            CommandSpec(
                name="symbolic-ref",
                description="Read, change or delete a symbolic ref",
                arguments=(
                    Argument(
                        "-q",
                        "--quiet",
                        action="store_true",
                        help="suppress error message for non-symbolic "
                        "(detached) refs",
                    ),
                    Argument(
                        "--no-quiet",
                        action="store_true",
                        help="Refuse a ref that is not symbolic aloud",
                    ),
                    Argument(
                        "-d",
                        "--delete",
                        action="store_true",
                        help="delete symbolic ref",
                    ),
                    Argument(
                        "--no-delete",
                        action="store_true",
                        help="Read or change the ref instead",
                    ),
                    Argument(
                        "--short",
                        action="store_true",
                        help="shorten ref output",
                    ),
                    Argument(
                        "--no-short",
                        action="store_true",
                        help="Print the full name it points at",
                    ),
                    Argument(
                        "--recurse",
                        action="store_true",
                        help="recursively dereference (default)",
                    ),
                    Argument(
                        "--no-recurse",
                        action="store_true",
                        help="Print only the ref this one points at directly",
                    ),
                    Argument(
                        "-m",
                        metavar="reason",
                        help="reason of the update",
                    ),
                    Argument("texts", nargs="*", metavar=""),
                ),
            ),
            # shortlog's -n is --numbered, so the count keeps only its long
            # spelling.
            CommandSpec(
                name="shortlog",
                description="Summarize commit history",
                arguments=(
                    *(opt for opt in LOG_OPTIONS if "-n" not in opt.names),
                    Argument(
                        "--max-count",
                        type="int",
                        help="Limit the number of commits",
                    ),
                    Argument(
                        "-s",
                        "--summary",
                        action="store_true",
                        help="Show only commit counts",
                    ),
                    Argument(
                        "-e",
                        "--email",
                        action="store_true",
                        help="Show author email addresses",
                    ),
                    Argument(
                        "-n",
                        "--numbered",
                        action="store_true",
                        help="Sort by commit count",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="rev-parse",
                description="Resolve revisions",
                arguments=(
                    Argument(
                        "--show-toplevel",
                        action="store_true",
                        help="Show the worktree root",
                    ),
                    Argument(
                        "--abbrev-ref",
                        nargs="?",
                        attached_only=True,
                        help="Show abbreviated reference names, strict or loose",
                    ),
                    Argument(
                        "--show-prefix",
                        action="store_true",
                        help="Show the current directory relative to the "
                        "worktree root",
                    ),
                    Argument(
                        "--is-shallow-repository",
                        action="store_true",
                        help="Print whether the repository is shallow",
                    ),
                    Argument(
                        "--is-inside-work-tree",
                        action="store_true",
                        help="Print whether the current directory is "
                        "inside the work tree",
                    ),
                    Argument(
                        "--verify",
                        action="store_true",
                        help="Require exactly one revision that names an object",
                    ),
                    Argument(
                        "--short",
                        nargs="?",
                        attached_only=True,
                        help="Abbreviate the object name; implies --verify",
                    ),
                    Argument(
                        "-q",
                        "--quiet",
                        action="store_true",
                        help="With --verify, exit 1 without a message",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="rev-list",
                description="List reachable commits",
                arguments=(
                    *LOG_OPTIONS,
                    Argument(
                        "--count",
                        action="store_true",
                        help="Print commit count",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="diff-tree",
                description="Compare a commit with its parent",
                arguments=(
                    *SHOW_OPTIONS,
                    Argument(
                        "--no-commit-id",
                        action="store_true",
                        help="Suppress commit ID",
                    ),
                    Argument(
                        "-r", action="store_true", help="Recurse into subtrees"
                    ),
                    Argument("commit"),
                    PATHSPEC,
                ),
            ),
            CommandSpec(
                name="status",
                description="Show the working tree status",
                arguments=(*STATUS_OPTIONS,),
            ),
            CommandSpec(
                name="log",
                description="Show commit logs",
                arguments=(
                    *LOG_OPTIONS,
                    *MAILMAP_OPTIONS,
                    *DIFF_OPTIONS,
                    REVISION,
                ),
            ),
            CommandSpec(
                name="show",
                description="Show a commit and its diff",
                arguments=(
                    *SHOW_OPTIONS,
                    *DECORATE_OPTIONS,
                    REVISION,
                ),
            ),
            CommandSpec(
                name="diff",
                description="Show changes between commits",
                arguments=(
                    *DIFF_OPTIONS,
                    Argument(
                        "--cached",
                        action="store_true",
                        help="Compare the index with a commit",
                    ),
                    Argument(
                        "--staged",
                        action="store_true",
                        help="Alias of --cached",
                    ),
                    REVISION,
                ),
            ),
            CommandSpec(
                name="branch",
                description="List, create or delete branches",
                arguments=(
                    *BRANCH_OPTIONS,
                    Argument("texts", nargs="*", metavar=""),
                ),
            ),
            CommandSpec(
                name="add",
                description="Stage working tree content",
                arguments=(
                    *ADD_OPTIONS,
                    PATHSPEC,
                ),
            ),
            CommandSpec(
                name="reset",
                description="Unstage, putting the index back to HEAD",
                arguments=(
                    Argument(
                        "-q",
                        "--quiet",
                        action="store_true",
                        help="Only report errors",
                    ),
                    PATHSPEC,
                ),
            ),
            CommandSpec(
                name="commit",
                description="Record the index as a new commit",
                arguments=(*COMMIT_OPTIONS,),
            ),
            CommandSpec(
                name="checkout",
                description="Switch branches",
                arguments=(
                    *CHECKOUT_OPTIONS,
                    REVISION,
                ),
            ),
            CommandSpec(
                name="switch",
                description="Switch branches",
                arguments=(
                    *SWITCH_OPTIONS,
                    REVISION,
                ),
            ),
            CommandSpec(
                name="restore",
                description="Restore working tree files",
                arguments=(
                    *RESTORE_OPTIONS,
                    PATHSPEC,
                ),
            ),
            CommandSpec(
                name="rm",
                description="Remove files from the working tree and the index",
                arguments=(
                    *RM_OPTIONS,
                    PATHSPEC,
                ),
            ),
            CommandSpec(
                name="mv",
                description="Move or rename a file, a directory, or a symlink",
                arguments=(
                    *MV_OPTIONS,
                    PATHSPEC,
                ),
            ),
            CommandSpec(
                name="tag",
                description="Create, list or delete a tag",
                arguments=(
                    *TAG_OPTIONS,
                    Argument("texts", nargs="*", metavar=""),
                ),
            ),
        ),
        arguments=(
            DIRECTORY_OPTION,
            Argument(
                "--git-dir",
                type="path",
                env="GIT_DIR",
                help="Use the repository at <path>",
            ),
            Argument(
                "--work-tree",
                type="path",
                env="GIT_WORK_TREE",
                help="Use <path> as the working tree",
            ),
        ),
    ),
    handlers={
        "reflog": CLIHandler(fn=verb(reflog)),
        "for-each-ref": CLIHandler(fn=verb(for_each_ref)),
        "cat-file": CLIHandler(fn=verb(cat_file)),
        "hash-object": CLIHandler(fn=verb(hash_object, hash_object_read_only)),
        "grep": CLIHandler(fn=verb(grep)),
        "ls-tree": CLIHandler(fn=verb(ls_tree)),
        "ls-files": CLIHandler(fn=verb(ls_files)),
        "fetch": CLIHandler(fn=verb(fetch, fetch_read_only)),
        "clone": CLIHandler(fn=verb(clone, clone_read_only)),
        "help": CLIHandler(fn=verb(help_cmd)),
        "init": CLIHandler(fn=verb(init), write=True),
        "fsck": CLIHandler(fn=verb(fsck)),
        "stash list": CLIHandler(fn=verb(stash_list)),
        "stash show": CLIHandler(fn=verb(stash_show)),
        "version": CLIHandler(fn=verb(version)),
        "remote": CLIHandler(fn=verb(remote)),
        "config": CLIHandler(fn=verb(config)),
        "merge-base": CLIHandler(fn=verb(merge_base)),
        "show-ref": CLIHandler(fn=verb(show_ref)),
        "symbolic-ref": CLIHandler(
            fn=verb(symbolic_ref, symbolic_ref_read_only), write=True
        ),
        "shortlog": CLIHandler(fn=verb(shortlog)),
        "rev-parse": CLIHandler(fn=verb(rev_parse)),
        "rev-list": CLIHandler(fn=verb(rev_list)),
        "diff-tree": CLIHandler(fn=verb(diff_tree)),
        "status": CLIHandler(fn=verb(status)),
        "log": CLIHandler(fn=verb(log)),
        "show": CLIHandler(fn=verb(show)),
        "diff": CLIHandler(fn=verb(diff)),
        "branch": CLIHandler(fn=verb(branch, branch_read_only), write=True),
        "add": CLIHandler(fn=verb(add, index_locked), write=True),
        "reset": CLIHandler(fn=verb(reset, index_locked), write=True),
        "commit": CLIHandler(fn=verb(commit, index_locked), write=True),
        "checkout": CLIHandler(
            fn=verb(checkout, checkout_read_only), write=True
        ),
        "switch": CLIHandler(fn=verb(switch, switch_read_only), write=True),
        "restore": CLIHandler(fn=verb(restore, index_locked), write=True),
        "rm": CLIHandler(fn=verb(rm, index_locked), write=True),
        "mv": CLIHandler(fn=verb(mv, index_locked), write=True),
        "tag": CLIHandler(fn=verb(tag, tag_read_only), write=True),
    },
)
