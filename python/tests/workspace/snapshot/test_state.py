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

from functools import partial
from pathlib import Path

import pytest
from pydantic import BaseModel, ConfigDict

from mirage import (NULL_INDEX, Accessor, CommandIO, FileStat, GenericResource,
                    IndexCacheStore, MountMode, PathSpec, Workspace,
                    stream_from_bytes)
from mirage.resource import registry as resource_registry
from mirage.resource.loader import SCRIPT_MODULE_NAME, load_backend_class
from mirage.resource.ram import RAMResource
from mirage.resource.registry import build_resource, register_resource
from mirage.secrets import registry
from mirage.secrets.registry import register_secrets
from mirage.secrets.types import ResolvedSecret
from mirage.types import ContentType, FileType
from mirage.workspace.snapshot.keys import MountKey, StateKey
from mirage.workspace.snapshot.state import build_mount_args, to_state_dict


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
