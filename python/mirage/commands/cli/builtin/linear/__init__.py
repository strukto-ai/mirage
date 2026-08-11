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
from mirage.commands.cli.builtin.linear.comment.update import \
    update as comment_update
from mirage.commands.cli.builtin.linear.issue.add_label import add_label
from mirage.commands.cli.builtin.linear.issue.assign import assign
from mirage.commands.cli.builtin.linear.issue.create import create
from mirage.commands.cli.builtin.linear.issue.set_priority import set_priority
from mirage.commands.cli.builtin.linear.issue.set_project import set_project
from mirage.commands.cli.builtin.linear.issue.transition import transition
from mirage.commands.cli.builtin.linear.issue.update import update
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Operand, Option
from mirage.core.linear.config import LinearConfig

TEAM_OPTION = Option(long="--team",
                     type="str",
                     required=True,
                     description="Team key, name, or ID")

ARG = Operand(type="str")

# The linear program tree, keeping the noun/verb grammar the mount
# commands already spoke (`linear issue create`, `linear team list`).
# Issues are addressed by positional key or ID (`linear issue get
# ENG-42`); free text (descriptions, comment bodies) comes from a flag
# or stdin. Install with a LinearConfig.
LINEAR = CLISpec(
    name="linear",
    description="Linear GraphQL API client",
    config_model=LinearConfig,
    subcommands=(
        CLISpec(
            name="team",
            description="Manage teams",
            subcommands=(
                CLISpec(
                    name="list",
                    description="List teams as JSON",
                    fn=reads.team_list,
                ),
                CLISpec(
                    name="get",
                    description="Get one team by key, name, or ID",
                    fn=reads.team_get,
                    rest=ARG,
                ),
                CLISpec(
                    name="members",
                    description="List a team's members",
                    fn=reads.team_members,
                    rest=ARG,
                ),
            ),
        ),
        CLISpec(
            name="issue",
            description="Manage issues",
            subcommands=(
                CLISpec(
                    name="list",
                    description="List a team's issues",
                    fn=reads.issue_list,
                    options=(TEAM_OPTION, ),
                ),
                CLISpec(
                    name="get",
                    description="Get one issue by key or ID",
                    fn=reads.issue_get,
                    rest=ARG,
                ),
                CLISpec(
                    name="create",
                    description="Create an issue",
                    fn=create,
                    write=True,
                    options=(
                        TEAM_OPTION,
                        Option(long="--title", type="str", required=True),
                        Option(long="--description",
                               type="str",
                               description="Body text (or pipe via stdin)"),
                    ),
                ),
                CLISpec(
                    name="update",
                    description="Update an issue's title or description",
                    fn=update,
                    write=True,
                    rest=ARG,
                    options=(
                        Option(long="--title", type="str"),
                        Option(long="--description",
                               type="str",
                               description="Body text (or pipe via stdin)"),
                    ),
                ),
                CLISpec(
                    name="assign",
                    description="Assign an issue to a user",
                    fn=assign,
                    write=True,
                    rest=ARG,
                    options=(
                        Option(long="--assignee-id", type="str"),
                        Option(long="--assignee-email", type="str"),
                    ),
                ),
                CLISpec(
                    name="transition",
                    description="Move an issue to a workflow state",
                    fn=transition,
                    write=True,
                    rest=ARG,
                    options=(
                        Option(long="--state-id", type="str"),
                        Option(long="--state-name", type="str"),
                    ),
                ),
                CLISpec(
                    name="set-priority",
                    description="Set an issue's priority",
                    fn=set_priority,
                    write=True,
                    rest=ARG,
                    options=(Option(
                        long="--priority",
                        type="int",
                        required=True,
                        description="0=none, 1=urgent, 2=high, 3=medium, "
                        "4=low",
                    ), ),
                ),
                CLISpec(
                    name="set-project",
                    description="Attach an issue to a project",
                    fn=set_project,
                    write=True,
                    rest=ARG,
                    options=(
                        Option(long="--project",
                               type="str",
                               description="Project ID"),
                        Option(long="--project-name",
                               type="str",
                               description="Project name, looked up on "
                               "the issue's team"),
                    ),
                ),
                CLISpec(
                    name="add-label",
                    description="Add a label to an issue",
                    fn=add_label,
                    write=True,
                    rest=ARG,
                    options=(
                        Option(long="--label",
                               type="str",
                               description="Label ID"),
                        Option(long="--label-name",
                               type="str",
                               description="Label name, looked up on "
                               "the issue's team"),
                    ),
                ),
            ),
        ),
        CLISpec(
            name="project",
            description="Manage projects",
            subcommands=(
                CLISpec(
                    name="list",
                    description="List a team's projects",
                    fn=reads.project_list,
                    options=(TEAM_OPTION, ),
                ),
                CLISpec(
                    name="get",
                    description="Get one project by ID",
                    fn=reads.project_get,
                    rest=ARG,
                    options=(TEAM_OPTION, ),
                ),
            ),
        ),
        CLISpec(
            name="cycle",
            description="Manage cycles",
            subcommands=(
                CLISpec(
                    name="list",
                    description="List a team's cycles",
                    fn=reads.cycle_list,
                    options=(TEAM_OPTION, ),
                ),
                CLISpec(
                    name="current",
                    description="Get a team's current cycle",
                    fn=reads.cycle_current,
                    options=(TEAM_OPTION, ),
                ),
                CLISpec(
                    name="get",
                    description="Get one cycle by ID",
                    fn=reads.cycle_get,
                    rest=ARG,
                    options=(TEAM_OPTION, ),
                ),
            ),
        ),
        CLISpec(
            name="label",
            description="Manage labels",
            subcommands=(CLISpec(
                name="list",
                description="List a team's labels",
                fn=reads.label_list,
                options=(TEAM_OPTION, ),
            ), ),
        ),
        CLISpec(
            name="comment",
            description="Manage comments",
            subcommands=(
                CLISpec(
                    name="list",
                    description="List an issue's comments",
                    fn=reads.comment_list,
                    rest=ARG,
                ),
                CLISpec(
                    name="add",
                    description="Comment on an issue",
                    fn=comment_add,
                    write=True,
                    rest=ARG,
                    options=(Option(long="--body",
                                    type="str",
                                    description="Comment text "
                                    "(or pipe via stdin)"), ),
                ),
                CLISpec(
                    name="update",
                    description="Edit a comment",
                    fn=comment_update,
                    write=True,
                    options=(
                        Option(long="--comment",
                               type="str",
                               required=True,
                               description="Comment ID"),
                        Option(long="--body",
                               type="str",
                               description="Comment text "
                               "(or pipe via stdin)"),
                    ),
                ),
            ),
        ),
        CLISpec(
            name="user",
            description="Manage users",
            subcommands=(
                CLISpec(
                    name="list",
                    description="List workspace users",
                    fn=reads.user_list,
                ),
                CLISpec(
                    name="get",
                    description="Get one user by email",
                    fn=reads.user_get,
                    rest=ARG,
                ),
            ),
        ),
        CLISpec(
            name="document",
            description="Manage documents",
            subcommands=(
                CLISpec(
                    name="list",
                    description="List a team's documents",
                    fn=reads.document_list,
                    options=(TEAM_OPTION, ),
                ),
                CLISpec(
                    name="get",
                    description="Get one document by ID",
                    fn=reads.document_get,
                    rest=ARG,
                    options=(TEAM_OPTION, ),
                ),
            ),
        ),
        CLISpec(
            name="search",
            description="Search issues by text",
            fn=reads.search,
            rest=ARG,
            options=(Option(long="--query", type="str"), ),
        ),
    ),
)
