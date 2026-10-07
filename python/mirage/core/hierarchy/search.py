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

from collections.abc import Awaitable, Callable, Mapping

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.grep_pattern import compile_pattern
from mirage.commands.builtin.grep_pushdown import grep_search_options
from mirage.commands.builtin.types import RegexSyntax
from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.scope import ROOT, DetectFn, ScopeMatch
from mirage.shell.bytes import byte_view
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.vfs.types import SearchOp, SearchQuery, SearchResult, StatOp

LineMatcher = Callable[[str], bool]


def query_matcher(query: SearchQuery) -> LineMatcher:
    """Whether the generic scan would select a line, for this request.

    A searcher that has to decide a line itself (a candidate the service
    returned, or a line it rendered) decides it with this, so what it
    prints is what grep over the same file would print. grep's dialects
    match a line's byte view in the C locale and its text under a UTF-8
    one, as its scan does; ripgrep's match the text.

    Args:
        query (SearchQuery): the qualified request.
    """
    options = grep_search_options(query)
    rust = options.syntax is RegexSyntax.RUST
    utf8 = options.utf8
    pattern = compile_pattern(
        query.query if rust else byte_view(query.query, utf8),
        ignore_case=options.ignore_case,
        fixed_string=options.fixed_string,
        whole_word=options.whole_word,
        syntax=options.syntax,
        utf8=utf8,
    )
    if rust:
        return lambda line: pattern.search(line) is not None
    return lambda line: pattern.search(byte_view(line, utf8)) is not None


Searcher = Callable[
    [A, ScopeMatch, SearchQuery], Awaitable[list[SearchResult]]
]


def make_search_op(
    detect: DetectFn,
    searchers: Mapping[str, Searcher[A]],
    stat: StatOp | None = None,
) -> SearchOp:
    """Adapt scope-specific search functions to the VFS search contract.

    Args:
        detect (DetectFn): classify the requested path.
        searchers (Mapping[str, Searcher]): supported scope handlers.
        stat (StatOp | None): optional existence check for non-root scopes.
    """

    async def search(
        accessor: A,
        path: PathSpec,
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[SearchResult] | None:
        match = detect(path)
        searcher = searchers.get(match.kind)
        if searcher is None:
            return None
        if stat is not None and match.kind != ROOT:
            await stat(accessor, path, index)
        prefix = mount_prefix_of(path.virtual, path.vfs_path).rstrip("/")
        return [
            (
                PathSpec.from_str_path(
                    f"{prefix}/{hit.vfs_path.lstrip('/')}", hit.vfs_path
                ),
                text,
            )
            for hit, text in await searcher(accessor, match, query)
        ]

    return search
