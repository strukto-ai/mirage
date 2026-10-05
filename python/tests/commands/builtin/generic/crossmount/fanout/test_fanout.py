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

import pytest

from mirage.commands.builtin.generic.crossmount.fanout import run_fanout
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.types import PathSpec
from mirage.utils.errors import enoent


class FakeRunSingle:
    """Serves canned per-operand outputs and records the calls in flight."""

    def __init__(self, outputs: dict[str, bytes | Exception]):
        self.outputs = outputs
        self.calls: list[tuple[str, dict]] = []
        self.open = 0
        self.peak = 0

    async def __call__(self, cmd_name, paths, texts, flag_kwargs, **_):
        self.calls.append((paths[0].virtual, dict(flag_kwargs)))
        self.open += 1
        self.peak = max(self.peak, self.open)
        await asyncio.sleep(0)
        out = self.outputs[paths[0].virtual]

        async def stream():
            try:
                if isinstance(out, Exception):
                    raise out
                yield out
            finally:
                self.open -= 1

        return stream(), IOResult()


@pytest.mark.asyncio
async def test_head_names_every_operand_and_joins_with_a_blank_line():
    rs = FakeRunSingle(
        {"/a/x": b"==> /a/x <==\n1\n", "/b/y": b"==> /b/y <==\n2\n"}
    )
    out, io = await run_fanout(
        "head",
        [PathSpec.from_str_path("/a/x"), PathSpec.from_str_path("/b/y")],
        [],
        {},
        rs,
    )
    assert await materialize(out) == b"==> /a/x <==\n1\n\n==> /b/y <==\n2\n"
    assert all(flags.get("verbose") is True for _, flags in rs.calls)
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_reads_prepare_at_most_four_ahead_in_operand_order():
    names = [f"/m{i}/f" for i in range(7)]
    rs = FakeRunSingle({n: n.encode() + b"\n" for n in names})
    out, _ = await run_fanout(
        "rev", [PathSpec.from_str_path(n) for n in names], [], {}, rs
    )
    assert await materialize(out) == b"".join(
        n.encode() + b"\n" for n in names
    )
    assert [p for p, _ in rs.calls] == names
    assert rs.peak <= 4


@pytest.mark.asyncio
async def test_a_failed_read_keeps_the_rest_and_settles_the_status():
    rs = FakeRunSingle({"/a/x": enoent("/a/x"), "/b/y": b"ok\n"})
    out, io = await run_fanout(
        "rev",
        [PathSpec.from_str_path("/a/x"), PathSpec.from_str_path("/b/y")],
        [],
        {},
        rs,
    )
    assert io.exit_code == 0
    assert await materialize(out) == b"ok\n"
    assert io.exit_code == 1
    assert await materialize(io.stderr) == (
        b"rev: cannot open /a/x: No such file or directory\n"
    )
