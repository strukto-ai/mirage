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

from mirage.commands.cli.builtin.gh import actions as action_commands
from mirage.commands.cli.builtin.gh import issue as issue_commands
from mirage.commands.cli.builtin.gh import pull as pull_commands
from mirage.commands.cli.builtin.gh import release as release_commands
from mirage.commands.cli.builtin.gh import repo as repo_commands
from mirage.commands.cli.builtin.gh.api import api
from mirage.commands.cli.builtin.gh.auth import status as auth_status
from mirage.commands.cli.builtin.gh.auth import token as auth_token
from mirage.commands.cli.builtin.gh.constants import (
    BOOLEAN,
    HELP_TOPICS,
    REPO_EDIT_FIELDS,
)
from mirage.commands.cli.builtin.gh.search import search_handlers, search_spec
from mirage.commands.cli.builtin.gh.types import RepoEditField
from mirage.commands.cli.builtin.gh.version import version
from mirage.commands.cli.types import CLI, CLIHandler, CLIInvocation
from mirage.commands.cli.walk import find_child, node_help
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.github.config import GhConfig
from mirage.io.types import IOResult

REPO = Argument(
    "-R",
    "--repo",
    help="Select another repository, as [HOST/]OWNER/REPO",
)
JSON = Argument("--json", help="Output selected JSON fields")
JQ = Argument("-q", "--jq", help="Filter JSON output")
LIMIT_30 = Argument("-L", "--limit", type="int", default="30")
BODY = Argument("-b", "--body")
BODY_FILE = Argument("-F", "--body-file", type="path")
TITLE = Argument("-t", "--title")
NUMBER = Argument("NUMBER")


def _flag(
    short: str | None = None, long: str = "", description: str | None = None
) -> Argument:
    """One of gh's boolean flags, which are pflag's.

    A bare ``--draft`` is true, and ``--draft=true`` or ``--draft=false``
    spells the value out, which is how a script turns one off. The
    shorts still cluster (``-sd``). Read one with ``gh_bool``.

    Args:
        short (str | None): the short spelling.
        long (str): the long spelling.
        description (str | None): the help line.
    """
    names = (short, long) if short is not None else (long,)
    return Argument(
        *names,
        nargs="?",
        attached_only=True,
        short_value=False,
        choices=BOOLEAN,
        help=description,
    )


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
                    LIMIT_30,
                    Argument(
                        "-s",
                        "--state",
                        choices=("open", "closed", "all"),
                        default="open",
                    ),
                    Argument("-a", "--assignee"),
                    Argument("-A", "--author"),
                    Argument("-l", "--label", action="append"),
                ),
            ),
            CommandSpec(
                name="view",
                description="View an issue",
                arguments=(
                    NUMBER,
                    REPO,
                    JSON,
                    JQ,
                    _flag(
                        short="-c",
                        long="--comments",
                        description="Show comments",
                    ),
                ),
            ),
            CommandSpec(
                name="create",
                aliases=("new",),
                description="Create an issue",
                arguments=(
                    REPO,
                    TITLE,
                    BODY,
                    BODY_FILE,
                    Argument("-a", "--assignee", action="append"),
                    Argument("-l", "--label", action="append"),
                ),
            ),
            CommandSpec(
                name="edit",
                description="Edit an issue",
                arguments=(
                    NUMBER,
                    REPO,
                    TITLE,
                    BODY,
                    BODY_FILE,
                    Argument("--add-assignee", action="append"),
                    Argument("--remove-assignee", action="append"),
                    Argument("--add-label", action="append"),
                    Argument("--remove-label", action="append"),
                ),
            ),
            CommandSpec(
                name="close",
                description="Close an issue",
                arguments=(
                    NUMBER,
                    REPO,
                ),
            ),
            CommandSpec(
                name="reopen",
                description="Reopen an issue",
                arguments=(
                    NUMBER,
                    REPO,
                ),
            ),
            CommandSpec(
                name="comment",
                description="Add a comment to an issue",
                arguments=(
                    NUMBER,
                    REPO,
                    BODY,
                    BODY_FILE,
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
                    ),
                    Argument("-B", "--base"),
                    Argument("-H", "--head"),
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
                        description="Show comments",
                    ),
                ),
            ),
            CommandSpec(
                name="create",
                aliases=("new",),
                description="Create a pull request",
                arguments=(
                    REPO,
                    TITLE,
                    BODY,
                    BODY_FILE,
                    Argument("-H", "--head"),
                    Argument("-B", "--base"),
                    _flag(short="-d", long="--draft"),
                    _flag(long="--no-maintainer-edit"),
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
                    Argument("-B", "--base"),
                ),
            ),
            CommandSpec(
                name="merge",
                description="Merge a pull request",
                arguments=(
                    NUMBER,
                    REPO,
                    BODY,
                    BODY_FILE,
                    _flag(short="-m", long="--merge"),
                    _flag(short="-r", long="--rebase"),
                    _flag(short="-s", long="--squash"),
                    Argument("-t", "--subject"),
                    Argument("--match-head-commit"),
                ),
            ),
            CommandSpec(
                name="close",
                description="Close a pull request",
                arguments=(
                    NUMBER,
                    REPO,
                ),
            ),
            CommandSpec(
                name="comment",
                description="Add a comment to a pull request",
                arguments=(
                    NUMBER,
                    REPO,
                    BODY,
                    BODY_FILE,
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
                ),
            ),
        ),
    )


