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

from mirage.commands.cli.builtin.ntn.api import api
from mirage.commands.cli.builtin.ntn.auth.token import token
from mirage.commands.cli.builtin.ntn.datasources.query import query
from mirage.commands.cli.builtin.ntn.datasources.resolve import resolve
from mirage.commands.cli.builtin.ntn.failure import guarded
from mirage.commands.cli.builtin.ntn.pages.create import create
from mirage.commands.cli.builtin.ntn.pages.edit import edit
from mirage.commands.cli.builtin.ntn.pages.get import get
from mirage.commands.cli.builtin.ntn.pages.trash import trash
from mirage.commands.cli.builtin.ntn.whoami import whoami
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.core.notion.config import NotionConfig

# Operand names are upstream's, verbatim: they are what the refusal for
# a missing one prints, so they are part of the grammar rather than
# documentation. Each verb names its own, which is why there is no one
# shared ID slot.
PAGE_ID = Argument("PAGE_ID")
DATA_SOURCE_ID = Argument("ID_OR_URL")
DATABASE_ID = Argument("ID")
API_PATH = Argument("PATH", nargs="*")
JSON_OUT = Argument(
    "--json", action="store_true", help="Output the raw API response as JSON"
)
PLAIN = Argument(
    "--plain",
    action="store_true",
    help="Output as tab-separated values with no headers",
)
# NOTION_API_VERSION is upstream's own environment fallback, and naming
# it here is what makes the flag real: the executor fills the value from
# the session, so a leaf reads one flag rather than a flag and a
# fallback, and a usage line counts the option as supplied the way clap
# does.
NOTION_VERSION = Argument(
    "--notion-version",
    metavar="VERSION",
    env="NOTION_API_VERSION",
    help="Override the Notion-Version header",
)
CONTENT = Argument("--content", help="Markdown body (also read from stdin)")

# The ntn program tree, matching the official Notion CLI's grammar verb
# for verb: ids are positional, `pages get` renders Markdown with a
# frontmatter title, and the REST surface that has no typed verb is
# reached through `ntn api` exactly as upstream reaches it. There is no
# `ntn blocks`/`ntn comments`/`ntn search`; those are `ntn api
# v1/blocks/...`, `ntn api v1/comments` and `ntn api v1/search`.
# Upstream's interactive and deploy verbs (`login`, `logout`, `update`,
# `workers`, `notion-as-code`, `doctor`, `files`) are out of scope for a
# virtualized CLI. Install with a NotionConfig.
NTN = CLI(
    spec=CommandSpec(
        name="ntn",
        description="Notion CLI (Beta)",
        # Upstream is a clap program, so this one answers in clap's voice:
        # its help layout and its refusal for a missing operand are pinned
        # against the real binary by integ/ntn_conformance.ts.
        usage_style=UsageStyle.CLAP,
        subcommands=(
            CommandSpec(
                name="api",
                description="Call the public Notion API (beta)",
                arguments=(
                    API_PATH,
                    Argument(
                        "-d",
                        "--data",
                        help="Use a JSON string as the request body",
                    ),
                    Argument(
                        "-X",
                        "--method",
                        help="Override the inferred HTTP method",
                    ),
                    NOTION_VERSION,
                ),
            ),
            CommandSpec(
                name="auth",
                description="Inspect authentication credentials",
                subcommands=(
                    CommandSpec(
                        name="token",
                        description="Print the current authentication token",
                    ),
                ),
            ),
            CommandSpec(
                name="datasources",
                description="Manage data sources",
                subcommands=(
                    CommandSpec(
                        name="query",
                        description="Query pages in a data source",
                        arguments=(
                            DATA_SOURCE_ID,
                            Argument(
                                "--limit",
                                type="int",
                                help="Maximum rows to return",
                            ),
                            Argument(
                                "--start-cursor",
                                help="Cursor to resume from",
                            ),
                            Argument(
                                "-s",
                                "--sort",
                                action="append",
                                metavar="SPEC",
                                help="'<property> [asc|desc]'",
                            ),
                            Argument(
                                "--filter",
                                metavar="JSON",
                                help="Filter as a JSON object",
                            ),
                            Argument(
                                "--filter-file",
                                type="path",
                                metavar="PATH",
                                help="Read the filter from a file",
                            ),
                            JSON_OUT,
                            PLAIN,
                            NOTION_VERSION,
                        ),
                    ),
                    CommandSpec(
                        name="resolve",
                        description=(
                            "Resolve a Notion database ID "
                            "to its data source IDs"
                        ),
                        arguments=(
                            DATABASE_ID,
                            JSON_OUT,
                            NOTION_VERSION,
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="pages",
                description="Manage pages",
                subcommands=(
                    CommandSpec(
                        name="get",
                        description="Retrieve a page as Markdown",
                        arguments=(
                            PAGE_ID,
                            JSON_OUT,
                            NOTION_VERSION,
                        ),
                    ),
                    CommandSpec(
                        name="create",
                        description="Create a page from Markdown content",
                        arguments=(
                            CONTENT,
                            Argument(
                                "--parent",
                                help="page:<id>, database:<id>, or data-source:<id>",
                            ),
                            JSON_OUT,
                            NOTION_VERSION,
                        ),
                    ),
                    CommandSpec(
                        name="edit",
                        description="Edit a page's content from Markdown",
                        arguments=(
                            PAGE_ID,
                            CONTENT,
                            JSON_OUT,
                            NOTION_VERSION,
                        ),
                    ),
                    CommandSpec(
                        name="trash",
                        description="Trash a page",
                        arguments=(
                            PAGE_ID,
                            Argument(
                                "--yes",
                                action="store_true",
                                help="Skip the confirmation prompt",
                            ),
                            NOTION_VERSION,
                        ),
                    ),
                ),
            ),
            CommandSpec(
                name="whoami",
                description="Show the authenticated Notion user",
                arguments=(
                    JSON_OUT,
                    PLAIN,
                    NOTION_VERSION,
                ),
            ),
        ),
    ),
    handlers={
        "api": CLIHandler(fn=partial(guarded, api), write=True),
        "auth token": CLIHandler(fn=partial(guarded, token)),
        "datasources query": CLIHandler(fn=partial(guarded, query)),
        "datasources resolve": CLIHandler(fn=partial(guarded, resolve)),
        "pages get": CLIHandler(fn=partial(guarded, get)),
        "pages create": CLIHandler(fn=partial(guarded, create), write=True),
        "pages edit": CLIHandler(fn=partial(guarded, edit), write=True),
        "pages trash": CLIHandler(fn=partial(guarded, trash), write=True),
        "whoami": CLIHandler(fn=partial(guarded, whoami)),
    },
    config_model=NotionConfig,
)
