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

import asyncio
import posixpath
from io import BytesIO
from typing import IO, Any, Callable, Iterator, cast

from dulwich.object_format import SHA1
from dulwich.object_store import PackCapableObjectStore
from dulwich.objects import Blob, ObjectID, RawObjectID, ShaFile
from dulwich.pack import Pack, PackData, load_pack_index_file
from dulwich.repo import BaseRepo

from mirage.bridge.sync import run_async_from_sync
from mirage.commands.cli.builtin.git.format import abbrev_length
from mirage.commands.cli.builtin.git.io import (file_size, read_file,
                                                read_names, read_optional,
                                                write_once)
from mirage.commands.cli.builtin.git.lazyfile import LazyFile

OBJECTS_DIR = "objects"
PACK_DIR = "objects/pack"
IDX_SUFFIX = ".idx"
PACK_SUFFIX = ".pack"
FANOUT_LEN = 2
SHA_LEN = 40


def _basename(entry: str) -> str:
    """The final segment of a readdir entry, directory marker stripped.

    Args:
        entry (str): one entry as the backend reported it, which may be
            a bare name or a path and may carry a trailing slash.
    """
    return entry.rstrip("/").rsplit("/", 1)[-1]


def loose_path(commondir: str, oid: ObjectID) -> str:
    """Where an object id lives when it is loose.

    A pure function of the id, which is why a loose object never has to
    be searched for: the read is attempted and a miss means it is not
    loose.

    Args:
        commondir (str): absolute virtual path of the shared git
            directory, which owns the object database.
        oid (ObjectID): hex object id.
    """
    name = oid.decode()
    return posixpath.join(commondir, OBJECTS_DIR, name[:FANOUT_LEN],
                          name[FANOUT_LEN:])


async def store_blob(dispatch: Callable[..., Any], commondir: str,
                     data: bytes) -> ObjectID:
    """Write file contents into the object database as a blob.

    Written straight through the dispatcher rather than through the
    object store, because the store is synchronous and would have to be
    driven from a worker thread; staging reads its files on the event
    loop already, and the loose path is a pure function of the id, so
    there is nothing the store would add here.

    Args:
        dispatch (Callable): workspace op dispatcher.
        commondir (str): absolute virtual path of the shared git
            directory.
        data (bytes): the file's contents.
    """
    blob = Blob.from_string(data)
    await write_once(dispatch, loose_path(commondir, blob.id),
                     blob.as_legacy_object())
    return blob.id


class LooseObjects:
    """The loose half of an object database, read one object at a time.

    A loose object's path is a pure function of its id, so nothing has to
    be listed to look one up: the read is attempted and a miss means the
    object is not loose. Only enumeration needs the directory walk, and
    that reads names rather than contents.

    Args:
        dispatch (Callable): workspace op dispatcher.
        gitdir (str): absolute virtual path of the ``.git`` directory.
        loop (asyncio.AbstractEventLoop): the loop serving the mount.
    """

    def __init__(self, dispatch: Callable[..., Any], gitdir: str,
                 loop: asyncio.AbstractEventLoop) -> None:
        self._dispatch = dispatch
        self._gitdir = gitdir
        self._root = posixpath.join(gitdir, OBJECTS_DIR)
        self._loop = loop
        self._cache: dict[ObjectID, ShaFile | None] = {}

    def _path(self, oid: ObjectID) -> str:
        """Where an object id lives when it is loose.

        Args:
            oid (ObjectID): hex object id.
        """
        return loose_path(self._gitdir, oid)

    def get(self, oid: ObjectID) -> ShaFile | None:
        """One loose object, or None when it is not loose here.

        Args:
            oid (ObjectID): hex object id.
        """
        if oid in self._cache:
            return self._cache[oid]
        data = run_async_from_sync(
            read_optional(self._dispatch, self._path(oid)), self._loop)
        obj = None if data is None else ShaFile.from_file(BytesIO(data))
        self._cache[oid] = obj
        return obj

    def ids_under(self, fanout: str) -> list[ObjectID]:
        """Every loose id in one fanout directory, by listing only.

        Args:
            fanout (str): the two-character directory name.
        """
        names = run_async_from_sync(
            read_names(self._dispatch, posixpath.join(self._root, fanout)),
            self._loop)
        found = []
        for entry in names:
            rest = _basename(entry)
            if len(fanout) + len(rest) == SHA_LEN:
                found.append(ObjectID(f"{fanout}{rest}".encode()))
        return found

    def ids(self) -> Iterator[ObjectID]:
        """Every loose id, walking the fanout directories by name."""
        for entry in run_async_from_sync(
                read_names(self._dispatch, self._root), self._loop):
            fanout = _basename(entry)
            if len(fanout) == FANOUT_LEN:
                yield from self.ids_under(fanout)

    def put(self, obj: ShaFile) -> None:
        """Write one object out loose, where its id says it belongs.

        Objects are written loose and never packed, which is what git
        does for anything it creates as it goes; packing is a separate
        maintenance step (``git gc``) that mirage does not offer.

        Args:
            obj (ShaFile): the object to store.
        """
        oid = obj.id
        run_async_from_sync(
            write_once(self._dispatch, self._path(oid),
                       obj.as_legacy_object()), self._loop)
        self._cache[oid] = obj


