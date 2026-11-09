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

from functools import partial

from mirage.accessor.github import GitHubAccount
from mirage.commands.cli.builtin.gh.admin import (
    admin_specs,
    repo_group_specs,
)
from mirage.commands.cli.builtin.gh.args import JQ, JSON, REPO, TEMPLATE
from mirage.commands.cli.builtin.gh.args import flag as _flag
from mirage.commands.cli.builtin.gh.constants import (
    BOOLEAN,
    HELP_TOPICS,
    REPO_EDIT_FIELDS,
)
from mirage.commands.cli.builtin.gh.host import run_leaf
from mirage.commands.cli.builtin.gh.repo import clone_cmd, gist_clone_cmd
from mirage.commands.cli.builtin.gh.search import search_handlers, search_spec
from mirage.commands.cli.builtin.gh.types import RepoEditField
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.cli.walk import find_child, node_help
from mirage.commands.config import Context
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.core.github.config import GhConfig
from mirage.io.types import IOResult
from mirage.types import PathSpec

LIMIT_30 = Argument(
    "-L",
    "--limit",
    type="int",
    default="30",
    help="Maximum number of items to fetch",
)
BODY = Argument("-b", "--body", help="Set the new body.")
BODY_FILE = Argument(
    "-F",
    "--body-file",
    type="path",
    metavar="file",
    help='Read body text from file (use "-" to read from standard input)',
)
TITLE = Argument("-t", "--title", help="Set the new title.")
REOPEN_COMMENT = Argument("-c", "--comment", help="Add a reopening comment")
NUMBER = Argument("NUMBER", metavar="[<number> | <url> | <branch>]")


def _repo_edit_option(field: RepoEditField) -> Argument:
    """Build the grammar from the setting consumed by the handler.

    Args:
        field (RepoEditField): Repository setting definition.
    """
    names = (
        (field.short, field.flag) if field.short is not None else (field.flag,)
    )
    return Argument(
        *names,
        nargs="?" if field.kind != "value" else None,
        attached_only=field.kind != "value",
        choices=field.choices if field.kind == "value" else BOOLEAN,
        metavar=field.metavar,
        help=field.description,
    )


