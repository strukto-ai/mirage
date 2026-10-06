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
from mirage.commands.cli.builtin.git.init import init
from mirage.commands.cli.builtin.git.inspect import (
    config,
    remote,
    rev_list,
    rev_parse,
    show_ref,
    version,
)
from mirage.commands.cli.builtin.git.log import log
from mirage.commands.cli.builtin.git.ls_files import ls_files
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
from mirage.commands.cli.types import CLIInvocation, CLISpec, UsageStyle
from mirage.commands.cli.walk import find_node, node_help
from mirage.commands.spec.types import Operand, Option
from mirage.io.types import ByteSource, IOResult

# `-C` is git's own before-anything-else option, so it sits on the root
# and every verb inherits it. The "." default is load-bearing: a PATH
# default lands as if typed, so an absent -C resolves to the session cwd
# and the leaves need no separate working-directory fact. The root names it
# its operand base, so a later relative -C lands under the one before it.
DIRECTORY_OPTION = Option(
    short="-C",
    type="path",
    default=".",
    description="Run as if git was started in <path>",
)

REVISION = Operand(type="str")

# --pretty and --format set the same variable in git; both take git's
# optional-value form, so a bare --pretty means medium and a detached
# next word is a revision, never a format. A bare --format stays
# parseable too, but only so pretty_format can answer it with git's own
# fatal (pretty.c reads --format in its =value form alone).
PRETTY_OPTION = Option(
    long="--pretty",
    type="str",
    value_optional=True,
    description="Commit display format: oneline, short, "
    "medium, full, fuller, or a format:/tformat:/%-string",
)
FORMAT_OPTION = Option(
    long="--format",
    type="str",
    value_optional=True,
    description="Alias of --pretty (requires =value)",
)

# Free text, read by parse_date_mode: git names a style it lacks in its
# own fatal, and format:<strftime> is no fixed word.
DATE_OPTION = Option(
    long="--date",
    type="str",
    description="Date display format: default, relative, "
    "local, iso, iso-strict, rfc, short, raw, unix, human "
    "or format:<strftime>",
)

DIFF_OPTIONS = (
    Option(
        short="-W",
        long="--function-context",
        description="Show whole functions as diff context",
    ),
    Option(
        short="-U",
        long="--unified",
        type="int",
        description="Number of context lines",
    ),
    Option(long="--name-status", description="Show changed paths and status"),
    Option(
        long="--name-only",
        description="Show changed paths instead of the patch",
    ),
    Option(
        long="--stat",
        description="Show the diffstat table instead of the patch",
    ),
    Option(
        long="--numstat",
        description="Show added and deleted line counts per path",
    ),
    Option(
        long="--shortstat", description="Show only the diffstat summary line"
    ),
    Option(
        long="--summary",
        description="Summarize creations, deletions and mode changes",
    ),
    Option(short="-p", long="--patch", description="Show the patch"),
    Option(
        short="-s", long="--no-patch", description="Suppress all diff output"
    ),
    Option(
        long="--no-ext-diff",
        description="Accepted for compatibility; there are no external "
        "diff drivers to disable",
    ),
    Option(
        short="-M",
        long="--find-renames",
        type="str",
        value_optional=True,
        description="Detect renames with an optional similarity threshold",
    ),
    Option(long="--no-renames", description="Turn off rename detection"),
    Option(long="--raw", description="Show the raw diff format"),
)

# git's optional-value form: a bare --decorate is short, and a detached
# next word is a revision, never a style.
DECORATE_OPTIONS = (
    Option(
        long="--decorate",
        type="str",
        value_optional=True,
        description="Print ref names on commits: short (the default), full, "
        "auto or no",
    ),
    Option(long="--no-decorate", description="Print no ref names on commits"),
)

MERGE_OPTIONS = (
    Option(
        short="-m",
        description="Show merge diffs separately against each parent",
    ),
    Option(short="-c", description="Show combined merge diffs"),
    Option(long="--cc", description="Show dense combined merge diffs"),
    Option(
        long="--first-parent",
        description="Follow and compare only the first parent",
    ),
    Option(
        long="--diff-merges", type="str", description="Select merge diff mode"
    ),
)