class VfsObjectStore(PackCapableObjectStore):
    """A git object database whose bytes come from a mirage mount.

    Loose objects are fetched by id when something asks for them, so a
    repository with thousands of them costs nothing to open. A pack
    contributes its index, which says whether an object is here and
    where it sits; the packfile itself is a window that fetches only the
    blocks a read lands in.

    Being lazy means the store reflects the backend as it is now rather
    than as it was when the store was built, which is also what git does.

    Writes go back the same way reads come: one loose object per call,
    through the dispatcher, marshalled onto the workspace's loop. That
    is what lets dulwich's own tree builder run against a mount, so
    ``commit`` assembles its trees with the same code a local
    repository would use. Packs stay read-only, which costs nothing:
    git never writes into an existing pack either.

    Args:
        loose (LooseObjects): the loose half, read on demand.
        packs (list[Pack]): every pack, already open.
    """

    def __init__(self, loose: LooseObjects, packs: list[Pack]) -> None:
        self._loose = loose
        self._packs = packs
        self.object_format = SHA1

    @property
    def packed_count(self) -> int:
        """How many objects the packs hold, for the id abbreviation.

        Read off each pack index, which states its own count, so this
        costs nothing already paid for. Loose objects are deliberately
        not counted: git's own estimate ignores them, and matching that
        is what makes an abbreviated id agree with real git.
        """
        return sum(len(pack.index) for pack in self._packs)

    def contains_loose(self, sha: ObjectID | RawObjectID) -> bool:
        """Whether an object id names a loose object here.

        Args:
            sha (ObjectID | RawObjectID): hex object id.
        """
        return self._loose.get(ObjectID(bytes(sha))) is not None

    def __contains__(self, sha: object) -> bool:
        if not isinstance(sha, bytes):
            return False
        oid = ObjectID(sha)
        if any(oid in pack for pack in self._packs):
            return True
        return self.contains_loose(oid)

    def __iter__(self) -> Iterator[ObjectID]:
        for pack in self._packs:
            yield from pack
        yield from self._loose.ids()

    def iter_prefix(self, prefix: bytes) -> Iterator[ObjectID]:
        """Every id starting with a hex prefix, without reading objects.

        Overridden because the inherited version walks the whole store,
        which for a lazy database means fetching every object to answer
        an abbreviated id. A pack index is already in memory and sorted,
        and the loose half narrows to a single fanout directory.

        Args:
            prefix (bytes): hex id prefix, as typed.
        """
        seen: set[ObjectID] = set()
        for pack in self._packs:
            for oid in pack:
                if oid.startswith(prefix) and oid not in seen:
                    seen.add(oid)
                    yield oid
        if len(prefix) < FANOUT_LEN:
            candidates = list(self._loose.ids())
        else:
            candidates = self._loose.ids_under(prefix[:FANOUT_LEN].decode())
        for oid in candidates:
            if oid.startswith(prefix) and oid not in seen:
                seen.add(oid)
                yield oid

    def get_raw(self, sha: ObjectID | RawObjectID) -> tuple[int, bytes]:
        """The raw (type number, contents) for one object id.

        Args:
            sha (ObjectID | RawObjectID): hex object id.
        """
        oid = ObjectID(bytes(sha))
        for pack in self._packs:
            if oid in pack:
                return pack.get_raw(oid)
        obj = self._loose.get(oid)
        if obj is not None:
            return obj.type_num, obj.as_raw_string()
        raise KeyError(sha)

    def __getitem__(self, sha: ObjectID | RawObjectID) -> ShaFile:
        oid = ObjectID(bytes(sha))
        type_num, raw = self.get_raw(oid)
        return ShaFile.from_raw_string(type_num, raw, sha=oid)

    def add_object(self, obj: ShaFile) -> None:
        """Store one object, loose.

        Args:
            obj (ShaFile): the object to store.
        """
        self._loose.put(obj)

    def add_objects(self, objects, progress=None) -> None:
        """Store several objects, loose.

        Args:
            objects (Iterable): (object, path) pairs, dulwich's shape.
            progress (Callable | None): ignored; nothing here is slow
                enough to report on and there is no terminal to report
                to.
        """
        for obj, _path in objects:
            self._loose.put(obj)

    def add_pack(self):
        # Packing is git's maintenance step, not part of any verb mirage
        # offers, and a pack cannot be built one object at a time through
        # a dispatcher anyway.
        raise NotImplementedError("VfsObjectStore writes loose objects only")

    def add_pack_data(self, count, unpacked_objects, progress=None):
        raise NotImplementedError("VfsObjectStore writes loose objects only")


