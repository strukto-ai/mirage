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

import pytest

from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.commands.builtin.generic_bind.factory import (
    GENERIC_COMMANDS,
    _bind,
    _run_builder,
    generic,
    generic_reading,
)
from mirage.commands.builtin.generic_bind.files import (
    _READINGS,
    Reading,
    command_files,
)
from mirage.commands.config import Context
from mirage.context import reset_mount_gate, set_mount_gate
from mirage.io import IOResult
from mirage.types import MountMode, PathSpec
from mirage.workspace.files import Files


async def _nothing(op: str, path: PathSpec, /, **_):
    return None, IOResult()


async def _never(accessor, paths, texts, ctx):
    raise AssertionError("a builder with no files must not run")


async def _hooked(path: PathSpec):
    yield b"hooked:" + path.virtual.encode()


def _hook(ctx, path):
    return _hooked(path) if path.virtual == "/f" else None


def test_the_generic_set_has_every_builder_whatever_the_backend_lacks():
    # A backend without the write-side functions still gets the whole
    # family: `gzip -c`, `tar -t` and `split -n 1/2` only read, and a line
    # that writes is refused at the write instead of the command being
    # absent.
    assert {c.name for c in GENERIC_COMMANDS} == {b.name for b in BUILDERS}
    assert {c.vfs for c in GENERIC_COMMANDS} == {None}


def test_generic_hands_back_the_shared_command():
    assert generic("grep") is GENERIC_COMMANDS.require("grep")


def test_generic_for_a_backend_registers_a_copy_for_it():
    ls = generic("ls", vfs="dify")
    assert (ls.name, ls.vfs) == ("ls", "dify")
    assert ls is not generic("ls")
    assert ls.spec == generic("ls").spec


def test_a_name_no_builder_has_is_refused():
    with pytest.raises(ValueError, match="no generic command named 'lss'"):
        generic("lss", vfs="fake")
    with pytest.raises(ValueError, match="no generic command named 'lss'"):
        generic_reading("lss", vfs="fake", stream=lambda ctx, path: None)


@pytest.mark.asyncio
async def test_a_builder_with_no_workspace_files_is_refused():
    stdout, io = await _run_builder(
        GenericCommand("cat", _never),
        Reading(split=False, cached_sizes=True),
        None,
        [],
        [],
        Context(),
    )
    assert stdout is None
    assert (io.exit_code, io.stderr) == (1, b"cat: no workspace files\n")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "builder,cached_sizes,split",
    [
        (GenericCommand("cat", None, read=True), True, True),
        (GenericCommand("ls", None), True, True),
        (GenericCommand("rm", None, write=True), False, True),
        (
            GenericCommand("head", None, read=True, pass_through=True),
            True,
            False,
        ),
    ],
)
async def test_a_run_binds_what_its_kind_decides(builder, cached_sizes, split):
    # A builder that reads or only looks fills a stat's size from the read
    # cache; a pass-through one keeps its producer's chunks.
    seen: list[Reading | None] = []

    async def capture(accessor, paths, texts, ctx):
        seen.append(_READINGS.get())
        return None, IOResult()

    run = GenericCommand(
        builder.name,
        capture,
        write=builder.write,
        read=builder.read,
        pass_through=builder.pass_through,
    )
    ctx = Context(vfs=Files([], _nothing, ledger=False))
    await _bind(run, None, None).fn(None, [], [], ctx)
    assert seen == [Reading(split=split, cached_sizes=cached_sizes)]
    assert _READINGS.get() is None


@pytest.mark.asyncio
async def test_a_stream_hook_changes_only_the_streamed_read():
    read: list[bytes] = []

    async def capture(accessor, paths, texts, ctx):
        stream = command_files(ctx, paths).read_stream
        read.extend([chunk async for chunk in stream(paths[0])])
        return None, IOResult()

    cat = generic_reading("cat", vfs="ram", stream=_hook)
    assert (cat.name, cat.vfs) == ("cat", "ram")
    run = GenericCommand("cat", capture, read=True, pass_through=True)
    token = set_mount_gate("/", MountMode.WRITE)
    try:
        await _run_builder(
            run,
            Reading(split=False, cached_sizes=True, stream=_hook),
            None,
            [PathSpec.from_str_path("/f")],
            [],
            Context(vfs=Files([], _nothing, ledger=False)),
        )
    finally:
        reset_mount_gate(token)
    assert read == [b"hooked:/f"]
