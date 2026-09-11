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

from mirage import (NULL_INDEX, Accessor, CommandIO, FileStat, GenericResource,
                    IndexCacheStore, MountMode, PathSpec, Workspace,
                    stream_from_bytes)
from mirage.cache.file.config import RedisCacheConfig
from mirage.policy import Action, Deny, Policy, PolicyDenied, PolicyError
from mirage.policy.profile import profile_from_dict
from mirage.policy.types import SessionContext
from mirage.resource import registry as resource_registry
from mirage.resource.loader import SCRIPT_MODULE_NAME, load_backend_class
from mirage.resource.minio import MinIOConfig, MinIOResource
from mirage.resource.ram import RAMResource
from mirage.resource.registry import build_resource, register_resource
from mirage.secrets import registry
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.shell.variable import ShellVar
from mirage.types import ConsistencyPolicy, ContentType, FileType
from mirage.workspace.snapshot.keys import (CacheKey, MountKey,
                                            ResourceStateKey, StateKey)
from mirage.workspace.snapshot.state import (apply_state_dict,
                                             build_mount_args,
                                             requires_resource_override,
                                             to_state_dict)


class FakeConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


@pytest.fixture(autouse=True)
def fresh_custom(monkeypatch):
    monkeypatch.setattr(registry, "_CUSTOM", {})


@pytest.fixture(autouse=True)
def fresh_resources(monkeypatch):
    monkeypatch.setattr(resource_registry, "_CUSTOM", {})


async def _fetch(config: FakeConfig, ref: str) -> ResolvedSecret:
    return ResolvedSecret(fields={"TOKEN": "t0"})


