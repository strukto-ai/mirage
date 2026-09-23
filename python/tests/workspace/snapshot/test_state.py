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

import logging
import os
from functools import partial
from pathlib import Path

import pytest
from pydantic import BaseModel, ConfigDict

from mirage import (NULL_INDEX, Accessor, CommandIO, FileStat, GenericVFS,
                    IndexCacheStore, MountMode, PathSpec, Workspace,
                    stream_from_bytes)
from mirage.cache.file.config import RedisCacheConfig
from mirage.policy import Action, Deny, Policy, PolicyDenied
from mirage.policy.types import SessionContext
from mirage.secrets import registry
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.types import ContentType, FileType, ReadPolicy, ReadSpec
from mirage.vfs import registry as vfs_registry
from mirage.vfs.loader import SCRIPT_MODULE_NAME, load_backend_class
from mirage.vfs.minio import MinIOConfig, MinIOVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs, register_vfs
from mirage.workspace.snapshot.keys import (CacheKey, MountKey, StateKey,
                                            VFSStateKey)
from mirage.workspace.snapshot.state import (apply_state_dict,
                                             build_mount_args,
                                             requires_vfs_override,
                                             to_state_dict)


class FakeConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


@pytest.fixture(autouse=True)
def fresh_custom(monkeypatch):
    monkeypatch.setattr(registry, "_CUSTOM", {})


@pytest.fixture(autouse=True)
def fresh_mounts(monkeypatch):
    monkeypatch.setattr(vfs_registry, "_CUSTOM", {})


async def _fetch(config: FakeConfig, ref: str) -> ResolvedSecret:
    return ResolvedSecret(fields={"TOKEN": "t0"})


@pytest.mark.asyncio
async def test_state_env_template_holds_the_pointer_never_a_value():
    register_secrets("fake", FakeConfig, _fetch)
    ws = Workspace({"/": RAMVFS()},
                   mode=MountMode.WRITE,
                   env={
                       "TOKEN": {
                           "from": "fake",
                           "ref": "r"
                       },
                       "MODE": "m"
                   })
    try:
        # Fetched into the session, so the template writer has to keep
        # writing the declaration rather than the live var.
        assert (await ws.shell("echo $TOKEN")).exit_code == 0
        state = await to_state_dict(ws)
        env = state[StateKey.ENV]
        assert env["env"] == {"MODE": "m"}
        assert env["managed"]["TOKEN"] == {
            "from": "fake",
            "ref": "r",
            "key": "TOKEN"
        }
    finally:
        await ws.close()


class NotesAccessor(Accessor):

    def __init__(self, pages: dict[str, str]) -> None:
        self.pages = pages


async def _notes_readdir(accessor: NotesAccessor,
                         path: PathSpec,
                         index: IndexCacheStore = NULL_INDEX) -> list[str]:
    parent = path.virtual.rstrip("/")
    return [f"{parent}/{name}" for name in sorted(accessor.pages)]


async def _notes_read(accessor: NotesAccessor,
                      path: PathSpec,
                      index: IndexCacheStore = NULL_INDEX) -> bytes:
    key = path.vfs_path.strip("/")
    if key not in accessor.pages:
        raise FileNotFoundError(path.virtual)
    return accessor.pages[key].encode()


async def _notes_stat(accessor: NotesAccessor,
                      path: PathSpec,
                      index: IndexCacheStore = NULL_INDEX) -> FileStat:
    key = path.vfs_path.strip("/")
    name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
    if not key:
        return FileStat(name=name, size=None, type=FileType.DIRECTORY)
    if key not in accessor.pages:
        raise FileNotFoundError(path.virtual)
    return FileStat(name=name,
                    size=len(accessor.pages[key].encode()),
                    type=FileType.FILE,
                    content=ContentType.TEXT)


def _notes_io() -> CommandIO:
    return CommandIO(readdir=_notes_readdir,
                     read_bytes=_notes_read,
                     read_stream=partial(stream_from_bytes, _notes_read),
                     stat=_notes_stat,
                     is_mounted=lambda a: True,
                     local=False)


