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

# Commands, flags and help lines from gh 2.85.0 (MIT; see
# licenses/third_party/gh.txt).

from mirage.commands.cli.builtin.gh.args import JQ, JSON, REPO, TEMPLATE
from mirage.commands.cli.builtin.gh.args import flag as _flag
from mirage.commands.spec.types import Argument, CommandSpec


def admin_specs() -> tuple[CommandSpec, ...]:
    return (
        CommandSpec(
            name="cache",
            description="Manage GitHub Actions caches",
            subcommands=(
                CommandSpec(
                    name="delete",
                    description="Delete GitHub Actions caches",
                    arguments=(
                        Argument(
                            "CACHE-ID",
                            nargs="*",
                            metavar="[<cache-id> | <cache-key> | --all]",
                        ),
                        REPO,
                        _flag(
                            short="-a",
                            long="--all",
                            description="Delete all caches",
                        ),
                        Argument(
                            "-r",
                            "--ref",
                            help=(
                                "Delete by cache key and ref, formatted "
                                "as refs/heads/<branch name> or "
                                "refs/pull/<number>/merge"
                            ),
                        ),
                        _flag(
                            long="--succeed-on-no-caches",
                            metavar="--all",
                            description=(
                                "Return exit code 0 if no caches found. "
                                "Must be used in conjunction with --all"
                            ),
                        ),
                    ),
                ),
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description="List GitHub Actions caches",
                    arguments=(
                        REPO,
                        JQ,
                        JSON,
                        Argument(
                            "-k", "--key", help="Filter by cache key prefix"
                        ),
                        Argument(
                            "-L",
                            "--limit",
                            type="int",
                            default="30",
                            help="Maximum number of caches to fetch",
                        ),
                        Argument(
                            "-O",
                            "--order",
                            choices=(
                                "asc",
                                "desc",
                            ),
                            default="desc",
                            help="Order of caches returned",
                        ),
                        Argument(
                            "-r",
                            "--ref",
                            help=(
                                "Filter by ref, formatted as "
                                "refs/heads/<branch name> or "
                                "refs/pull/<number>/merge"
                            ),
                        ),
                        Argument(
                            "-S",
                            "--sort",
                            choices=(
                                "created_at",
                                "last_accessed_at",
                                "size_in_bytes",
                            ),
                            default="last_accessed_at",
                            help="Sort fetched caches",
                        ),
                        TEMPLATE,
                    ),
                ),
            ),
        ),
        CommandSpec(
            name="gist",
            description="Manage gists",
            subcommands=(
                CommandSpec(
                    name="create",
                    aliases=("new",),
                    description="Create a new GitHub gist with given contents",
                    arguments=(
                        Argument(
                            "FILENAME",
                            nargs="*",
                            metavar="[<filename>... | <pattern>... | -]",
                        ),
                        Argument(
                            "-d", "--desc", help="A description for this gist"
                        ),
                        Argument(
                            "-f",
                            "--filename",
                            help=(
                                "Provide a filename to be used when "
                                "reading from standard input"
                            ),
                        ),
                        _flag(
                            short="-p",
                            long="--public",
                            description='List the gist publicly (default "secret")',
                        ),
                    ),
                ),
                CommandSpec(
                    name="delete",
                    description="Delete a GitHub gist",
                    arguments=(
                        Argument("ID", nargs="*", metavar="{<id> | <url>}"),
                        _flag(
                            long="--yes",
                            description="Confirm deletion without prompting",
                        ),
                    ),
                ),
                CommandSpec(
                    name="edit",
                    description="Edit one of your gists",
                    arguments=(
                        Argument(
                            "ID",
                            nargs="*",
                            metavar="{<id> | <url>} [<filename>]",
                        ),
                        Argument(
                            "-a", "--add", help="Add a new file to the gist"
                        ),
                        Argument(
                            "-d", "--desc", help="New description for the gist"
                        ),
                        Argument(
                            "-f", "--filename", help="Select a file to edit"
                        ),
                        Argument(
                            "-r",
                            "--remove",
                            help="Remove a file from the gist",
                        ),
                    ),
                ),
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description="List gists from your user account",
                    arguments=(
                        Argument(
                            "--filter",
                            metavar="expression",
                            help="Filter gists using a regular expression",
                        ),
                        _flag(
                            long="--include-content",
                            description="Include gists' file content when filtering",
                        ),
                        Argument(
                            "-L",
                            "--limit",
                            type="int",
                            default="10",
                            help="Maximum number of gists to fetch",
                        ),
                        _flag(
                            long="--public",
                            description="Show only public gists",
                        ),
                        _flag(
                            long="--secret",
                            description="Show only secret gists",
                        ),
                    ),
                ),
                CommandSpec(
                    name="rename",
                    description="Rename a file in the given gist ID / URL",
                    arguments=(
                        Argument(
                            "ID",
                            nargs="*",
                            metavar="{<id> | <url>} <old-filename> <new-filename>",
                        ),
                    ),
                ),
                CommandSpec(
                    name="view",
                    description=(
                        "View the given gist or select from recent gists"
                    ),
                    arguments=(
                        Argument("ID", nargs="*", metavar="[<id> | <url>]"),
                        Argument(
                            "-f",
                            "--filename",
                            help="Display a single file from the gist",
                        ),
                        _flag(
                            long="--files",
                            description="List file names from the gist",
                        ),
                        _flag(
                            short="-r",
                            long="--raw",
                            description="Print raw instead of rendered gist contents",
                        ),
                    ),
                ),
                CommandSpec(
                    name="clone",
                    description="Clone a GitHub gist locally",
                    arguments=(
                        Argument(
                            "GIST",
                            nargs="*",
                            metavar="<gist> [<directory>] [-- <gitflags>...]",
                        ),
                    ),
                ),
            ),
        ),
        CommandSpec(
            name="label",
            description="Manage labels",
            subcommands=(
                CommandSpec(
                    name="clone",
                    description=(
                        "Clones labels from a source repository to a "
                        "destination repository on GitHub"
                    ),
                    arguments=(
                        Argument(
                            "SOURCE-REPOSITORY",
                            nargs="*",
                            metavar="<source-repository>",
                        ),
                        REPO,
                        _flag(
                            short="-f",
                            long="--force",
                            description=(
                                "Overwrite labels in the destination "
                                "repository"
                            ),
                        ),
                    ),
                ),
                CommandSpec(
                    name="create",
                    description=(
                        "Create a new label on GitHub, or update an existing "
                        "one with `--force`"
                    ),
                    arguments=(
                        Argument("NAME", nargs="*", metavar="<name>"),
                        REPO,
                        Argument("-c", "--color", help="Color of the label"),
                        Argument(
                            "-d",
                            "--description",
                            help="Description of the label",
                        ),
                        _flag(
                            short="-f",
                            long="--force",
                            description=(
                                "Update the label color and description "
                                "if label already exists"
                            ),
                        ),
                    ),
                ),
                CommandSpec(
                    name="delete",
                    description="Delete a label from a repository",
                    arguments=(
                        Argument("NAME", nargs="*", metavar="<name>"),
                        REPO,
                        _flag(
                            long="--yes",
                            description="Confirm deletion without prompting",
                        ),
                    ),
                ),
                CommandSpec(
                    name="edit",
                    description="Update a label on GitHub",
                    arguments=(
                        Argument("NAME", nargs="*", metavar="<name>"),
                        REPO,
                        Argument("-c", "--color", help="Color of the label"),
                        Argument(
                            "-d",
                            "--description",
                            help="Description of the label",
                        ),
                        Argument("-n", "--name", help="New name of the label"),
                    ),
                ),
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description="Display labels in a GitHub repository",
                    arguments=(
                        REPO,
                        JQ,
                        JSON,
                        Argument(
                            "-L",
                            "--limit",
                            type="int",
                            default="30",
                            help="Maximum number of labels to fetch",
                        ),
                        Argument(
                            "--order",
                            choices=(
                                "asc",
                                "desc",
                            ),
                            default="asc",
                            help="Order of labels returned",
                        ),
                        Argument(
                            "-S",
                            "--search",
                            help="Search label names and descriptions",
                        ),
                        Argument(
                            "--sort",
                            choices=(
                                "created",
                                "name",
                            ),
                            default="created",
                            help="Sort fetched labels",
                        ),
                        TEMPLATE,
                    ),
                ),
            ),
        ),
        CommandSpec(
            name="org",
            description="Manage organizations",
            subcommands=(
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description=(
                        "List organizations for the authenticated user"
                    ),
                    arguments=(
                        Argument(
                            "-L",
                            "--limit",
                            type="int",
                            default="30",
                            help="Maximum number of organizations to list",
                        ),
                    ),
                ),
            ),
        ),
        CommandSpec(
            name="ruleset",
            description="View info about repo rulesets",
            subcommands=(
                CommandSpec(
                    name="check",
                    description=(
                        "View information about GitHub rules that apply to a "
                        "given branch"
                    ),
                    arguments=(
                        Argument("BRANCH", nargs="*", metavar="[<branch>]"),
                        REPO,
                        _flag(
                            long="--default",
                            description="Check rules on default branch",
                        ),
                    ),
                ),
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description=(
                        "List GitHub rulesets for a repository or organization"
                    ),
                    arguments=(
                        REPO,
                        Argument(
                            "-L",
                            "--limit",
                            type="int",
                            default="30",
                            help="Maximum number of rulesets to list",
                        ),
                        Argument(
                            "-o",
                            "--org",
                            help=(
                                "List organization-wide rulesets for the "
                                "provided organization"
                            ),
                        ),
                        _flag(
                            short="-p",
                            long="--parents",
                            description=(
                                "Whether to include rulesets configured "
                                "at higher levels that also apply "
                                "(default true)"
                            ),
                        ),
                    ),
                ),
                CommandSpec(
                    name="view",
                    description="View information about a GitHub ruleset",
                    arguments=(
                        Argument(
                            "RULESET-ID", nargs="*", metavar="[<ruleset-id>]"
                        ),
                        REPO,
                        Argument(
                            "-o",
                            "--org",
                            help=(
                                "Organization name if the provided ID is "
                                "an organization-level ruleset"
                            ),
                        ),
                        _flag(
                            short="-p",
                            long="--parents",
                            description=(
                                "Whether to include rulesets configured "
                                "at higher levels that also apply "
                                "(default true)"
                            ),
                        ),
                    ),
                ),
            ),
        ),
        CommandSpec(
            name="secret",
            description="Manage GitHub secrets",
            subcommands=(
                CommandSpec(
                    name="delete",
                    aliases=("remove",),
                    description=(
                        "Delete a secret on one of the following levels:"
                    ),
                    arguments=(
                        Argument(
                            "SECRET-NAME", nargs="*", metavar="<secret-name>"
                        ),
                        REPO,
                        Argument(
                            "-a",
                            "--app",
                            choices=(
                                "actions",
                                "codespaces",
                                "dependabot",
                            ),
                            help="Delete a secret for a specific application",
                        ),
                        Argument(
                            "-e",
                            "--env",
                            help="Delete a secret for an environment",
                        ),
                        Argument(
                            "-o",
                            "--org",
                            help="Delete a secret for an organization",
                        ),
                        _flag(
                            short="-u",
                            long="--user",
                            description="Delete a secret for your user",
                        ),
                    ),
                ),
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description="List secrets on one of the following levels:",
                    arguments=(
                        REPO,
                        Argument(
                            "-a",
                            "--app",
                            choices=(
                                "actions",
                                "codespaces",
                                "dependabot",
                            ),
                            help="List secrets for a specific application",
                        ),
                        Argument(
                            "-e",
                            "--env",
                            help="List secrets for an environment",
                        ),
                        JQ,
                        JSON,
                        Argument(
                            "-o",
                            "--org",
                            help="List secrets for an organization",
                        ),
                        TEMPLATE,
                        _flag(
                            short="-u",
                            long="--user",
                            description="List a secret for your user",
                        ),
                    ),
                ),
            ),
        ),
        CommandSpec(
            name="variable",
            description="Manage GitHub Actions variables",
            subcommands=(
                CommandSpec(
                    name="delete",
                    aliases=("remove",),
                    description=(
                        "Delete a variable on one of the following levels:"
                    ),
                    arguments=(
                        Argument(
                            "VARIABLE-NAME",
                            nargs="*",
                            metavar="<variable-name>",
                        ),
                        REPO,
                        Argument(
                            "-e",
                            "--env",
                            help="Delete a variable for an environment",
                        ),
                        Argument(
                            "-o",
                            "--org",
                            help="Delete a variable for an organization",
                        ),
                    ),
                ),
                CommandSpec(
                    name="get",
                    description=(
                        "Get a variable on one of the following levels:"
                    ),
                    arguments=(
                        Argument(
                            "VARIABLE-NAME",
                            nargs="*",
                            metavar="<variable-name>",
                        ),
                        REPO,
                        Argument(
                            "-e",
                            "--env",
                            help="Get a variable for an environment",
                        ),
                        JQ,
                        JSON,
                        Argument(
                            "-o",
                            "--org",
                            help="Get a variable for an organization",
                        ),
                        TEMPLATE,
                    ),
                ),
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description=(
                        "List variables on one of the following levels:"
                    ),
                    arguments=(
                        REPO,
                        Argument(
                            "-e",
                            "--env",
                            help="List variables for an environment",
                        ),
                        JQ,
                        JSON,
                        Argument(
                            "-o",
                            "--org",
                            help="List variables for an organization",
                        ),
                        TEMPLATE,
                    ),
                ),
                CommandSpec(
                    name="set",
                    description=(
                        "Set a value for a variable on one of the following "
                        "levels:"
                    ),
                    arguments=(
                        Argument(
                            "VARIABLE-NAME",
                            nargs="*",
                            metavar="<variable-name>",
                        ),
                        REPO,
                        Argument(
                            "-b",
                            "--body",
                            help=(
                                "The value for the variable (reads from "
                                "standard input if not specified)"
                            ),
                        ),
                        Argument(
                            "-e",
                            "--env",
                            metavar="environment",
                            help="Set deployment environment variable",
                        ),
                        Argument(
                            "-f",
                            "--env-file",
                            type="path",
                            metavar="file",
                            help=(
                                "Load variable names and values from a "
                                "dotenv-formatted file"
                            ),
                        ),
                        Argument(
                            "-o",
                            "--org",
                            metavar="organization",
                            help="Set organization variable",
                        ),
                        Argument(
                            "-r",
                            "--repos",
                            action="append",
                            metavar="repositories",
                            help=(
                                "List of repositories that can access an "
                                "organization variable"
                            ),
                        ),
                        Argument(
                            "-v",
                            "--visibility",
                            choices=(
                                "all",
                                "private",
                                "selected",
                            ),
                            default="private",
                            help="Set visibility for an organization variable",
                        ),
                    ),
                ),
            ),
        ),
    )