LOG_OPTIONS = (
    Option(
        short="-E",
        long="--extended-regexp",
        description="Use extended regular expressions",
    ),
    Option(
        short="-F",
        long="--fixed-strings",
        description="Match patterns literally",
    ),
    Option(
        short="-P",
        long="--perl-regexp",
        description="Use Perl-compatible regular expressions",
    ),
    Option(long="--basic-regexp", description="Use basic regular expressions"),
    Option(
        long="--committer",
        type="str",
        multiple=True,
        description="Limit commits to matching committers",
    ),
    Option(
        long="--author",
        type="str",
        multiple=True,
        description="Limit commits to matching authors",
    ),
    Option(
        long="--grep",
        type="str",
        multiple=True,
        description="Limit commits to ones with a message line that matches",
    ),
    Option(
        short="-i",
        long="--regexp-ignore-case",
        description="Match --grep, --author and -S without regard to case",
    ),
    *MERGE_OPTIONS,
    Option(
        long="--after",
        type="str",
        description="Commits more recent than a date, like --since",
    ),
    Option(
        long="--before",
        type="str",
        description="Commits older than a date, like --until",
    ),
    Option(
        long="--max-parents",
        type="int",
        description="Show only commits with at most this many parents",
    ),
    Option(
        long="--min-parents",
        type="int",
        description="Show only commits with at least this many parents",
    ),
    Option(long="--merges", description="Show only merge commits"),
    Option(long="--no-merges", description="Leave out merge commits"),
    DATE_OPTION,
    *DECORATE_OPTIONS,
    Option(
        short="-n",
        long="--max-count",
        type="int",
        numeric_shorthand=True,
        description="Limit the number of commits shown",
    ),
    Option(long="--oneline", description="One abbreviated line per commit"),
    Option(long="--reverse", description="Print commits oldest first"),
    Option(
        long="--graph",
        description="Draw the commit history beside the log "
        "(implies --topo-order)",
    ),
    Option(
        long="--topo-order",
        description="Show no parent before all its children, one line "
        "of history at a time",
    ),
    Option(
        long="--date-order",
        description="Show no parent before all its children, otherwise "
        "newest first",
    ),
    Option(
        long="--all",
        description="Start from every ref as well as the revision",
    ),
    PRETTY_OPTION,
    FORMAT_OPTION,
    # The pickaxe, and the reason `git log -S <name> --reverse` answers
    # "which commit introduced this": it selects commits that changed
    # how many times the string occurs, not commits that mention it.
    Option(
        short="-S",
        type="str",
        description="Show commits that change the number of occurrences "
        "of the string",
    ),
    Option(
        long="--since",
        type="str",
        description="Commits more recent than a date (ISO-8601 or epoch)",
    ),
    Option(
        long="--until",
        type="str",
        description="Commits older than a date (ISO-8601 or epoch)",
    ),
)

MAILMAP_OPTIONS = (
    Option(long="--mailmap", description="Apply mailmap to identities"),
    Option(long="--use-mailmap", description="Apply mailmap to identities"),
    Option(long="--no-mailmap", description="Use recorded identities"),
    Option(long="--no-use-mailmap", description="Use recorded identities"),
)

SHOW_OPTIONS = (
    *MAILMAP_OPTIONS,
    Option(long="--oneline", description="One abbreviated line per commit"),
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
    Option(
        long="--contains",
        type="str",
        value_optional=True,
        multiple=True,
        metavar="commit",
        description="List only refs that contain the commit (HEAD if omitted)",
    ),
    Option(
        long="--no-contains",
        type="str",
        value_optional=True,
        multiple=True,
        metavar="commit",
        description="List only refs that don't contain the commit "
        "(HEAD if omitted)",
    ),
    Option(
        long="--merged",
        type="str",
        value_optional=True,
        multiple=True,
        metavar="commit",
        description="List only refs reachable from the commit (HEAD if "
        "omitted)",
    ),
    Option(
        long="--no-merged",
        type="str",
        value_optional=True,
        multiple=True,
        metavar="commit",
        description="List only refs not reachable from the commit (HEAD "
        "if omitted)",
    ),
    Option(
        long="--points-at",
        type="str",
        multiple=True,
        metavar="object",
        description="List only refs that point at the object",
    ),
)

