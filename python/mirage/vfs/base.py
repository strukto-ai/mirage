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

from collections.abc import AsyncIterator, Awaitable, Mapping
from types import MappingProxyType
from typing import Any

from pydantic import BaseModel

from mirage.accessor.base import Accessor
from mirage.errors.fs import enotsup
from mirage.events.base import DeltaHook
from mirage.io.types import ByteSource
from mirage.types import (
    CapacityResult,
    CapacityState,
    DirListing,
    FileStat,
    ListingVersion,
    PathSpec,
    SearchQuery,
)
from mirage.vfs.call import vfs_call
from mirage.vfs.constants import WALK_LIMIT
from mirage.vfs.secrets import redacted_config_dump
from mirage.vfs.types import (
    Effect,
    Target,
)


class BaseVFS:
    """A backend: an accessor, the facts about it, and its functions.

    A VFS answers ``readdir``, ``read`` and ``stat``; every other function
    (``write``, ``unlink``, a native ``find`` or ``search``, ...) is
    optional, and a VFS answers exactly the ones it
    defines. Every generic shell command (``ls``, ``cat``, ``grep``,
    ``find``, ``head``, ``wc``, ...) runs on the three required ones, and
    a line that needs a function the VFS does not define answers
    ``Operation not supported`` at that call, so ``gzip -c`` and
    ``tar -t`` still run as readers on a read-only backend. A function
    marked ``@vfs_call`` is also reachable by name through the
    dispatcher (``ws.dispatch("search_abc", path)``), with every check the
    dispatcher runs; the built-in ones are marked here, and an override keeps
    the mark.

    Everything a tree needs to run one (the placement, the index store,
    the registered commands, the reference it was built from) lives on
    the mount, so an author never sees it.

    Snapshots and versions see one of two things, and a subclass picks
    which by what it owns. Content the VFS holds itself (an in-memory
    store) is mirage-owned state: override ``get_state`` and
    ``load_state`` to carry it, register the class under its name, and
    a snapshot or a version rebuilds the mount with that content and
    no override. Content that lives in a remote service is only
    observed: keep the default state, set ``supports_snapshot`` and
    fill ``FileStat.fingerprint``, and a snapshot pins what it read
    while ``Workspace.load`` asks for the live VFS back.
    """

    name: str = "base"
    accessor: Accessor = Accessor()
    vfs_md: str = ""

    # How long the mount's index keeps a listing or a stat, in seconds,
    # when no index config says otherwise.
    index_ttl: float = 600

    # Whether reads may be served from and written to the file cache.
    # A read-mostly network store sets it; a live source (a database
    # collection, a chat channel) leaves it off so ``tail -f`` and the
    # like are never masked by a cached snapshot.
    caches_reads: bool = False

    # Whether this VFS carries enough version information for
    # snapshot+replay drift detection. When True, the VFS's stat()
    # must populate FileStat.fingerprint with a stable per-path marker
    # (ETag, md5, commit SHA, etc.) that distinguishes content versions.
    # When False (the default), reads are treated as live-only at replay
    # time: no fingerprint is recorded at snapshot, no drift check fires
    # at load. See docs/home/snapshot.mdx for the contract.
    supports_snapshot: bool = False

    # Whether stat() can size every regular file without fetching its
    # content, i.e. FileStat.size is None only for directories. True for
    # byte stores that keep a length in their metadata (ram, disk, redis,
    # s3, gridfs); False for mounts that render content on read, where
    # the size is unknowable until the bytes exist (slack, gmail, notion,
    # postgres rows.jsonl, dify documents).
    #
    # The FUSE path does not need this: direct_io + attr_timeout=0 +
    # hydrate-on-open make size-unknown files read correctly anyway. FSKit
    # has no direct_io equivalent, so a mount there is driven entirely by
    # the reported size and a False VFS serves silent empty files.
    # The mount-time check (fuse/backend.py check_sizes) names such
    # mounts in a warning rather than refusing; see
    # docs/python/setup/fuse.mdx.
    sizes_always_known: bool = False

    # Whether a `read: fresh` mount can actually be revalidated against
    # this backend: stat() and read must stamp FileStat.fingerprint /
    # the read record with the *same kind* of content token, so the gate
    # can compare them with ==. False (the default) is refused at mount
    # time rather than degraded, because a mount that declares fresh and
    # silently serves bounded is the bug the policy exists to prevent.
    #
    # Distinct from supports_snapshot, which asks whether a token exists
    # at all, and from caches_reads, which asks whether the gate can
    # fire. A backend can have a token on both sides and still fail this
    # one, by stamping two different kinds.
    #
    # A declarer must stamp the token on every read, not only while a
    # recorder is active: tests/vfs/test_read_revalidatable.py holds each
    # one to that (#1165). onedrive and sharepoint qualify because every
    # unpinned byte read fetches the item's cTag before its bytes, recorded
    # or not; a stream stamps only under a recorder, the one place its token
    # can land.
    read_revalidatable: bool = False

    # What a `read: fresh` mount checks a cached listing against before it
    # lists again: nothing (NONE, the default), one version for the whole
    # mount answered by a stat of its root (MOUNT), or each folder's own
    # version answered by a stat of that folder (FOLDER). A declarer stores
    # with each listing it writes a version no newer than its rows: taken
    # from the same response (github's tree names its head), or read first
    # and the rows then read at it or after it (hf walks the tree at the
    # commit its revision request answered; disk stats a folder before it
    # scans), so a change in between leaves the stored version behind and
    # the next check re-lists. Its stat must answer the same kind of token:
    # tests/vfs/test_listing_version.py holds each one to that.
    listing_version: ListingVersion = ListingVersion.NONE

    # The version every listing of this mount is pinned at, when its ref
    # names a commit outright (github's full-sha ref; see
    # ``github._pin_of`` for why that cannot move). A stored listing
    # whose version equals it is served without a check. It depends on the
    # mount's config, so an instance sets it; None pins nothing.
    listings_pin: str | None = None

    # Whether ``read`` fetches a byte window from the store itself. When
    # False the caller reads the whole file and slices it, so ``read`` is
    # only ever handed a window by a VFS that sets this.
    reads_ranges: bool = False

    # Whether the data lives on the host filesystem, which lets a command
    # aggregate on the host instead of streaming through mirage.
    local: bool = False

    # The files ``files_containing`` answers for, as mount-relative
    # globs matched segment by segment (a glob naming a directory covers
    # what is below it); None for every file. grep and rg read any other
    # file whatever the answer, as a full scan would.
    searchable: tuple[str, ...] | None = None

    # ``files_containing`` answers only a whole-word search (grep -w,
    # rg -w); any other pattern reads every file.
    whole_word_search: bool = False

    # The most files one command walks under a directory of this mount:
    # grep -r, rg and git grep stop reading there, find, ls -R, tree, du
    # and getfattr -R stop listing, git status and the other verbs that
    # walk a work tree fail, a glob matching more is refused, and so are
    # tar -c, zip -r, cp -r, rm -r, chmod -R, chown -R, chgrp -R, mv to
    # another mount and diff -r of a directory holding more
    # (``before_full_walk``); -1 for no cap.
    walk_limit: int = WALK_LIMIT

    # Extensions whose ``read`` is a rendering rather than the stored
    # bytes, each to the name of the method that renders it, which takes
    # ``read``'s arguments, window included. A rendered read is never
    # served from or kept in the file cache, and a ``raw`` read asks for
    # ``read`` itself.
    renderers: Mapping[str, str] = MappingProxyType({})

    _closed: bool = False

    def __init__(
        self,
        *,
        name: str | None = None,
        accessor: Accessor | None = None,
        vfs_md: str | None = None,
        commands: list[Any] | None = None,
        caches_reads: bool | None = None,
        sizes_always_known: bool | None = None,
        supports_snapshot: bool | None = None,
        read_revalidatable: bool | None = None,
    ) -> None:
        """Set the facts a subclass does not declare as attributes.

        Every argument is optional, so a class that declares its facts
        as attributes calls ``super().__init__()`` bare.

        Args:
            name (str | None): VFS name commands register under; also
                the registry key when the class is exposed through
                ``register_vfs`` or a ``mirage.vfs`` entry point. None
                keeps the class attribute.
            accessor (Accessor | None): backend handle the functions use.
            vfs_md (str | None): this VFS's part of VFS.md: its layout
                and file formats, ``{prefix}`` standing for the mount
                path. None keeps the class attribute.
            commands (list[Any] | None): extra ``@command`` functions,
                ``Command`` values or ``CLI`` trees: bespoke verbs, a
                program's verbs as one command tree under its root's
                name, or replacements that win over the generic command
                of the same name.
            caches_reads (bool | None): serve repeat reads from the file
                cache; enable only for stable, read-mostly content.
            sizes_always_known (bool | None): whether ``stat`` sizes every
                regular file without fetching it, which is also what
                makes the mount legal on FSKit.
            supports_snapshot (bool | None): whether ``stat`` fills
                ``FileStat.fingerprint`` with a stable per-path marker.
                Setting it without that is not drift detection.
            read_revalidatable (bool | None): whether ``stat`` and the
                read record stamp the same kind of content token, so a
                ``read: fresh`` mount can compare them. Setting it without
                that makes every read verdict stale; a mount declaring
                ``fresh`` on a backend that leaves it False is refused.
        """
        # Cooperative, so a mixin beside this class in a subclass's bases
        # (the RAM cache store's key locks) still initializes.
        super().__init__()
        if name is not None:
            if not name:
                raise ValueError("a VFS needs a non-empty name")
            self.name = name
        if accessor is not None:
            self.accessor = accessor
        if vfs_md is not None:
            self.vfs_md = vfs_md
        if caches_reads is not None:
            self.caches_reads = caches_reads
        if sizes_always_known is not None:
            self.sizes_always_known = sizes_always_known
        if supports_snapshot is not None:
            self.supports_snapshot = supports_snapshot
        if read_revalidatable is not None:
            self.read_revalidatable = read_revalidatable
        self._commands = list(commands or [])

    def supports(self, name: str) -> bool:
        """Whether this VFS defines the function ``name``.

        A function the base declares is supported once a subclass or the
        instance itself replaces it; one only a subclass declares (a
        custom ``@vfs_call``) is supported because it exists.

        Args:
            name (str): the function name.
        """
        own = getattr(self, name, None)
        fn = getattr(own, "__func__", own)
        return callable(own) and fn is not getattr(BaseVFS, name, None)

    def commands(self) -> list[Any]:
        """The ``@command`` functions, ``Command`` values and ``CLI``
        trees this VFS was handed."""
        return list(self._commands)

    @vfs_call(effect=Effect.READ, target=Target.DIR)
    async def readdir(self, path: PathSpec) -> list[FileStat] | DirListing:
        """List the children of a directory, each as its stat answers it.

        Args:
            path (PathSpec): the directory.
        """
        raise enotsup(self.name, "readdir", path)

    @vfs_call(effect=Effect.READ, target=Target.FILE)
    def read(
        self,
        path: PathSpec,
        *,
        offset: int = 0,
        size: int | None = None,
    ) -> Awaitable[ByteSource] | AsyncIterator[bytes]:
        """Read a file's bytes, or a window of them.

        Answer with the bytes, or with an async iterator that hands them
        out as the caller pulls, so a large file never sits in memory: an
        ``async def`` that returns either, or one that yields chunks.
        Mirage collects a stream for a caller that needs the bytes whole
        and hands bytes to a streaming caller as one chunk. A window
        reaches this only when ``reads_ranges`` is set: the caller
        otherwise reads the whole file and slices it.

        Args:
            path (PathSpec): the file.
            offset (int): the first byte of the window.
            size (int | None): the window's length, None through the end.
        """
        raise enotsup(self.name, "read", path)

    @vfs_call(effect=Effect.METADATA)
    async def stat(self, path: PathSpec) -> FileStat:
        """Describe a path; raises FileNotFoundError when nothing is there.

        Args:
            path (PathSpec): the path.
        """
        raise enotsup(self.name, "stat", path)

    async def exists(self, path: PathSpec) -> bool:
        """Whether anything is at ``path``; derived from ``stat`` when
        not defined.

        Args:
            path (PathSpec): the path.
        """
        raise enotsup(self.name, "exists", path)

    @vfs_call(effect=Effect.READ, target=Target.FILE)
    async def first_lines(self, path: PathSpec, n: int) -> bytes | None:
        """The first ``n`` lines of a file, without reading the rest.

        ``head -n N`` asks this before it reads, so a backend that can
        fetch the start of a file on its own (a ``LIMIT`` on a table)
        does not send the whole file. The answer stands in for the file:
        exactly the first ``n`` lines a read gives, each with its newline,
        and the whole file when it has fewer. A file the read cache holds
        is read instead. Return None to have the file read the usual way;
        raise the file's read error otherwise (``EFBIG`` when the answer
        passes a ceiling on one read, such as ``max_read_rows``).

        Args:
            path (PathSpec): the file.
            n (int): how many lines, at least 1.
        """
        raise enotsup(self.name, "first_lines", path)

    @vfs_call(effect=Effect.READ, target=Target.FILE)
    async def last_lines(self, path: PathSpec, n: int) -> bytes | None:
        """The last ``n`` lines of a file, without reading the rest.

        ``tail -n N`` asks this before it reads, and ``tail -f`` for its
        first print. The answer stands in for the file: exactly the last
        ``n`` lines a read gives, each with its newline, and the whole
        file when it has fewer. A file the read cache holds is read
        instead. Return None to have the file read the usual way; raise
        the file's read error otherwise (``EFBIG`` when the answer passes
        a ceiling on one read).

        Args:
            path (PathSpec): the file.
            n (int): how many lines, at least 1.
        """
        raise enotsup(self.name, "last_lines", path)

    @vfs_call(effect=Effect.READ, target=Target.FILE)
    async def line_count(self, path: PathSpec) -> int | None:
        """How many newlines a read of the file gives, without reading it.

        ``wc -l`` asks this before it reads (a ``COUNT(*)`` on a table),
        and only when it counts lines alone. A file the read cache holds
        is read instead. Return None to have the file read the usual way;
        raise the file's read error otherwise.

        Args:
            path (PathSpec): the file.
        """
        raise enotsup(self.name, "line_count", path)

    @vfs_call(effect=Effect.READ, target=Target.FILE)
    async def checksum(
        self,
        path: PathSpec,
        algorithm: str,
    ) -> str | None:
        """The digest the backend keeps for a file, without reading it.

        ``md5sum`` and its siblings ask this before they read, except
        under ``-c``, which checks the bytes themselves, so a backend
        that stores a file's digest (an object's MD5 ETag, a drive's
        ``md5Checksum``) does not send the file. Answer only a digest of
        exactly the bytes a read gives, in lowercase hex: a stored value
        that can be anything else (a multipart or encrypted object's
        ETag) is None. A file the read cache holds is read instead.
        Return None to have the file read and hashed; raise the file's
        read error otherwise.

        Args:
            path (PathSpec): the file.
            algorithm (str): the hashlib name, ``md5``, ``sha1``,
                ``sha224``, ``sha256``, ``sha384``, ``sha512`` or
                ``blake2b``, or ``blake2b-N`` for BLAKE2b at N bits.
        """
        raise enotsup(self.name, "checksum", path)

    @vfs_call(effect=Effect.READ, target=Target.FILE)
    async def follow(
        self,
        path: PathSpec,
        n: int,
        interval: float,
    ) -> AsyncIterator[bytes] | None:
        """The last ``n`` lines of a file, then each line added to it, as
        it lands.

        ``tail -f`` on one file asks this for all it prints, so a backend
        that can be told about new data (a change stream) does not have
        to be polled, one that can be asked for only what is new does not
        read the whole file again on each poll, and the lines it prints
        first and the ones it follows meet at one point: none is lost or
        printed twice. The stream yields whole lines, each with its
        newline, in the order a read would show them, and ends only when
        the caller closes it. Return None to have ``tail`` read the file
        and poll it every ``-s`` seconds; raise the file's read error
        otherwise.

        Args:
            path (PathSpec): the file.
            n (int): how many of its last lines come first, 0 for none.
            interval (float): ``tail -s``, the seconds between two asks
                for what is new; a change stream has no use for it.
        """
        raise enotsup(self.name, "follow", path)

    @vfs_call(effect=Effect.READ, target=Target.DIR, subtree=True)
    async def read_tree(
        self,
        path: PathSpec,
    ) -> dict[str, FileStat] | None:
        """Every entry under a directory, in one answer.

        ``find``, ``du``, ``ls -R``, ``tree``, ``grep -r`` and ``rg`` ask
        this before they walk a directory, so a backend that can list a
        subtree on its own (a recursive listing, one query over many
        folders) does not take a ``readdir`` per directory. The answer
        stands in for the walk: every file and directory below ``path``,
        keyed by its path below ``path`` (``a``, ``a/b.txt``), each with
        the stat ``stat`` gives for it.
        The walk lists each directory from it in name order. Return None
        to have the command walk ``readdir`` the usual way; raise what
        ``readdir`` of ``path`` raises otherwise.

        Args:
            path (PathSpec): the directory.
        """
        raise enotsup(self.name, "read_tree", path)

    @vfs_call(effect=Effect.WRITE, target=Target.FILE, creates=True)
    async def write(self, path: PathSpec, data: ByteSource) -> FileStat | None:
        """Replace a file's bytes, creating it when missing.

        ``data`` is the whole content, or an async iterator that hands it
        over as it is produced (a program's output redirected into the
        file); ``materialize(data)`` collects it for a store that takes
        one body. A stream that lands as it arrives lets a reader watch
        the file grow. A write that also takes ``atomic: bool`` is asked,
        with it, to show nothing until the stream has ended whole; any
        other write is handed the collected bytes for that.

        Args:
            path (PathSpec): the file.
            data (ByteSource): its new content, consumed once.
        """
        raise enotsup(self.name, "write", path)

    @vfs_call(effect=Effect.WRITE, target=Target.FILE, creates=True)
    async def append(
        self, path: PathSpec, data: ByteSource
    ) -> FileStat | None:
        """Add bytes to the end of a file, creating it when missing.

        ``data`` is bytes or a stream, as ``write`` takes it. A VFS that
        defines ``write`` and not this is appended to by reading the file
        and writing it back.

        Args:
            path (PathSpec): the file.
            data (ByteSource): the bytes to add, consumed once.
        """
        raise enotsup(self.name, "append", path)

    @vfs_call(effect=Effect.WRITE, target=Target.FILE, creates=True)
    async def pwrite(
        self, path: PathSpec, data: bytes, offset: int
    ) -> FileStat | None:
        """Write bytes at an offset, keeping every byte outside them.

        As pwrite(2): a gap past the end reads back as zeros and a missing
        file is created. A VFS that defines ``write`` and not this is
        written by reading the file and writing it back.

        Args:
            path (PathSpec): the file.
            data (bytes): the bytes to write.
            offset (int): where they start.
        """
        raise enotsup(self.name, "pwrite", path)

    @vfs_call(effect=Effect.WRITE, target=Target.FILE, creates=True)
    async def create(self, path: PathSpec) -> FileStat | None:
        """Create an empty file, leaving an existing one as it is.

        Args:
            path (PathSpec): the file.
        """
        raise enotsup(self.name, "create", path)

    @vfs_call(effect=Effect.CREATE, target=Target.DIR)
    async def mkdir(
        self, path: PathSpec, parents: bool = False
    ) -> FileStat | None:
        """Make a directory.

        Args:
            path (PathSpec): the directory.
            parents (bool): make missing parents too, as ``mkdir -p``.
        """
        raise enotsup(self.name, "mkdir", path)

    @vfs_call(effect=Effect.REMOVE, target=Target.FILE)
    async def unlink(self, path: PathSpec) -> None:
        """Remove a file.

        Args:
            path (PathSpec): the file.
        """
        raise enotsup(self.name, "unlink", path)

    @vfs_call(effect=Effect.REMOVE, target=Target.DIR)
    async def rmdir(self, path: PathSpec) -> None:
        """Remove an empty directory.

        Args:
            path (PathSpec): the directory.
        """
        raise enotsup(self.name, "rmdir", path)

    @vfs_call(effect=Effect.REMOVE, target=Target.DIR, subtree=True)
    async def rm_r(self, path: PathSpec) -> Any:
        """Remove a subtree in one call instead of entry by entry.

        Args:
            path (PathSpec): the subtree's root.
        """
        raise enotsup(self.name, "rm_r", path)

    @vfs_call(effect=Effect.RENAME, subtree=True)
    async def rename(self, src: PathSpec, dst: PathSpec) -> FileStat | None:
        """Move a name within this VFS.

        Args:
            src (PathSpec): the current name.
            dst (PathSpec): the new name.
        """
        raise enotsup(self.name, "rename", src)

    @vfs_call(effect=Effect.COPY, target=Target.FILE)
    async def copy(self, src: PathSpec, dst: PathSpec) -> FileStat | None:
        """Copy a file within this VFS without moving its bytes through
        mirage.

        Args:
            src (PathSpec): the file.
            dst (PathSpec): the copy.
        """
        raise enotsup(self.name, "copy", dst)

    async def copy_from(
        self, source: "BaseVFS", src: PathSpec, dst: PathSpec
    ) -> None:
        """Copy a file from another mount onto this one without moving
        its bytes through mirage.

        ``cp`` and ``mv`` between two mounts ask this before they read
        the file and write it here, once the dispatcher has judged the
        source as a read and the destination as a create. It is no
        dispatcher call of its own, so nothing reaches it unjudged.
        Raise EXDEV when this backend cannot copy from ``source`` (another
        kind of store, other credentials, a refusal), and the bytes move
        through the read and the write instead.

        Args:
            source (BaseVFS): the source mount's VFS.
            src (PathSpec): the file, on ``source``.
            dst (PathSpec): the copy, on this VFS.
        """
        raise enotsup(self.name, "copy_from", dst)

    @vfs_call(effect=Effect.COPY, target=Target.DIR, subtree=True)
    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> FileStat | None:
        """Copy a directory tree within this VFS in one call.

        Args:
            src (PathSpec): the directory.
            dst (PathSpec): the copy.
        """
        raise enotsup(self.name, "dir_copy", dst)

    @vfs_call(effect=Effect.WRITE, target=Target.FILE, creates=True)
    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> FileStat | None:
        """Resize a file, padding with zeros or cutting the end.

        Args:
            path (PathSpec): the file.
            length (int): its new size.
            no_create (bool): refuse a missing file instead of creating
                it; a VFS that cannot hold that atomically raises ENOTSUP
                before writing.
        """
        raise enotsup(self.name, "truncate", path)

    @vfs_call(effect=Effect.ATTR)
    async def setattr(
        self,
        path: PathSpec,
        *,
        mode: int | None = None,
        uid: int | str | None = None,
        gid: int | str | None = None,
        atime: str | None = None,
        mtime: str | None = None,
    ) -> dict[str, int | str]:
        """Store metadata fields the backend keeps itself.

        Returns the fields it stored; the rest land in the namespace's
        attribute overlay.

        Args:
            path (PathSpec): the path.
            mode (int | None): permission bits.
            uid (int | str | None): owner.
            gid (int | str | None): group.
            atime (str | None): access time.
            mtime (str | None): modification time.
        """
        raise enotsup(self.name, "setattr", path)

    @vfs_call(effect=Effect.READ, subtree=True)
    async def search(
        self,
        path: PathSpec,
        query: SearchQuery,
    ) -> list[tuple[str, str]] | None:
        """Search the resource under ``path``; None declines, [] is none.

        One ``(path, record)`` pair per hit: the hit's virtual path, which
        the dispatcher drops the hit for when the session hides it, and
        the record the ``search`` command prints, a header line naming
        the path (``path:score`` where the store ranks) and then the
        hit's text. Errors and incomplete results are raised, never
        answered as a miss.

        Args:
            path (PathSpec): the scope.
            query (SearchQuery): the query and its options.
        """
        raise enotsup(self.name, "search", path)

    async def search_many(
        self,
        paths: list[PathSpec],
        query: SearchQuery,
    ) -> list[tuple[str, str]] | None:
        """Search several scopes as one ranked query.

        Args:
            paths (list[PathSpec]): the scopes.
            query (SearchQuery): the query and its options.
        """
        raise enotsup(self.name, "search", paths[0] if paths else "")

    async def read_many(
        self, paths: list[PathSpec], limit: int
    ) -> dict[str, bytes]:
        """Read several whole files in one request, for a read-ahead.

        Keyed by each answered path's ``virtual``. A file may be left out
        (one larger than ``limit`` bytes, one the request could not
        read), and its own read answers it later; an error of the whole
        request is raised. Each file read is recorded as ``read`` records
        it, fingerprint included, so the read cache keeps its token. A VFS
        that needs what the listings hold takes ``entries`` (what is at
        each path) or ``parents`` (what is at each path's folder), each in
        the order of ``paths``.

        Args:
            paths (list[PathSpec]): the files, all on this mount.
            limit (int): the most bytes worth fetching for one file.
        """
        raise enotsup(self.name, "read", paths[0] if paths else "")

    @vfs_call(effect=Effect.READ, target=Target.DIR, subtree=True)
    async def files_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
    ) -> list[PathSpec] | None:
        """Files under ``path`` whose content may contain ``text``.

        grep and rg still walk, filter, order and label every file, and
        of the files ``searchable`` names read only the ones answered
        here, matched on ``vfs_path`` without case, so an extra file
        costs a read and a missing one is a wrong answer. A search that
        holds only keys names each one with
        ``mounted_path(path, "/" + key)``. Return None when the answer
        may be incomplete (an error, a truncated result, an index that
        lags writes), and every file is read; raise to refuse the
        command, and the error's message is what it prints. The
        dispatcher drops every file the session hides from the answer.

        Args:
            path (PathSpec): a directory walked: one of grep's directory
                operands under -r or -R, or of rg's operands or the cwd;
                asked once per directory.
            text (str): plain text every match holds, never a pattern:
                the pattern or each -e of grep and rg, or for a regex a
                fixed piece of at least three characters every match
                contains. Asked once per text; a file any answer holds
                is read.
            whole_word (bool): True under -w or -x with a plain-text
                pattern, where ``text`` is a whole word of every match;
                False otherwise, where it may sit inside a word.
            ignore_case (bool): True under -i, and under rg -S with a
                lowercase pattern; folding case when False is fine.
        """
        return None

    @vfs_call(effect=Effect.READ, target=Target.FILE)
    async def lines_containing(
        self,
        path: PathSpec,
        text: str,
        *,
        ignore_case: bool,
    ) -> ByteSource | None:
        """The lines of ``path`` that may contain ``text``, in file order.

        grep and rg match each line themselves, so an extra line is fine
        and a missing one is a wrong answer. Each line keeps the newline
        the file has, whole or streamed. The lines stand in for the file
        when the output shows no line positions (no -n, -b, --column,
        --vimgrep), no context (no -A, -B, -C) and there is one text;
        otherwise the file is read only when some answer holds a line,
        and only a stream's first chunk is pulled. None reads the file;
        answer None for a file that may hold a NUL byte, since grep and rg
        call such a file binary from bytes outside its matching lines.
        Raise to refuse the command.

        Args:
            path (PathSpec): the file.
            text (str): plain text every match holds, as
                ``files_containing`` gets it.
            ignore_case (bool): True under -i, and under rg -S with a
                lowercase pattern.
        """
        return None

    @vfs_call(effect=Effect.READ, target=Target.DIR)
    async def before_full_walk(
        self,
        path: PathSpec,
        *,
        files: int | None = None,
    ) -> None:
        """Called before a command acts on every file under ``path``.

        Once per directory a command copies, compares, changes or removes
        whole, before the first file it touches there: tar -c, zip -r,
        cp -r, mv across mounts, diff -r, rm -r, chmod -R, chown -R and
        chgrp -R. Return to let the walk run; raise to refuse it, and the
        error's message is what the command prints. The default refuses
        more than ``walk_limit`` files. Searches and listings are
        never refused: they stop after ``walk_limit`` files.

        Args:
            path (PathSpec): the directory about to be walked.
            files (int | None): how many files the session sees under
                ``path``, with every hidden file dropped: the mount's
                ``read_tree``, or under a ``walk_limit`` a walk of
                its listings that stops one file past it; None when
                neither counts, and the guard counts them itself.
        """
        limit = self.walk_limit
        if limit >= 0 and files is not None and files > limit:
            raise ValueError(
                f"more than {limit} files in scope (walk_limit); "
                "narrow the path"
            )
        return None

    def is_mounted(self) -> bool:
        """Whether the backend is there to answer at all."""
        return True

    def storage_location(self) -> str | None:
        """Where this driver's bytes live, as one string a person can read.

        ``disk:/srv/data``, ``s3:aws:my-bucket/prefix``. Two mounts with
        the same location address the same bytes, which is how ``cp`` and
        ``mv`` across mounts refuse to copy a file onto itself. None, the
        default, means unknown, and the mount then treats this instance
        as a location of its own, which is the safe direction to be wrong
        in: a false "different" only keeps the pre-existing behavior,
        while a false "same" would refuse a legitimate move. A driver
        whose config pins the storage (a disk root, a bucket and key
        prefix) overrides this so two instances pointing at one target
        compare equal.
        """
        return None

    async def capacity(self) -> CapacityResult:
        """How much space this backend has, for ``df``.

        The default is UNKNOWN, which ``df`` renders as ``-``. A driver
        that can answer truthfully (a real filesystem, a provider that
        exposes a storage quota) overrides this. Never fabricate a number:
        report QUOTA only with real values, else ELASTIC/NA/UNKNOWN.
        """
        return CapacityResult(state=CapacityState.UNKNOWN)

    def delta_hook(self) -> DeltaHook | None:
        """Hook a consumer calls when the backend pings it, or None.

        A backend whose push says only that something changed (a ping)
        answers it with one read of its own change feed from the last
        checkpoint. None means it has no such feed, which is most of
        them; a subclass that has one overrides this and narrows the
        return to ``DeltaHook``.
        """
        return None

    def get_state(self) -> dict[str, Any]:
        """What a snapshot records for this driver.

        The default carries the type and ``needs_override``: the base
        cannot know a subclass's constructor, so both loaders then
        require the mount to be handed back live (``mounts=``;
        ``Workspace.copy`` does this itself). A builtin that owns nothing
        records only its type, which is enough to rebuild it; a driver
        that owns its content (an in-memory store) overrides this and
        ``load_state`` to carry it; a driver over a remote service keeps
        the default and pins what it read through ``supports_snapshot``
        fingerprints instead.
        """
        return {"type": self.name, "needs_override": True}

    def config_state(self, config: BaseModel, **extra: Any) -> dict[str, Any]:
        """``get_state`` for a driver rebuilt from a config: the type and
        the config with its secrets redacted.

        Args:
            config (BaseModel): the config the driver was built from.
            **extra (Any): further keys to record beside it.
        """
        cfg = redacted_config_dump(config)
        return {
            "type": self.name,
            "config": cfg,
            **extra,
        }

    def load_state(self, state: dict[str, Any]) -> None:
        """Take back what ``get_state`` put out.

        A no-op by default, which is right for every VFS whose bytes live
        in the remote service: its state is a redacted config, and the
        restored mount reaches its data through that config alone. Only a
        VFS holding content of its own (ram, disk, redis) overrides this.

        Args:
            state (dict[str, Any]): the payload ``get_state`` produced.
        """

    @property
    def is_closed(self) -> bool:
        """Whether this instance has completed its VFS lifecycle."""
        return self._closed

    async def close(self) -> None:
        """Release what this driver owns, exactly once: its accessor.

        A driver with handles of its own (a pool, a channel) overrides
        this and calls ``super().close()``.
        """
        if self._closed:
            return
        await self.accessor.close()
        self._closed = True