@pytest.mark.asyncio
async def test_state_env_template_holds_the_pointer_never_a_value():
    register_secrets("fake", FakeConfig, _fetch)
    ws = Workspace({"/": RAMResource()},
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
        assert (await ws.execute("echo $TOKEN")).exit_code == 0
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
    key = path.resource_path.strip("/")
    if key not in accessor.pages:
        raise FileNotFoundError(path.virtual)
    return accessor.pages[key].encode()


async def _notes_stat(accessor: NotesAccessor,
                      path: PathSpec,
                      index: IndexCacheStore = NULL_INDEX) -> FileStat:
    key = path.resource_path.strip("/")
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


class Notes(GenericResource):
    """Content the resource owns rides its state, so a version restores it."""

    def __init__(self, pages: dict[str, str] | None = None) -> None:
        self.notes = NotesAccessor(dict(pages or {}))
        super().__init__(name="notes", accessor=self.notes, io=_notes_io())

    def get_state(self) -> dict:
        return {"type": self.name, "pages": dict(self.notes.pages)}

    def load_state(self, state: dict) -> None:
        self.notes.pages = dict(state.get("pages", {}))


class Bare(GenericResource):
    """Keeps the default state, so it has to be handed back live."""

    def __init__(self) -> None:
        super().__init__(name="bare",
                         accessor=NotesAccessor({}),
                         io=_notes_io())


@pytest.mark.asyncio
async def test_registered_content_resource_rebuilds_without_override():
    register_resource("notes", Notes)
    ws = Workspace({"/n/": Notes({"a.md": "one\n"})}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    mount = state[StateKey.MOUNTS][0]
    assert mount[MountKey.RESOURCE_STATE] == {
        "type": "notes",
        "pages": {
            "a.md": "one\n"
        }
    }
    # Constructed in code, so no registry reference was stamped: the
    # loader reaches the class through the registered name alone.
    assert mount[MountKey.RESOURCE_REF] is None
    restored = await Workspace.from_state(state)
    try:
        result = await restored.execute("cat /n/a.md")
        assert await result.stdout_str() == "one\n"
        notes = [m for m in restored.mounts() if m.prefix == "/n/"]
        assert isinstance(notes[0].resource, Notes)
    finally:
        await restored.close()


@pytest.mark.asyncio
async def test_a_generic_resource_keeping_the_default_state_needs_an_override(
):
    ws = Workspace({"/b/": Bare()}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    assert state[StateKey.MOUNTS][0][MountKey.RESOURCE_STATE] == {
        "type": "bare",
        "needs_override": True
    }
    # The flag means the same thing in both languages now: hand me back.
    with pytest.raises(ValueError, match="resources= must include") as exc:
        build_mount_args(state)
    assert "/b/" in str(exc.value)
    args = build_mount_args(state, resources={"/b/": Bare()})
    assert isinstance(args.mount_args["/b/"][0], Bare)


TAGGED_MODULE = '''
from functools import partial

from pydantic import BaseModel

from mirage import (NULL_INDEX, Accessor, CommandIO, FileStat,
                    GenericResource, stream_from_bytes)
from mirage.types import FileType


class AlphaConfig(BaseModel):
    """A decoy: alphabetically first, and not this resource's config."""
    unrelated: int


class ZetaConfig(BaseModel):
    label: str


async def readdir(accessor, path, index=NULL_INDEX):
    return []


async def read_bytes(accessor, path, index=NULL_INDEX):
    raise FileNotFoundError(path.virtual)


async def stat(accessor, path, index=NULL_INDEX):
    return FileStat(name="/", size=None, type=FileType.DIRECTORY)


class Tagged(GenericResource):
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
    ws = Workspace({"/t/": build_resource(ref, {"label": "x"})},
                   mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    mount = state[StateKey.MOUNTS][0]
    # The class ran under the loader's module name, which nothing can
    # import back; the reference the registry built it from is what the
    # loader rebuilds through.
    assert mount[MountKey.RESOURCE_CLASS] == "_mirage_user_backend.Tagged"
    assert mount[MountKey.RESOURCE_REF] == ref
    args = build_mount_args(state)
    rebuilt = args.mount_args["/t/"][0]
    assert type(rebuilt).__name__ == "Tagged"
    # The config class is the declared CONFIG_CLS, not the first name in
    # the module ending in Config (AlphaConfig would have been picked).
    assert rebuilt.config.label == "x"
    assert rebuilt.resource_ref == ref


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
    assert state[StateKey.MOUNTS][0][MountKey.RESOURCE_REF] is None
    with pytest.raises(ValueError, match="cannot import") as exc:
        build_mount_args(state)
    assert "/t/" in str(exc.value)


class SeededRAM(RAMResource):
    """Inherits ``name``, so its state reports the builtin's ``ram`` type."""


SEEDED_MODULE = '''
from mirage.resource.ram import RAMResource


class SeededRAM(RAMResource):
    pass
'''


@pytest.mark.asyncio
async def test_an_alias_over_a_builtin_rebuilds_through_its_ref_not_its_type():
    register_resource("seeded", SeededRAM)
    ws = Workspace({"/s/": build_resource("seeded")}, mode=MountMode.WRITE)
    try:
        await ws.execute("echo one > /s/a.txt")
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    mount = state[StateKey.MOUNTS][0]
    # The type alone names RAMResource, which is what the mount used to
    # come back as; the ref is the door it was declared through.
    assert mount[MountKey.RESOURCE_STATE]["type"] == "ram"
    assert mount[MountKey.RESOURCE_REF] == "seeded"
    restored = await Workspace.from_state(state)
    try:
        seeded = [m for m in restored.mounts() if m.prefix == "/s/"][0]
        assert type(seeded.resource) is SeededRAM
        assert seeded.resource.resource_ref == "seeded"
        result = await restored.execute("cat /s/a.txt")
        assert await result.stdout_str() == "one\n"
    finally:
        await restored.close()


@pytest.mark.asyncio
async def test_a_colon_reference_subclassing_a_builtin_keeps_the_subclass(
        tmp_path: Path):
    module = tmp_path / "seeded_backend.py"
    module.write_text(SEEDED_MODULE)
    ref = f"{module}:SeededRAM"
    ws = Workspace({"/s/": build_resource(ref)}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    assert state[StateKey.MOUNTS][0][MountKey.RESOURCE_STATE]["type"] == "ram"
    rebuilt = build_mount_args(state).mount_args["/s/"][0]
    assert type(rebuilt).__name__ == "SeededRAM"
    assert type(rebuilt) is not RAMResource


@pytest.mark.asyncio
async def test_a_ref_this_process_cannot_resolve_is_not_guessed_from_the_type(
):
    ws = Workspace({"/s/": RAMResource()}, mode=MountMode.READ)
    try:
        state = await to_state_dict(ws)
    finally:
        await ws.close()
    mount = state[StateKey.MOUNTS][0]
    # Saved by a process that had an alias registered over a class loaded
    # from a script file; this one has neither, and the type would only
    # say RAMResource.
    mount[MountKey.RESOURCE_REF] = "seeded"
    mount[MountKey.RESOURCE_CLASS] = f"{SCRIPT_MODULE_NAME}.SeededRAM"
    with pytest.raises(ValueError, match="resources= must include") as exc:
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
    source = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        assert (await source.execute("export GATE_X=1")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMResource()},
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
    source = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        assert (await source.execute("export PUBLIC_X=1")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMResource()},
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
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       session_id="src")
    try:
        assert (await source.execute("echo restored > /f.txt")).exit_code == 0
        assert (await source.execute("export PUBLIC_A=1")).exit_code == 0
        source.create_session("s2")
        assert (await source.execute("export GATE_X=1",
                                     session_id="s2")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       session_id="tgt",
                       policies=[DenyGate()])
    try:
        assert (await target.execute("export KEEP=1")).exit_code == 0
        with pytest.raises(PolicyDenied):
            await apply_state_dict(target, state)
        assert "PUBLIC_A" not in target.env
        assert target.env.get("KEEP") == "1"
        assert [s.session_id for s in target.list_sessions()] == ["tgt"]
        assert (await target.execute("test -e /f.txt")).exit_code == 1
        # The gate created a candidate for s2 and dropped it with its
        # lock, so the id is free again.
        with pytest.raises(KeyError):
            target._session_mgr.lock_for("s2")
        assert target.create_session("s2").session_id == "s2"
    finally:
        await target.close()


# The env template is vetted with the tables, so a refused template
# lands no session either.
@pytest.mark.asyncio
async def test_a_refused_env_template_lands_no_session():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       env={"GATE_X": "1"})
    try:
        assert (
            await
            source.execute("unset GATE_X; export PUBLIC_A=1")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMResource()},
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
    source = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        assert (await source.execute("echo kept > /f.txt")).exit_code == 0
        source.create_session("s2")
        assert (await source.execute("export PUBLIC_A=1",
                                     session_id="s2")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMResource()},
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
        refused = await target.execute("rm /f.txt", session_id="s2")
        assert refused.exit_code == 126
        assert refused.stderr == b"rm: Permission denied\n"
        assert (await target.execute("test -e /f.txt")).exit_code == 0
    finally:
        await target.close()


# A snapshot prefix the workspace does not mount was skipped in silence
# (#1019); the state is still not restored (never into an ancestor
# mount), but the load now says so.
@pytest.mark.asyncio
async def test_a_snapshot_mount_with_no_matching_prefix_is_reported(caplog):
    source = Workspace({"/a": RAMResource()}, mode=MountMode.WRITE)
    try:
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/b": RAMResource()}, mode=MountMode.WRITE)
    try:
        with caplog.at_level(logging.WARNING,
                             logger="mirage.workspace.snapshot.state"):
            await apply_state_dict(target, state)
    finally:
        await target.close()
    messages = [r.getMessage() for r in caplog.records]
    assert any("/a" in m and "not restored" in m for m in messages)
    assert not any("/b" in m for m in messages)


# An alias resource saves its own config under its parent's `type`
# (MinIO reports `s3`), so the class the type names has the wrong secret
# field names; the redaction check scans every value instead (#1019).
@pytest.mark.asyncio
async def test_an_alias_saved_with_redacted_creds_requires_an_override():
    minio = MinIOResource(
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
    assert mount[MountKey.RESOURCE_STATE][ResourceStateKey.TYPE] == "s3"
    assert requires_resource_override(mount)
    with pytest.raises(ValueError, match="/s3"):
        build_mount_args(state, None, None)


# The capture side used to read `cache._entries` unconditionally, which
# only a RAM cache has, so `Workspace.snapshot()` raised AttributeError
# under a Redis cache while the restore side already skipped it.
@pytest.mark.skipif(not os.environ.get("REDIS_URL"),
                    reason="REDIS_URL not set")
@pytest.mark.asyncio
async def test_to_state_dict_carries_no_entries_for_a_redis_cache():
    ws = Workspace({"/r": RAMResource()},
                   mode=MountMode.WRITE,
                   cache=RedisCacheConfig(url=os.environ["REDIS_URL"],
                                          key_prefix="test-snapshot:"))
    try:
        state = await to_state_dict(ws)
        assert state[StateKey.CACHE][CacheKey.ENTRIES] == []
    finally:
        await ws.close()


RESTRICTED = {
    "env": {
        "SLACK_TOKEN": "xoxb-secret"
    },
    "vars": {
        "hide": ["SLACK_TOKEN"]
    },
    "commands": {
        "deny": ["rm"],
        "ask": [{
            "reason": "creates files",
            "commands": ["touch"]
        }],
    },
}


# A session created under a named profile came back under the target's
# default: the snapshot carried no document, so `Workspace.load` had
# nothing to narrow it under, and the restore copied cwd, vars and modes
# off the table and dropped the rest. The state now carries the document
# and the restore lands the whole table under the profile of its name.
@pytest.mark.asyncio
async def test_a_session_under_a_named_profile_survives_from_state():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={
                           "default": {},
                           "restricted": RESTRICTED
                       })
    try:
        source.create_session("agent",
                              profile="restricted",
                              permissions={"commands": {
                                  "deny": ["mv"]
                              }})
        asked = await source.execute("touch /made", session_id="agent")
        assert asked.exit_code == 126
        pending = source.decisions.pending("agent")
        assert len(pending) == 1
        state = await to_state_dict(source)
    finally:
        await source.close()
    assert state[StateKey.PROFILE] is None
    assert (profile_from_dict(state[StateKey.PROFILES]["restricted"]) ==
            profile_from_dict(RESTRICTED))
    target = await Workspace.from_state(state)
    try:
        restored = target.get_session("agent")
        assert restored.profile == "restricted"
        assert restored.hidden_vars is not None
        shown = await target.execute("echo tok=[$SLACK_TOKEN]",
                                     session_id="agent")
        assert (shown.exit_code, shown.stdout) == (0, b"tok=[]\n")
        out = await target.execute("rm -f /x", session_id="agent")
        assert out.exit_code == 126
        assert out.stderr == b"rm: Permission denied\n"
        moved = await target.execute("mv /a /b", session_id="agent")
        assert moved.exit_code == 126
        write = await target.execute("export SLACK_TOKEN=evil",
                                     session_id="agent")
        assert write.exit_code != 0
        assert [d.id for d in target.decisions.pending("agent")
                ] == [d.id for d in pending]
        assert target.decisions.pending("agent")[0].rule == pending[0].rule
    finally:
        await target.close()


# A restored table is a fact about the source session, never a grant: a
# wider cap and a wider allow list than the target's document states
# land as the target's, and what the table adds on top is kept.
@pytest.mark.asyncio
async def test_a_restored_table_never_widens_the_target_document():
    source = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                       mode=MountMode.WRITE,
                       profiles={
                           "default": {
                               "commands": {
                                   "allow": ["cat", "echo", "touch", "ls"]
                               }
                           }
                       })
    try:
        source.create_session("agent", mounts={"/data": "write"})
        assert (await source.execute("touch /data/made",
                                     session_id="agent")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                       mode=MountMode.WRITE,
                       profiles={
                           "default": {
                               "mounts": {
                                   "/data": "r"
                               },
                               "commands": {
                                   "allow": ["echo", "ls", "rm"],
                                   "deny": ["rm"],
                               },
                           }
                       })
    try:
        await apply_state_dict(target, state)
        restored = target.get_session("agent")
        assert restored.mount_modes == {"/data": MountMode.READ}
        assert restored.commands is not None
        assert set(restored.commands.allow or ()) == {"echo", "ls"}
        assert (await target.execute("echo ok",
                                     session_id="agent")).exit_code == 0
        assert (await target.execute("touch /data/x",
                                     session_id="agent")).exit_code == 127
        assert (await target.execute("rm /data/made",
                                     session_id="agent")).exit_code != 0
        listed = await target.execute("ls /data", session_id="agent")
        assert listed.exit_code == 0 and b"made" in listed.stdout
    finally:
        await target.close()


# The other direction: a table narrower than the target's document lands
# with its own hides, denies and answers, under a target that states
# nothing at all (its `default` name resolves to the target default).
@pytest.mark.asyncio
async def test_a_tables_own_narrowing_lands_under_a_permissive_target():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={"default": RESTRICTED})
    try:
        assert (await source.execute("echo kept > /f.txt")).exit_code == 0
        source.create_session("agent")
        asked = await source.execute("touch /made", session_id="agent")
        assert asked.exit_code == 126
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        await apply_state_dict(target, state)
        for sid in ("agent", target.default_session_id):
            shown = await target.execute("echo tok=[$SLACK_TOKEN]",
                                         session_id=sid)
            assert (shown.exit_code, shown.stdout) == (0, b"tok=[]\n")
            assert (await target.execute("rm /f.txt",
                                         session_id=sid)).exit_code == 126
        assert (await target.execute("test -e /f.txt")).exit_code == 0
        assert len(target.decisions.pending("agent")) == 1
        # Nothing the target document never said arrives as a program.
        assert target.get_session("agent").profile is None
        assert target.get_session("agent").script is None
    finally:
        await target.close()


# A name the target does not define is refused with the PolicyError an
# unknown profile gets everywhere, before a mount or a session has moved.
@pytest.mark.asyncio
async def test_an_unknown_profile_name_refuses_the_load_before_it_lands():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       session_id="src",
                       profiles={"restricted": RESTRICTED})
    try:
        assert (await source.execute("echo restored > /f.txt")).exit_code == 0
        source.create_session("agent", profile="restricted")
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       session_id="tgt")
    try:
        assert (await target.execute("export KEEP=1")).exit_code == 0
        with pytest.raises(PolicyError, match="unknown profile 'restricted'"):
            await apply_state_dict(target, state)
        assert target.env.get("KEEP") == "1"
        assert [s.session_id for s in target.list_sessions()] == ["tgt"]
        assert (await target.execute("test -e /f.txt")).exit_code == 1
    finally:
        await target.close()
    # The loader's own document has the same rule: one that omits the
    # snapshot's default profile fails at construction.
    state[StateKey.PROFILE] = "restricted"
    with pytest.raises(PolicyError, match="unknown profile 'restricted'"):
        await Workspace.from_state(state, profiles={"default": {}})


# The loader's document outranks the snapshot's, the way the document
# outranks a stored record at hydration.
@pytest.mark.asyncio
async def test_a_loader_supplied_document_wins_over_the_snapshots():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={"restricted": RESTRICTED})
    try:
        source.create_session("agent", profile="restricted")
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = await Workspace.from_state(
        state, profiles={"restricted": {
            "commands": {
                "deny": ["touch"]
            }
        }})
    try:
        restored = target.get_session("agent")
        assert restored.profile == "restricted"
        # The table's hides and rules still land (never wider), the
        # loader's rule beside them.
        assert restored.hidden_vars is not None
        assert (await target.execute("touch /x",
                                     session_id="agent")).exit_code == 126
        assert (await target.execute("rm -f /x",
                                     session_id="agent")).exit_code == 126
        assert target.create_session("fresh",
                                     profile="restricted").hidden_vars is None
    finally:
        await target.close()


# Landing a workspace's own state on itself changes nothing, which a
# checkout that hands live tables back through the restore relies on.
@pytest.mark.asyncio
async def test_re_applying_a_workspaces_own_state_is_a_no_op():
    ws = Workspace({"/repo": (RAMResource(), MountMode.EXEC)},
                   mode=MountMode.EXEC,
                   profiles={
                       "default": {
                           "mounts": {
                               "/repo": {
                                   "mode": "rw",
                                   "paths": {
                                       "hide": ["/repo/sealed", "*.pem"],
                                       "show": {
                                           "/repo/sealed/public": "r"
                                       },
                                   },
                                   "commands": {
                                       "ask": ["git push"]
                                   },
                               }
                           },
                           "vars": {
                               "hide": ["AWS_*"]
                           },
                           "commands": {
                               "allow": ["ls", "cat", "echo", "git *", "rm"],
                               "deny": ["rm"],
                           },
                       },
                       "restricted": RESTRICTED,
                   })
    try:
        ws.create_session("agent",
                          profile="restricted",
                          permissions={"paths": {
                              "hide": ["/repo/.env"]
                          }})
        assert (await ws.execute("echo a > /repo/a.txt")).exit_code == 0
        assert (await ws.execute("touch /repo/b",
                                 session_id="agent")).exit_code == 126
        before = {s.session_id: s.to_dict() for s in ws.list_sessions()}
        compiled = ws._session_mgr.default_profile
        assert compiled is not None
        await apply_state_dict(ws, await to_state_dict(ws))
        after = {s.session_id: s.to_dict() for s in ws.list_sessions()}
        assert after == before
        default = ws.get_session(ws.default_session_id)
        assert default.commands is compiled.commands
        assert default.hidden_paths is compiled.hidden_paths
        assert default.shown_paths is compiled.shown_paths
        assert default.hidden_vars is compiled.hidden_vars
        assert default.hide_reasons is compiled.hide_reasons
    finally:
        await ws.close()


# The consistency knob is the workspace's; every mount used to record the
# mount() default and the loader restored LAZY regardless.
@pytest.mark.asyncio
async def test_the_consistency_knob_round_trips():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       consistency=ConsistencyPolicy.ALWAYS)
    try:
        state = await to_state_dict(source)
    finally:
        await source.close()
    assert state[StateKey.CONSISTENCY] == "always"
    assert all(m[MountKey.CONSISTENCY] == "always"
               for m in state[StateKey.MOUNTS])
    assert build_mount_args(state).consistency is ConsistencyPolicy.ALWAYS
    target = await Workspace.from_state(state)
    try:
        assert target._consistency is ConsistencyPolicy.ALWAYS
    finally:
        await target.close()
    del state[StateKey.CONSISTENCY]
    assert build_mount_args(state).consistency is ConsistencyPolicy.LAZY


# A coded policy is named, never carried: the loader registers it, and a
# name nothing answers to is reported rather than silently dropped.
@pytest.mark.asyncio
async def test_a_recorded_policy_class_the_target_lacks_is_reported(caplog):
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       policies=[DenyGate()])
    try:
        state = await to_state_dict(source)
    finally:
        await source.close()
    assert state[StateKey.POLICIES] == ["DenyGate"]
    with caplog.at_level(logging.WARNING):
        target = await Workspace.from_state(state)
        await target.close()
    assert any("DenyGate" in r.getMessage() for r in caplog.records)
    caplog.clear()
    with caplog.at_level(logging.WARNING):
        target = await Workspace.from_state(state, policies=[DenyGate()])
        await target.close()
    assert not any("policy class" in r.getMessage() for r in caplog.records)


LOCKED = {
    "commands": {
        "allow": ["echo", "cat", "rm", "ls", "test"],
        "deny": ["rm"],
    },
    "policy": {
        "script": {
            "source":
            "def pre_command(ctx):\n"
            "    if ctx['command']['name'] == 'cat':\n"
            "        return {'deny': 'no reading here'}\n"
            "    return None\n",
            "language":
            "python",
        },
        "runtime": "monty",
    },
}


# The gate created and narrowed the sessions it had to make, but left
# the default session and every live one on whatever profile they
# already ran under, so the target's document of the name a table
# carries never governed the restored session: `narrow_restored` takes
# no program and no new restriction off a table, and nothing else
# applied the document's.
@pytest.mark.asyncio
async def test_the_default_sessions_named_profile_governs_after_a_load():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={"locked": LOCKED})
    try:
        assert (await source.execute("echo kept > /f.txt")).exit_code == 0
        await source.set_session_profile(source.default_session_id, "locked")
        assert (await source.execute("cat /f.txt")).exit_code == 126
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = await Workspace.from_state(state)
    try:
        restored = target.get_session(target.default_session_id)
        assert restored.profile == "locked"
        assert restored.script is not None
        # `cat` is on the profile's allow list and not on its deny
        # list, so only the profile's policy program can refuse it.
        assert (await target.execute("cat /f.txt")).exit_code == 126
        assert (await target.execute("rm /f.txt")).exit_code == 126
        assert (await target.execute("echo ok")).exit_code == 0
        assert (await target.execute("ls /")).exit_code == 0
    finally:
        await target.close()


# The same rule with no policy program in sight: a loader that supplies
# a stricter version of the profile a table names governs the restored
# session, where before only the table's own restrictions landed.
@pytest.mark.asyncio
async def test_a_stricter_loader_profile_governs_the_restored_default():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={"crew": {
                           "commands": {
                               "deny": ["rm"]
                           }
                       }})
    try:
        assert (await source.execute("echo kept > /f.txt")).exit_code == 0
        await source.set_session_profile(source.default_session_id, "crew")
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = await Workspace.from_state(
        state, profiles={"crew": {
            "commands": {
                "deny": ["rm", "cat"]
            }
        }})
    try:
        restored = target.get_session(target.default_session_id)
        assert restored.profile == "crew"
        assert (await target.execute("rm /f.txt")).exit_code == 126
        assert (await target.execute("cat /f.txt")).exit_code == 126
        assert (await target.execute("ls /")).exit_code == 0
    finally:
        await target.close()


# The other half of the same rule: a checkout adds the version's
# restrictions to a live session and lifts none of the live ones, and
# the program the host installed with set_session_profile stays.
@pytest.mark.asyncio
async def test_a_checkout_never_lifts_a_live_sessions_program():
    source = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    try:
        assert (await source.execute("echo kept > /f.txt")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={"locked": LOCKED})
    try:
        await target.set_session_profile(target.default_session_id, "locked")
        program = target.get_session(target.default_session_id).script
        await apply_state_dict(target, state, replace_cache=True)
        live = target.get_session(target.default_session_id)
        assert live.script is program
        assert live.profile == "locked"
        assert (await target.execute("cat /f.txt")).exit_code == 126
        assert (await target.execute("rm /f.txt")).exit_code == 126
        assert (await target.execute("ls /")).exit_code == 0
    finally:
        await target.close()


# A refusal after the profiles have been joined onto the live sessions
# puts them back: the workspace is the one the snapshot never touched.
@pytest.mark.asyncio
async def test_a_refused_table_puts_a_joined_live_session_back():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={"locked": LOCKED})
    try:
        await source.set_session_profile(source.default_session_id, "locked")
        assert (await source.execute("export SEALED=1")).exit_code == 0
        state = await to_state_dict(source)
    finally:
        await source.close()

    class RefuseSealed(Policy):

        async def pre_session(self, ctx: SessionContext) -> Deny | None:
            return Deny("sealed is refused") if ctx.key == "SEALED" else None

    target = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={"locked": LOCKED},
                       policies=[RefuseSealed()])
    try:
        before = target.get_session(target.default_session_id).to_dict()
        with pytest.raises(PolicyDenied):
            await apply_state_dict(target, state)
        assert target.get_session(
            target.default_session_id).to_dict() == before
    finally:
        await target.close()


# `profile=None` is a value on the loader, not an omission: a caller
# clearing the default profile a snapshot names could not say so while
# None was also the absent-argument marker.
@pytest.mark.asyncio
async def test_an_explicit_none_profile_clears_the_recorded_default():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={"locked": LOCKED})
    try:
        state = await to_state_dict(source)
    finally:
        await source.close()
    state[StateKey.PROFILE] = "locked"
    kept = await Workspace.from_state(state, profiles={"locked": LOCKED})
    try:
        assert kept._default_profile_name == "locked"
    finally:
        await kept.close()
    cleared = await Workspace.from_state(state,
                                         profiles={"locked": LOCKED},
                                         profile=None)
    try:
        assert cleared._default_profile_name is None
    finally:
        await cleared.close()


MONTY_GUARD = {
    "commands": {
        "allow": ["echo", "cat", "ls"]
    },
    "policy": {
        "script": {
            "source":
            "def pre_command(ctx):\n"
            "    if ctx['command']['name'] == 'cat':\n"
            "        return {'deny': 'monty says no'}\n"
            "    return None\n",
            "language":
            "python",
        },
        "runtime": "monty",
    },
}


# A runtime world is deployment wiring the snapshot never carries, and a
# restored profile policy names the runtime it needs, so the loader has
# to be able to state one. TypeScript took `runtimes` through its
# options from the start; Python had no way to say it.
@pytest.mark.asyncio
async def test_the_loader_states_the_runtime_world_a_profile_policy_needs():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       profiles={"guard": MONTY_GUARD},
                       profile="guard",
                       runtimes=["monty"])
    try:
        assert (await source.execute("echo hi > /f.txt")).exit_code == 0
        refused = await source.execute("cat /f.txt")
        assert refused.exit_code == 126
        assert refused.refusal is not None
        assert refused.refusal.reason == "monty says no"
        state = await to_state_dict(source)
    finally:
        await source.close()
    target = await Workspace.from_state(state, runtimes=["monty"])
    try:
        out = await target.execute("cat /f.txt")
        assert out.exit_code == 126
        assert out.refusal is not None
        assert out.refusal.reason == "monty says no"
        assert (await target.execute("echo ok")).exit_code == 0
    finally:
        await target.close()


# A profile whose policy program refuses one variable name. The gate
# fires it per restored variable, so which program answers is decided
# by the session id the gate names.
SEALS_A_VAR = {
    "commands": {
        "allow": ["echo", "cat", "export"]
    },
    "policy": {
        "script": {
            "source":
            "def pre_session(ctx):\n"
            "    if ctx['write']['key'] == 'SEALED':\n"
            "        return {'deny': 'sealed is refused'}\n"
            "    return None\n",
            "language":
            "python",
        },
        "runtime": "monty",
    },
}


# A policy hook reads its program off the manager by session id, and the
# manager cannot answer for the snapshot's default id until
# `adopt_default` re-keys the live default onto it. So a checkout whose
# recorded default id differs from the live one gated that table under
# the target's default program instead of the one the join had just
# installed, and a `pre_session` rule the named profile carries never
# saw the restored variables.
@pytest.mark.asyncio
async def test_a_remapped_default_table_is_gated_under_its_landing_id():
    source = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       session_id="src",
                       profiles={"sealed": SEALS_A_VAR})
    try:
        await source.set_session_profile("src", "sealed")
        # The gate the target will fire is the profile's, so the source
        # writes the name through a door the profile does not refuse.
        source._session_mgr.get("src").vars["SEALED"] = ShellVar(value="1")
        state = await to_state_dict(source)
    finally:
        await source.close()
    assert state[StateKey.DEFAULT_SESSION_ID] == "src"
    target = Workspace({"/": RAMResource()},
                       mode=MountMode.WRITE,
                       session_id="tgt",
                       profiles={"sealed": SEALS_A_VAR},
                       runtimes=["monty"])
    try:
        with pytest.raises(PolicyDenied, match="sealed is refused"):
            await apply_state_dict(target, state)
        # Refused before anything landed: the live default keeps its id
        # and the variable never arrived.
        assert target.default_session_id == "tgt"
        assert "SEALED" not in target.get_session("tgt").vars
    finally:
        await target.close()