# git's ref-format options, which `for-each-ref`, `branch` and `tag`
# share. --sort repeats, the last key given sorting first, and --no-sort
# drops every key before it, the default refname included.
FORMAT_OPTION_REF = Option(
    long="--format",
    type="str",
    metavar="format",
    description="Format each ref: %(fieldname) "
    "placeholders, as git for-each-ref",
)
SORT_OPTIONS = (
    Option(
        long="--sort",
        type="str",
        multiple=True,
        metavar="key",
        description="Sort on a field, - reversing it and version: "
        "comparing as versions",
    ),
    Option(long="--no-sort", description="Drop the sort keys given so far"),
)
OMIT_EMPTY_OPTION = Option(
    long="--omit-empty",
    description="Print nothing, not even a newline, for an empty row",
)
IGNORE_CASE_OPTION = Option(
    short="-i",
    long="--ignore-case",
    description="Sort and match patterns case-insensitively",
)

FOR_EACH_REF_OPTIONS = (
    Option(
        short="-s",
        long="--shell",
        description="Quote fields suitably for shells",
    ),
    Option(
        short="-p", long="--perl", description="Quote fields suitably for perl"
    ),
    Option(long="--python", description="Quote fields suitably for python"),
    Option(long="--tcl", description="Quote fields suitably for Tcl"),
    OMIT_EMPTY_OPTION,
    Option(
        long="--count",
        type="int",
        metavar="n",
        description="Show only the first <n> refs",
    ),
    FORMAT_OPTION_REF,
    Option(
        long="--exclude",
        type="str",
        multiple=True,
        metavar="pattern",
        description="Leave out refs matching the pattern",
    ),
    *SORT_OPTIONS,
    *REF_FILTER_OPTIONS,
    Option(
        long="--ignore-case",
        description="Sort and match patterns case-insensitively",
    ),
    Option(long="--stdin", description="Read ref patterns from stdin"),
    Option(
        long="--include-root-refs",
        description="Also list HEAD and the other root refs",
    ),
)

BRANCH_OPTIONS = (
    Option(long="--show-current", description="Show the current branch name"),
    Option(
        short="-q", long="--quiet", description="Suppress feedback messages"
    ),
    Option(
        short="-v",
        long="--verbose",
        count=True,
        description="Show commit and upstream details",
    ),
    Option(short="-a", description="List local and remote-tracking branches"),
    Option(short="-r", description="List remote-tracking branches"),
    Option(
        short="-d", long="--delete", description="Delete a fully merged branch"
    ),
    Option(short="-D", description="Delete a branch even if not merged"),
    Option(
        short="-l",
        long="--list",
        description="List branches matching the patterns",
    ),
    *REF_FILTER_OPTIONS,
    *SORT_OPTIONS,
    FORMAT_OPTION_REF,
    OMIT_EMPTY_OPTION,
    IGNORE_CASE_OPTION,
)

PATHSPEC = Operand(type="str")

ADD_OPTIONS = (
    Option(short="-A", long="--all", description="Stage every change"),
    Option(
        short="-u",
        long="--update",
        description="Stage changes to tracked files only",
    ),
    Option(
        short="-f",
        long="--force",
        description="Stage paths an ignore rule covers",
    ),
    Option(
        short="-v",
        long="--verbose",
        description="Name each path as it is added or removed",
    ),
)

