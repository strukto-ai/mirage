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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.paths import default_paths
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import Context
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.io.types import IOResult
from mirage.types import JsonValue, PathSpec, SearchQuery


def search_options(fl: FlagView, prog: str) -> dict[str, JsonValue]:
    """The options a line gives the mount's search, only those it names.

    The mount answers an absent one with its own default and refuses a
    value it cannot take, before it sends any request.

    Args:
        fl (FlagView): the line's flags.
        prog (str): the name the CLI is installed under.

    Raises:
        UsageError: ``--top-k`` below 1.
    """
    options: dict[str, JsonValue] = {}
    top_k = fl.as_int("top_k")
    if top_k is not None:
        if top_k < 1:
            raise UsageError(f"{prog}: top-k must be positive")
        options["top_k"] = top_k
    threshold = fl.as_float("threshold")
    if threshold is not None:
        options["threshold"] = threshold
    method = fl.as_str("method")
    if method is not None:
        options["method"] = method
    return options


async def search(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[bytes, IOResult]:
    """Rank the records under every scope for one query and print each
    hit's record.

    One search through the dispatcher, the scopes after the first riding
    along as ``scopes``: it ranks them as one where the mount serving
    them all ranks a batch, and searches each and joins the hits in scope
    order otherwise. A declined query fails rather than reading as no
    matches.

    Args:
        accessor (Accessor): the install's accessor, unused.
        paths (list[PathSpec]): the scopes; the working directory when
            none is given.
        texts (list[str]): the query.
        ctx (Context): the invocation context.
    """
    prog = ctx.spec.name if ctx.spec is not None else "search"
    if not texts or not texts[0]:
        raise UsageError(f"{prog}: query is required")
    if ctx.vfs is None:
        raise RuntimeError("no workspace files")
    query = SearchQuery(
        texts[0], options=search_options(FlagView(ctx.flags, ctx.spec), prog)
    )
    scopes = default_paths(paths, ctx.cwd)
    records, _ = await ctx.vfs.dispatch(
        "search", scopes[0], query=query, scopes=scopes[1:]
    )
    if records is None:
        raise NotImplementedError("the mount declined the query")
    out = "".join(record + "\n" for _, record in records).encode()
    return out, IOResult()


SEARCH = CLI(
    spec=CommandSpec(
        name="search",
        description="Rank the records of a search mount for a query",
        arguments=(
            Argument(
                "--method",
                help="Ranking method: semantic (default); Dify also takes "
                "fulltext, hybrid and keyword",
            ),
            Argument(
                "--top-k",
                type="int",
                help="Most hits to print; the mount's default when absent",
            ),
            Argument(
                "--threshold",
                type="float",
                help="Lowest score a hit needs, or on LanceDB the largest "
                "distance it may have; 0 keeps every hit",
            ),
            Argument("query", nargs="?", help="Text to rank records by"),
            Argument(
                "paths",
                type="path",
                nargs="*",
                help="Folders or files to search; the working directory "
                "when none is given",
            ),
        ),
    ),
    handlers={"": CLIHandler(fn=search)},
)
