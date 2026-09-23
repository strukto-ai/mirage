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

from collections.abc import Callable
from typing import Any

from pydantic import BaseModel

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind import (CommandIO,
                                                  make_generic_commands)
from mirage.commands.config import RegisteredCommand
from mirage.commands.registry import registered_commands
from mirage.ops.generic import make_generic_ops
from mirage.ops.registry import RegisteredOp
from mirage.types import CapacityResult, CapacityState
from mirage.vfs.secrets import redacted_config_dump
from mirage.watch.base import DeltaHook


class BaseVFS:
    """What a driver supplies, and nothing a mount runs it with.

    A driver is an accessor and the tables it serves through: ``ops``
    for the VFS/FUSE verbs and ``commands`` for the shell. Everything
    a tree needs to run one (the placement, the index store, the
    registered tables, the reference it was built from) lives on the
    mount, so an author never sees it.

    There are two ways to be one. A builtin declares its facts as
    class attributes and returns from ``ops`` and ``commands`` the
    tables its ``ops/<name>`` and ``commands/builtin/<name>`` modules
    build, so it calls ``super().__init__()`` bare. A custom backend
    hands the constructor an accessor and a ``CommandIO`` table, and
    the whole generic command set (``ls``, ``cat``, ``grep``, ``find``,
    ``head``, ``wc``, ...) plus glob resolution and the VFS/FUSE ops
    are derived from it: the one-file path, which
    ``examples/python/other/custom_vfs.py`` walks end to end. Optional
    fields on the table unlock more surface (``write`` enables the
    byte-mutation family, ``find`` and ``du_size`` become native fast
    paths), and a command whose requirements the table cannot meet is
    never registered rather than registered and broken.

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
    # at all: gdrive stamps one on both sides and still cannot honour
    # fresh, because stat returns a timestamp where read returns an md5.
    # Distinct from caches_reads, which asks whether the gate can fire.
    #
    # onedrive and sharepoint look like they qualify and do not: both
    # stamp a cTag on stat and on read, so on token kind alone the
    # refusal reads as unnecessary. It is correct for a second reason
    # the flag does not name -- both label the read record with
    # `path.vfs_path`, which carries no leading slash, so `record()`
    # builds a malformed key ("/oda/b.txt" rather than "/od/a/b.txt")
    # and the cTag can never be matched against the cache entry. The
    # backends that do qualify pass `path_spec.mount_path` instead.
    # gdrive carries the same slashless label on top of its token-kind
    # mismatch. Fix the label before reconsidering the flag.
    read_revalidatable: bool = False

    _closed: bool = False

    # Whether this driver was built from a table, and the two tables
    # derived from it when it was.
    _from_table: bool = False
    _commands_table: list[RegisteredCommand] | None = None
    _ops_table: list[RegisteredOp] | None = None

    def __init__(
        self,
        *,
        name: str | None = None,
        accessor: Accessor | None = None,
        io: CommandIO | None = None,
        prompt: str | None = None,
        write_prompt: str | None = None,
        overrides: set[str] | None = None,
        commands: list[Callable[..., Any]] | None = None,
        ops: list[Callable[..., Any]] | None = None,
        provision_overrides: dict[str, Callable[..., Any]] | None = None,
        auto_ops: bool = True,
        caches_reads: bool | None = None,
        sizes_always_known: bool | None = None,
        supports_snapshot: bool | None = None,
        read_revalidatable: bool | None = None,
    ) -> None:
        """Build a driver from a table, or nothing at all.

        Every argument is optional, so a class that declares its facts
        as attributes and returns its tables from ``ops`` and
        ``commands`` calls ``super().__init__()`` bare. Given ``io``,
        the whole generic command set and the derived op set are wired
        from the table.

        Args:
            name (str | None): VFS name commands register under; also
                the registry key when the class is exposed through
                ``register_vfs`` or a ``mirage.vfs`` entry point. None
                keeps the class attribute.
            accessor (Accessor | None): backend handle passed to every
                core function.
            io (CommandIO | None): the backend's IO table.
            prompt (str | None): LLM-facing description of the layout.
            write_prompt (str | None): appended when mounted writable.
            overrides (set[str] | None): generic command names the
                backend replaces (pass the replacements via ``commands``).
            commands (list[Callable] | None): extra ``@command``
                functions (bespoke verbs or override replacements).
            ops (list[Callable] | None): ``@op`` functions or
                ``RegisteredOp`` values layered over the derived set; one
                carrying no filetype shadows the derived op of its name.
            provision_overrides (dict[str, Callable] | None): per-command
                cost estimators replacing the catalog default.
            auto_ops (bool): derive the op set from the table; disable to
                serve only the explicit ``ops``.
            caches_reads (bool | None): serve repeat reads from the file
                cache; enable only for stable, read-mostly content.
            sizes_always_known (bool | None): whether ``io.stat`` sizes
                every regular file without fetching it, which is also
                what makes the mount legal on FSKit.
            supports_snapshot (bool | None): whether ``io.stat`` fills
                ``FileStat.fingerprint`` with a stable per-path marker.
                Setting it without that is not drift detection.
            read_revalidatable (bool | None): whether ``io.stat`` and the
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
        if caches_reads is not None:
            self.caches_reads = caches_reads
        if sizes_always_known is not None:
            self.sizes_always_known = sizes_always_known
        if supports_snapshot is not None:
            self.supports_snapshot = supports_snapshot
        if read_revalidatable is not None:
            self.read_revalidatable = read_revalidatable
        if io is None:
            if any(x is not None
                   for x in (overrides, commands, ops, provision_overrides)):
                raise ValueError(
                    "overrides, commands, ops and provision_overrides "
                    "derive from an io table; pass io")
            return
        self._from_table = True
        self._commands_table = registered_commands([
            *make_generic_commands(self.name,
                                   io,
                                   overrides=overrides,
                                   provision_overrides=provision_overrides),
            *(commands or []),
        ])
        user_ops: list[RegisteredOp] = []
        for fn in ops or []:
            if isinstance(fn, RegisteredOp):
                user_ops.append(fn)
            else:
                user_ops.extend(getattr(fn, "_registered_ops"))
        # A user op carrying no filetype replaces the derived op of the
        # same name: the derived set is built with those names skipped,
        # so two handlers never compete for one key.
        shadowed = {ro.name for ro in user_ops if ro.filetype is None}
        derived = (make_generic_ops(self.name, io, overrides=shadowed)
                   if auto_ops else [])
        self._ops_table = [*derived, *user_ops]

    def ops(self) -> list[RegisteredOp]:
        """The VFS/FUSE verbs this driver serves, as registered ops.

        A verb that is not in this list is not served: the mount answers
        ``Operation not supported`` for it. A driver built from a table
        serves the set derived from it; a builtin returns the list its
        ``ops/<name>`` module derives from the backend's table.
        """
        return self._ops_table if self._ops_table is not None else []

    def commands(self) -> list[RegisteredCommand]:
        """The shell commands this driver serves, as registered commands."""
        return (self._commands_table
                if self._commands_table is not None else [])

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

        The default carries only the type, which is enough to rebuild a
        builtin that owns nothing. A driver built from a table adds
        ``needs_override``: the base cannot know a subclass's
        constructor, so both loaders then require the mount to be handed
        back live (``mounts=``; ``Workspace.copy`` does this itself). A
        driver that owns its content (an in-memory store) overrides this
        and ``load_state`` to carry it and drops the flag; a driver over
        a remote service keeps the default and pins what it read through
        ``supports_snapshot`` fingerprints instead.
        """
        if not self._from_table:
            return {"type": self.name}
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
        """Take back what ``get_state`` put out. A no-op by default.

        Args:
            state (dict[str, Any]): the recorded state.
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