COMMIT_OPTIONS = (
    Option(
        short="-q", long="--quiet", description="Suppress feedback messages"
    ),
    Option(
        short="-a",
        long="--all",
        description="Stage modified and deleted tracked files first",
    ),
    # Required, not defaulted: git would open an editor without it, and
    # a mount has none to open.
    Option(
        short="-m", long="--message", type="str", description="Commit message"
    ),
    Option(
        long="--author", type="str", description="Override the recorded author"
    ),
    Option(
        long="--allow-empty",
        description="Record a commit that changes nothing from its parent",
    ),
)

CHECKOUT_OPTIONS = (
    Option(short="-b", description="Create the branch and switch to it"),
    Option(long="--detach", description="Leave HEAD on the commit itself"),
    Option(
        short="-q", long="--quiet", description="Suppress feedback messages"
    ),
)

SWITCH_OPTIONS = (
    Option(
        short="-q", long="--quiet", description="Suppress feedback messages"
    ),
    Option(
        short="-c",
        long="--create",
        type="str",
        description="Create the branch and switch to it",
    ),
    Option(
        short="-d",
        long="--detach",
        description="Detach HEAD at the named commit",
    ),
)

RESTORE_OPTIONS = (
    Option(short="-S", long="--staged", description="Restore the index"),
    Option(
        short="-W",
        long="--worktree",
        description="Restore the working tree (default)",
    ),
    Option(
        short="-s",
        long="--source",
        type="str",
        description="Which tree-ish to restore from",
    ),
)

RM_OPTIONS = (
    Option(short="-r", description="Allow recursive removal"),
    Option(
        long="--cached",
        description="Only remove from the index, keeping the file",
    ),
    Option(
        short="-f", long="--force", description="Override the up-to-date check"
    ),
    Option(
        short="-q", long="--quiet", description="Do not list removed files"
    ),
    Option(
        long="--ignore-unmatch",
        description="Exit with a zero status even if nothing matched",
    ),
)

MV_OPTIONS = (
    Option(
        short="-f",
        long="--force",
        description="Force move/rename even if target exists",
    ),
    Option(short="-k", description="Skip move/rename errors"),
    Option(short="-n", long="--dry-run", description="Dry run"),
    Option(short="-v", long="--verbose", description="Be verbose"),
)

TAG_OPTIONS = (
    Option(short="-l", long="--list", description="List tag names"),
    # git spells the count attached (`-n2`) or not at all, never as a
    # separate token, which is what value_optional says: a bare -n means
    # one line and the next word is left alone to be a pattern.
    Option(
        short="-n",
        type="int",
        value_optional=True,
        description="Print <n> lines of each tag message",
    ),
    Option(short="-d", long="--delete", description="Delete tags"),
    Option(
        short="-a",
        long="--annotate",
        description="Annotated tag, needs a message",
    ),
    Option(
        short="-m",
        long="--message",
        type="str",
        multiple=True,
        description="Tag message (repeatable, one paragraph each)",
    ),
    Option(
        short="-f", long="--force", description="Replace the tag if exists"
    ),
    *REF_FILTER_OPTIONS,
    *SORT_OPTIONS,
    FORMAT_OPTION_REF,
    OMIT_EMPTY_OPTION,
    IGNORE_CASE_OPTION,
)

