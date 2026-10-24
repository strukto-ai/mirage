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

import re
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from typing import Any

from bson import ObjectId
from gridfs.errors import NoFile

from mirage.accessor.gridfs import GridFSAccessor
from mirage.vfs.gridfs.config import GridFSConfig

_EPOCH = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _selects(query: dict[str, Any], doc: dict[str, Any]) -> bool:
    """Whether a files document matches the subset of the query language
    the GridFS driver uses.

    Args:
        query (dict[str, Any]): an fs.files filter.
        doc (dict[str, Any]): the document.
    """
    for field, spec in query.items():
        if field == "$or":
            if not any(_selects(sub, doc) for sub in spec):
                return False
            continue
        value = doc[field]
        if not isinstance(spec, dict):
            if value != spec:
                return False
        elif "$regex" in spec:
            if not re.match(spec["$regex"], value):
                return False
        elif "$in" in spec:
            if value not in spec["$in"]:
                return False
        else:
            raise NotImplementedError(spec)
    return True


def _latest_first(doc: dict[str, Any]) -> tuple[Any, ...]:
    return (-doc["uploadDate"].timestamp(), str(doc["_id"]))


class FakeStore:
    """A GridFS bucket in memory: the files collection, its chunks and the
    bucket API the driver, the reads and the event hook call.

    Each upload is one revision with its own ``_id`` and a later
    ``uploadDate``, so the newest-wins sort orders them as pymongo would.

    Args:
        names (list[str]): filenames to seed, one empty revision each.
    """

    def __init__(self, names: list[str] | None = None) -> None:
        self.docs: list[dict[str, Any]] = []
        self.chunks: dict[ObjectId, bytes] = {}
        self._uploads = 0
        for name in names or []:
            self.upload(name, b"")

    def upload(self, filename: str, data: bytes) -> ObjectId:
        """Add one revision of ``filename`` holding ``data``.

        Args:
            filename (str): the backend key.
            data (bytes): the revision's content.
        """
        self._uploads += 1
        oid = ObjectId()
        self.docs.append(
            {
                "_id": oid,
                "filename": filename,
                "length": len(data),
                "uploadDate": _EPOCH + timedelta(seconds=self._uploads),
            }
        )
        self.chunks[oid] = data
        return oid

    def names(self) -> list[str]:
        """Every revision's filename, in upload order."""
        return [doc["filename"] for doc in self.docs]

    def ids(self, filename: str) -> list[ObjectId]:
        """The ``_id`` of each revision of ``filename``, oldest first.

        Args:
            filename (str): the backend key.
        """
        return [d["_id"] for d in self.docs if d["filename"] == filename]

    def _match(self, query: dict[str, Any]) -> list[dict[str, Any]]:
        return [doc for doc in self.docs if _selects(query, doc)]

    async def _iter(
        self, docs: list[dict[str, Any]]
    ) -> AsyncIterator[dict[str, Any]]:
        for doc in docs:
            yield dict(doc)

    def find(self, query: dict[str, Any], projection: Any = None) -> Any:
        return self._iter(self._match(query))

    async def find_one(
        self, query: dict[str, Any], sort: Any = None, projection: Any = None
    ) -> dict[str, Any] | None:
        found = self._match(query)
        if sort is not None:
            found.sort(key=_latest_first)
        return dict(found[0]) if found else None

    async def count_documents(self, query: dict[str, Any], limit: int) -> int:
        return min(len(self._match(query)), limit)

    async def update_one(
        self, query: dict[str, Any], update: dict[str, Any]
    ) -> None:
        for doc in self._match(query)[:1]:
            doc.update(update["$set"])

    async def update_many(
        self, query: dict[str, Any], update: dict[str, Any]
    ) -> None:
        for doc in self._match(query):
            doc.update(update["$set"])

    async def delete_many(self, query: dict[str, Any]) -> None:
        if "files_id" in query:
            for oid in query["files_id"]["$in"]:
                self.chunks.pop(oid, None)
            return
        gone = set(query["_id"]["$in"])
        self.docs = [d for d in self.docs if d["_id"] not in gone]

    async def aggregate(self, pipeline: list[dict[str, Any]]) -> Any:
        # The two pipelines the client builds: newest per filename
        # (iter_latest) and every _id per filename, newest first (prune).
        docs = sorted(
            self._match(pipeline[0]["$match"]),
            key=lambda d: (d["filename"], *_latest_first(d)),
        )
        grouped: dict[str, list[dict[str, Any]]] = {}
        for doc in docs:
            grouped.setdefault(doc["filename"], []).append(doc)
        fields = pipeline[2]["$group"]
        out = []
        for name, revisions in sorted(grouped.items()):
            row: dict[str, Any] = {"_id": name}
            if "ids" in fields:
                row["ids"] = [d["_id"] for d in revisions]
            else:
                row["fid"] = revisions[0]["_id"]
                row["length"] = revisions[0]["length"]
                row["uploadDate"] = revisions[0]["uploadDate"]
            out.append(row)
        return self._iter(out)

    async def upload_from_stream(self, filename: str, data: bytes) -> ObjectId:
        return self.upload(filename, data)

    def open_upload_stream(self, filename: str) -> "_Upload":
        return _Upload(self, filename)

    async def open_download_stream(self, file_id: ObjectId) -> "_Download":
        if file_id not in self.chunks:
            raise NoFile(str(file_id))
        return _Download(self.chunks[file_id])


class _Upload:
    def __init__(self, store: FakeStore, filename: str) -> None:
        self._store = store
        self._filename = filename
        self._parts: list[bytes] = []
        self._id = ObjectId()

    async def write(self, chunk: bytes) -> None:
        self._parts.append(bytes(chunk))

    async def close(self) -> None:
        self._id = self._store.upload(self._filename, b"".join(self._parts))

    async def abort(self) -> None:
        self._parts.clear()


class _Download:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self._pos = 0

    async def seek(self, offset: int) -> None:
        self._pos = offset

    async def read(self, size: int) -> bytes:
        end = len(self._data) if size < 0 else self._pos + size
        out = self._data[self._pos : end]
        self._pos = end
        return out

    async def close(self) -> None:
        return None


def make_accessor(**config: Any) -> GridFSAccessor:
    """A GridFS accessor over a config no fake ever connects with.

    Args:
        **config (Any): ``GridFSConfig`` fields beyond the uri and database.
    """
    return GridFSAccessor(
        GridFSConfig(uri="mongodb://localhost:27017", database="db", **config)
    )