async def load_packs(dispatch: Callable[..., Any], gitdir: str,
                     loop: asyncio.AbstractEventLoop) -> list[Pack]:
    """Open every packfile under ``.git/objects/pack``.

    The index is read whole, because dulwich unpacks it through the
    buffer protocol and it is the small half. The packfile is opened as
    a lazy window instead: dulwich reaches pack data through nothing but
    seek and read, so a lookup fetches the blocks it lands in rather than
    the whole file. A backend that cannot report a size has to be read
    whole, which is correct but costs what this exists to avoid.

    Args:
        dispatch (Callable): workspace op dispatcher.
        gitdir (str): absolute virtual path of the ``.git`` directory.
        loop (asyncio.AbstractEventLoop): the loop serving the mount.
    """
    root = posixpath.join(gitdir, PACK_DIR)
    packs: list[Pack] = []
    for entry in await read_names(dispatch, root):
        name = _basename(entry)
        if not name.endswith(IDX_SUFFIX):
            continue
        stem = name[:-len(IDX_SUFFIX)]
        idx_bytes = await read_file(dispatch, posixpath.join(root, name))
        index = load_pack_index_file(name, BytesIO(idx_bytes), SHA1)
        pack_path = posixpath.join(root, f"{stem}{PACK_SUFFIX}")
        size = await file_size(dispatch, pack_path)
        if size is None:
            raw = await read_file(dispatch, pack_path)
            data = PackData.from_file(BytesIO(raw), SHA1, len(raw))
        else:
            # Cast because LazyFile implements the four methods dulwich
            # actually calls on pack data (read, seek, tell, close) and
            # not the rest of IO[bytes], most of which is writing and
            # means nothing for a read-only window.
            window = cast(IO[bytes], LazyFile(dispatch, pack_path, size, loop))
            data = PackData.from_file(window, SHA1, size)
        packs.append(Pack.from_objects(data, index))
    return packs


async def load_object_store(dispatch: Callable[..., Any],
                            gitdir: str) -> VfsObjectStore:
    """Assemble the object database for one repository.

    Args:
        dispatch (Callable): workspace op dispatcher.
        gitdir (str): absolute virtual path of the ``.git`` directory.
    """
    loop = asyncio.get_running_loop()
    return VfsObjectStore(LooseObjects(dispatch, gitdir, loop), await
                          load_packs(dispatch, gitdir, loop))


def abbrev_for(repo: BaseRepo) -> int:
    """How many hex digits this repository abbreviates an id to.

    Args:
        repo (BaseRepo): an opened repository.
    """
    store = repo.object_store
    packed = store.packed_count if isinstance(store, VfsObjectStore) else 0
    return abbrev_length(packed)