STATUS_OPTIONS = (
    Option(long="--ignored", description="Show ignored files"),
    Option(
        long="--porcelain",
        type="str",
        value_optional=True,
        description="Machine-readable output, stable across versions",
    ),
    Option(
        short="-s",
        long="--short",
        description="Give the output in the short format",
    ),
    Option(
        short="-b",
        long="--branch",
        description="Show the branch line even in short format",
    ),
    # git spells the mode attached (`-uall`) or not at all, never as a
    # separate token, which is what value_optional says: a bare -u means
    # "all" and the next word is left alone to be an operand.
    Option(
        short="-u",
        long="--untracked-files",
        type="str",
        value_optional=True,
        choices=("no", "normal", "all"),
        description="Show untracked files: no, normal or all",
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
    found = find_node(GIT, inv.texts)
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
        " ".join(("git", *path)), node, GIT.usage_style
    ).encode(), IOResult()


# The git program tree. No config_model: local git needs no credentials,
# which is what makes it installable with a bare `cli: git`.
GIT = CLISpec(
    name="git",
    description="Content tracker",
    usage_style=UsageStyle.GIT,
    operand_base="-C",
    options=(
        DIRECTORY_OPTION,
        Option(
            long="--git-dir",
            type="path",
            env="GIT_DIR",
            description="Use the repository at <path>",
        ),
        Option(
            long="--work-tree",
            type="path",
            env="GIT_WORK_TREE",
            description="Use <path> as the working tree",
        ),
    ),
    subcommands=(
        CLISpec(
            name="reflog",
            fn=verb(reflog),
            description="Show reference history",
            options=(
                Option(
                    short="-n",
                    long="--max-count",
                    type="int",
                    numeric_shorthand=True,
                    description="Limit the number of entries",
                ),
            ),
            rest=REVISION,
        ),
        CLISpec(
            name="for-each-ref",
            fn=verb(for_each_ref),
            description="List references with a format",
            options=FOR_EACH_REF_OPTIONS,
            rest=REVISION,
        ),
        CLISpec(
            name="ls-files",
            fn=verb(ls_files),
            description="Show files in the index",
            options=(
                Option(short="-z", description="Terminate paths with NUL"),
                Option(
                    short="-s",
                    long="--stage",
                    description="Show staged object metadata",
                ),
                Option(
                    short="-c",
                    long="--cached",
                    description="Show cached files",
                ),
            ),
            rest=REVISION,
        ),
        CLISpec(
            name="fetch",
            fn=verb(fetch, fetch_read_only),
            description="Download objects and refs from another repository",
            options=(
                Option(
                    short="-q",
                    long="--quiet",
                    description="Print nothing but errors",
                ),
                Option(
                    short="-v",
                    long="--verbose",
                    description="Also list unchanged refs",
                ),
                Option(
                    short="-p",
                    long="--prune",
                    description="Remove remote-tracking refs the "
                    "remote no longer has",
                ),
                Option(
                    short="-t", long="--tags", description="Fetch every tag"
                ),
                Option(
                    short="-n", long="--no-tags", description="Follow no tags"
                ),
            ),
            rest=REVISION,
        ),
        CLISpec(
            name="clone",
            fn=verb(clone, clone_read_only),
            description="Clone a repository into a new directory",
            options=(
                Option(
                    short="-q",
                    long="--quiet",
                    description="Print nothing but errors",
                ),
                Option(
                    short="-b",
                    long="--branch",
                    type="str",
                    description="Check out this branch or tag",
                ),
                Option(
                    short="-o",
                    long="--origin",
                    type="str",
                    description="Name the remote this instead of origin",
                ),
                Option(
                    short="-n",
                    long="--no-checkout",
                    description="Leave the working tree empty",
                ),
            ),
            rest=REVISION,
        ),
        CLISpec(
            name="help",
            fn=verb(help_cmd),
            description="Show command help",
            rest=Operand(type="str"),
        ),
        CLISpec(
            name="init",
            fn=verb(init),
            description=(
                "Create an empty Git repository or reinitialize an "
                "existing one"
            ),
            write=True,
            options=(
                Option(short="-q", long="--quiet"),
                Option(long="--bare"),
                Option(short="-b", long="--initial-branch", type="str"),
            ),
            positional=(Operand(type="str", name="directory"),),
        ),
        CLISpec(
            name="fsck",
            fn=verb(fsck),
            description="Verify object hashes and connectivity",
            options=(Option(long="--full"), Option(long="--no-dangling")),
        ),
        CLISpec(
            name="stash",
            description="Inspect saved working trees",
            subcommands=(
                CLISpec(
                    name="list",
                    fn=verb(stash_list),
                    description="List stashed changes",
                ),
                CLISpec(
                    name="show",
                    fn=verb(stash_show),
                    description="Show stashed changes",
                    options=DIFF_OPTIONS,
                    positional=(Operand(type="str", name="stash"),),
                ),
            ),
        ),
        CLISpec(
            name="version",
            aliases=("--version", "-v"),
            fn=verb(version),
            description="Show the Mirage Git implementation version",
        ),
        CLISpec(
            name="remote",
            description="List remotes",
            fn=verb(remote),
            options=(
                Option(
                    short="-v",
                    long="--verbose",
                    description="Show remote URLs",
                ),
            ),
        ),
        CLISpec(
            name="config",
            description="Read repository configuration",
            fn=verb(config),
            options=(
                Option(
                    long="--global", description="Read global configuration"
                ),
                Option(long="--get", description="Get a configuration value"),
                Option(
                    short="-l",
                    long="--list",
                    description="List every variable and value",
                ),
                Option(
                    long="--show-origin",
                    description="Show the file each value comes from",
                ),
                Option(
                    long="--get-regexp",
                    description="Get the variables whose names "
                    "match a regular expression",
                ),
            ),
            positional=(Operand(type="str", name="name"),),
        ),
        CLISpec(
            name="show-ref",
            description="List references",
            fn=verb(show_ref),
            rest=REVISION,
        ),
        # symbolic-ref has every option git's has, so its rows carry git's
        # own help and its usage block reads exactly as git's.
        CLISpec(
            name="symbolic-ref",
            description="Read, change or delete a symbolic ref",
            fn=verb(symbolic_ref, symbolic_ref_read_only),
            options=(
                Option(
                    short="-q",
                    long="--quiet",
                    description="suppress error message for non-symbolic "
                    "(detached) refs",
                ),
                Option(
                    long="--no-quiet",
                    description="Refuse a ref that is not symbolic aloud",
                ),
                Option(
                    short="-d",
                    long="--delete",
                    description="delete symbolic ref",
                ),
                Option(
                    long="--no-delete",
                    description="Read or change the ref instead",
                ),
                Option(
                    long="--short",
                    description="shorten ref output",
                ),
                Option(
                    long="--no-short",
                    description="Print the full name it points at",
                ),
                Option(
                    long="--recurse",
                    description="recursively dereference (default)",
                ),
                Option(
                    long="--no-recurse",
                    description="Print only the ref this one points at "
                    "directly",
                ),
                Option(
                    short="-m",
                    type="str",
                    metavar="reason",
                    description="reason of the update",
                ),
            ),
            rest=Operand(type="str"),
            write=True,
        ),
        # shortlog's -n is --numbered, so the count keeps only its long
        # spelling.
        CLISpec(
            name="shortlog",
            fn=verb(shortlog),
            description="Summarize commit history",
            options=(
                *(opt for opt in LOG_OPTIONS if opt.short != "-n"),
                Option(
                    long="--max-count",
                    type="int",
                    description="Limit the number of commits",
                ),
                Option(
                    short="-s",
                    long="--summary",
                    description="Show only commit counts",
                ),
                Option(
                    short="-e",
                    long="--email",
                    description="Show author email addresses",
                ),
                Option(
                    short="-n",
                    long="--numbered",
                    description="Sort by commit count",
                ),
            ),
            rest=REVISION,
        ),
        CLISpec(
            name="rev-parse",
            fn=verb(rev_parse),
            description="Resolve revisions",
            options=(
                Option(
                    long="--show-toplevel",
                    description="Show the worktree root",
                ),
                Option(
                    long="--abbrev-ref",
                    type="str",
                    value_optional=True,
                    description="Show abbreviated reference names, strict "
                    "or loose",
                ),
                Option(
                    long="--show-prefix",
                    description="Show the current directory relative to the "
                    "worktree root",
                ),
                Option(
                    long="--is-inside-work-tree",
                    description="Print whether the current directory is "
                    "inside the work tree",
                ),
                Option(
                    long="--verify",
                    description="Require exactly one revision that names an "
                    "object",
                ),
                Option(
                    long="--short",
                    type="str",
                    value_optional=True,
                    description="Abbreviate the object name; implies --verify",
                ),
                Option(
                    short="-q",
                    long="--quiet",
                    description="With --verify, exit 1 without a message",
                ),
            ),
            rest=REVISION,
        ),
        CLISpec(
            name="rev-list",
            description="List reachable commits",
            fn=verb(rev_list),
            options=(
                *LOG_OPTIONS,
                Option(long="--count", description="Print commit count"),
            ),
            rest=REVISION,
        ),
        CLISpec(
            name="diff-tree",
            description="Compare a commit with its parent",
            fn=verb(diff_tree),
            options=(
                *SHOW_OPTIONS,
                Option(
                    long="--no-commit-id", description="Suppress commit ID"
                ),
                Option(short="-r", description="Recurse into subtrees"),
            ),
            positional=(Operand(type="str", name="commit", required=True),),
            rest=PATHSPEC,
        ),
        CLISpec(
            name="status",
            description="Show the working tree status",
            fn=verb(status),
            options=STATUS_OPTIONS,
        ),
        CLISpec(
            name="log",
            description="Show commit logs",
            fn=verb(log),
            options=(*LOG_OPTIONS, *MAILMAP_OPTIONS, *DIFF_OPTIONS),
            rest=REVISION,
        ),
        CLISpec(
            name="show",
            description="Show a commit and its diff",
            fn=verb(show),
            options=(*SHOW_OPTIONS, *DECORATE_OPTIONS),
            rest=REVISION,
        ),
        CLISpec(
            name="diff",
            description="Show changes between commits",
            fn=verb(diff),
            options=(
                *DIFF_OPTIONS,
                Option(
                    long="--cached",
                    description="Compare the index with a commit",
                ),
                Option(long="--staged", description="Alias of --cached"),
            ),
            rest=REVISION,
        ),
        CLISpec(
            name="branch",
            description="List, create or delete branches",
            fn=verb(branch, branch_read_only),
            options=BRANCH_OPTIONS,
            rest=Operand(type="str"),
            write=True,
        ),
        CLISpec(
            name="add",
            description="Stage working tree content",
            fn=verb(add, index_locked),
            options=ADD_OPTIONS,
            rest=PATHSPEC,
            write=True,
        ),
        CLISpec(
            name="reset",
            description="Unstage, putting the index back to HEAD",
            fn=verb(reset, index_locked),
            options=(
                Option(
                    short="-q",
                    long="--quiet",
                    description="Only report errors",
                ),
            ),
            rest=PATHSPEC,
            write=True,
        ),
        CLISpec(
            name="commit",
            description="Record the index as a new commit",
            fn=verb(commit, index_locked),
            options=COMMIT_OPTIONS,
            write=True,
        ),
        CLISpec(
            name="checkout",
            description="Switch branches",
            fn=verb(checkout, checkout_read_only),
            options=CHECKOUT_OPTIONS,
            rest=REVISION,
            write=True,
        ),
        CLISpec(
            name="switch",
            description="Switch branches",
            fn=verb(switch, switch_read_only),
            options=SWITCH_OPTIONS,
            rest=REVISION,
            write=True,
        ),
        CLISpec(
            name="restore",
            description="Restore working tree files",
            fn=verb(restore, index_locked),
            options=RESTORE_OPTIONS,
            rest=PATHSPEC,
            write=True,
        ),
        CLISpec(
            name="rm",
            description="Remove files from the working tree and the index",
            fn=verb(rm, index_locked),
            options=RM_OPTIONS,
            rest=PATHSPEC,
            write=True,
        ),
        CLISpec(
            name="mv",
            description="Move or rename a file, a directory, or a symlink",
            fn=verb(mv, index_locked),
            options=MV_OPTIONS,
            rest=PATHSPEC,
            write=True,
        ),
        CLISpec(
            name="tag",
            description="Create, list or delete a tag",
            fn=verb(tag, tag_read_only),
            options=TAG_OPTIONS,
            rest=Operand(type="str"),
            write=True,
        ),
    ),
)
