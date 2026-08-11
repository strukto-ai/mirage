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
from mirage.commands.cli.builtin.git.branch import branch
from mirage.commands.cli.builtin.git.checkout import checkout
from mirage.commands.cli.builtin.git.commit import commit
from mirage.commands.cli.builtin.git.diff import diff
from mirage.commands.cli.builtin.git.log import log
from mirage.commands.cli.builtin.git.reset import reset
from mirage.commands.cli.builtin.git.show import show
from mirage.commands.cli.builtin.git.status import status
from mirage.commands.cli.types import CLISpec, UsageStyle
from mirage.commands.spec.types import Operand, Option

# `-C` is git's own before-anything-else option, so it sits on the root
# and every verb inherits it. The "." default is load-bearing: a PATH
# default lands as if typed, so an absent -C resolves to the session cwd
# and the leaves need no separate working-directory fact.
DIRECTORY_OPTION = Option(short="-C",
                          type="path",
                          default=".",
                          description="Run as if git was started in <path>")

REVISION = Operand(type="str")

# --pretty and --format set the same variable in git; both take git's
# optional-value form, so a bare --pretty means medium and a detached
# next word is a revision, never a format. A bare --format stays
# parseable too, but only so pretty_value can answer it with git's own
# fatal (pretty.c reads --format in its =value form alone).
PRETTY_OPTION = Option(long="--pretty",
                       type="str",
                       value_optional=True,
                       description="Commit display format: oneline, short, "
                       "medium, full, fuller, or a format:/tformat:/%-string")
FORMAT_OPTION = Option(long="--format",
                       type="str",
                       value_optional=True,
                       description="Alias of --pretty (requires =value)")

LOG_OPTIONS = (
    Option(short="-n",
           type="int",
           numeric_shorthand=True,
           description="Limit the number of commits shown"),
    Option(long="--oneline", description="One abbreviated line per commit"),
    Option(long="--reverse", description="Print commits oldest first"),
    Option(long="--all",
           description="Start from every ref as well as the revision"),
    PRETTY_OPTION,
    FORMAT_OPTION,
    # The pickaxe, and the reason `git log -S <name> --reverse` answers
    # "which commit introduced this": it selects commits that changed
    # how many times the string occurs, not commits that mention it.
    Option(short="-S",
           type="str",
           description="Show commits that change the number of occurrences "
           "of the string"),
    Option(long="--since",
           type="str",
           description="Commits more recent than a date (ISO-8601 or epoch)"),
    Option(long="--until",
           type="str",
           description="Commits older than a date (ISO-8601 or epoch)"),
)

SHOW_OPTIONS = (
    Option(long="--stat",
           description="Show the diffstat table instead of the patch"),
    Option(short="-s",
           long="--no-patch",
           description="Suppress all diff output"),
    Option(long="--name-only",
           description="Show changed paths instead of the patch"),
    Option(long="--no-ext-diff",
           description="Accepted for compatibility; there are no external "
           "diff drivers to disable"),
    PRETTY_OPTION,
    FORMAT_OPTION,
)

BRANCH_OPTIONS = (
    Option(short="-a", description="List local and remote-tracking branches"),
    Option(short="-r", description="List remote-tracking branches"),
    Option(short="-d",
           long="--delete",
           description="Delete a fully merged branch"),
    Option(short="-D", description="Delete a branch even if not merged"),
)

PATHSPEC = Operand(type="str")

ADD_OPTIONS = (
    Option(short="-A", long="--all", description="Stage every change"),
    Option(short="-u",
           long="--update",
           description="Stage changes to tracked files only"),
    Option(short="-f",
           long="--force",
           description="Stage paths an ignore rule covers"),
)

COMMIT_OPTIONS = (
    # Required, not defaulted: git would open an editor without it, and
    # a mount has none to open.
    Option(short="-m",
           long="--message",
           type="str",
           description="Commit message"),
    Option(long="--author",
           type="str",
           description="Override the recorded author"),
)

CHECKOUT_OPTIONS = (Option(short="-b",
                           description="Create the branch and switch to it"), )

STATUS_OPTIONS = (
    Option(long="--porcelain",
           description="Machine-readable output, stable across versions"),
    Option(short="-s",
           long="--short",
           description="Give the output in the "
           "short format"),
    Option(short="-b",
           long="--branch",
           description="Show the branch line even in short format"),
    # git spells the mode attached (`-uall`) or not at all, never as a
    # separate token, which is what value_optional says: a bare -u means
    # "all" and the next word is left alone to be an operand.
    Option(short="-u",
           long="--untracked-files",
           type="str",
           value_optional=True,
           choices=("no", "normal", "all"),
           description="Show untracked files: no, normal or all"),
)

# The git program tree. No config_model: local git needs no credentials,
# which is what makes it installable with a bare `cli: git`.
GIT = CLISpec(
    name="git",
    description="Content tracker",
    usage_style=UsageStyle.GIT,
    options=(DIRECTORY_OPTION, ),
    subcommands=(
        CLISpec(
            name="status",
            description="Show the working tree status",
            fn=status,
            options=STATUS_OPTIONS,
        ),
        CLISpec(
            name="log",
            description="Show commit logs",
            fn=log,
            options=LOG_OPTIONS,
            rest=REVISION,
        ),
        CLISpec(
            name="show",
            description="Show a commit and its diff",
            fn=show,
            options=SHOW_OPTIONS,
            rest=REVISION,
        ),
        CLISpec(
            name="diff",
            description="Show changes between commits",
            fn=diff,
            rest=REVISION,
        ),
        CLISpec(
            name="branch",
            description="List, create or delete branches",
            fn=branch,
            options=BRANCH_OPTIONS,
            rest=Operand(type="str"),
            write=True,
        ),
        CLISpec(
            name="add",
            description="Stage working tree content",
            fn=add,
            options=ADD_OPTIONS,
            rest=PATHSPEC,
            write=True,
        ),
        CLISpec(
            name="reset",
            description="Unstage, putting the index back to HEAD",
            fn=reset,
            rest=PATHSPEC,
            write=True,
        ),
        CLISpec(
            name="commit",
            description="Record the index as a new commit",
            fn=commit,
            options=COMMIT_OPTIONS,
            write=True,
        ),
        CLISpec(
            name="checkout",
            description="Switch branches",
            fn=checkout,
            options=CHECKOUT_OPTIONS,
            rest=REVISION,
            write=True,
        ),
    ),
)