REPO_EDIT_OPTIONS = (
    *(_repo_edit_option(field) for field in REPO_EDIT_FIELDS),
    Argument("--add-topic", action="append", help="Add repository topic"),
    Argument(
        "--remove-topic",
        action="append",
        help="Remove repository topic",
    ),
    _flag(
        long="--accept-visibility-change-consequences",
        description="Accept the consequences of changing the repository "
        "visibility",
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
                    Argument("OWNER", nargs="?"),
                    JSON,
                    JQ,
                    LIMIT_30,
                ),
            ),
            CommandSpec(
                name="clone",
                description="Clone a repository locally",
                arguments=(
                    Argument("REPOSITORY", nargs="?"),
                    Argument("DIRECTORY", nargs="?"),
                    Argument("GITFLAGS", nargs="*"),
                    Argument(
                        "-u",
                        "--upstream-remote-name",
                        help="Upstream remote name when cloning a fork",
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
                    Argument("REPOSITORY", nargs="?"),
                    REPO,
                    JSON,
                    JQ,
                ),
            ),
            CommandSpec(
                name="create",
                description="Create a repository",
                arguments=(
                    Argument("NAME", nargs="?"),
                    _flag(long="--public"),
                    _flag(long="--private"),
                    Argument("-d", "--description"),
                    Argument("-h", "--homepage"),
                    _flag(long="--add-readme"),
                ),
            ),
            CommandSpec(
                name="fork",
                description="Create a fork of a repository",
                arguments=(
                    Argument("REPOSITORY", nargs="?"),
                    _flag(long="--clone", description="Clone the fork"),
                    _flag(
                        long="--default-branch-only",
                        description="Only include the default branch in the "
                        "fork",
                    ),
                    Argument(
                        "--fork-name",
                        help="Rename the forked repository",
                    ),
                    Argument(
                        "--org",
                        help="Create the fork in an organization",
                    ),
                    _flag(
                        long="--remote",
                        description="Add a git remote for the fork",
                    ),
                    Argument(
                        "--remote-name",
                        help="Specify the name for the new remote",
                    ),
                ),
            ),
            CommandSpec(
                name="rename",
                description="Rename a repository",
                arguments=(
                    Argument("NEW-NAME"),
                    REPO,
                ),
            ),
            CommandSpec(
                name="edit",
                description="Edit repository settings",
                arguments=(
                    Argument("REPOSITORY", nargs="?"),
                    *REPO_EDIT_OPTIONS,
                ),
            ),
            CommandSpec(
                name="delete",
                description="Delete a repository",
                arguments=(
                    Argument("REPOSITORY", nargs="?"),
                    *REPO_DELETE_OPTIONS,
                ),
            ),
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
                ),
            ),
            CommandSpec(
                name="view",
                description="View a release",
                arguments=(
                    Argument("TAG"),
                    REPO,
                    JSON,
                    JQ,
                ),
            ),
            CommandSpec(
                name="create",
                description="Create a release",
                arguments=(
                    Argument("TAG"),
                    REPO,
                    Argument("-n", "--notes"),
                    Argument("-F", "--notes-file", type="path"),
                    TITLE,
                    _flag(short="-d", long="--draft"),
                    _flag(short="-p", long="--prerelease"),
                    _flag(long="--generate-notes"),
                    Argument("--target"),
                ),
            ),
        ),
    )