def _issue() -> CommandSpec:
    return CommandSpec(
        name="issue",
        description="Manage issues",
        subcommands=(
            CommandSpec(
                name="list",
                aliases=("ls",),
                description="List issues",
                arguments=(
                    REPO,
                    JSON,
                    JQ,
                    Argument(
                        "-L",
                        "--limit",
                        type="int",
                        default="30",
                        help="Maximum number of issues to fetch",
                    ),
                    Argument(
                        "-s",
                        "--state",
                        choices=("open", "closed", "all"),
                        default="open",
                        help="Filter by state",
                    ),
                    Argument("-a", "--assignee", help="Filter by assignee"),
                    Argument("-A", "--author", help="Filter by author"),
                    Argument(
                        "-l",
                        "--label",
                        action="append",
                        help="Filter by label",
                    ),
                    Argument("--app", help="Filter by GitHub App author"),
                    Argument("--mention", help="Filter by mention"),
                    Argument(
                        "-m",
                        "--milestone",
                        help="Filter by milestone number or title",
                    ),
                    Argument(
                        "-S",
                        "--search",
                        metavar="query",
                        help="Search issues with query",
                    ),
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="view",
                description="View an issue",
                arguments=(
                    Argument("NUMBER", metavar="{<number> | <url>}"),
                    REPO,
                    JSON,
                    JQ,
                    _flag(
                        short="-c",
                        long="--comments",
                        description="View issue comments",
                    ),
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="create",
                aliases=("new",),
                description="Create an issue",
                arguments=(
                    REPO,
                    Argument(
                        "-t",
                        "--title",
                        help="Supply a title. Will prompt for one otherwise.",
                    ),
                    Argument(
                        "-b",
                        "--body",
                        help="Supply a body. Will prompt for one otherwise.",
                    ),
                    BODY_FILE,
                    Argument(
                        "-a",
                        "--assignee",
                        action="append",
                        metavar="login",
                        help='Assign people by their login. Use "@me" to self-assign.',
                    ),
                    Argument(
                        "-l",
                        "--label",
                        action="append",
                        metavar="name",
                        help="Add labels by name",
                    ),
                    Argument(
                        "-m",
                        "--milestone",
                        metavar="name",
                        help="Add the issue to a milestone by name",
                    ),
                ),
            ),
            CommandSpec(
                name="edit",
                description="Edit an issue",
                arguments=(
                    Argument("NUMBER", metavar="{<numbers> | <urls>}"),
                    REPO,
                    TITLE,
                    BODY,
                    BODY_FILE,
                    Argument(
                        "--add-assignee",
                        action="append",
                        metavar="login",
                        help=(
                            'Add assigned users by their login. Use "@me" '
                            'to assign yourself, or "@copilot" to assign '
                            "Copilot."
                        ),
                    ),
                    Argument(
                        "--remove-assignee",
                        action="append",
                        metavar="login",
                        help=(
                            "Remove assigned users by their login. Use "
                            '"@me" to unassign yourself, or "@copilot" to '
                            "unassign Copilot."
                        ),
                    ),
                    Argument(
                        "--add-label",
                        action="append",
                        metavar="name",
                        help="Add labels by name",
                    ),
                    Argument(
                        "--remove-label",
                        action="append",
                        metavar="name",
                        help="Remove labels by name",
                    ),
                    Argument(
                        "-m",
                        "--milestone",
                        metavar="name",
                        help="Edit the milestone the issue belongs to by name",
                    ),
                    _flag(
                        long="--remove-milestone",
                        description="Remove the milestone association from the issue",
                    ),
                ),
            ),
            CommandSpec(
                name="close",
                description="Close an issue",
                arguments=(
                    Argument("NUMBER", metavar="{<number> | <url>}"),
                    REPO,
                    Argument(
                        "-c", "--comment", help="Leave a closing comment"
                    ),
                    Argument(
                        "-r",
                        "--reason",
                        choices=(
                            "completed",
                            "not planned",
                        ),
                        help="Reason for closing",
                    ),
                ),
            ),
            CommandSpec(
                name="reopen",
                description="Reopen an issue",
                arguments=(
                    Argument("NUMBER", metavar="{<number> | <url>}"),
                    REPO,
                    REOPEN_COMMENT,
                ),
            ),
            CommandSpec(
                name="comment",
                description="Add a comment to an issue",
                arguments=(
                    Argument("NUMBER", metavar="{<number> | <url>}"),
                    REPO,
                    Argument(
                        "-b",
                        "--body",
                        metavar="text",
                        help="The comment body text",
                    ),
                    BODY_FILE,
                    _flag(
                        long="--create-if-none",
                        description=(
                            "Create a new comment if no comments are "
                            "found. Can be used only with --edit-last"
                        ),
                    ),
                    _flag(
                        long="--delete-last",
                        description="Delete the last comment of the current user",
                    ),
                    _flag(
                        long="--edit-last",
                        description="Edit the last comment of the current user",
                    ),
                    _flag(
                        long="--yes",
                        description=(
                            "Skip the delete confirmation prompt when "
                            "--delete-last is provided"
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="delete",
                description="Delete issue",
                arguments=(
                    Argument(
                        "NUMBER", nargs="*", metavar="{<number> | <url>}"
                    ),
                    REPO,
                    _flag(
                        long="--yes",
                        description="Confirm deletion without prompting",
                    ),
                ),
            ),
            CommandSpec(
                name="lock",
                description="Lock issue conversation",
                arguments=(
                    Argument(
                        "NUMBER", nargs="*", metavar="{<number> | <url>}"
                    ),
                    REPO,
                    Argument(
                        "-r",
                        "--reason",
                        help=(
                            "Optional reason for locking conversation "
                            "(off_topic, resolved, spam, too_heated)."
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="pin",
                description="Pin an issue to a repository",
                arguments=(
                    Argument(
                        "NUMBER", nargs="*", metavar="{<number> | <url>}"
                    ),
                    REPO,
                ),
            ),
            CommandSpec(
                name="status",
                description="Show status of relevant issues",
                arguments=(
                    REPO,
                    JQ,
                    JSON,
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="transfer",
                description="Transfer issue to another repository",
                arguments=(
                    Argument(
                        "NUMBER",
                        nargs="*",
                        metavar="{<number> | <url>} <destination-repo>",
                    ),
                    REPO,
                ),
            ),
            CommandSpec(
                name="unlock",
                description="Unlock issue conversation",
                arguments=(
                    Argument(
                        "NUMBER", nargs="*", metavar="{<number> | <url>}"
                    ),
                    REPO,
                ),
            ),
            CommandSpec(
                name="unpin",
                description="Unpin an issue from a repository",
                arguments=(
                    Argument(
                        "NUMBER", nargs="*", metavar="{<number> | <url>}"
                    ),
                    REPO,
                ),
            ),
        ),
    )


def _pr() -> CommandSpec:
    return CommandSpec(
        name="pr",
        description="Manage pull requests",
        subcommands=(
            CommandSpec(
                name="list",
                aliases=("ls",),
                description="List pull requests",
                arguments=(
                    REPO,
                    JSON,
                    JQ,
                    LIMIT_30,
                    Argument(
                        "-s",
                        "--state",
                        choices=("open", "closed", "merged", "all"),
                        default="open",
                        help="Filter by state",
                    ),
                    Argument("-B", "--base", help="Filter by base branch"),
                    Argument(
                        "-H",
                        "--head",
                        help=(
                            'Filter by head branch ("<owner>:<branch>" '
                            "syntax not supported)"
                        ),
                    ),
                    Argument("--app", help="Filter by GitHub App author"),
                    Argument("-a", "--assignee", help="Filter by assignee"),
                    Argument("-A", "--author", help="Filter by author"),
                    _flag(
                        short="-d",
                        long="--draft",
                        description="Filter by draft state",
                    ),
                    Argument(
                        "-l",
                        "--label",
                        action="append",
                        help="Filter by label",
                    ),
                    Argument(
                        "-S",
                        "--search",
                        metavar="query",
                        help="Search pull requests with query",
                    ),
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="view",
                description="View a pull request",
                arguments=(
                    NUMBER,
                    REPO,
                    JSON,
                    JQ,
                    _flag(
                        short="-c",
                        long="--comments",
                        description="View pull request comments",
                    ),
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="create",
                aliases=("new",),
                description="Create a pull request",
                arguments=(
                    REPO,
                    Argument(
                        "-t", "--title", help="Title for the pull request"
                    ),
                    Argument("-b", "--body", help="Body for the pull request"),
                    BODY_FILE,
                    Argument(
                        "-H",
                        "--head",
                        metavar="branch",
                        help=(
                            "The branch that contains commits for your "
                            "pull request (default [current branch])"
                        ),
                    ),
                    Argument(
                        "-B",
                        "--base",
                        metavar="branch",
                        help="The branch into which you want your code merged",
                    ),
                    _flag(
                        short="-d",
                        long="--draft",
                        description="Mark pull request as a draft",
                    ),
                    _flag(
                        long="--no-maintainer-edit",
                        description=(
                            "Disable maintainer's ability to modify pull "
                            "request"
                        ),
                    ),
                    Argument(
                        "-a",
                        "--assignee",
                        action="append",
                        metavar="login",
                        help='Assign people by their login. Use "@me" to self-assign.',
                    ),
                    Argument(
                        "-l",
                        "--label",
                        action="append",
                        metavar="name",
                        help="Add labels by name",
                    ),
                    Argument(
                        "-m",
                        "--milestone",
                        metavar="name",
                        help="Add the pull request to a milestone by name",
                    ),
                    Argument(
                        "-r",
                        "--reviewer",
                        action="append",
                        metavar="handle",
                        help="Request reviews from people or teams by their handle",
                    ),
                ),
            ),
            CommandSpec(
                name="edit",
                description="Edit a pull request",
                arguments=(
                    NUMBER,
                    REPO,
                    TITLE,
                    BODY,
                    BODY_FILE,
                    Argument(
                        "-B",
                        "--base",
                        metavar="branch",
                        help="Change the base branch for this pull request",
                    ),
                    Argument(
                        "--add-assignee",
                        action="append",
                        metavar="login",
                        help=(
                            'Add assigned users by their login. Use "@me" '
                            'to assign yourself, or "@copilot" to assign '
                            "Copilot."
                        ),
                    ),
                    Argument(
                        "--add-label",
                        action="append",
                        metavar="name",
                        help="Add labels by name",
                    ),
                    Argument(
                        "--add-reviewer",
                        action="append",
                        metavar="login",
                        help="Add reviewers by their login.",
                    ),
                    Argument(
                        "-m",
                        "--milestone",
                        metavar="name",
                        help="Edit the milestone the pull request belongs to by name",
                    ),
                    Argument(
                        "--remove-assignee",
                        action="append",
                        metavar="login",
                        help=(
                            "Remove assigned users by their login. Use "
                            '"@me" to unassign yourself, or "@copilot" to '
                            "unassign Copilot."
                        ),
                    ),
                    Argument(
                        "--remove-label",
                        action="append",
                        metavar="name",
                        help="Remove labels by name",
                    ),
                    _flag(
                        long="--remove-milestone",
                        description=(
                            "Remove the milestone association from the "
                            "pull request"
                        ),
                    ),
                    Argument(
                        "--remove-reviewer",
                        action="append",
                        metavar="login",
                        help="Remove reviewers by their login.",
                    ),
                ),
            ),
            CommandSpec(
                name="merge",
                description="Merge a pull request",
                arguments=(
                    NUMBER,
                    REPO,
                    Argument(
                        "-b",
                        "--body",
                        metavar="text",
                        help="Body text for the merge commit",
                    ),
                    BODY_FILE,
                    _flag(
                        short="-m",
                        long="--merge",
                        description="Merge the commits with the base branch",
                    ),
                    _flag(
                        short="-r",
                        long="--rebase",
                        description="Rebase the commits onto the base branch",
                    ),
                    _flag(
                        short="-s",
                        long="--squash",
                        description=(
                            "Squash the commits into one commit and merge "
                            "it into the base branch"
                        ),
                    ),
                    Argument(
                        "-t",
                        "--subject",
                        metavar="text",
                        help="Subject text for the merge commit",
                    ),
                    Argument(
                        "--match-head-commit",
                        metavar="SHA",
                        help=(
                            "Commit SHA that the pull request head must "
                            "match to allow merge"
                        ),
                    ),
                    _flag(
                        long="--admin",
                        description=(
                            "Use administrator privileges to merge a pull "
                            "request that does not meet requirements"
                        ),
                    ),
                    Argument(
                        "-A",
                        "--author-email",
                        metavar="text",
                        help="Email text for merge commit author",
                    ),
                    _flag(
                        long="--auto",
                        description=(
                            "Automatically merge only after necessary "
                            "requirements are met"
                        ),
                    ),
                    _flag(
                        short="-d",
                        long="--delete-branch",
                        description="Delete the local and remote branch after merge",
                    ),
                    _flag(
                        long="--disable-auto",
                        description="Disable auto-merge for this pull request",
                    ),
                ),
            ),
            CommandSpec(
                name="close",
                description="Close a pull request",
                arguments=(
                    Argument(
                        "NUMBER", metavar="{<number> | <url> | <branch>}"
                    ),
                    REPO,
                    Argument(
                        "-c", "--comment", help="Leave a closing comment"
                    ),
                    _flag(
                        short="-d",
                        long="--delete-branch",
                        description="Delete the local and remote branch after close",
                    ),
                ),
            ),
            CommandSpec(
                name="reopen",
                description="Reopen a pull request",
                arguments=(
                    Argument(
                        "NUMBER", metavar="{<number> | <url> | <branch>}"
                    ),
                    REPO,
                    REOPEN_COMMENT,
                ),
            ),
            CommandSpec(
                name="comment",
                description="Add a comment to a pull request",
                arguments=(
                    NUMBER,
                    REPO,
                    Argument(
                        "-b",
                        "--body",
                        metavar="text",
                        help="The comment body text",
                    ),
                    BODY_FILE,
                    _flag(
                        long="--create-if-none",
                        description=(
                            "Create a new comment if no comments are "
                            "found. Can be used only with --edit-last"
                        ),
                    ),
                    _flag(
                        long="--delete-last",
                        description="Delete the last comment of the current user",
                    ),
                    _flag(
                        long="--edit-last",
                        description="Edit the last comment of the current user",
                    ),
                    _flag(
                        long="--yes",
                        description=(
                            "Skip the delete confirmation prompt when "
                            "--delete-last is provided"
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="diff",
                description="View changes in a pull request",
                arguments=(
                    NUMBER,
                    REPO,
                    _flag(
                        long="--name-only",
                        description="Display only names of changed files",
                    ),
                    Argument(
                        "--color",
                        choices=(
                            "always",
                            "never",
                            "auto",
                        ),
                        default="auto",
                        help="Use color in diff output",
                    ),
                    _flag(
                        long="--patch",
                        description="Display diff in patch format",
                    ),
                ),
            ),
            CommandSpec(
                name="checks",
                description="Show CI checks for a pull request",
                arguments=(
                    NUMBER,
                    REPO,
                    JSON,
                    JQ,
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="lock",
                description="Lock pull request conversation",
                arguments=(
                    Argument(
                        "NUMBER", nargs="*", metavar="{<number> | <url>}"
                    ),
                    REPO,
                    Argument(
                        "-r",
                        "--reason",
                        help=(
                            "Optional reason for locking conversation "
                            "(off_topic, resolved, spam, too_heated)."
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="ready",
                description="Mark a pull request as ready for review",
                arguments=(
                    Argument(
                        "NUMBER",
                        nargs="*",
                        metavar="[<number> | <url> | <branch>]",
                    ),
                    REPO,
                    _flag(
                        long="--undo",
                        description='Convert a pull request to "draft"',
                    ),
                ),
            ),
            CommandSpec(
                name="revert",
                description="Revert a pull request",
                arguments=(
                    Argument(
                        "NUMBER",
                        nargs="*",
                        metavar="{<number> | <url> | <branch>}",
                    ),
                    REPO,
                    Argument(
                        "-b", "--body", help="Body for the revert pull request"
                    ),
                    Argument(
                        "-F",
                        "--body-file",
                        type="path",
                        metavar="file",
                        help=(
                            'Read body text from file (use "-" to read '
                            "from standard input)"
                        ),
                    ),
                    _flag(
                        short="-d",
                        long="--draft",
                        description="Mark revert pull request as a draft",
                    ),
                    Argument(
                        "-t",
                        "--title",
                        help="Title for the revert pull request",
                    ),
                ),
            ),
            CommandSpec(
                name="review",
                description="Add a review to a pull request",
                arguments=(
                    Argument(
                        "NUMBER",
                        nargs="*",
                        metavar="[<number> | <url> | <branch>]",
                    ),
                    REPO,
                    _flag(
                        short="-a",
                        long="--approve",
                        description="Approve pull request",
                    ),
                    Argument(
                        "-b", "--body", help="Specify the body of a review"
                    ),
                    Argument(
                        "-F",
                        "--body-file",
                        type="path",
                        metavar="file",
                        help=(
                            'Read body text from file (use "-" to read '
                            "from standard input)"
                        ),
                    ),
                    _flag(
                        short="-c",
                        long="--comment",
                        description="Comment on a pull request",
                    ),
                    _flag(
                        short="-r",
                        long="--request-changes",
                        description="Request changes on a pull request",
                    ),
                ),
            ),
            CommandSpec(
                name="status",
                description="Show status of relevant pull requests",
                arguments=(
                    REPO,
                    _flag(
                        short="-c",
                        long="--conflict-status",
                        description=(
                            "Display the merge conflict status of each "
                            "pull request"
                        ),
                    ),
                    JQ,
                    JSON,
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="unlock",
                description="Unlock pull request conversation",
                arguments=(
                    Argument(
                        "NUMBER", nargs="*", metavar="{<number> | <url>}"
                    ),
                    REPO,
                ),
            ),
            CommandSpec(
                name="update-branch",
                description=(
                    "Update a pull request branch with latest changes of the "
                    "base branch"
                ),
                arguments=(
                    Argument(
                        "NUMBER",
                        nargs="*",
                        metavar="[<number> | <url> | <branch>]",
                    ),
                    REPO,
                    _flag(
                        long="--rebase",
                        description=(
                            "Update PR branch by rebasing on top of "
                            "latest base branch"
                        ),
                    ),
                ),
            ),
        ),
    )


REPO_EDIT_OPTIONS = (
    *(_repo_edit_option(field) for field in REPO_EDIT_FIELDS),
    Argument("--add-topic", action="append", help="Add repository topic"),
    Argument(
        "--remove-topic", action="append", help="Remove repository topic"
    ),
    _flag(
        long="--accept-visibility-change-consequences",
        description="Accept the consequences of changing the repository visibility",
    ),
)
REPO_DELETE_OPTIONS = (
    _flag(long="--yes", description="Confirm deletion without prompting"),
    _flag(long="--confirm", description="Deprecated: use --yes instead"),
)


def _repo() -> CommandSpec:
    return CommandSpec(
        name="repo",
        description="Manage repositories",
        subcommands=(
            CommandSpec(
                name="list",
                aliases=("ls",),
                description="List repositories",
                arguments=(
                    Argument("OWNER", nargs="?", metavar="[<owner>]"),
                    JSON,
                    JQ,
                    Argument(
                        "-L",
                        "--limit",
                        type="int",
                        default="30",
                        help="Maximum number of repositories to list",
                    ),
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="clone",
                description="Clone a repository locally",
                arguments=(
                    Argument("REPOSITORY", nargs="?", metavar="<repository>"),
                    Argument("DIRECTORY", nargs="?", metavar="[<directory>]"),
                    Argument(
                        "GITFLAGS", nargs="*", metavar="[-- <gitflags>...]"
                    ),
                    Argument(
                        "-u",
                        "--upstream-remote-name",
                        help=(
                            "Upstream remote name when cloning a fork "
                            '(default "upstream")'
                        ),
                    ),
                    _flag(
                        long="--no-upstream",
                        description="Do not add an upstream remote when "
                        "cloning a fork",
                    ),
                ),
            ),
            CommandSpec(
                name="view",
                description="View a repository",
                arguments=(
                    Argument(
                        "REPOSITORY", nargs="?", metavar="[<repository>]"
                    ),
                    REPO,
                    JSON,
                    JQ,
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="create",
                description="Create a repository",
                arguments=(
                    Argument("NAME", nargs="?", metavar="[<name>]"),
                    _flag(
                        long="--public",
                        description="Make the new repository public",
                    ),
                    _flag(
                        long="--private",
                        description="Make the new repository private",
                    ),
                    Argument(
                        "-d",
                        "--description",
                        help="Description of the repository",
                    ),
                    Argument(
                        "-h",
                        "--homepage",
                        metavar="URL",
                        help="Repository home page URL",
                    ),
                    _flag(
                        long="--add-readme",
                        description="Add a README file to the new repository",
                    ),
                    _flag(
                        long="--disable-issues",
                        description="Disable issues in the new repository",
                    ),
                    _flag(
                        long="--disable-wiki",
                        description="Disable wiki in the new repository",
                    ),
                    Argument(
                        "-g",
                        "--gitignore",
                        help="Specify a gitignore template for the repository",
                    ),
                    _flag(
                        long="--internal",
                        description="Make the new repository internal",
                    ),
                    Argument(
                        "-l",
                        "--license",
                        help="Specify an Open Source License for the repository",
                    ),
                ),
            ),
            CommandSpec(
                name="fork",
                description="Create a fork of a repository",
                arguments=(
                    Argument(
                        "REPOSITORY",
                        nargs="?",
                        metavar="[<repository>] [-- <gitflags>...]",
                    ),
                    _flag(long="--clone", description="Clone the fork"),
                    _flag(
                        long="--default-branch-only",
                        description="Only include the default branch in the fork",
                    ),
                    Argument(
                        "--fork-name", help="Rename the forked repository"
                    ),
                    Argument(
                        "--org", help="Create the fork in an organization"
                    ),
                    _flag(
                        long="--remote",
                        description="Add a git remote for the fork",
                    ),
                    Argument(
                        "--remote-name",
                        help='Specify the name for the new remote (default "origin")',
                    ),
                ),
            ),
            CommandSpec(
                name="rename",
                description="Rename a repository",
                arguments=(
                    Argument("NEW-NAME", metavar="[<new-name>]"),
                    Argument(
                        "-R",
                        "--repo",
                        metavar="[HOST/]OWNER/REPO",
                        help="Select another repository using the "
                        "[HOST/]OWNER/REPO format",
                    ),
                    _flag(
                        short="-y",
                        long="--yes",
                        description="Skip the confirmation prompt",
                    ),
                ),
            ),
            CommandSpec(
                name="edit",
                description="Edit repository settings",
                arguments=(
                    Argument(
                        "REPOSITORY", nargs="?", metavar="[<repository>]"
                    ),
                    *REPO_EDIT_OPTIONS,
                ),
            ),
            CommandSpec(
                name="delete",
                description="Delete a repository",
                arguments=(
                    Argument(
                        "REPOSITORY", nargs="?", metavar="[<repository>]"
                    ),
                    *REPO_DELETE_OPTIONS,
                ),
            ),
            CommandSpec(
                name="archive",
                description="Archive a GitHub repository",
                arguments=(
                    Argument(
                        "REPOSITORY", nargs="*", metavar="[<repository>]"
                    ),
                    _flag(
                        short="-y",
                        long="--yes",
                        description="Skip the confirmation prompt",
                    ),
                ),
            ),
            CommandSpec(
                name="sync",
                description=(
                    "Sync destination repository from source repository"
                ),
                arguments=(
                    Argument(
                        "DESTINATION-REPOSITORY",
                        nargs="*",
                        metavar="[<destination-repository>]",
                    ),
                    Argument(
                        "-b",
                        "--branch",
                        help="Branch to sync (default [default branch])",
                    ),
                    _flag(
                        long="--force",
                        description=(
                            "Hard reset the branch of the destination "
                            "repository to match the source repository"
                        ),
                    ),
                    Argument("-s", "--source", help="Source repository"),
                ),
            ),
            CommandSpec(
                name="unarchive",
                description="Unarchive a GitHub repository",
                arguments=(
                    Argument(
                        "REPOSITORY", nargs="*", metavar="[<repository>]"
                    ),
                    _flag(
                        short="-y",
                        long="--yes",
                        description="Skip the confirmation prompt",
                    ),
                ),
            ),
            *repo_group_specs(),
        ),
    )


def _release() -> CommandSpec:
    return CommandSpec(
        name="release",
        description="Manage releases",
        subcommands=(
            CommandSpec(
                name="list",
                aliases=("ls",),
                description="List releases",
                arguments=(
                    REPO,
                    JSON,
                    JQ,
                    LIMIT_30,
                    _flag(
                        long="--exclude-drafts",
                        description="Exclude draft releases",
                    ),
                    _flag(
                        long="--exclude-pre-releases",
                        description="Exclude pre-releases",
                    ),
                    Argument(
                        "-O",
                        "--order",
                        choices=(
                            "asc",
                            "desc",
                        ),
                        default="desc",
                        help="Order of releases returned",
                    ),
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="view",
                description="View a release",
                arguments=(
                    Argument("TAG", metavar="[<tag>]"),
                    REPO,
                    JSON,
                    JQ,
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="create",
                description="Create a release",
                arguments=(
                    Argument(
                        "TAG", metavar="[<tag>] [<filename>... | <pattern>...]"
                    ),
                    REPO,
                    Argument("-n", "--notes", help="Release notes"),
                    Argument(
                        "-F",
                        "--notes-file",
                        type="path",
                        metavar="file",
                        help=(
                            'Read release notes from file (use "-" to '
                            "read from standard input)"
                        ),
                    ),
                    Argument("-t", "--title", help="Release title"),
                    _flag(
                        short="-d",
                        long="--draft",
                        description=(
                            "Save the release as a draft instead of "
                            "publishing it"
                        ),
                    ),
                    _flag(
                        short="-p",
                        long="--prerelease",
                        description="Mark the release as a prerelease",
                    ),
                    _flag(
                        long="--generate-notes",
                        description=(
                            "Automatically generate title and notes for "
                            "the release via GitHub Release Notes API"
                        ),
                    ),
                    Argument(
                        "--target",
                        metavar="branch",
                        help="Target branch or full commit SHA (default [main branch])",
                    ),
                    Argument(
                        "--discussion-category",
                        help="Start a discussion in the specified category",
                    ),
                    _flag(
                        long="--latest",
                        description=(
                            'Mark this release as "Latest" (default '
                            "[automatic based on date and version]). "
                            "--latest=false to explicitly NOT set as "
                            "latest"
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="delete",
                description="Delete a release",
                arguments=(
                    Argument("TAG", nargs="*", metavar="<tag>"),
                    REPO,
                    _flag(
                        long="--cleanup-tag",
                        description=(
                            "Delete the specified tag in addition to its "
                            "release"
                        ),
                    ),
                    _flag(
                        short="-y",
                        long="--yes",
                        description="Skip the confirmation prompt",
                    ),
                ),
            ),
            CommandSpec(
                name="delete-asset",
                description="Delete an asset from a release",
                arguments=(
                    Argument("TAG", nargs="*", metavar="<tag> <asset-name>"),
                    REPO,
                    _flag(
                        short="-y",
                        long="--yes",
                        description="Skip the confirmation prompt",
                    ),
                ),
            ),
            CommandSpec(
                name="edit",
                description="Edit a release",
                arguments=(
                    Argument("TAG", nargs="*", metavar="<tag>"),
                    REPO,
                    Argument(
                        "--discussion-category",
                        help=(
                            "Start a discussion in the specified category "
                            "when publishing a draft"
                        ),
                    ),
                    _flag(
                        long="--draft",
                        description=(
                            "Save the release as a draft instead of "
                            "publishing it"
                        ),
                    ),
                    _flag(
                        long="--latest",
                        description='Explicitly mark the release as "Latest"',
                    ),
                    Argument("-n", "--notes", help="Release notes"),
                    Argument(
                        "-F",
                        "--notes-file",
                        type="path",
                        metavar="file",
                        help=(
                            'Read release notes from file (use "-" to '
                            "read from standard input)"
                        ),
                    ),
                    _flag(
                        long="--prerelease",
                        description="Mark the release as a prerelease",
                    ),
                    Argument("--tag", help="The name of the tag"),
                    Argument(
                        "--target",
                        metavar="branch",
                        help="Target branch or full commit SHA (default [main branch])",
                    ),
                    Argument("-t", "--title", help="Release title"),
                    _flag(
                        long="--verify-tag",
                        description=(
                            "Abort in case the git tag doesn't already "
                            "exist in the remote repository"
                        ),
                    ),
                ),
            ),
        ),
    )


# `gh run view`'s flags: the summary's, and gh 2.85's two log views.
RUN_VIEW_OPTIONS = (
    REPO,
    JSON,
    JQ,
    _flag(
        long="--exit-status",
        description="Exit with non-zero status if run failed",
    ),
    _flag(
        long="--log",
        description="View full log for either a run or specific job",
    ),
    _flag(
        long="--log-failed",
        description="View the log for any failed steps in a run or specific job",
    ),
)
# `gh workflow view`'s flags, `--ref` only beside `--yaml`, as in gh 2.85.
WORKFLOW_VIEW_OPTIONS = (
    REPO,
    _flag(
        short="-y", long="--yaml", description="View the workflow yaml file"
    ),
    Argument(
        "-r",
        "--ref",
        help=(
            "The branch or tag name which contains the version of the "
            "workflow file you'd like to view"
        ),
    ),
)


def _run() -> CommandSpec:
    return CommandSpec(
        name="run",
        description="View workflow runs",
        subcommands=(
            CommandSpec(
                name="list",
                aliases=("ls",),
                description="List workflow runs",
                arguments=(
                    REPO,
                    JSON,
                    JQ,
                    Argument(
                        "-L",
                        "--limit",
                        type="int",
                        default="20",
                        help="Maximum number of runs to fetch",
                    ),
                    Argument("-b", "--branch", help="Filter runs by branch"),
                    Argument(
                        "-c",
                        "--commit",
                        metavar="SHA",
                        help="Filter runs by the SHA of the commit",
                    ),
                    Argument(
                        "--created",
                        metavar="date",
                        help="Filter runs by the date it was created",
                    ),
                    Argument(
                        "-e",
                        "--event",
                        metavar="event",
                        help="Filter runs by which event triggered the run",
                    ),
                    Argument(
                        "-s",
                        "--status",
                        help=(
                            "Filter runs by status: "
                            "{queued|completed|in_progress|requested|waiting|pending|action_required|cancelled|failure|neutral|skipped|stale|startup_failure|success|timed_out}"
                        ),
                    ),
                    Argument(
                        "-u",
                        "--user",
                        help="Filter runs by user who triggered the run",
                    ),
                    Argument(
                        "-w", "--workflow", help="Filter runs by workflow"
                    ),
                    _flag(
                        short="-a",
                        long="--all",
                        description="Include disabled workflows",
                    ),
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="view",
                description="View a workflow run",
                arguments=(
                    Argument("RUN-ID", metavar="[<run-id>]"),
                    *RUN_VIEW_OPTIONS,
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="rerun",
                description="Rerun a workflow run",
                arguments=(
                    Argument("RUN-ID", metavar="[<run-id>]"),
                    REPO,
                    _flag(
                        short="-d",
                        long="--debug",
                        description="Rerun with debug logging",
                    ),
                    _flag(
                        long="--failed",
                        description="Rerun only failed jobs, including dependencies",
                    ),
                    Argument(
                        "-j",
                        "--job",
                        help=(
                            "Rerun a specific job ID from a run, "
                            "including dependencies"
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="cancel",
                description="Cancel a workflow run",
                arguments=(
                    Argument("RUN-ID", nargs="*", metavar="[<run-id>]"),
                    REPO,
                    _flag(
                        long="--force",
                        description="Force cancel a workflow run",
                    ),
                ),
            ),
            CommandSpec(
                name="delete",
                description="Delete a workflow run",
                arguments=(
                    Argument("RUN-ID", nargs="*", metavar="[<run-id>]"),
                    REPO,
                ),
            ),
        ),
    )


def _workflow() -> CommandSpec:
    return CommandSpec(
        name="workflow",
        description="Manage workflows",
        subcommands=(
            CommandSpec(
                name="list",
                aliases=("ls",),
                description="List workflows",
                arguments=(
                    REPO,
                    JSON,
                    JQ,
                    Argument(
                        "-L",
                        "--limit",
                        type="int",
                        default="50",
                        help="Maximum number of workflows to fetch",
                    ),
                    _flag(
                        short="-a",
                        long="--all",
                        description="Include disabled workflows",
                    ),
                    TEMPLATE,
                ),
            ),
            CommandSpec(
                name="view",
                description="View a workflow",
                arguments=(
                    Argument(
                        "WORKFLOW",
                        metavar="[<workflow-id> | <workflow-name> | <filename>]",
                    ),
                    *WORKFLOW_VIEW_OPTIONS,
                ),
            ),
            CommandSpec(
                name="run",
                description="Run a workflow",
                arguments=(
                    Argument(
                        "WORKFLOW", metavar="[<workflow-id> | <workflow-name>]"
                    ),
                    REPO,
                    Argument(
                        "-r",
                        "--ref",
                        help=(
                            "Branch or tag name which contains the "
                            "version of the workflow file you'd like to "
                            "run"
                        ),
                    ),
                    Argument(
                        "-f",
                        "--raw-field",
                        action="append",
                        metavar="key=value",
                        help="Add a string parameter in key=value format",
                    ),
                    Argument(
                        "-F",
                        "--field",
                        action="append",
                        metavar="key=value",
                        help=(
                            "Add a string parameter in key=value format, "
                            'respecting @ syntax (see "gh help api").'
                        ),
                    ),
                    _flag(
                        long="--json",
                        description="Read workflow inputs as JSON via STDIN",
                    ),
                ),
            ),
            CommandSpec(
                name="disable",
                description=(
                    "Disable a workflow, preventing it from running or "
                    "showing up when listing workflows"
                ),
                arguments=(
                    Argument(
                        "WORKFLOW-ID",
                        nargs="*",
                        metavar="[<workflow-id> | <workflow-name>]",
                    ),
                    REPO,
                ),
            ),
            CommandSpec(
                name="enable",
                description=(
                    "Enable a workflow, allowing it to be run and show up "
                    "when listing workflows"
                ),
                arguments=(
                    Argument(
                        "WORKFLOW-ID",
                        nargs="*",
                        metavar="[<workflow-id> | <workflow-name>]",
                    ),
                    REPO,
                ),
            ),
        ),
    )


async def _help_cmd(
    accessor: GitHubAccount,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[bytes | None, IOResult]:
    """``gh help [<command>...]``, as cobra answers it.

    The help of the deepest command the words name (words past it are
    ignored), a help topic when the first word names one, and otherwise
    gh's unknown-topic answer, which goes to stderr with the list of
    commands and still exits 0.

    Args:
        accessor (GitHubAccount): the install's account.
        paths (list[PathSpec]): the path operands.
        texts (list[str]): the words after ``help``.
        ctx (Context): the invocation's context.
    """
    node = GH.spec
    path: list[str] = []
    for word in texts:
        child = find_child(node, word)
        if child is None:
            break
        node = child
        path.append(child.name)
    if texts and not path:
        topic = HELP_TOPICS.get(texts[0])
        if topic is not None:
            return topic.encode(), IOResult()
        names = sorted(
            f"  {child.name}\n"
            for child in GH.spec.subcommands
            if child.name != "help"
        )
        asked = " ".join(f"`{word}`" for word in texts)
        usage = (
            "Usage:  gh <command> <subcommand> [flags]\n\n"
            f"Available commands:\n{''.join(names)}"
        )
        return None, IOResult(
            stderr=f"Unknown help topic [{asked}]\n{usage}".encode()
        )
    return node_help(
        " ".join(("gh", *path)), node, GH.spec.usage_style
    ).encode(), IOResult()


_READS = (
    "auth status",
    "auth token",
    "version",
    "issue list",
    "issue view",
    "pr list",
    "pr view",
    "pr diff",
    "pr checks",
    "repo list",
    "repo view",
    "release list",
    "release view",
    "run list",
    "run view",
    "workflow list",
    "workflow view",
    "cache list",
    "gist list",
    "gist view",
    "issue status",
    "label list",
    "org list",
    "pr status",
    "repo autolink list",
    "repo autolink view",
    "repo deploy-key list",
    "repo gitignore list",
    "repo gitignore view",
    "repo license list",
    "repo license view",
    "ruleset check",
    "ruleset list",
    "ruleset view",
    "secret list",
    "variable get",
    "variable list",
)
_WRITES = (
    "api",
    "issue create",
    "issue edit",
    "issue close",
    "issue reopen",
    "issue comment",
    "pr create",
    "pr edit",
    "pr merge",
    "pr close",
    "pr reopen",
    "pr comment",
    "repo create",
    "repo fork",
    "repo rename",
    "repo edit",
    "repo delete",
    "release create",
    "run rerun",
    "workflow run",
    "cache delete",
    "gist create",
    "gist delete",
    "gist edit",
    "gist rename",
    "issue delete",
    "issue lock",
    "issue pin",
    "issue transfer",
    "issue unlock",
    "issue unpin",
    "label clone",
    "label create",
    "label delete",
    "label edit",
    "pr lock",
    "pr ready",
    "pr revert",
    "pr review",
    "pr unlock",
    "pr update-branch",
    "release delete",
    "release delete-asset",
    "release edit",
    "repo archive",
    "repo autolink create",
    "repo autolink delete",
    "repo deploy-key add",
    "repo deploy-key delete",
    "repo sync",
    "repo unarchive",
    "run cancel",
    "run delete",
    "secret delete",
    "variable delete",
    "variable set",
    "workflow disable",
    "workflow enable",
)


def _leaf(leaf: str, write: bool = False) -> CLIHandler:
    return CLIHandler(fn=partial(run_leaf, leaf), write=write)


GH = CLI(
    spec=CommandSpec(
        name="gh",
        description="GitHub CLI",
        usage_style=UsageStyle.COBRA,
        subcommands=(
            CommandSpec(
                name="auth",
                description="Manage authentication",
                subcommands=(
                    CommandSpec(
                        name="status", description="Check the configured token"
                    ),
                    CommandSpec(
                        name="token",
                        description="Token display is unavailable in Mirage",
                        arguments=(
                            Argument(
                                "-h",
                                "--hostname",
                                help="The hostname of the GitHub instance "
                                "authenticated with",
                            ),
                            Argument(
                                "-u",
                                "--user",
                                help="The account selector; tokens are "
                                "never printed",
                            ),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="help",
                description="Help about any command",
                arguments=(Argument("texts", nargs="*", metavar="[command]"),),
            ),
            CommandSpec(
                name="version",
                aliases=("--version",),
                description=(
                    "Show the Mirage GitHub CLI implementation version"
                ),
            ),
            CommandSpec(
                name="api",
                description="Make an authenticated GitHub API request",
                arguments=(
                    Argument("ENDPOINT", metavar="<endpoint>"),
                    Argument(
                        "-X",
                        "--method",
                        help='The HTTP method for the request (default "GET")',
                    ),
                    Argument(
                        "-f",
                        "--raw-field",
                        action="append",
                        metavar="key=value",
                        help="Add a string parameter in key=value format",
                    ),
                    Argument(
                        "-F",
                        "--field",
                        action="append",
                        metavar="key=value",
                        help=(
                            "Add a typed parameter in key=value format "
                            '(use "@<path>" or "@-" to read value from '
                            "file or stdin)"
                        ),
                    ),
                    Argument(
                        "-H",
                        "--header",
                        action="append",
                        metavar="key:value",
                        help="Add a HTTP request header in key:value format",
                    ),
                    _flag(
                        short="-i",
                        long="--include",
                        description=(
                            "Include HTTP response status line and "
                            "headers in the output"
                        ),
                    ),
                    Argument(
                        "--input",
                        type="path",
                        metavar="file",
                        help=(
                            "The file to use as body for the HTTP request "
                            '(use "-" to read from standard input)'
                        ),
                    ),
                    Argument(
                        "-q",
                        "--jq",
                        help="Query to select values from the response using jq syntax",
                    ),
                    _flag(
                        long="--paginate",
                        description=(
                            "Make additional HTTP requests to fetch all "
                            "pages of results"
                        ),
                    ),
                    _flag(
                        long="--slurp",
                        description=(
                            'Use with "--paginate" to return an array of '
                            "all pages of either JSON arrays or objects"
                        ),
                    ),
                    _flag(
                        long="--silent",
                        description="Do not print the response body",
                    ),
                ),
            ),
            _issue(),
            _pr(),
            _repo(),
            _release(),
            _run(),
            _workflow(),
            search_spec(),
            *admin_specs(),
        ),
    ),
    handlers={
        **search_handlers(),
        **{leaf: _leaf(leaf) for leaf in _READS},
        **{leaf: _leaf(leaf, write=True) for leaf in _WRITES},
        "help": CLIHandler(fn=_help_cmd),
        "repo clone": CLIHandler(fn=clone_cmd),
        "gist clone": CLIHandler(fn=gist_clone_cmd),
    },
    config_model=GhConfig,
    accessor=GitHubAccount,
)
