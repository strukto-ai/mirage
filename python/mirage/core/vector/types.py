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
from dataclasses import dataclass
from typing import Any, Generic

from mirage.core.hierarchy.codec import Codec
from mirage.core.hierarchy.probe import A
from mirage.core.hierarchy.read import Reader
from mirage.core.hierarchy.readdir import Lister
from mirage.core.hierarchy.scope import DetectFn
from mirage.types import ContentType

Row = dict[str, Any]

Leaf = tuple[str, Codec, ContentType]


@dataclass(frozen=True)
class VectorTree(Generic[A]):
    """What the shared row tree asks of one vector store.

    The tree lists the store's tables (or pins one), adds one directory
    level per ``group_by`` column, and renders one file per row and
    suffix. The shared kit answers the catalog, stat, read dispatch and
    the ranked search; the store answers its own listing below a table,
    its readers, and how a ranked row spells its path and body.

    Args:
        detect (Callable[[A], DetectFn]): the mount's classifier.
        pinned (Callable[[A], str | None]): the table the config pins.
        search_limit (Callable[[A], int]): the default ``top_k``.
        list_tables (Callable[[A], Awaitable[list[str]]]): the catalog.
        table_exists (Callable[[A, str], Awaitable[bool]]): whether one
            table exists.
        children (Lister[A]): the entries under a table or a group.
        readers (Mapping[str, Reader[A]]): one reader per leaf kind.
        search_rows (Callable[[A, str, str, int], Awaitable[list[Row]]]):
            the ranked rows of a table for a query and a limit.
        rank_key (str): the row key the rank rides under.
        drops (Callable[[float, float], bool]): whether a rank falls short
            of a positive threshold.
        hit (Callable[[A, Row], tuple[list[str], bytes]]): a ranked row's
            path segments below its table, and its body.
    """

    detect: Callable[[A], DetectFn]
    pinned: Callable[[A], str | None]
    search_limit: Callable[[A], int]
    list_tables: Callable[[A], Awaitable[list[str]]]
    table_exists: Callable[[A, str], Awaitable[bool]]
    children: Lister[A]
    readers: Mapping[str, Reader[A]]
    search_rows: Callable[[A, str, str, int], Awaitable[list[Row]]]
    rank_key: str
    drops: Callable[[float, float], bool]
    hit: Callable[[A, Row], tuple[list[str], bytes]]
