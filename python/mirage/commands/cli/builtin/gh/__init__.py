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
from mirage.commands.cli.builtin.gh.search import search_spec
from mirage.commands.cli.builtin.gh.types import RepoEditField
from mirage.commands.cli.builtin.gh.version import version
from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.commands.cli.walk import find_child, node_help
from mirage.commands.spec.types import Operand, Option
from mirage.core.github.config import GhConfig
from mirage.io.types import IOResult

REPO = Option(
    short="-R",
    long="--repo",
    type="str",
    description="Select another repository, as [HOST/]OWNER/REPO",
)
JSON = Option(
    long="--json", type="str", description="Output selected JSON fields"
)
JQ = Option(
    short="-q", long="--jq", type="str", description="Filter JSON output"
)
LIMIT_30 = Option(short="-L", long="--limit", type="int", default="30")
BODY = Option(short="-b", long="--body", type="str")
BODY_FILE = Option(short="-F", long="--body-file", type="path")
TITLE = Option(short="-t", long="--title", type="str")
NUMBER = Operand(type="str", name="NUMBER", required=True)


def _flag(
    short: str | None = None, long: str = "", description: str | None = None
) -> Option:
    """One of gh's boolean flags, which are pflag's.

    A bare ``--draft`` is true, and ``--draft=true`` or ``--draft=false``
    spells the value out, which is how a script turns one off. The
    shorts still cluster (``-sd``). Read one with ``gh_bool``.

    Args:
        short (str | None): the short spelling.
        long (str): the long spelling.
        description (str | None): the help line.
    """
    return Option(
        short=short,
        long=long,
        type="str",
        value_optional=True,
        short_value=False,
        choices=BOOLEAN,
        description=description,
    )


def _repo_edit_option(field: RepoEditField) -> Option:
    """Build the grammar from the setting consumed by the handler.

    Args:
        field (RepoEditField): Repository setting definition.
    """
    return Option(
        short=field.short,
        long=field.flag,
        type="str",
        value_optional=field.kind != "value",
        choices=field.choices if field.kind == "value" else BOOLEAN,
        description=field.description,
    )


