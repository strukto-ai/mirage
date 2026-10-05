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

from collections.abc import Awaitable, Callable
from typing import TypeVar

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.google.entry import resolve_app_entry
from mirage.core.hierarchy.probe import ReaddirFn
from mirage.core.hierarchy.scope import DetectFn, ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.types import ContentType, FileStat, FileType, PathSpec

A = TypeVar("A", bound=GoogleApiAccessor)


def make_app_stat(
    mime: str,
    detect_scope: DetectFn,
    readdir: ReaddirFn[A],
    resource_type: str,
    make_filename: Callable[[str, str, str], str],
) -> Callable[..., Awaitable[FileStat]]:
    """The stat of a Google app mount: a file resolves through Drive.

    Sheets, Docs and Slides stat the same tree and differ only in the
    MIME type a file carries and what they name it. Mirrors TS
    ``makeAppStat``.

    Args:
        mime (str): the Drive MIME type the app's files carry.
        detect_scope (DetectFn): the app's path classifier.
        readdir (ReaddirFn): the app's readdir.
        resource_type (str): the index entry's resource type.
        make_filename (Callable[[str, str, str], str]): the app's file
            name from a title, a file id and a modified time.
    """

    async def file_stat(
        accessor: GoogleApiAccessor,
        match: ScopeMatch,
        path: PathSpec,
        index: IndexCacheStore,
    ) -> FileStat:
        entry = await resolve_app_entry(
            accessor.token_manager,
            match,
            path,
            index,
            mime,
            resource_type,
            make_filename,
        )
        return FileStat(
            name=entry.vfs_name,
            type=FileType.FILE,
            content=ContentType.JSON,
            modified=entry.remote_time,
            size=entry.size,
            fingerprint=entry.remote_time or None,
            extra={
                "doc_id": entry.id,
                "doc_name": entry.name,
                **entry.extra,
            },
        )

    return make_stat(detect_scope, readdir, overrides={"file": file_stat})