def repo_group_specs() -> tuple[CommandSpec, ...]:
    return (
        CommandSpec(
            name="autolink",
            description="Manage autolink references",
            subcommands=(
                CommandSpec(
                    name="create",
                    aliases=("new",),
                    description=(
                        "Create a new autolink reference for a repository"
                    ),
                    arguments=(
                        Argument(
                            "KEYPREFIX",
                            nargs="*",
                            metavar="<keyPrefix> <urlTemplate>",
                        ),
                        REPO,
                        _flag(
                            short="-n",
                            long="--numeric",
                            description="Mark autolink as numeric",
                        ),
                    ),
                ),
                CommandSpec(
                    name="delete",
                    description=(
                        "Delete an autolink reference for a repository"
                    ),
                    arguments=(
                        Argument("ID", nargs="*", metavar="<id>"),
                        REPO,
                        _flag(
                            long="--yes",
                            description="Confirm deletion without prompting",
                        ),
                    ),
                ),
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description=(
                        "Gets all autolink references that are configured for "
                        "a repository"
                    ),
                    arguments=(
                        REPO,
                        JQ,
                        JSON,
                        TEMPLATE,
                    ),
                ),
                CommandSpec(
                    name="view",
                    description="View an autolink reference for a repository",
                    arguments=(
                        Argument("ID", nargs="*", metavar="<id>"),
                        REPO,
                        JQ,
                        JSON,
                        TEMPLATE,
                    ),
                ),
            ),
        ),
        CommandSpec(
            name="deploy-key",
            description="Manage deploy keys in a repository",
            subcommands=(
                CommandSpec(
                    name="add",
                    description="Add a deploy key to a GitHub repository",
                    arguments=(
                        Argument("KEY-FILE", nargs="*", metavar="<key-file>"),
                        REPO,
                        _flag(
                            short="-w",
                            long="--allow-write",
                            description="Allow write access for the key",
                        ),
                        Argument("-t", "--title", help="Title of the new key"),
                    ),
                ),
                CommandSpec(
                    name="delete",
                    description="Delete a deploy key from a GitHub repository",
                    arguments=(
                        Argument("KEY-ID", nargs="*", metavar="<key-id>"),
                        REPO,
                    ),
                ),
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description="List deploy keys in a GitHub repository",
                    arguments=(
                        REPO,
                        JQ,
                        JSON,
                        TEMPLATE,
                    ),
                ),
            ),
        ),
        CommandSpec(
            name="gitignore",
            description=(
                "List and view available repository gitignore templates"
            ),
            subcommands=(
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description=(
                        "List available repository gitignore templates"
                    ),
                ),
                CommandSpec(
                    name="view",
                    description=(
                        "View an available repository `.gitignore` template"
                    ),
                    arguments=(
                        Argument("TEMPLATE", nargs="*", metavar="<template>"),
                    ),
                ),
            ),
        ),
        CommandSpec(
            name="license",
            description="Explore repository licenses",
            subcommands=(
                CommandSpec(
                    name="list",
                    aliases=("ls",),
                    description="List common repository licenses",
                ),
                CommandSpec(
                    name="view",
                    description=(
                        "View a specific repository license by license key or "
                        "SPDX ID"
                    ),
                    arguments=(
                        Argument(
                            "LICENSE-KEY",
                            nargs="*",
                            metavar="{<license-key> | <spdx-id>}",
                        ),
                    ),
                ),
            ),
        ),
    )
