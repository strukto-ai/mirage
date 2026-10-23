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

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.google.constants import TOP_LEVEL_DIRS
from mirage.core.google.date_glob import glob_to_modified_range
from mirage.core.google.entry import app_file
from mirage.core.hierarchy.scope import DetectFn
from mirage.errors.fs import enoent
from mirage.types import DirListing, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import raw_path_of


def make_app_readdir(
    mime: str,
    detect_scope: DetectFn,
    make_filename: Callable[[str, str, str], str],
) -> Callable[
    [GoogleApiAccessor, PathSpec], Awaitable[list[FileStat] | DirListing]
]:
    """The readdir of a Google app mount: its corpora and their files.

    Sheets, Docs and Slides list the same tree, one Drive query per
    corpus narrowed to the app's MIME type, and differ only in what they
    name a file and how they classify a path.

    Args:
        mime (str): the Drive MIME type the app's files carry.
        detect_scope (DetectFn): the app's path classifier.
        make_filename (Callable[[str, str, str], str]): the app's file
            name from a title, a file id and a modified time.
    """

    async def readdir(
        accessor: GoogleApiAccessor, path_spec: PathSpec
    ) -> list[FileStat] | DirListing:
        modified_range = None
        if path_spec.pattern:
            modified_range = glob_to_modified_range(path_spec.pattern)
        path = raw_path_of(path_spec.dir if path_spec.pattern else path_spec)
        key = path.strip("/")

        # Bespoke below the classifier: the date-glob push-down filters
        # the Drive query itself, and a filtered or incomplete listing
        # is no listing of the directory, which the kit readdir has no
        # notion of.
        match = detect_scope(path)
        if match.kind == "root":
            return [
                FileStat(name=d, type=FileType.DIRECTORY)
                for d in TOP_LEVEL_DIRS
            ]

        if match.kind != "corpus":
            raise enoent(path_spec.virtual)

        files, complete = await accessor.drive.list_all_files(
            mime_type=mime,
            modified_after=modified_range[0] if modified_range else None,
            modified_before=modified_range[1] if modified_range else None,
        )
        is_owned = key == "owned"
        rows = []
        for f in files:
            owners = f.get("owners", [])
            first_owner = owners[0] if owners else {}
            if first_owner.get("me", False) != is_owned:
                continue
            name = make_filename(f["name"], f["id"], f.get("modifiedTime", ""))
            rows.append(app_file(name, f))
        # A modified-range listing is a filtered view rather than the
        # directory, and an incomplete all-corpora search is a directory
        # Drive could not finish reading. Neither may stand in for the
        # directory: keeping one would pin a short listing until it
        # expires. The rows are real either way.
        return DirListing(
            entries=rows, partial=bool(modified_range) or not complete
        )

    return readdir
