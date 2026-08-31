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

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.read import make_read, make_read_range
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.slack import files as slack_files
from mirage.core.slack.history import get_history_jsonl
from mirage.core.slack.readdir import readdir
from mirage.core.slack.scope import detect_scope
from mirage.core.slack.users import get_user_profile, user_json_bytes
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def _ancestor_entry(accessor: SlackAccessor, path: PathSpec,
                          index: IndexCacheStore,
                          up: int) -> IndexEntry | None:
    virtual = path.virtual.rstrip("/")
    for _ in range(up):
        virtual = virtual.rsplit("/", 1)[0]
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    spec = PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=mount_key(virtual, prefix))
    return await resolve_entry(readdir, accessor, spec, index)


async def _read_chat(accessor: SlackAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore) -> bytes:
    """Render one day's history; the channel id comes from the listing.

    The typed ``name__id`` dirname is only trusted once the listing
    proves it, so a fabricated channel id is ENOENT rather than a raw
    API error.

    Args:
        accessor (SlackAccessor): slack accessor.
        match (ScopeMatch): a match holding the day chain.
        path (PathSpec): the chat.jsonl path.
        index (IndexCacheStore): index cache.
    """
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is not None:
        channel_id = entry.id.split(":", 1)[0]
    else:
        # A sealed day lists nothing but the file still reads through
        # the channel, reproducing the API's own answer for the fetch.
        channel = await _ancestor_entry(accessor, path, index, up=2)
        if channel is None:
            raise enoent(path.virtual)
        channel_id = channel.id
    return await get_history_jsonl(accessor.config,
                                   channel_id,
                                   match.slots["day"],
                                   session=accessor.pool)


async def _read_user(accessor: SlackAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore) -> bytes:
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is None:
        raise enoent(path.virtual)
    user = await get_user_profile(accessor.config,
                                  entry.id,
                                  session=accessor.pool)
    return user_json_bytes(user)


async def _blob_url(accessor: SlackAccessor, path: PathSpec,
                    index: IndexCacheStore) -> str:
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is None:
        raise enoent(path.virtual)
    url = entry.extra.get("url_private_download")
    if not isinstance(url, str) or not url:
        raise enoent(path.virtual)
    return url


async def _read_blob(accessor: SlackAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore) -> bytes:
    url = await _blob_url(accessor, path, index)
    return await slack_files.download_file(accessor.config,
                                           url,
                                           0,
                                           None,
                                           session=accessor.pool)


async def _read_blob_range(accessor: SlackAccessor, match: ScopeMatch,
                           path: PathSpec, index: IndexCacheStore, offset: int,
                           size: int | None) -> bytes:
    url = await _blob_url(accessor, path, index)
    return await slack_files.download_file(accessor.config,
                                           url,
                                           offset,
                                           size,
                                           session=accessor.pool)


read = make_read(
    detect_scope,
    readers={
        "messages": _read_chat,
        "user": _read_user,
        "file_blob": _read_blob,
    },
)

# Only an uploaded file has a remote range to ask for. A channel's
# history and a user profile are rendered here into JSON, so their bytes
# do not exist until we make them and the window can only be taken
# afterwards.
read_range = make_read_range(
    detect_scope,
    read,
    ranged={"file_blob": _read_blob_range},
)
