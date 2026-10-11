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

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.hierarchy.codec import PATH_SAFE
from mirage.core.lancedb.query import (
    holding_clause,
    list_tables,
    rows_where,
    table_columns,
    text_columns,
)
from mirage.core.lancedb.render import cell_text, render_card
from mirage.core.lancedb.scope import detect_for
from mirage.core.vector.scope import filters_of, table_of
from mirage.core.vector.types import Row
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path
from mirage.utils.record_search import record_queries
from mirage.vfs.lancedb.config import LanceDBConfig

# What a card spells outside its string values: a boolean, a null, a float
# no JSON number holds, and the blob line's name.
CARD_WORDS = frozenset(
    {"true", "false", "null", "nan", "inf", "infinity", "blob"}
)


def card_path(config: LanceDBConfig, row: Row) -> list[str]:
    """A row's card path below its table: its group values as the
    listing names them, then ``<id>.md``.

    Args:
        config (LanceDBConfig): the mount's config.
        row (Row): the row, its id and group columns selected.
    """
    segments = [
        PATH_SAFE.encode(cell_text(row[column]))
        for column in config.group_by
        if row.get(column) is not None
    ]
    return segments + [f"{cell_text(row[config.id_column])}.md"]


def hit(accessor: LanceDBAccessor, row: Row) -> tuple[list[str], bytes]:
    """A ranked row's path below its table, and its card.

    Args:
        accessor (LanceDBAccessor): the mount's accessor.
        row (Row): the ranked row.
    """
    return card_path(accessor.config, row), render_card(row, accessor.config)


async def files_containing(
    accessor: LanceDBAccessor,
    text: str,
    under: list[PathSpec],
    whole_word: bool,
    ignore_case: bool,
) -> list[PathSpec] | None:
    """The cards under ``under`` whose row holds ``text`` in a string
    column.

    A card is ``column: value`` lines, so a line grep matches holds the
    text in one value, unless it reaches into the column's name, the
    title's ``# `` or the separator: the text is asked only when
    ``record_queries`` passes it with every rendered column's name and
    ``CARD_WORDS`` as keys and it does not start with a space. A value
    that is not a string spells only digits and signs, or one of
    ``CARD_WORDS``; a table that renders a list, struct or bytes column
    reads every card, as does a scope inside a card.

    Args:
        accessor (LanceDBAccessor): the mount's accessor.
        text (str): the text searched for.
        under (list[PathSpec]): the directories walked.
        whole_word (bool): whether only whole words of ``text`` match.
        ignore_case (bool): fold ASCII case.
    """
    if text.startswith(" "):
        return None
    config = accessor.config
    skipped = {c for c in (config.vector_column, config.blob_column) if c}
    found: list[PathSpec] = []
    for scope in under:
        match = detect_for(accessor)(scope.mount_path)
        if match.kind == "root":
            tables = (
                [config.table] if config.table else await list_tables(accessor)
            )
        elif match.kind == "group":
            tables = [table_of(config.table, match)]
        else:
            return None
        filters = filters_of(config.group_by, match)
        for table in tables:
            columns = await text_columns(accessor, table, skipped)
            if columns is None:
                return None
            rendered = [
                c
                for c in await table_columns(accessor, table)
                if c not in skipped
            ]
            keys = frozenset(c.lower() for c in rendered) | CARD_WORDS
            queries = record_queries(text, keys, whole_word)
            if queries is None:
                return None
            if not columns:
                continue
            rows = await rows_where(
                accessor,
                table,
                holding_clause(columns, queries, ignore_case, filters),
                [config.id_column, *config.group_by],
            )
            base = "" if config.table else f"/{table}"
            for row in rows:
                if row.get(config.id_column) is None or any(
                    row.get(g) is None for g in config.group_by
                ):
                    continue
                path = "/".join(card_path(config, row))
                found.append(mounted_path(scope, f"{base}/{path}"))
    return found
