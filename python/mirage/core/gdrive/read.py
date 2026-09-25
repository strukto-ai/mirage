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

import hashlib
import posixpath
from functools import partial

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.cache.index.warm import entry_or_warm
from mirage.core.gdocs.read import read_doc
from mirage.core.gdrive import DIRECTORY_RESOURCE_TYPES
from mirage.core.gdrive.fingerprint import drive_fingerprint
from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.versions import (capture_file_metadata,
                                         download_revision)
from mirage.core.google.client import TokenManager
from mirage.core.google.drive import download_file
from mirage.core.gsheets.read import read_spreadsheet
from mirage.core.gslides.read import read_presentation
from mirage.observe.context import (active_recorder, record, revision_for,
                                    start_op)
from mirage.types import JsonValue, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of
from mirage.utils.ranges import slice_window, window_for


async def read_bytes(
    token_manager: TokenManager,
    file_id: str,
) -> bytes:
    return await download_file(token_manager, file_id)


_NATIVE_RESOURCE_TYPES = frozenset(
    {"gdrive/gdoc", "gdrive/gsheet", "gdrive/gslide"})


def _whole_file(offset: int, size: int | None) -> bool:
    """Whether a read returned the entire object rather than a window.

    A token describes the whole object, and `latest_fingerprint`'s
    byte-identity guard applies only to writes, so a windowed body
    stamped with one would read as fresh for the life of the entry. Both
    read paths ask this before stamping; a guard written twice is a
    guard the two paths can drift apart on.

    Args:
        offset (int): first byte the caller asked for.
        size (int | None): how many bytes, or None for the rest.
    """
    return offset == 0 and size is None


def _verified_tokens(md5: str | None, head_revision: str | None,
                     modified: str | None, data: bytes, offset: int,
                     size: int | None) -> tuple[str | None, str | None]:
    """The (fingerprint, revision) pair that describes bytes we just read.

    The capture and the download are two separate requests, so the
    metadata describes the object as of the first and the bytes come
    from the second. Drive's md5Checksum is the md5 of the content and
    the content is already in memory, so the two are compared here
    rather than trusted -- no extra request.

    The three answers are three different states of evidence, and they
    are not interchangeable:

    * A window proves nothing about either token. The fingerprint is
      dropped because it describes the whole object and a partial body
      under it would read as fresh for the life of the entry, but the
      revision still names the object the window came from, so it
      stays.
    * A disagreeing md5 is positive proof that the capture predates
      these bytes -- and the revision came from that same capture, so
      it describes the old content too. Both are dropped. Keeping the
      revision here would be worse than useless: a revision pin
      REPLACES the drift check rather than supplementing it, so replay
      would serve the pre-change bytes and report success, with the one
      mechanism that would have surfaced it switched off.
    * Otherwise the capture is trusted. A capture with no md5 cannot be
      checked, so its token is stamped as it arrived -- dropping it
      would leave the read at None against stat's head revision, the
      mismatch this chain exists to remove.

    Args:
        md5 (str | None): Drive's md5Checksum for the item.
        head_revision (str | None): Drive's headRevisionId.
        modified (str | None): Drive's modifiedTime.
        data (bytes): the bytes this read returned.
        offset (int): first byte read.
        size (int | None): how many bytes, or None for the rest.
    """
    if not _whole_file(offset, size):
        return None, head_revision
    if md5 is not None and hashlib.md5(data).hexdigest() != md5:
        return None, None
    return drive_fingerprint(md5, head_revision, modified), head_revision


def _entry_token(value: JsonValue) -> str | None:
    """One version field off an index entry, or None when it is unusable.

    ``IndexEntry.extra`` is untyped: a listing that omitted the field
    leaves it absent, and a restored index can hold an empty string or a
    non-string. Any of those reaching the md5 comparison would drop a
    token the next link of the chain could have stamped.

    Args:
        value (JsonValue): the stored field.
    """
    return value if isinstance(value, str) and value else None