def _issue() -> CLISpec:
    return CLISpec(
        name="issue",
        description="Manage issues",
        subcommands=(
            CLISpec(
                name="list",
                aliases=("ls",),
                description="List issues",
                fn=issue_commands.list_cmd,
                options=(
                    REPO,
                    JSON,
                    JQ,
                    LIMIT_30,
                    Option(
                        short="-s",
                        long="--state",
                        type="str",
                        choices=("open", "closed", "all"),
                        default="open",
                    ),
                    Option(short="-a", long="--assignee", type="str"),
                    Option(short="-A", long="--author", type="str"),
                    Option(
                        short="-l", long="--label", type="str", multiple=True
                    ),
                ),
            ),
            CLISpec(
                name="view",
                description="View an issue",
                fn=issue_commands.view_cmd,
                positional=(NUMBER,),
                options=(
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
            CLISpec(
                name="create",
                aliases=("new",),
                description="Create an issue",
                fn=issue_commands.create_cmd,
                write=True,
                options=(
                    REPO,
                    TITLE,
                    BODY,
                    BODY_FILE,
                    Option(
                        short="-a",
                        long="--assignee",
                        type="str",
                        multiple=True,
                    ),
                    Option(
                        short="-l", long="--label", type="str", multiple=True
                    ),
                ),
            ),
            CLISpec(
                name="edit",
                description="Edit an issue",
                fn=issue_commands.edit_cmd,
                write=True,
                positional=(NUMBER,),
                options=(
                    REPO,
                    TITLE,
                    BODY,
                    BODY_FILE,
                    Option(long="--add-assignee", type="str", multiple=True),
                    Option(
                        long="--remove-assignee", type="str", multiple=True
                    ),
                    Option(long="--add-label", type="str", multiple=True),
                    Option(long="--remove-label", type="str", multiple=True),
                ),
            ),
            CLISpec(
                name="close",
                description="Close an issue",
                fn=issue_commands.close_cmd,
                write=True,
                positional=(NUMBER,),
                options=(REPO,),
            ),
            CLISpec(
                name="reopen",
                description="Reopen an issue",
                fn=issue_commands.reopen_cmd,
                write=True,
                positional=(NUMBER,),
                options=(REPO,),
            ),
            CLISpec(
                name="comment",
                description="Add a comment to an issue",
                fn=issue_commands.comment_cmd,
                write=True,
                positional=(NUMBER,),
                options=(REPO, BODY, BODY_FILE),
            ),
        ),
    )


def _pr() -> CLISpec:
    return CLISpec(
        name="pr",
        description="Manage pull requests",
        subcommands=(
            CLISpec(
                name="list",
                aliases=("ls",),
                description="List pull requests",
                fn=pull_commands.list_cmd,
                options=(
                    REPO,
                    JSON,
                    JQ,
                    LIMIT_30,
                    Option(
                        short="-s",
                        long="--state",
                        type="str",
                        choices=("open", "closed", "merged", "all"),
                        default="open",
                    ),
                    Option(short="-B", long="--base", type="str"),
                    Option(short="-H", long="--head", type="str"),
                ),
            ),
            CLISpec(
                name="view",
                description="View a pull request",
                fn=pull_commands.view_cmd,
                positional=(NUMBER,),
                options=(
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
            CLISpec(
                name="create",
                aliases=("new",),
                description="Create a pull request",
                fn=pull_commands.create_cmd,
                write=True,
                options=(
                    REPO,
                    TITLE,
                    BODY,
                    BODY_FILE,
                    Option(short="-H", long="--head", type="str"),
                    Option(short="-B", long="--base", type="str"),
                    _flag(short="-d", long="--draft"),
                    _flag(long="--no-maintainer-edit"),
                ),
            ),
            CLISpec(
                name="edit",
                description="Edit a pull request",
                fn=pull_commands.edit_cmd,
                write=True,
                positional=(NUMBER,),
                options=(
                    REPO,
                    TITLE,
                    BODY,
                    BODY_FILE,
                    Option(short="-B", long="--base", type="str"),
                ),
            ),
            CLISpec(
                name="merge",
                description="Merge a pull request",
                fn=pull_commands.merge_cmd,
                write=True,
                positional=(NUMBER,),
                options=(
                    REPO,
                    BODY,
                    BODY_FILE,
                    _flag(short="-m", long="--merge"),
                    _flag(short="-r", long="--rebase"),
                    _flag(short="-s", long="--squash"),
                    Option(short="-t", long="--subject", type="str"),
                    Option(long="--match-head-commit", type="str"),
                ),
            ),
            CLISpec(
                name="close",
                description="Close a pull request",
                fn=pull_commands.close_cmd,
                write=True,
                positional=(NUMBER,),
                options=(REPO,),
            ),
            CLISpec(
                name="comment",
                description="Add a comment to a pull request",
                fn=pull_commands.comment_cmd,
                write=True,
                positional=(NUMBER,),
                options=(REPO, BODY, BODY_FILE),
            ),
            CLISpec(
                name="diff",
                description="View changes in a pull request",
                fn=pull_commands.diff_cmd,
                positional=(NUMBER,),
                options=(
                    REPO,
                    _flag(
                        long="--name-only",
                        description="Display only names of changed files",
                    ),
                ),
            ),
            CLISpec(
                name="checks",
                description="Show CI checks for a pull request",
                fn=pull_commands.checks_cmd,
                positional=(NUMBER,),
                options=(REPO, JSON, JQ),
            ),
        ),
    )


REPO_EDIT_OPTIONS = (
    *(_repo_edit_option(field) for field in REPO_EDIT_FIELDS),
    Option(
        long="--add-topic",
        type="str",
        multiple=True,
        description="Add repository topic",
    ),
    Option(
        long="--remove-topic",
        type="str",
        multiple=True,
        description="Remove repository topic",
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


def _repo() -> CLISpec:
    return CLISpec(
        name="repo",
        description="Manage repositories",
        subcommands=(
            CLISpec(
                name="list",
                aliases=("ls",),
                description="List repositories",
                fn=repo_commands.list_cmd,
                positional=(Operand(type="str", name="OWNER"),),
                options=(JSON, JQ, LIMIT_30),
            ),
            CLISpec(
                name="clone",
                description="Clone a repository locally",
                fn=repo_commands.clone_cmd,
                positional=(
                    Operand(type="str", name="REPOSITORY"),
                    Operand(type="str", name="DIRECTORY"),
                ),
                rest=Operand(type="str", name="GITFLAGS"),
                options=(
                    Option(
                        short="-u",
                        long="--upstream-remote-name",
                        type="str",
                        description="Upstream remote name when cloning a fork",
                    ),
                    _flag(
                        long="--no-upstream",
                        description="Do not add an upstream remote when "
                        "cloning a fork",
                    ),
                ),
            ),
            CLISpec(
                name="view",
                description="View a repository",
                fn=repo_commands.view,
                positional=(Operand(type="str", name="REPOSITORY"),),
                options=(REPO, JSON, JQ),
            ),
            CLISpec(
                name="create",
                description="Create a repository",
                fn=repo_commands.create_cmd,
                write=True,
                positional=(Operand(type="str", name="NAME"),),
                options=(
                    _flag(long="--public"),
                    _flag(long="--private"),
                    Option(short="-d", long="--description", type="str"),
                    Option(short="-h", long="--homepage", type="str"),
                    _flag(long="--add-readme"),
                ),
            ),
            CLISpec(
                name="fork",
                description="Create a fork of a repository",
                fn=repo_commands.fork,
                write=True,
                positional=(Operand(type="str", name="REPOSITORY"),),
                options=(
                    _flag(long="--clone", description="Clone the fork"),
                    _flag(
                        long="--default-branch-only",
                        description="Only include the default branch in the "
                        "fork",
                    ),
                    Option(
                        long="--fork-name",
                        type="str",
                        description="Rename the forked repository",
                    ),
                    Option(
                        long="--org",
                        type="str",
                        description="Create the fork in an organization",
                    ),
                    _flag(
                        long="--remote",
                        description="Add a git remote for the fork",
                    ),
                    Option(
                        long="--remote-name",
                        type="str",
                        description="Specify the name for the new remote",
                    ),
                ),
            ),
            CLISpec(
                name="rename",
                description="Rename a repository",
                fn=repo_commands.rename,
                write=True,
                positional=(
                    Operand(type="str", name="NEW-NAME", required=True),
                ),
                options=(REPO,),
            ),
            CLISpec(
                name="edit",
                description="Edit repository settings",
                fn=repo_commands.edit_cmd,
                write=True,
                positional=(Operand(type="str", name="REPOSITORY"),),
                options=REPO_EDIT_OPTIONS,
            ),
            CLISpec(
                name="delete",
                description="Delete a repository",
                fn=repo_commands.delete_cmd,
                write=True,
                positional=(Operand(type="str", name="REPOSITORY"),),
                options=REPO_DELETE_OPTIONS,
            ),
        ),
    )


def _release() -> CLISpec:
    return CLISpec(
        name="release",
        description="Manage releases",
        subcommands=(
            CLISpec(
                name="list",
                aliases=("ls",),
                description="List releases",
                fn=release_commands.list_cmd,
                options=(REPO, JSON, JQ, LIMIT_30),
            ),
            CLISpec(
                name="view",
                description="View a release",
                fn=release_commands.view_cmd,
                positional=(Operand(type="str", name="TAG", required=True),),
                options=(REPO, JSON, JQ),
            ),
            CLISpec(
                name="create",
                description="Create a release",
                fn=release_commands.create_cmd,
                write=True,
                positional=(Operand(type="str", name="TAG", required=True),),
                options=(
                    REPO,
                    Option(short="-n", long="--notes", type="str"),
                    Option(short="-F", long="--notes-file", type="path"),
                    TITLE,
                    _flag(short="-d", long="--draft"),
                    _flag(short="-p", long="--prerelease"),
                    _flag(long="--generate-notes"),
                    Option(long="--target", type="str"),
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
    Option(
        short="-r",
        long="--ref",
        type="str",
        description="The branch or tag name which contains the version of "
        "the workflow file you'd like to view",
    ),
)


def _run() -> CLISpec:
    return CLISpec(
        name="run",
        description="View workflow runs",
        subcommands=(
            CLISpec(
                name="list",
                aliases=("ls",),
                description="List workflow runs",
                fn=action_commands.run_list_cmd,
                options=(
                    REPO,
                    JSON,
                    JQ,
                    Option(
                        short="-L", long="--limit", type="int", default="20"
                    ),
                    Option(short="-b", long="--branch", type="str"),
                    Option(short="-c", long="--commit", type="str"),
                    Option(long="--created", type="str"),
                    Option(short="-e", long="--event", type="str"),
                    Option(short="-s", long="--status", type="str"),
                    Option(short="-u", long="--user", type="str"),
                    Option(short="-w", long="--workflow", type="str"),
                ),
            ),
            CLISpec(
                name="view",
                description="View a workflow run",
                fn=action_commands.run_view_cmd,
                positional=(
                    Operand(type="str", name="RUN-ID", required=True),
                ),
                options=RUN_VIEW_OPTIONS,
            ),
            CLISpec(
                name="rerun",
                description="Rerun a workflow run",
                fn=action_commands.run_rerun_cmd,
                write=True,
                positional=(
                    Operand(type="str", name="RUN-ID", required=True),
                ),
                options=(
                    REPO,
                    _flag(short="-d", long="--debug"),
                    _flag(long="--failed"),
                    Option(short="-j", long="--job", type="str"),
                ),
            ),
        ),
    )


def _workflow() -> CLISpec:
    return CLISpec(
        name="workflow",
        description="Manage workflows",
        subcommands=(
            CLISpec(
                name="list",
                aliases=("ls",),
                description="List workflows",
                fn=action_commands.workflow_list_cmd,
                options=(
                    REPO,
                    JSON,
                    JQ,
                    Option(
                        short="-L", long="--limit", type="int", default="50"
                    ),
                    _flag(short="-a", long="--all"),
                ),
            ),
            CLISpec(
                name="view",
                description="View a workflow",
                fn=action_commands.workflow_view_cmd,
                positional=(
                    Operand(type="str", name="WORKFLOW", required=True),
                ),
                options=WORKFLOW_VIEW_OPTIONS,
            ),
            CLISpec(
                name="run",
                description="Run a workflow",
                fn=action_commands.workflow_run_cmd,
                write=True,
                positional=(
                    Operand(type="str", name="WORKFLOW", required=True),
                ),
                options=(
                    REPO,
                    Option(short="-r", long="--ref", type="str"),
                    Option(
                        short="-f",
                        long="--raw-field",
                        type="str",
                        multiple=True,
                    ),
                    Option(
                        short="-F", long="--field", type="str", multiple=True
                    ),
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
    node = GH
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
            for child in GH.subcommands
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
        " ".join(("gh", *path)), node, GH.usage_style
    ).encode(), IOResult()


GH = CLISpec(
    name="gh",
    description="GitHub CLI",
    config_model=GhConfig,
    subcommands=(
        CLISpec(
            name="auth",
            description="Manage authentication",
            subcommands=(
                CLISpec(
                    name="status",
                    description="Check the configured token",
                    fn=auth_status,
                ),
                CLISpec(
                    name="token",
                    description="Token display is unavailable in Mirage",
                    fn=auth_token,
                    options=(
                        Option(
                            long="--hostname",
                            type="str",
                            description="The hostname of the GitHub instance "
                            "authenticated with",
                        ),
                        Option(
                            short="-u",
                            long="--user",
                            type="str",
                            description="The account selector; tokens are "
                            "never printed",
                        ),
                    ),
                ),
            ),
        ),
        CLISpec(
            name="help",
            fn=_help_cmd,
            description="Help about any command",
            rest=Operand(type="str"),
        ),
        CLISpec(
            name="version",
            aliases=("--version",),
            fn=version,
            description="Show the Mirage GitHub CLI implementation version",
        ),
        CLISpec(
            name="api",
            description="Make an authenticated GitHub API request",
            fn=api,
            write=True,
            positional=(Operand(type="str", name="ENDPOINT", required=True),),
            options=(
                Option(short="-X", long="--method", type="str"),
                Option(
                    short="-f", long="--raw-field", type="str", multiple=True
                ),
                Option(short="-F", long="--field", type="str", multiple=True),
                Option(short="-H", long="--header", type="str", multiple=True),
                _flag(
                    short="-i",
                    long="--include",
                    description="Include HTTP response status line "
                    "and headers in the output",
                ),
                Option(long="--input", type="path"),
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
)