# `gh run view`'s flags: the summary's, and gh 2.85's two log views.
RUN_VIEW_OPTIONS = (
    REPO,
    JSON,
    JQ,
    _flag(long="--exit-status"),
    _flag(
        long="--log",
        description="View full log for either a run or specific job",
    ),
    _flag(
        long="--log-failed",
        description="View the log for any failed steps in a run or "
        "specific job",
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
        help="The branch or tag name which contains the version of "
        "the workflow file you'd like to view",
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
                    Argument("-L", "--limit", type="int", default="20"),
                    Argument("-b", "--branch"),
                    Argument("-c", "--commit"),
                    Argument("--created"),
                    Argument("-e", "--event"),
                    Argument("-s", "--status"),
                    Argument("-u", "--user"),
                    Argument("-w", "--workflow"),
                ),
            ),
            CommandSpec(
                name="view",
                description="View a workflow run",
                arguments=(
                    Argument("RUN-ID"),
                    *RUN_VIEW_OPTIONS,
                ),
            ),
            CommandSpec(
                name="rerun",
                description="Rerun a workflow run",
                arguments=(
                    Argument("RUN-ID"),
                    REPO,
                    _flag(short="-d", long="--debug"),
                    _flag(long="--failed"),
                    Argument("-j", "--job"),
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
                    Argument("-L", "--limit", type="int", default="50"),
                    _flag(short="-a", long="--all"),
                ),
            ),
            CommandSpec(
                name="view",
                description="View a workflow",
                arguments=(
                    Argument("WORKFLOW"),
                    *WORKFLOW_VIEW_OPTIONS,
                ),
            ),
            CommandSpec(
                name="run",
                description="Run a workflow",
                arguments=(
                    Argument("WORKFLOW"),
                    REPO,
                    Argument("-r", "--ref"),
                    Argument("-f", "--raw-field", action="append"),
                    Argument("-F", "--field", action="append"),
                    _flag(long="--json"),
                ),
            ),
        ),
    )


async def _help_cmd(
    inv: CLIInvocation[GhConfig],
) -> tuple[bytes | None, IOResult]:
    """``gh help [<command>...]``, as cobra answers it.

    The help of the deepest command the words name (words past it are
    ignored), a help topic when the first word names one, and otherwise
    gh's unknown-topic answer, which goes to stderr with the list of
    commands and still exits 0.

    Args:
        inv (CLIInvocation[GhConfig]): the words after ``help``.
    """
    node = GH.spec
    path: list[str] = []
    for word in inv.texts:
        child = find_child(node, word)
        if child is None:
            break
        node = child
        path.append(child.name)
    if inv.texts and not path:
        topic = HELP_TOPICS.get(inv.texts[0])
        if topic is not None:
            return topic.encode(), IOResult()
        names = sorted(
            f"  {child.name}\n"
            for child in GH.spec.subcommands
            if child.name != "help"
        )
        asked = " ".join(f"`{word}`" for word in inv.texts)
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