class Notes(GenericVFS):
    """Content the VFS owns rides its state, so a version restores it."""

    def __init__(self, pages: dict[str, str] | None = None) -> None:
        self.notes = NotesAccessor(dict(pages or {}))
        super().__init__(name="notes", accessor=self.notes, io=_notes_io())

    def get_state(self) -> dict:
        return {"type": self.name, "pages": dict(self.notes.pages)}

    def load_state(self, state: dict) -> None:
        self.notes.pages = dict(state.get("pages", {}))


class Bare(GenericVFS):
    """Keeps the default state, so it has to be handed back live."""

    def __init__(self) -> None:
        super().__init__(name="bare",
                         accessor=NotesAccessor({}),
                         io=_notes_io())


@pytest.mark.asyncio
async def test_registered_content_vfs_rebuilds_without_override():
    register_vfs("notes", Notes)
    ws = Workspace({"/n/": Notes({"a.md": "one\n"})}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    mount = state[StateKey.MOUNTS][0]
    assert mount[MountKey.VFS_STATE] == {
        "type": "notes",
        "pages": {
            "a.md": "one\n"
        }
    }
    # Constructed in code, so no registry reference was stamped: the
    # loader reaches the class through the registered name alone.
    assert mount[MountKey.VFS_REF] is None
    restored = await Workspace.from_state(state)
    try:
        result = await restored.shell("cat /n/a.md")
        assert await result.stdout_str() == "one\n"
        notes = [m for m in restored.mounts() if m.prefix == "/n/"]
        assert isinstance(notes[0].vfs, Notes)
    finally:
        await restored.close()


@pytest.mark.asyncio
async def test_a_generic_vfs_keeping_the_default_state_needs_an_override():
    ws = Workspace({"/b/": Bare()}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    assert state[StateKey.MOUNTS][0][MountKey.VFS_STATE] == {
        "type": "bare",
        "needs_override": True
    }
    # The flag means the same thing in both languages now: hand me back.
    with pytest.raises(ValueError, match="mounts= must include") as exc:
        build_mount_args(state)
    assert "/b/" in str(exc.value)
    args = build_mount_args(state, mounts={"/b/": Bare()})
    assert isinstance(args.mount_args["/b/"].vfs, Bare)


TAGGED_MODULE = '''
from functools import partial

from pydantic import BaseModel

from mirage import (NULL_INDEX, Accessor, CommandIO, FileStat,
                    GenericVFS, stream_from_bytes)
from mirage.types import FileType


class AlphaConfig(BaseModel):
    """A decoy: alphabetically first, and not this VFS's config."""
    unrelated: int


class ZetaConfig(BaseModel):
    label: str


async def readdir(accessor, path, index=NULL_INDEX):
    return []


async def read_bytes(accessor, path, index=NULL_INDEX):
    raise FileNotFoundError(path.virtual)


async def stat(accessor, path, index=NULL_INDEX):
    return FileStat(name="/", size=None, type=FileType.DIRECTORY)


class Tagged(GenericVFS):
    CONFIG_CLS = ZetaConfig

    def __init__(self, config: ZetaConfig) -> None:
        self.config = config
        super().__init__(name="tagged",
                         accessor=Accessor(),
                         io=CommandIO(readdir=readdir,
                                      read_bytes=read_bytes,
                                      read_stream=partial(
                                          stream_from_bytes, read_bytes),
                                      stat=stat,
                                      is_mounted=lambda a: True,
                                      local=False))

    def get_state(self) -> dict:
        return {"type": self.name, "config": {"label": self.config.label}}
'''


@pytest.mark.asyncio
async def test_a_colon_reference_rebuilds_through_the_recorded_ref(
        tmp_path: Path):
    module = tmp_path / "tagged_backend.py"
    module.write_text(TAGGED_MODULE)
    ref = f"{module}:Tagged"
    ws = Workspace({"/t/": build_vfs(ref, {"label": "x"})},
                   mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    mount = state[StateKey.MOUNTS][0]
    # The class ran under the loader's module name, which nothing can
    # import back; the reference the registry built it from is what the
    # loader rebuilds through.
    assert mount[MountKey.VFS_CLASS] == "_mirage_user_backend.Tagged"
    assert mount[MountKey.VFS_REF] == ref
    args = build_mount_args(state)
    rebuilt = args.mount_args["/t/"].vfs
    assert type(rebuilt).__name__ == "Tagged"
    # The config class is the declared CONFIG_CLS, not the first name in
    # the module ending in Config (AlphaConfig would have been picked).
    assert rebuilt.config.label == "x"
    assert rebuilt.vfs_ref == ref


@pytest.mark.asyncio
async def test_a_script_class_with_no_reference_asks_for_an_override(
        tmp_path: Path):
    module = tmp_path / "tagged_backend.py"
    module.write_text(TAGGED_MODULE)
    cls = load_backend_class(f"{module}:Tagged")
    config_cls = load_backend_class(f"{module}:ZetaConfig")
    # Constructed directly from the loaded class: no registry, no ref.
    ws = Workspace({"/t/": cls(config_cls(label="x"))}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    assert state[StateKey.MOUNTS][0][MountKey.VFS_REF] is None
    with pytest.raises(ValueError, match="cannot import") as exc:
        build_mount_args(state)
    assert "/t/" in str(exc.value)


class SeededRAM(RAMVFS):
    """Inherits ``name``, so its state reports the builtin's ``ram`` type."""


SEEDED_MODULE = '''
from mirage.vfs.ram import RAMVFS


class SeededRAM(RAMVFS):
    pass
'''


@pytest.mark.asyncio
async def test_an_alias_over_a_builtin_rebuilds_through_its_ref_not_its_type():
    register_vfs("seeded", SeededRAM)
    ws = Workspace({"/s/": build_vfs("seeded")}, mode=MountMode.WRITE)
    try:
        await ws.shell("echo one > /s/a.txt")
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    mount = state[StateKey.MOUNTS][0]
    # The type alone names RAMVFS, which is what the mount used to
    # come back as; the ref is the door it was declared through.
    assert mount[MountKey.VFS_STATE]["type"] == "ram"
    assert mount[MountKey.VFS_REF] == "seeded"
    restored = await Workspace.from_state(state)
    try:
        seeded = [m for m in restored.mounts() if m.prefix == "/s/"][0]
        assert type(seeded.vfs) is SeededRAM
        assert seeded.vfs.vfs_ref == "seeded"
        result = await restored.shell("cat /s/a.txt")
        assert await result.stdout_str() == "one\n"
    finally:
        await restored.close()


@pytest.mark.asyncio
async def test_a_colon_reference_subclassing_a_builtin_keeps_the_subclass(
        tmp_path: Path):
    module = tmp_path / "seeded_backend.py"
    module.write_text(SEEDED_MODULE)
    ref = f"{module}:SeededRAM"
    ws = Workspace({"/s/": build_vfs(ref)}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    assert state[StateKey.MOUNTS][0][MountKey.VFS_STATE]["type"] == "ram"
    rebuilt = build_mount_args(state).mount_args["/s/"].vfs
    assert type(rebuilt).__name__ == "SeededRAM"
    assert type(rebuilt) is not RAMVFS


@pytest.mark.asyncio
async def test_a_ref_this_process_cannot_resolve_is_not_guessed_from_the_type(
):
    ws = Workspace({"/s/": RAMVFS()}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    mount = state[StateKey.MOUNTS][0]
    # Saved by a process that had an alias registered over a class loaded
    # from a script file; this one has neither, and the type would only
    # say RAMVFS.
    mount[MountKey.VFS_REF] = "seeded"
    mount[MountKey.VFS_CLASS] = f"{SCRIPT_MODULE_NAME}.SeededRAM"
    with pytest.raises(ValueError, match="mounts= must include") as exc:
        build_mount_args(state)
    assert "/s/" in str(exc.value)


class DenyGate(Policy):
    """Refuse env writes to GATE_* names, the deployment's rule."""

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        if ctx.plane == "env" and ctx.key.startswith("GATE_"):
            return Deny("GATE_* refused by policy\n")
        return None


# The restore used to seed `session.vars` directly, past the gate a live
# `export GATE_X=1` clears (#1017); a snapshot is the one env input the
# deployment did not author, so this is the door where the rule matters.
@pytest.mark.asyncio
async def test_a_restored_variable_clears_the_session_gate():
    source = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert (await source.shell("export GATE_X=1")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMVFS()},
                       mode=MountMode.WRITE,
                       policies=[DenyGate()])
    try:
        with pytest.raises(PolicyDenied):
            await apply_state_dict(target, state)
        assert "GATE_X" not in target.env
    finally:
        await target.close()


@pytest.mark.asyncio
async def test_a_restore_the_gate_allows_lands_every_variable():
    source = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert (await source.shell("export PUBLIC_X=1")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMVFS()},
                       mode=MountMode.WRITE,
                       policies=[DenyGate()])
    try:
        await apply_state_dict(target, state)
        assert target.env.get("PUBLIC_X") == "1"
    finally:
        await target.close()


# A snapshot holding several sessions used to land each one as its table
# cleared the gate, so a refusal on a later session left the earlier ones
# overwritten, the default identity adopted and every mount's state
# loaded: a workspace matching no snapshot, and one a close would then
# persist. Every table is vetted before anything lands.
@pytest.mark.asyncio
async def test_a_refused_session_table_leaves_the_workspace_untouched():
    source = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE, session_id="src")
    try:
        assert (await source.shell("echo restored > /f.txt")).exit_code == 0
        assert (await source.shell("export PUBLIC_A=1")).exit_code == 0
        source.create_session("s2")
        assert (await source.shell("export GATE_X=1",
                                   session_id="s2")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMVFS()},
                       mode=MountMode.WRITE,
                       session_id="tgt",
                       policies=[DenyGate()])
    try:
        assert (await target.shell("export KEEP=1")).exit_code == 0
        with pytest.raises(PolicyDenied):
            await apply_state_dict(target, state)
        assert "PUBLIC_A" not in target.env
        assert target.env.get("KEEP") == "1"
        assert [s.session_id for s in target.list_sessions()] == ["tgt"]
        assert (await target.shell("test -e /f.txt")).exit_code == 1
    finally:
        await target.close()


# The env template is vetted with the tables, so a refused template
# lands no session either.
@pytest.mark.asyncio
async def test_a_refused_env_template_lands_no_session():
    source = Workspace({"/": RAMVFS()},
                       mode=MountMode.WRITE,
                       env={"GATE_X": "1"})
    try:
        assert (await
                source.shell("unset GATE_X; export PUBLIC_A=1")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMVFS()},
                       mode=MountMode.WRITE,
                       policies=[DenyGate()])
    try:
        with pytest.raises(PolicyDenied):
            await apply_state_dict(target, state)
        assert "PUBLIC_A" not in target.env
        assert "GATE_X" not in target.env
    finally:
        await target.close()


# A session the restore had to create was a bare one, under no profile,
# while its table had cleared the gate under the default profile's
# policy (`script_of` for an id the manager does not know); the created
# session now runs under that profile, so what the gate judged is what
# lands, and a restored session no longer wakes unrestricted.
@pytest.mark.asyncio
async def test_a_session_the_restore_creates_runs_under_the_default_profile():
    source = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        assert (await source.shell("echo kept > /f.txt")).exit_code == 0
        source.create_session("s2")
        assert (await source.shell("export PUBLIC_A=1",
                                   session_id="s2")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMVFS()},
                       mode=MountMode.WRITE,
                       profiles={"default": {
                           "commands": {
                               "deny": ["rm"]
                           }
                       }})
    try:
        await apply_state_dict(target, state)
        compiled = target._session_mgr.default_profile
        assert compiled is not None
        restored = target.get_session("s2")
        assert restored.profile == "default"
        assert restored.commands is compiled.commands
        assert restored.script is compiled.script
        assert target._session_mgr.script_of("s2") is compiled.script
        assert restored.env.get("PUBLIC_A") == "1"
        refused = await target.shell("rm /f.txt", session_id="s2")
        assert refused.exit_code == 126
        assert refused.stderr == b"rm: Permission denied\n"
        assert (await target.shell("test -e /f.txt")).exit_code == 0
    finally:
        await target.close()