async def read_file_versioned(token_manager: TokenManager,
                              file_id: str,
                              virtual: str,
                              entry: IndexEntry,
                              offset: int = 0,
                              size: int | None = None) -> bytes:
    """Download a binary file honouring snapshot revision pins.

    A pinned path reads that revision's content; an actively recorded
    read captures the version fields and checks the md5 against the
    bytes it downloaded before stamping either token.

    An unrecorded read stamps from the index entry the caller resolved
    the file through, checked the same way, so its token does not depend
    on a recorder being bound and costs no request. The entry precedes
    the download, so a stale md5 is caught by the check; the other two
    fields are unverified and trusted, as an md5-less capture is. It pins
    no revision: the entry's can be a TTL old, and a replay pinned to it
    could serve bytes this read never saw.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        file_id (str): file ID.
        virtual (str): full virtual path, the pin lookup key and the
            recorded path.
        entry (IndexEntry): the index entry the file was resolved from.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    pinned = revision_for(virtual)
    window = window_for(offset, size)
    timer = start_op()
    fingerprint = None
    revision = pinned
    if pinned:
        data = await download_revision(token_manager, file_id, pinned, window)
    elif active_recorder() is not None:
        md5, revision, modified = await capture_file_metadata(
            token_manager, file_id)
        data = await download_file(token_manager, file_id, window)
        fingerprint, revision = _verified_tokens(md5, revision, modified, data,
                                                 offset, size)
    else:
        data = await download_file(token_manager, file_id, window)
        fingerprint, _ = _verified_tokens(
            _entry_token(entry.extra.get("md5_checksum")),
            _entry_token(entry.extra.get("head_revision_id")),
            _entry_token(entry.remote_time), data, offset, size)
    record("read",
           virtual,
           "gdrive",
           len(data),
           timer,
           fingerprint=fingerprint,
           revision=revision)
    return data


async def read(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a Drive file, optionally only a byte range of it.

    Only a binary file has a remote range to ask for. A google-apps file
    is rendered here into JSON, so its bytes do not exist until we make
    them and the window can only be taken afterwards.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, consulted for the file id.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    key = path.vfs_path
    virtual_key = prefix + "/" + key if prefix else "/" + key
    parent_key = posixpath.dirname(virtual_key) or "/"
    parent_path = PathSpec.from_str_path(parent_key,
                                         mount_key(parent_key, prefix))
    warm = (partial(readdir, accessor, parent_path, index)
            if parent_key != virtual_key else None)
    entry = await entry_or_warm(index, virtual_key, warm)
    if entry is None:
        raise enoent(virtual)
    if entry.resource_type in DIRECTORY_RESOURCE_TYPES:
        raise IsADirectoryError(virtual)
    if entry.resource_type not in _NATIVE_RESOURCE_TYPES:
        return await read_file_versioned(accessor.token_manager, entry.id,
                                         virtual, entry, offset, size)
    timer = start_op()
    if entry.resource_type == "gdrive/gdoc":
        rendered = await read_doc(accessor.token_manager, entry.id)
    elif entry.resource_type == "gdrive/gsheet":
        rendered = await read_spreadsheet(accessor.token_manager, entry.id)
    else:
        rendered = await read_presentation(accessor.token_manager, entry.id)
    sliced = slice_window(rendered, offset, size)
    # The token comes off the entry the listing already produced, so this
    # costs no request, and it is never NEWER than the render because the
    # listing preceded it -- so it can never mark stale bytes fresh.
    #
    # It can be older, though, by up to the index TTL (a day), and the two
    # consumers of a read record disagree about what that costs. For the
    # cache probe it is one wasted refetch. For snapshot drift it is a
    # failed load: capture stores the stale stamp, and a STRICT load stats
    # the live one and raises on a file nothing touched since the snapshot.
    # Buying the fresher stamp means a metadata request per native read,
    # which is the round trip this backend is built to avoid.
    #
    # `revision=None` deliberately: a pin REPLACES the drift check rather
    # than supplementing it, and this branch dispatches before
    # `revision_for` is ever consulted, so a pin here would be dead and
    # would silently disable the check it displaced.
    fingerprint = (drive_fingerprint(
        entry.extra.get("md5_checksum"), entry.extra.get("head_revision_id"),
        entry.remote_time) if _whole_file(offset, size) else None)
    record("read",
           virtual,
           "gdrive",
           len(sliced),
           timer,
           fingerprint=fingerprint,
           revision=None)
    return sliced
