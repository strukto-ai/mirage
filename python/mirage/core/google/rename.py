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
from mirage.core.google.drive import get_file, patch_file
from mirage.core.google.scope import DATE_LEN, app_filename
from mirage.core.hierarchy.scope import INVALID, DetectFn
from mirage.errors.fs import eisdir, enoent, fs_error
from mirage.errors.types import FsCondition
from mirage.types import FileStat, PathSpec

G = TypeVar("G", bound=GoogleApiAccessor)


def app_title(
    name: str, file_id: str, modified: str, suffix: str
) -> str | None:
    """The title a file name gives a file, None when the listing would
    render that title under any other name.

    Args:
        name (str): the file name asked for.
        file_id (str): the file's Drive id.
        modified (str): the file's modified time, ISO 8601.
        suffix (str): the app's file suffix, e.g. ``.gdoc.json``.
    """
    lead = f"{modified[:DATE_LEN]}_" if len(modified) >= DATE_LEN else ""
    tail = f"__{file_id}{suffix}"
    if not name.startswith(lead) or not name.endswith(tail):
        return None
    title = name[len(lead) : len(name) - len(tail)]
    if app_filename(title, file_id, modified, suffix=suffix) != name:
        return None
    return title


def make_app_rename(
    detect: DetectFn,
    suffix: str,
) -> Callable[..., Awaitable[None]]:
    """The rename of a Google app mount: a new title for a file.

    A file can take only a name the listing renders back (same folder,
    date and id); its modified time goes back unchanged, as rename(2)
    leaves it, and any other name is EPERM.

    Args:
        detect (DetectFn): the app's path classifier.
        suffix (str): the app's file suffix.
    """

    async def rename(
        accessor: G,
        src: PathSpec,
        dst: PathSpec,
        entry: FileStat | None = None,
    ) -> None:
        match = detect(src)
        if match.kind != "file":
            if match.kind != INVALID and (
                match.scope is None or not match.scope.leaf
            ):
                raise eisdir(src.virtual)
            raise enoent(src)
        if entry is None:
            raise enoent(src)
        doc_id = str(entry.extra["doc_id"])
        tm = accessor.token_manager
        modified = str((await get_file(tm, doc_id)).get("modifiedTime", ""))
        folder, _, name = dst.virtual.rpartition("/")
        title = app_title(name, doc_id, modified, suffix)
        if title is None or folder != src.virtual.rpartition("/")[0]:
            raise fs_error(dst, FsCondition.EPERM)
        await patch_file(tm, doc_id, {"name": title, "modifiedTime": modified})

    return rename
