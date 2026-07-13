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

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.postgres import _client
from mirage.core.postgres.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def is_dir_name(child: str) -> bool:
    # Entries are recognized by extension, so classification never needs the
    # stat fallback.
    name = child.rsplit("/", 1)[-1]
    return not (name.endswith(".json") or name.endswith(".jsonl"))


async def readdir(accessor: PostgresAccessor,
                  path: PathSpec,
                  index: IndexCacheStore = None) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    raw = path.directory if path.pattern else path.virtual
    if prefix and raw.startswith(prefix):
        raw = raw[len(prefix):] or "/"
    scope = detect_scope(
        PathSpec(virtual=raw,
                 directory=raw,
                 resource_path=mount_key(raw, prefix)))
    # Canonical key: no trailing slash (except root), or the same dir
    # indexes under two keys and cache hits return doubled-slash entries.
    virtual_key = ((prefix or "") + raw).rstrip("/") or "/"

    if scope.level == "root":
        return await _list_root(accessor, virtual_key, index, prefix)
    if scope.level == "schema":
        base = raw.rstrip("/")
        return [f"{prefix}{base}/tables", f"{prefix}{base}/views"]
    if scope.level == "kind":
        return await _list_entities(accessor, scope.schema, scope.kind,
                                    virtual_key, index, prefix, raw)
    if scope.level == "entity":
        base = raw.rstrip("/")
        return [
            f"{prefix}{base}/schema.json",
            f"{prefix}{base}/rows.jsonl",
        ]
    raise enoent(path)


async def _list_root(accessor: PostgresAccessor, virtual_key: str,
                     index: IndexCacheStore | None, prefix: str) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        schemas = await _client.list_schemas(conn, accessor.config.schemas)
    entries: list[tuple[str, IndexEntry]] = [(
        "database.json",
        IndexEntry(id="database.json",
                   name="database.json",
                   resource_type="postgres/database_json",
                   vfs_name="database.json"),
    )]
    for s in schemas:
        entries.append((s,
                        IndexEntry(id=s,
                                   name=s,
                                   resource_type="postgres/schema",
                                   vfs_name=s)))
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return [f"{prefix}/{name}" for name, _ in entries]


async def _list_entities(accessor: PostgresAccessor, schema: str, kind: str,
                         virtual_key: str, index: IndexCacheStore | None,
                         prefix: str, raw: str) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        if kind == "tables":
            names = await _client.list_tables(conn, schema)
        else:
            views = await _client.list_views(conn, schema)
            mviews = await _client.list_matviews(conn, schema)
            names = sorted(set(views) | set(mviews))
    entries: list[tuple[str, IndexEntry]] = []
    for n in names:
        entries.append((n,
                        IndexEntry(id=n,
                                   name=n,
                                   resource_type=f"postgres/{kind[:-1]}",
                                   vfs_name=n)))
    if index is not None:
        await index.set_dir(virtual_key, entries)
    base = raw.rstrip("/")
    return [f"{prefix}{base}/{n}" for n, _ in entries]
