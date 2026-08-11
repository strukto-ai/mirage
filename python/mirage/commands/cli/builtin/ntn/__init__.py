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
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Operand, Option, UsageStyle
from mirage.core.notion.config import NotionConfig

# Operand names are upstream's, verbatim: they are what the refusal for
# a missing one prints, so they are part of the grammar rather than
# documentation. Each verb names its own, which is why there is no one
# shared ID slot.
PAGE_ID = Operand(type="str", name="PAGE_ID", required=True)
DATA_SOURCE_ID = Operand(type="str", name="ID_OR_URL", required=True)
DATABASE_ID = Operand(type="str", name="ID", required=True)
API_PATH = Operand(type="str", name="PATH")
JSON_OUT = Option(long="--json",
                  type="bool",
                  description="Output the raw API response as JSON")
PLAIN = Option(long="--plain",
               type="bool",
               description="Output as tab-separated values with no headers")
# NOTION_API_VERSION is upstream's own environment fallback, and naming
# it here is what makes the flag real: the executor fills the value from
# the session, so a leaf reads one flag rather than a flag and a
# fallback, and a usage line counts the option as supplied the way clap
# does.
NOTION_VERSION = Option(long="--notion-version",
                        type="str",
                        metavar="VERSION",
                        env="NOTION_API_VERSION",
                        description="Override the Notion-Version header")
CONTENT = Option(long="--content",
                 type="str",
                 description="Markdown body (also read from stdin)")

# The ntn program tree, matching the official Notion CLI's grammar verb
# for verb: ids are positional, `pages get` renders Markdown with a
# frontmatter title, and the REST surface that has no typed verb is
# reached through `ntn api` exactly as upstream reaches it. There is no
# `ntn blocks`/`ntn comments`/`ntn search`; those are `ntn api
# v1/blocks/...`, `ntn api v1/comments` and `ntn api v1/search`.
# Upstream's interactive and deploy verbs (`login`, `logout`, `update`,
# `workers`, `notion-as-code`, `doctor`, `files`) are out of scope for a
# virtualized CLI. Install with a NotionConfig.
NTN = CLISpec(
    name="ntn",
    description="Notion CLI (Beta)",
    config_model=NotionConfig,
    # Upstream is a clap program, so this one answers in clap's voice:
    # its help layout and its refusal for a missing operand are pinned
    # against the real binary by integ/ntn_conformance.ts.
    usage_style=UsageStyle.CLAP,
    subcommands=(
        CLISpec(
            name="api",
            description="Call the public Notion API (beta)",
            fn=partial(guarded, api),
            write=True,
            rest=API_PATH,
            options=(
                Option(long="--data",
                       short="-d",
                       type="str",
                       description="Use a JSON string as the request body"),
                Option(long="--method",
                       short="-X",
                       type="str",
                       description="Override the inferred HTTP method"),
                NOTION_VERSION,
            ),
        ),
        CLISpec(
            name="auth",
            description="Inspect authentication credentials",
            subcommands=(CLISpec(
                name="token",
                description="Print the current authentication token",
                fn=partial(guarded, token),
            ), ),
        ),
        CLISpec(
            name="datasources",
            description="Manage data sources",
            subcommands=(
                CLISpec(
                    name="query",
                    description="Query pages in a data source",
                    fn=partial(guarded, query),
                    positional=(DATA_SOURCE_ID, ),
                    options=(
                        Option(long="--limit",
                               type="int",
                               description="Maximum rows to return"),
                        Option(long="--start-cursor",
                               type="str",
                               description="Cursor to resume from"),
                        Option(long="--sort",
                               short="-s",
                               type="str",
                               multiple=True,
                               metavar="SPEC",
                               description="'<property> [asc|desc]'"),
                        Option(long="--filter",
                               type="str",
                               metavar="JSON",
                               description="Filter as a JSON object"),
                        Option(long="--filter-file",
                               type="path",
                               metavar="PATH",
                               description="Read the filter from a file"),
                        JSON_OUT,
                        PLAIN,
                        NOTION_VERSION,
                    ),
                ),
                CLISpec(
                    name="resolve",
                    description=("Resolve a Notion database ID to its "
                                 "data source IDs"),
                    fn=partial(guarded, resolve),
                    positional=(DATABASE_ID, ),
                    options=(JSON_OUT, NOTION_VERSION),
                ),
            ),
        ),
        CLISpec(
            name="pages",
            description="Manage pages",
            subcommands=(
                CLISpec(
                    name="get",
                    description="Retrieve a page as Markdown",
                    fn=partial(guarded, get),
                    positional=(PAGE_ID, ),
                    options=(JSON_OUT, NOTION_VERSION),
                ),
                CLISpec(
                    name="create",
                    description="Create a page from Markdown content",
                    fn=partial(guarded, create),
                    write=True,
                    options=(
                        CONTENT,
                        Option(
                            long="--parent",
                            type="str",
                            description=("page:<id>, database:<id>, or "
                                         "data-source:<id>"),
                        ),
                        JSON_OUT,
                        NOTION_VERSION,
                    ),
                ),
                CLISpec(
                    name="edit",
                    description="Edit a page's content from Markdown",
                    fn=partial(guarded, edit),
                    write=True,
                    positional=(PAGE_ID, ),
                    options=(CONTENT, JSON_OUT, NOTION_VERSION),
                ),
                CLISpec(
                    name="trash",
                    description="Trash a page",
                    fn=partial(guarded, trash),
                    write=True,
                    positional=(PAGE_ID, ),
                    options=(
                        Option(long="--yes",
                               type="bool",
                               description="Skip the confirmation prompt"),
                        NOTION_VERSION,
                    ),
                ),
            ),
        ),
        CLISpec(
            name="whoami",
            description="Show the authenticated Notion user",
            fn=partial(guarded, whoami),
            options=(JSON_OUT, PLAIN, NOTION_VERSION),
        ),
    ),
)
