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

from mirage.commands.builtin.generic.crossmount.fanout import run_fanout
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.types import PathSpec


def _scope(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual[: virtual.rfind("/") + 1],
        vfs_path="",
        resolved=True,
    )


class FakeRunSingle:
    """Serves canned per-operand outputs and records every call."""

    def __init__(self, outputs: dict[str, tuple[bytes, int]]):
        self.outputs = outputs
        self.calls: list[dict] = []

    async def __call__(
        self,
        cmd_name,
        paths,
        texts,
        flag_kwargs,
        stdin=None,
        resolve_hint=None,
    ):
        stdin_data = await materialize(stdin) if stdin is not None else None
        self.calls.append(
            dict(
                cmd=cmd_name,
                paths=[p.virtual for p in paths],
                flags=dict(flag_kwargs),
                stdin=stdin_data,
            )
        )
        data, code = self.outputs[paths[0].virtual]
        io = IOResult(exit_code=code)
        if code != 0:
            io.stderr = f"{cmd_name}: {paths[0].virtual}: error\n".encode()
        return data, io


def _run(coro):
    return asyncio.run(coro)


def test_run_fanout_forces_grep_filenames_unless_suppressed():
    rs = FakeRunSingle({"/a/x": (b"", 1), "/b/y": (b"", 1)})
    _run(run_fanout("grep", [_scope("/a/x"), _scope("/b/y")], ["pat"], {}, rs))
    assert all(c["flags"].get("H") is True for c in rs.calls)
    rs2 = FakeRunSingle({"/a/x": (b"", 1), "/b/y": (b"", 1)})
    _run(
        run_fanout(
            "grep", [_scope("/a/x"), _scope("/b/y")], ["pat"], {"h": True}, rs2
        )
    )
    assert all("H" not in c["flags"] for c in rs2.calls)


def test_run_fanout_stops_a_quiet_search_at_its_first_match():
    # grep -q and rg -q exit at the first match, so the operands after it
    # are never read (GNU grep 3.11, ripgrep 14.1.1: `rg -q x a /nope`
    # says nothing about /nope).
    for cmd, flags in (("grep", {"q": True}), ("rg", {"quiet": True})):
        rs = FakeRunSingle({"/a/x": (b"", 0), "/b/y": (b"", 2)})
        _, io = _run(
            run_fanout(
                cmd, [_scope("/a/x"), _scope("/b/y")], ["pat"], flags, rs
            )
        )
        assert [c["paths"] for c in rs.calls] == [["/a/x"]]
        assert io.exit_code == 0


def test_run_fanout_forces_head_headers_and_blank_line_joins():
    rs = FakeRunSingle(
        {
            "/a/x": (b"==> /a/x <==\n1\n", 0),
            "/b/y": (b"==> /b/y <==\n2\n", 0),
        }
    )
    out, _ = _run(
        run_fanout("head", [_scope("/a/x"), _scope("/b/y")], [], {}, rs)
    )
    assert all(c["flags"].get("verbose") is True for c in rs.calls)
    assert _run(materialize(out)) == b"==> /a/x <==\n1\n\n==> /b/y <==\n2\n"
