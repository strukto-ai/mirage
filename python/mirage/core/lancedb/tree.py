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

import operator

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.lancedb.query import list_tables, search_rows, table_exists
from mirage.core.lancedb.read import READERS
from mirage.core.lancedb.readdir import children
from mirage.core.lancedb.scope import detect_for
from mirage.core.lancedb.search import hit
from mirage.core.vector.read import make_read
from mirage.core.vector.readdir import make_readdir
from mirage.core.vector.search import make_search
from mirage.core.vector.stat import make_stat
from mirage.core.vector.types import VectorTree

TREE: VectorTree[LanceDBAccessor] = VectorTree(
    detect=detect_for,
    pinned=lambda accessor: accessor.config.table,
    search_limit=lambda accessor: accessor.config.search_limit,
    list_tables=list_tables,
    table_exists=table_exists,
    children=children,
    readers=READERS,
    search_rows=search_rows,
    rank_key="_distance",
    drops=operator.gt,
    hit=hit,
)

readdir = make_readdir(TREE)
read = make_read(TREE)
stat = make_stat(TREE, read)
SEARCH = make_search(TREE)