# A snapshot prefix the workspace does not mount was skipped in silence
# (#1019); the state is still not restored (never into an ancestor
# mount), but the load now says so.
@pytest.mark.asyncio
async def test_a_snapshot_mount_with_no_matching_prefix_is_reported(caplog):
    source = Workspace({"/a": RAMVFS()}, mode=MountMode.WRITE)
    try:
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/b": RAMVFS()}, mode=MountMode.WRITE)
    try:
        with caplog.at_level(logging.WARNING,
                             logger="mirage.workspace.snapshot.state"):
            await apply_state_dict(target, state)
    finally:
        await target.close()
    messages = [r.getMessage() for r in caplog.records]
    assert any("/a" in m and "not restored" in m for m in messages)
    assert not any("/b" in m for m in messages)


# An alias VFS saves its own config under its parent's `type`
# (MinIO reports `s3`), so the class the type names has the wrong secret
# field names; the redaction check scans every value instead (#1019).
@pytest.mark.asyncio
async def test_an_alias_saved_with_redacted_creds_requires_an_override():
    minio = MinIOVFS(
        MinIOConfig(bucket="b",
                    endpoint_url="http://localhost:9000",
                    access_key_id="k",
                    secret_access_key="s"))
    ws = Workspace({"/s3": minio}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    (mount, ) = (m for m in state[StateKey.MOUNTS]
                 if m[MountKey.PREFIX].rstrip("/") == "/s3")
    assert mount[MountKey.VFS_STATE][VFSStateKey.TYPE] == "s3"
    assert requires_vfs_override(mount)
    with pytest.raises(ValueError, match="/s3"):
        build_mount_args(state, None, None)


# The capture side used to read `cache._entries` unconditionally, which
# only a RAM cache has, so `Workspace.snapshot()` raised AttributeError
# under a Redis cache while the restore side already skipped it.
@pytest.mark.skipif(not os.environ.get("REDIS_URL"),
                    reason="REDIS_URL not set")
@pytest.mark.asyncio
async def test_to_state_dict_carries_no_entries_for_a_redis_cache():
    ws = Workspace({"/r": RAMVFS()},
                   mode=MountMode.WRITE,
                   cache=RedisCacheConfig(url=os.environ["REDIS_URL"],
                                          key_prefix="test-snapshot:"))
    try:
        state = await to_state_dict(ws)
        assert state[StateKey.CACHE][CacheKey.ENTRIES] == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_read_policy_survives_a_snapshot_round_trip():
    """Restored off the reloaded registry, not off the serialized dict.

    The write side and the read side land independently, so asserting
    that the state dict contains the policy would pass while the loader
    still discarded it. Reloaded without ``mounts=``, so the loader
    reconstructs the saved backend itself -- the one case where the
    saved policy still describes what is being mounted.
    """
    vfs = RAMVFS()
    ws = Workspace({"/d/": vfs},
                   mode=MountMode.WRITE,
                   read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=45))
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()

    restored = await Workspace.from_state(state)
    try:
        mount = restored._registry.mount_for_prefix("/d/")
        assert mount.read == ReadSpec(policy=ReadPolicy.BOUNDED, ttl=45)
    finally:
        await restored.close()


