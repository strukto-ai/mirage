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

from mirage.commands.cli.builtin.ntn.blocks.append import append
from mirage.commands.cli.builtin.ntn.comments.create import \
    create as comment_create
from mirage.commands.cli.builtin.ntn.datasources.query import query
from mirage.commands.cli.builtin.ntn.pages.create import create
from mirage.commands.cli.builtin.ntn.pages.edit import edit
from mirage.commands.cli.builtin.ntn.pages.get import get
from mirage.commands.cli.builtin.ntn.pages.trash import trash
from mirage.commands.cli.builtin.ntn.search import search
from mirage.commands.cli.types import CLISpec
from mirage.commands.spec.types import Option
from mirage.core.notion.config import NotionConfig

# The ntn program tree, following the official Notion CLI grammar
# (`ntn pages get/create/edit/trash`, `ntn datasources query`). blocks,
# comments and search are mirage extensions spelled with the REST API's
# nouns; the official CLI reaches them through `ntn api`, which mirage
# does not ship (the TypeScript transport speaks MCP tool names, not
# raw REST paths). Install with a NotionConfig.
NTN = CLISpec(
    name="ntn",
    description="Notion API client",
    config_model=NotionConfig,
    subcommands=(
        CLISpec(
            name="pages",
            description="Manage pages",
            subcommands=(
                CLISpec(
                    name="get",
                    description="Retrieve a page",
                    fn=get,
                    options=(Option(long="--page", type="str",
                                    required=True), ),
                ),
                CLISpec(
                    name="create",
                    description="Create a page from a JSON body",
                    fn=create,
                    write=True,
                    options=(Option(
                        long="--json",
                        type="str",
                        required=True,
                        description=("Page body with parent and properties, "
                                     "as the POST /pages API resource"),
                    ), ),
                ),
                CLISpec(
                    name="edit",
                    description="Update a page's properties from JSON",
                    fn=edit,
                    write=True,
                    options=(
                        Option(long="--page", type="str", required=True),
                        Option(long="--json",
                               type="str",
                               required=True,
                               description="PATCH /pages body"),
                    ),
                ),
                CLISpec(
                    name="trash",
                    description="Move a page to the trash",
                    fn=trash,
                    write=True,
                    options=(Option(long="--page", type="str",
                                    required=True), ),
                ),
            ),
        ),
        CLISpec(
            name="blocks",
            description="Manage blocks",
            subcommands=(CLISpec(
                name="append",
                description="Append child blocks to a block or page",
                fn=append,
                write=True,
                options=(
                    Option(long="--block", type="str", required=True),
                    Option(long="--json",
                           type="str",
                           required=True,
                           description="Body with a children array"),
                ),
            ), ),
        ),
        CLISpec(
            name="comments",
            description="Manage comments",
            subcommands=(CLISpec(
                name="create",
                description="Add a comment to a page or discussion",
                fn=comment_create,
                write=True,
                options=(Option(
                    long="--json",
                    type="str",
                    required=True,
                    description="Body with parent and rich_text",
                ), ),
            ), ),
        ),
        CLISpec(
            name="datasources",
            description="Query data sources",
            subcommands=(CLISpec(
                name="query",
                description="Query a database's pages",
                fn=query,
                options=(
                    Option(long="--datasource",
                           type="str",
                           required=True,
                           description="Database ID"),
                    Option(long="--json",
                           type="str",
                           description="Filter and sorts body"),
                ),
            ), ),
        ),
        CLISpec(
            name="search",
            description="Search pages by title",
            fn=search,
            options=(
                Option(long="--query", type="str", required=True),
                Option(long="--limit",
                       type="int",
                       description="Max results (default: 20)"),
            ),
        ),
    ),
)
