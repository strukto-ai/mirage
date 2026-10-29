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

import contextlib
from dataclasses import replace

import pytest

from mirage.cache.context import (
    capture_read,
    native_condition,
    publish_read,
    settle_after,
    write_condition,
)
from mirage.cache.types import (
    ABSENT_WRITE,
    ANY_WRITE,
    LiveVersion,
    MatchWrite,
    OwnRead,
    WriteContext,
)
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.errors.types import OperationNotSupportedError
from mirage.types import PathSpec


class _OpFailed(Exception):
    pass


class _SettleFailed(Exception):
    pass


async def _op(error: type[Exception] | None) -> str:
    if error is not None:
        raise error
    return "done"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "op_error, settle_breaks, raised, seen",
    [
        (None, False, None, "done"),
        (_OpFailed, False, _OpFailed, None),
        (_OpFailed, True, _OpFailed, None),
        (None, True, _SettleFailed, "done"),
    ],
)
async def test_settle_after_settles_and_keeps_the_ops_error(
    op_error, settle_breaks, raised, seen
):
    # The op's own error wins over a settle that fails after it.
    results = []

    async def settle(result: str | None) -> None:
        results.append(result)
        if settle_breaks:
            raise _SettleFailed

    with pytest.raises(raised) if raised else contextlib.nullcontext():
        assert await settle_after(_op(op_error), settle) == "done"
    assert results == [seen]


@pytest.mark.asyncio
@pytest.mark.parametrize("tokens", [["verified"], [None], ["first", "second"]])
async def test_capture_keeps_exact_object_facts(tokens):
    data = b"payload"
    foreign = bytes(bytearray(data))
    assert foreign == data and foreign is not data

    async def fetch():
        publish_read("/m/other", data, "wrong-path")
        publish_read("/m/x", foreign, "wrong-object")
        for token in tokens:
            publish_read("/m/x", data, token)
        return data

    result, facts = await capture_read("/m/x", fetch)
    assert result is data
    assert facts == tokens


@pytest.mark.asyncio
async def test_capture_preserves_non_byte_results():
    value = 42

    async def fetch():
        return value

    assert await capture_read("/m/x", fetch) == (42, [])


async def _held(_path: PathSpec) -> str | None:
    return "v1"


async def _held_all(paths: list[PathSpec]) -> list[str | None]:
    return ["v1"] * len(paths)


async def _noop(*_args: PathSpec | str) -> None:
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "own, want",
    [
        ("v2", MatchWrite("v2")),
        (None, MatchWrite("v1")),
        (OwnRead.UNKNOWN, ANY_WRITE),
    ],
)
async def test_explicit_own_version_takes_precedence(own, want):
    path = PathSpec(virtual="/s3/f", directory="/s3/", vfs_path="/f")
    context = WriteContext(
        vfs="s3",
        conditions=frozenset({"put", "copy", "delete"}),
        read_version=_held,
        read_versions=_held_all,
        drop=_noop,
        keep=_noop,
    )
    prev = bind_caller(replace(current_caller(), write_context=context))
    try:
        cond = await write_condition(path, "put", own=own)
    finally:
        reset_caller(prev)
    assert cond == want


@pytest.mark.asyncio
async def test_missing_write_requires_absence_without_a_mount_context():
    path = PathSpec.from_str_path("/s3/f", "f")
    assert (
        await write_condition(path, "put", own=OwnRead.ABSENT) is ABSENT_WRITE
    )
    assert await write_condition(path, "put") is ANY_WRITE
    assert await write_condition(path, "delete", own=OwnRead.ABSENT) is None


@pytest.mark.asyncio
async def test_match_without_a_native_token_refuses_without_mount_context():
    path = PathSpec.from_str_path("/box/f", "f")
    with pytest.raises(OperationNotSupportedError):
        await native_condition(
            path, MatchWrite("same"), LiveVersion("same", None), "put"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["put", "copy", "delete"])
async def test_native_condition_names_the_op_it_cannot_condition(kind):
    path = PathSpec(virtual="/box/f", directory="/box/", vfs_path="/f")
    context = WriteContext(
        vfs="box",
        conditions=frozenset({"put", "copy", "delete"}),
        read_version=_held,
        read_versions=_held_all,
        drop=_noop,
        keep=_noop,
    )
    prev = bind_caller(replace(current_caller(), write_context=context))
    try:
        with pytest.raises(OperationNotSupportedError) as info:
            await native_condition(
                path,
                MatchWrite("s1"),
                LiveVersion(content="s1", native=None),
                kind,
            )
    finally:
        reset_caller(prev)
    assert f"conditional {kind}" in str(info.value)
