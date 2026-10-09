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

from mirage.commands.cli.builtin.linear import reads
from mirage.commands.cli.builtin.linear.comment.add import add as comment_add
from mirage.commands.cli.builtin.linear.comment.update import (
    update as comment_update,
)
from mirage.commands.cli.builtin.linear.issue.add_label import add_label
from mirage.commands.cli.builtin.linear.issue.assign import assign
from mirage.commands.cli.builtin.linear.issue.create import create
from mirage.commands.cli.builtin.linear.issue.set_priority import set_priority
from mirage.commands.cli.builtin.linear.issue.set_project import set_project
from mirage.commands.cli.builtin.linear.issue.transition import transition
from mirage.commands.cli.builtin.linear.issue.update import update
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.core.linear.config import LinearConfig

TEAM_OPTION = Argument("--team", required=True, help="Team key, name, or ID")

ARG = Argument("text", nargs="*", metavar="")

# The linear program tree, keeping the noun/verb grammar the mount
# commands already spoke (`linear issue create`, `linear team list`).
# Issues are addressed by positional key or ID (`linear issue get
# ENG-42`); free text (descriptions, comment bodies) comes from a flag
# or stdin. Install with a LinearConfig.
LINEAR = CLI(
    spec=CommandSpec(
        name="linear",
        description="Linear GraphQL API client",
        subcommands=(
            CommandSpec(
                name="team",
                description="Manage teams",
                subcommands=(
                    CommandSpec(name="list", description="List teams as JSON"),
                    CommandSpec(
                        name="get",
                        description="Get one team by key, name, or ID",
                        arguments=(ARG,),
                    ),
                    CommandSpec(
                        name="members",
                        description="List a team's members",
                        arguments=(ARG,),
                    ),
                ),
            ),
            CommandSpec(
                name="issue",
                description="Manage issues",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List a team's issues",
                        arguments=(TEAM_OPTION,),
                    ),
                    CommandSpec(
                        name="get",
                        description="Get one issue by key or ID",
                        arguments=(ARG,),
                    ),
                    CommandSpec(
                        name="create",
                        description="Create an issue",
                        arguments=(
                            TEAM_OPTION,
                            Argument("--title", required=True),
                            Argument(
                                "--description",
                                help="Body text (or pipe via stdin)",
                            ),
                        ),
                    ),
                    CommandSpec(
                        name="update",
                        description="Update an issue's title or description",
                        arguments=(
                            ARG,
                            Argument("--title"),
                            Argument(
                                "--description",
                                help="Body text (or pipe via stdin)",
                            ),
                        ),
                    ),
                    CommandSpec(
                        name="assign",
                        description="Assign an issue to a user",
                        arguments=(
                            ARG,
                            Argument("--assignee-id"),
                            Argument("--assignee-email"),
                        ),
                    ),
                    CommandSpec(
                        name="transition",
                        description="Move an issue to a workflow state",
                        arguments=(
                            ARG,
                            Argument("--state-id"),
                            Argument("--state-name"),
                        ),
                    ),
                    CommandSpec(
                        name="set-priority",
                        description="Set an issue's priority",
                        arguments=(
                            ARG,
                            Argument(
                                "--priority",
                                type="int",
                                required=True,
                                help="0=none, 1=urgent, 2=high, 3=medium, "
                                "4=low",
                            ),
                        ),
                    ),
                    CommandSpec(
                        name="set-project",
                        description="Attach an issue to a project",
                        arguments=(
                            ARG,
                            Argument("--project", help="Project ID"),
                            Argument(
                                "--project-name",
                                help="Project name, looked up on "
                                "the issue's team",
                            ),
                        ),
                    ),
                    CommandSpec(
                        name="add-label",
                        description="Add a label to an issue",
                        arguments=(
                            ARG,
                            Argument("--label", help="Label ID"),
                            Argument(
                                "--label-name",
                                help="Label name, looked up on "
                                "the issue's team",
                            ),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="project",
                description="Manage projects",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List a team's projects",
                        arguments=(TEAM_OPTION,),
                    ),
                    CommandSpec(
                        name="get",
                        description="Get one project by ID",
                        arguments=(
                            ARG,
                            TEAM_OPTION,
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="cycle",
                description="Manage cycles",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List a team's cycles",
                        arguments=(TEAM_OPTION,),
                    ),
                    CommandSpec(
                        name="current",
                        description="Get a team's current cycle",
                        arguments=(TEAM_OPTION,),
                    ),
                    CommandSpec(
                        name="get",
                        description="Get one cycle by ID",
                        arguments=(
                            ARG,
                            TEAM_OPTION,
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="label",
                description="Manage labels",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List a team's labels",
                        arguments=(TEAM_OPTION,),
                    ),
                ),
            ),
            CommandSpec(
                name="comment",
                description="Manage comments",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List an issue's comments",
                        arguments=(ARG,),
                    ),
                    CommandSpec(
                        name="add",
                        description="Comment on an issue",
                        arguments=(
                            ARG,
                            Argument(
                                "--body",
                                help="Comment text (or pipe via stdin)",
                            ),
                        ),
                    ),
                    CommandSpec(
                        name="update",
                        description="Edit a comment",
                        arguments=(
                            Argument(
                                "--comment",
                                required=True,
                                help="Comment ID",
                            ),
                            Argument(
                                "--body",
                                help="Comment text (or pipe via stdin)",
                            ),
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="user",
                description="Manage users",
                subcommands=(
                    CommandSpec(
                        name="list", description="List workspace users"
                    ),
                    CommandSpec(
                        name="get",
                        description="Get one user by email",
                        arguments=(ARG,),
                    ),
                ),
            ),
            CommandSpec(
                name="document",
                description="Manage documents",
                subcommands=(
                    CommandSpec(
                        name="list",
                        description="List a team's documents",
                        arguments=(TEAM_OPTION,),
                    ),
                    CommandSpec(
                        name="get",
                        description="Get one document by ID",
                        arguments=(
                            ARG,
                            TEAM_OPTION,
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="search",
                description="Search issues by text",
                arguments=(
                    ARG,
                    Argument("--query"),
                ),
            ),
        ),
    ),
    handlers={
        "team list": CLIHandler(fn=reads.team_list),
        "team get": CLIHandler(fn=reads.team_get),
        "team members": CLIHandler(fn=reads.team_members),
        "issue list": CLIHandler(fn=reads.issue_list),
        "issue get": CLIHandler(fn=reads.issue_get),
        "issue create": CLIHandler(fn=create, write=True),
        "issue update": CLIHandler(fn=update, write=True),
        "issue assign": CLIHandler(fn=assign, write=True),
        "issue transition": CLIHandler(fn=transition, write=True),
        "issue set-priority": CLIHandler(fn=set_priority, write=True),
        "issue set-project": CLIHandler(fn=set_project, write=True),
        "issue add-label": CLIHandler(fn=add_label, write=True),
        "project list": CLIHandler(fn=reads.project_list),
        "project get": CLIHandler(fn=reads.project_get),
        "cycle list": CLIHandler(fn=reads.cycle_list),
        "cycle current": CLIHandler(fn=reads.cycle_current),
        "cycle get": CLIHandler(fn=reads.cycle_get),
        "label list": CLIHandler(fn=reads.label_list),
        "comment list": CLIHandler(fn=reads.comment_list),
        "comment add": CLIHandler(fn=comment_add, write=True),
        "comment update": CLIHandler(fn=comment_update, write=True),
        "user list": CLIHandler(fn=reads.user_list),
        "user get": CLIHandler(fn=reads.user_get),
        "document list": CLIHandler(fn=reads.document_list),
        "document get": CLIHandler(fn=reads.document_get),
        "search": CLIHandler(fn=reads.search),
    },
    config_model=LinearConfig,
)
