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

from mirage.cache.index.store import IndexCacheStore
from mirage.cache.index.warm import entry_or_warm
from mirage.errors.fs import enoent
from mirage.types import DirListing, FileStat, FileType, PathSpec


def index_key(prefix: str, path: PathSpec) -> str:
    """The key a mount keeps ``path`` under in its index: the virtual
    path, the mount root spelled without its slash.

    A glob word is keyed as the directory it lists.

    Args:
        prefix (str): the mount prefix, with its trailing slash.
        path (PathSpec): the path, keyed below the mount.
    """
    root = prefix.rstrip("/")
    key = (path.dir if path.pattern else path).vfs_path.strip("/")
    return f"{root}/{key}" if key else root or "/"


def folder_of(key: str) -> str:
    """The key of the directory holding ``key``; the root holds itself.

    Args:
        key (str): an index key.
    """
    return key.rsplit("/", 1)[0] or "/"


async def stored_listing(
    index: IndexCacheStore, key: str, glob: bool = False
) -> list[str] | None:
    """A directory's listing as the index holds it, None when the index
    holds no complete, live listing for it.

    The mount's read policy rides the index: a listing past its bound,
    or one a ``fresh`` mount's check refuses, answers None here. A
    window (the newest messages, the last days) answers no glob: the
    backend moves its window to the span the glob asks for.

    Args:
        index (IndexCacheStore): the mount's index.
        key (str): the directory's key.
        glob (bool): the listing answers a glob word.
    """
    listing = await index.list_dir(key)
    if glob and listing.window:
        return None
    return listing.entries


async def beyond_window(index: IndexCacheStore, key: str) -> bool:
    """Whether ``key``'s folder holds a window that does not name it.

    A window shows everything to show but proves nothing absent: a day
    it does not list may still be there, and only the backend says.

    Args:
        index (IndexCacheStore): the mount's index.
        key (str): the path's key, below the mount root.
    """
    listing = await index.list_dir(folder_of(key))
    return (
        listing.window
        and listing.entries is not None
        and key not in listing.entries
    )


async def keep_listing(
    index: IndexCacheStore, key: str, listed: list[FileStat] | DirListing
) -> list[str]:
    """Keep what a backend listed, and answer the children's paths.

    A plain list is the directory's whole listing. A ``DirListing``
    may also prove descendant listings (``seeds``), be a view rather
    than the whole directory (``partial``), or prove nothing absent
    (``window``); each is kept for what it proves, and a seed at the
    version its listing was read at.

    Args:
        index (IndexCacheStore): the mount's index.
        key (str): the listed directory's key.
        listed (list[FileStat] | DirListing): the backend's answer.
    """
    listing = listed if isinstance(listed, DirListing) else DirListing(listed)
    rows: list[tuple[str, FileStat]] = [
        (row.name, row) for row in listing.entries
    ]
    if listing.partial:
        await index.set_partial_dir(key, rows)
    else:
        await index.set_dir(
            key, rows, window=listing.window, version=listing.version
        )
    stem = "" if key == "/" else key
    for relative, children in listing.seeds.items():
        seeded: list[tuple[str, FileStat]] = [
            (row.name, row) for row in children
        ]
        await index.set_dir(
            f"{stem}/{relative.strip('/')}",
            seeded,
            window=listing.window,
            version=listing.version,
        )
    return [f"{stem}/{row.name}" for row in listing.entries]


async def unproven_miss(index: IndexCacheStore, key: str) -> bool:
    """Whether the stored listing of the path's folder leaves it out
    without proving it absent: a complete listing the running command
    did not fetch, which another client may have added the name to
    since.

    Args:
        index (IndexCacheStore): the mount's index.
        key (str): the path's key, below the mount root.
    """
    folder = folder_of(key)
    listing = await index.list_dir(folder)
    return (
        listing.entries is not None
        and not listing.window
        and key not in listing.entries
        and not index.listed_this_command(folder)
    )


async def stored_stat(index: IndexCacheStore, key: str) -> FileStat | None:
    """A stat the stored listings answer, None when none does.

    The row the parent's listing holds answers it, so a listing costs
    one request and the stat of each child after it none. A complete
    listing that does not name the path answers ENOENT the same way; a
    window that does not answers nothing. A directory whose own listing
    is held answers with the row a subtree read kept for it.

    Args:
        index (IndexCacheStore): the mount's index.
        key (str): the path's key, below the mount root.

    Raises:
        FileNotFoundError: a complete, live listing of the parent does
            not name the path.
    """
    listing = await index.list_dir(folder_of(key))
    if listing.entries is not None:
        if key not in listing.entries:
            if listing.window:
                return None
            raise enoent(key)
    elif key not in (listing.partial_entries or []):
        if await stored_listing(index, key) is None:
            return None
    row = (await index.get(key)).entry
    return row if isinstance(row, FileStat) else None


async def entry_at(
    index: IndexCacheStore,
    key: str,
    warm: Callable[[], Awaitable[list[str]]] | None,
) -> FileStat | None:
    """What is at ``key``, as its parent's listing names it, listing the
    parent through ``warm`` when no listing proves it; None when nothing
    is there.

    Args:
        index (IndexCacheStore): the mount's index.
        key (str): the path's key, below the mount root, which no
            listing names.
        warm (Callable[[], Awaitable[list[str]]] | None): lists the parent
            directory into the index; None to answer from the index alone.
    """
    row = await entry_or_warm(index, key, warm)
    return row if isinstance(row, FileStat) else None


async def stored_tree(
    index: IndexCacheStore, key: str
) -> dict[str, FileStat] | None:
    """A subtree read the stored listings answer, None when one does not.

    Every entry below the directory as its parent's listing holds it,
    keyed by its path below ``key``: what a walk of ``readdir`` and
    ``stat`` over the same listings would see. None while any directory
    under it has no complete, live listing; a window is not one.

    Args:
        index (IndexCacheStore): the mount's index.
        key (str): the directory's key.
    """
    found: dict[str, FileStat] = {}
    base = "" if key == "/" else key
    pending = [key]
    while pending:
        listing = await index.list_dir(pending.pop())
        children = None if listing.window else listing.entries
        if children is None:
            return None
        for child in children:
            row = (await index.get(child)).entry
            if not isinstance(row, FileStat):
                return None
            found[child[len(base) + 1 :]] = row
            if row.type is FileType.DIRECTORY:
                pending.append(child)
    return found


async def keep_tree(
    index: IndexCacheStore, key: str, tree: dict[str, FileStat]
) -> None:
    """Keep a subtree read as the listings it proves.

    A subtree read names everything below the directory, so it is a
    complete listing of the directory and of each directory below it.
    The directory's own stat, which a read may name under ``""``, is
    kept where a stat of it finds it.

    Args:
        index (IndexCacheStore): the mount's index.
        key (str): the directory's key.
        tree (dict[str, FileStat]): the read, keyed below ``key``.
    """
    base = "" if key == "/" else key
    listings: dict[str, list[tuple[str, FileStat]]] = {key: []}
    for relative, row in sorted(tree.items()):
        if not relative:
            await index.put(key, row)
            continue
        folder, _, _ = relative.rpartition("/")
        listings.setdefault(f"{base}/{folder}" if folder else key, []).append(
            (row.name, row)
        )
        if row.type is FileType.DIRECTORY:
            listings.setdefault(f"{base}/{relative}", [])
    for folder, rows in listings.items():
        await index.set_dir(folder, rows)
