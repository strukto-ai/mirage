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

from collections.abc import AsyncIterator, Callable, Mapping
from types import MappingProxyType
from typing import Any

from pydantic import BaseModel

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.du import DEFAULT_MAX_DU_ENTRIES
from mirage.errors.fs import enotsup
from mirage.types import (
    CapacityResult,
    CapacityState,
    FileStat,
    JsonValue,
    ListingVersion,
    PathSpec,
)
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES
from mirage.vfs.call import vfs_call
from mirage.vfs.secrets import redacted_config_dump
from mirage.vfs.types import DuEntries, Effect, SearchQuery
from mirage.watch.base import DeltaHook


class BaseVFS:
    """A backend: an accessor, the facts about it, and its functions.

    A VFS answers ``readdir``, ``read`` and ``stat``; every other function
    (``write``, ``unlink``, ``read_stream``, a native ``find`` or
    ``search``, ...) is optional, and a VFS answers exactly the ones it
    defines. Every generic shell command (``ls``, ``cat``, ``grep``,
    ``find``, ``head``, ``wc``, ...) runs on the three required ones, and
    a line that needs a function the VFS does not define answers
    ``Operation not supported`` at that call, so ``gzip -c`` and
    ``tar -t`` still run as readers on a read-only backend. A function
    marked ``@vfs_call`` is also reachable by name through the
    dispatcher (``ws.dispatch("search_abc", path)``), with every check the
    door runs; the built-in ones are marked here, and an override keeps
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
    prompt: str = ""
    write_prompt: str = ""

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

    # How many entries a du walk of this mount visits before it stops and
    # reports a partial answer, None for no cap: the command table's own
    # ``max_du_entries``, read here by a walk that crosses mounts through
    # the dispatcher, which charges each entry to the mount serving it.
    max_du_entries: int | None = DEFAULT_MAX_DU_ENTRIES

    # Whether ``read`` fetches a byte window from the store itself. When
    # False the caller reads the whole file and slices it, so ``read`` is
    # only ever handed a window by a VFS that sets this.
    reads_ranges: bool = False

    # Whether the data lives on the host filesystem, which lets a command
    # aggregate on the host instead of streaming through mirage.
    local: bool = False

    # How many paths one glob may expand to before it stops; None for no
    # cap.
    max_glob_matches: int | None = DEFAULT_MAX_GLOB_MATCHES

    # What ``search`` supports, read by the consumers that opt in by
    # namespace (``{"grep": {"mode": "literal"}}`` lets grep and rg use
    # it). Empty means no consumer may assume anything.
    search_meta: Mapping[str, JsonValue] = MappingProxyType({})

    # Extensions whose ``read`` is a rendering rather than the stored
    # bytes, each to the name of the method that renders it, which takes
    # ``read``'s arguments, window included. A rendered read is never
    # served from or kept in the file cache, and a ``raw`` read asks for
    # ``read`` itself.
    renderers: Mapping[str, str] = MappingProxyType({})

    # The generic shell commands this VFS replaces with its own.
    overrides: frozenset[str] = frozenset()

    _closed: bool = False

    def __init__(
        self,
        *,
        name: str | None = None,
        accessor: Accessor | None = None,
        prompt: str | None = None,
        write_prompt: str | None = None,
        overrides: set[str] | frozenset[str] | None = None,
        commands: list[Callable[..., Any]] | None = None,
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
            prompt (str | None): LLM-facing description of the layout.
            write_prompt (str | None): appended when mounted writable.
            overrides (set[str] | frozenset[str] | None): generic command
                names this VFS replaces (pass the replacements via
                ``commands``).
            commands (list[Callable] | None): extra ``@command``
                functions (bespoke verbs or override replacements).
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
        if prompt is not None:
            self.prompt = prompt
        if write_prompt is not None:
            self.write_prompt = write_prompt
        if overrides is not None:
            self.overrides = frozenset(overrides)
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

        A function the base declares is supported once a subclass
        overrides it; one only a subclass declares (a custom
        ``@vfs_call``) is supported because it exists.

        Args:
            name (str): the function name.
        """
        own = getattr(type(self), name, None)
        return callable(own) and own is not getattr(BaseVFS, name, None)

    def commands(self) -> list[Callable[..., Any]]:
        """The bespoke ``@command`` functions this VFS was handed."""
        return list(self._commands)

    @vfs_call(effect=Effect.READ)
    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        """List the children of a directory.

        Args:
            path (PathSpec): the directory.
            index (IndexCacheStore): the mount's index, for backends that
                address items by id.
        """
        raise enotsup(self.name, "readdir", path)

    @vfs_call(effect=Effect.READ)
    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        """Read a file's bytes, or a window of them.

        A window reaches this only when ``reads_ranges`` is set: the
        caller otherwise reads the whole file and slices it.

        Args:
            path (PathSpec): the file.
            index (IndexCacheStore): the mount's index.
            offset (int): the first byte of the window.
            size (int | None): the window's length, None through the end.
        """
        raise enotsup(self.name, "read", path)

    @vfs_call(effect=Effect.READ)
    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        """Describe a path; raises FileNotFoundError when nothing is there.

        Args:
            path (PathSpec): the path.
            index (IndexCacheStore): the mount's index.
        """
        raise enotsup(self.name, "stat", path)

    def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        """Stream a file's bytes as the caller pulls them.

        A VFS that does not define it is read whole instead.

        Args:
            path (PathSpec): the file.
            index (IndexCacheStore): the mount's index.
        """
        raise enotsup(self.name, "read_stream", path)

    async def exists(self, path: PathSpec) -> bool:
        """Whether anything is at ``path``; derived from ``stat`` when
        not defined.

        Args:
            path (PathSpec): the path.
        """
        raise enotsup(self.name, "exists", path)

    async def find(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        **predicates: Any,
    ) -> list[str]:
        """Answer ``find`` natively instead of walking ``readdir``.

        Args:
            path (PathSpec): where the search starts.
            index (IndexCacheStore): the mount's index.
            **predicates (Any): the parsed ``find`` expression.
        """
        raise enotsup(self.name, "find", path)

    async def du_size(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> int:
        """The recursive byte total under ``path``, natively.

        Native ``du`` is both ``du_size`` and ``du_entries``: the generic
        derives its per-directory rows from the entries, so one without
        the other is not served.

        Args:
            path (PathSpec): the path.
            index (IndexCacheStore): the mount's index.
        """
        raise enotsup(self.name, "du", path)

    async def du_entries(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> DuEntries:
        """Every stored file under ``path`` with its size, natively.

        A native answer comes from one pass over the stored files, so a
        directory holding no file never appears in the entries and gets no
        row, where the shared readdir walk prints its ``0`` row. The
        difference is accepted for the speed and pinned in
        ``integ/unix/du/empty.json``.

        Args:
            path (PathSpec): the path.
            index (IndexCacheStore): the mount's index.
        """
        raise enotsup(self.name, "du", path)

    @vfs_call(effect=Effect.WRITE)
    async def write(self, path: PathSpec, data: bytes) -> None:
        """Replace a file's bytes, creating it when missing.

        Args:
            path (PathSpec): the file.
            data (bytes): its new content.
        """
        raise enotsup(self.name, "write", path)

    @vfs_call(effect=Effect.WRITE)
    async def append(
        self,
        path: PathSpec,
        data: bytes,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        """Add bytes to the end of a file, creating it when missing.

        A VFS that defines ``write`` and not this is appended to by
        reading the file and writing it back.

        Args:
            path (PathSpec): the file.
            data (bytes): the bytes to add.
            index (IndexCacheStore): the mount's index.
        """
        raise enotsup(self.name, "append", path)

    @vfs_call(effect=Effect.WRITE)
    async def pwrite(
        self,
        path: PathSpec,
        data: bytes,
        offset: int,
        index: IndexCacheStore = NULL_INDEX,
    ) -> None:
        """Write bytes at an offset, keeping every byte outside them.

        As pwrite(2): a gap past the end reads back as zeros and a missing
        file is created. A VFS that defines ``write`` and not this is
        written by reading the file and writing it back.

        Args:
            path (PathSpec): the file.
            data (bytes): the bytes to write.
            offset (int): where they start.
            index (IndexCacheStore): the mount's index.
        """
        raise enotsup(self.name, "pwrite", path)

    @vfs_call(effect=Effect.WRITE)
    async def create(self, path: PathSpec) -> None:
        """Create an empty file, leaving an existing one as it is.

        Args:
            path (PathSpec): the file.
        """
        raise enotsup(self.name, "create", path)

    @vfs_call(effect=Effect.WRITE)
    async def mkdir(self, path: PathSpec, parents: bool = False) -> None:
        """Make a directory.

        Args:
            path (PathSpec): the directory.
            parents (bool): make missing parents too, as ``mkdir -p``.
        """
        raise enotsup(self.name, "mkdir", path)

    @vfs_call(effect=Effect.WRITE)
    async def unlink(self, path: PathSpec) -> None:
        """Remove a file.

        Args:
            path (PathSpec): the file.
        """
        raise enotsup(self.name, "unlink", path)

    @vfs_call(effect=Effect.WRITE)
    async def rmdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> None:
        """Remove an empty directory.

        Args:
            path (PathSpec): the directory.
            index (IndexCacheStore): the mount's index, which a refused
                rmdir's hidden-remnant walk lists through.
        """
        raise enotsup(self.name, "rmdir", path)

    async def rm_r(self, path: PathSpec) -> Any:
        """Remove a subtree in one call instead of entry by entry.

        Args:
            path (PathSpec): the subtree's root.
        """
        raise enotsup(self.name, "rm_r", path)

    @vfs_call(effect=Effect.WRITE)
    async def rename(self, src: PathSpec, dst: PathSpec) -> None:
        """Move a name within this VFS.

        Args:
            src (PathSpec): the current name.
            dst (PathSpec): the new name.
        """
        raise enotsup(self.name, "rename", src)

    async def copy(self, src: PathSpec, dst: PathSpec) -> None:
        """Copy a file within this VFS without moving its bytes through
        mirage.

        Args:
            src (PathSpec): the file.
            dst (PathSpec): the copy.
        """
        raise enotsup(self.name, "copy", dst)

    async def dir_copy(self, src: PathSpec, dst: PathSpec) -> None:
        """Copy a directory tree within this VFS in one call.

        Args:
            src (PathSpec): the directory.
            dst (PathSpec): the copy.
        """
        raise enotsup(self.name, "dir_copy", dst)

    @vfs_call(effect=Effect.WRITE)
    async def truncate(
        self, path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        """Resize a file, padding with zeros or cutting the end.

        Args:
            path (PathSpec): the file.
            length (int): its new size.
            no_create (bool): refuse a missing file instead of creating
                it; a VFS that cannot hold that atomically raises ENOTSUP
                before writing.
        """
        raise enotsup(self.name, "truncate", path)

    @vfs_call(effect=Effect.WRITE)
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

    async def search(
        self,
        path: PathSpec,
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str] | None:
        """Search the resource under ``path``; None declines, [] is none.

        Results are text records in the format ``search_meta`` declares.
        Errors and incomplete results are raised, never answered as a
        miss.

        Args:
            path (PathSpec): the scope.
            query (SearchQuery): the query and its options.
            index (IndexCacheStore): the mount's index.
        """
        raise enotsup(self.name, "search", path)

    async def search_many(
        self,
        paths: list[PathSpec],
        query: SearchQuery,
        index: IndexCacheStore = NULL_INDEX,
    ) -> list[str] | None:
        """Search several scopes as one ranked query.

        Args:
            paths (list[PathSpec]): the scopes.
            query (SearchQuery): the query and its options.
            index (IndexCacheStore): the mount's index.
        """
        raise enotsup(self.name, "search", paths[0] if paths else "")

    async def narrow_paths(
        self, query: str, paths: list[PathSpec]
    ) -> list[PathSpec] | None:
        """The files under ``paths`` a content index says may hold
        ``query``, so a recursive grep scans only those.

        A superset is harmless, since the scan still runs over the
        answer; None means the index cannot answer and the scan walks
        everything. Consulted only while ``content_search_enabled``.

        Args:
            query (str): the whole-word literal.
            paths (list[PathSpec]): the scopes.
        """
        return None

    def content_search_enabled(self) -> bool:
        """Whether this mount opted in to ``narrow_paths``."""
        return False

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
        """Hook a consumer's poll loop can pull deltas from, or None.

        None means this backend has no native change detection, which
        is most of them; a subclass that has one overrides this and
        narrows the return to ``DeltaHook``.
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