@pytest.mark.asyncio
async def test_a_v3_snapshot_is_refused_with_the_regenerate_message():
    ws = Workspace({"/d/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    state[StateKey.VERSION] = 3
    with pytest.raises(ValueError) as exc:
        build_mount_args(state)
    assert "v3 not supported" in str(exc.value)
    assert "regenerate" in str(exc.value)


@pytest.mark.asyncio
async def test_an_unversioned_state_dict_is_refused_not_keyerrored():
    """The absent-version hole, newly reachable.

    Every key the loader read used to have a default, so a dict with no
    version was merely odd. v4 makes the read policy required, so an
    unversioned dict would land on a bare KeyError instead of a message
    naming the fix.
    """
    ws = Workspace({"/d/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    del state[StateKey.VERSION]
    with pytest.raises(ValueError) as exc:
        build_mount_args(state)
    assert "unversioned" in str(exc.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("key", [MountKey.READ, MountKey.TTL])
async def test_a_v4_entry_missing_the_read_key_raises_rather_than_defaulting(
        key):
    """Required, never `.get(default)`, and named rather than subscripted.

    A dict labelled v4 with the key missing would otherwise install a
    default on a mount that was saved carrying something else -- the
    silent-downgrade failure the whole policy exists to remove. The bare
    subscript said so as `KeyError: 'read'`, which names neither the
    mount nor the fix, where TypeScript's loader named both; a snapshot
    written by a foreign writer is the one that arrives without the key,
    so the two hosts have to refuse it the same way.
    """
    ws = Workspace({"/d/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    del state[StateKey.MOUNTS][0][key]
    with pytest.raises(ValueError) as exc:
        build_mount_args(state)
    assert "/d/" in str(exc.value)
    assert "missing its read policy" in str(exc.value)
    assert "regenerate the snapshot" in str(exc.value)


@pytest.mark.asyncio
async def test_apply_state_dict_runs_the_version_check_too():
    """Both doors, or the same bytes get two answers.

    ``build_mount_args`` builds a workspace from the state;
    ``apply_state_dict`` restores into one that already exists and is
    what ``version checkout`` and the agent sandbox's hydrate call.
    Checking one door only meant a v3 commit was refused through
    ``Workspace.load`` and half-restored through a checkout.
    """
    ws = Workspace({"/d/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    state[StateKey.VERSION] = 3

    target = Workspace({}, mode=MountMode.WRITE)
    try:
        with pytest.raises(ValueError) as exc:
            await apply_state_dict(target, state)
        assert "v3 not supported" in str(exc.value)
        assert target._registry.try_mount_for_prefix("/d/") is None
    finally:
        await target.close()


@pytest.mark.asyncio
async def test_an_overridden_mount_takes_the_default_read_spec():
    """The saved policy belongs to the backend that was saved.

    An override hands back a different instance -- typically a stand-in
    with different capabilities -- so replaying the saved verdict onto
    it can refuse a restore that has nothing wrong with it. A `fresh`
    S3 mount overridden with a RAMVFS is exactly that case.
    """
    minio = MinIOVFS(
        MinIOConfig(bucket="b",
                    endpoint_url="http://localhost:9000",
                    access_key_id="k",
                    secret_access_key="s"))
    ws = Workspace({"/s3/": minio},
                   mode=MountMode.WRITE,
                   read=ReadSpec(policy=ReadPolicy.FRESH))
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    assert state[StateKey.MOUNTS][0][MountKey.READ] == ReadPolicy.FRESH.value

    restored = await Workspace.from_state(state, mounts={"/s3/": RAMVFS()})
    try:
        mount = restored._registry.mount_for_prefix("/s3/")
        assert mount.read == ReadSpec()
    finally:
        await restored.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(("key", "value", "message"), [
    (MountKey.READ, "banana", "fresh, bounded, pinned"),
    (MountKey.TTL, 0, "at least 1 second"),
])
async def test_a_saved_spec_is_coerced_even_on_an_overridden_mount(
        key, value, message):
    """The coercion runs before the override resets the spec.

    ``docs/home/yaml.mdx`` states this ("a snapshot naming an unknown
    one is refused whether or not the mount is overridden"), so swapping
    the two statements would break documented behaviour in silence: the
    junk would be discarded along with the spec rather than reported.
    """
    ws = Workspace({"/d/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    state[StateKey.MOUNTS][0][key] = value
    with pytest.raises(ValueError, match=message):
        build_mount_args(state, {"/d/": RAMVFS()})


@pytest.mark.asyncio
async def test_a_restore_into_a_live_workspace_keeps_the_live_read_policy():
    """``apply_state_dict`` restores content, not mount configuration.

    It loads state into mounts that already exist and never re-reads
    their `read`/`ttl`, exactly as it never re-reads `mode`. A
    ``version checkout`` therefore keeps the running workspace's policy.
    Written down here because the saved keys are right there in the
    state dict and the omission otherwise reads as an oversight.
    """
    source = Workspace({"/d/": RAMVFS()},
                       mode=MountMode.WRITE,
                       read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=45))
    try:
        state = await to_state_dict(source)
    finally:
        await source.close()
    assert state[StateKey.MOUNTS][0][MountKey.TTL] == 45

    target = Workspace({"/d/": RAMVFS()},
                       mode=MountMode.WRITE,
                       read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=90))
    try:
        await apply_state_dict(target, state)
        assert target._registry.mount_for_prefix("/d/").read.ttl == 90
    finally:
        await target.close()