GH = CLI(
    spec=CommandSpec(
        name="gh",
        description="GitHub CLI",
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
                arguments=(Argument("texts", nargs="*", metavar=""),),
            ),
            CommandSpec(
                name="version",
                aliases=("--version",),
                description="Show the Mirage GitHub CLI implementation version",
            ),
            CommandSpec(
                name="api",
                description="Make an authenticated GitHub API request",
                arguments=(
                    Argument("ENDPOINT"),
                    Argument("-X", "--method"),
                    Argument("-f", "--raw-field", action="append"),
                    Argument("-F", "--field", action="append"),
                    Argument("-H", "--header", action="append"),
                    _flag(
                        short="-i",
                        long="--include",
                        description="Include HTTP response status line "
                        "and headers in the output",
                    ),
                    Argument("--input", type="path"),
                    JQ,
                    _flag(long="--paginate"),
                    _flag(long="--slurp"),
                    _flag(long="--silent"),
                ),
            ),
            _issue(),
            _pr(),
            _repo(),
            _release(),
            _run(),
            _workflow(),
            search_spec(),
        ),
    ),
    handlers={
        **search_handlers(),
        "auth status": CLIHandler(fn=auth_status),
        "auth token": CLIHandler(fn=auth_token),
        "help": CLIHandler(fn=_help_cmd),
        "version": CLIHandler(fn=version),
        "api": CLIHandler(fn=api, write=True),
        "issue list": CLIHandler(fn=issue_commands.list_cmd),
        "issue view": CLIHandler(fn=issue_commands.view_cmd),
        "issue create": CLIHandler(fn=issue_commands.create_cmd, write=True),
        "issue edit": CLIHandler(fn=issue_commands.edit_cmd, write=True),
        "issue close": CLIHandler(fn=issue_commands.close_cmd, write=True),
        "issue reopen": CLIHandler(fn=issue_commands.reopen_cmd, write=True),
        "issue comment": CLIHandler(fn=issue_commands.comment_cmd, write=True),
        "pr list": CLIHandler(fn=pull_commands.list_cmd),
        "pr view": CLIHandler(fn=pull_commands.view_cmd),
        "pr create": CLIHandler(fn=pull_commands.create_cmd, write=True),
        "pr edit": CLIHandler(fn=pull_commands.edit_cmd, write=True),
        "pr merge": CLIHandler(fn=pull_commands.merge_cmd, write=True),
        "pr close": CLIHandler(fn=pull_commands.close_cmd, write=True),
        "pr comment": CLIHandler(fn=pull_commands.comment_cmd, write=True),
        "pr diff": CLIHandler(fn=pull_commands.diff_cmd),
        "pr checks": CLIHandler(fn=pull_commands.checks_cmd),
        "repo list": CLIHandler(fn=repo_commands.list_cmd),
        "repo clone": CLIHandler(fn=repo_commands.clone_cmd),
        "repo view": CLIHandler(fn=repo_commands.view),
        "repo create": CLIHandler(fn=repo_commands.create_cmd, write=True),
        "repo fork": CLIHandler(fn=repo_commands.fork, write=True),
        "repo rename": CLIHandler(fn=repo_commands.rename, write=True),
        "repo edit": CLIHandler(fn=repo_commands.edit_cmd, write=True),
        "repo delete": CLIHandler(fn=repo_commands.delete_cmd, write=True),
        "release list": CLIHandler(fn=release_commands.list_cmd),
        "release view": CLIHandler(fn=release_commands.view_cmd),
        "release create": CLIHandler(
            fn=release_commands.create_cmd, write=True
        ),
        "run list": CLIHandler(fn=action_commands.run_list_cmd),
        "run view": CLIHandler(fn=action_commands.run_view_cmd),
        "run rerun": CLIHandler(fn=action_commands.run_rerun_cmd, write=True),
        "workflow list": CLIHandler(fn=action_commands.workflow_list_cmd),
        "workflow view": CLIHandler(fn=action_commands.workflow_view_cmd),
        "workflow run": CLIHandler(
            fn=action_commands.workflow_run_cmd, write=True
        ),
    },
    config_model=GhConfig,
)
