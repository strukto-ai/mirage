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

from mirage.commands.builtin.generic.crossmount.constants import (
    CROSS_MOUNT_COMMANDS,
    FANOUT_COMMANDS,
    RELAY_COMMANDS,
    STREAM_COMMANDS,
)
from mirage.commands.builtin.generic.crossmount.detect import (
    aggregate_for,
    is_cross_mount,
    strategy_for,
)
from mirage.commands.builtin.generic.crossmount.types import (
    Cmd,
    OperandMount,
    Strategy,
)
from mirage.types import PathSpec


def _scope(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual[: virtual.rfind("/") + 1],
        vfs_path="",
        resolved=True,
    )


def _on(virtual: str, mount: str | None, aggregate=None, nests=False):
    return OperandMount(_scope(virtual), mount, aggregate, nests)


def test_sets_are_disjoint():
    assert not STREAM_COMMANDS & FANOUT_COMMANDS
    assert not STREAM_COMMANDS & RELAY_COMMANDS
    assert not FANOUT_COMMANDS & RELAY_COMMANDS
    assert set(Cmd) <= CROSS_MOUNT_COMMANDS
    assert CROSS_MOUNT_COMMANDS == (
        STREAM_COMMANDS | FANOUT_COMMANDS | RELAY_COMMANDS
    )


@pytest.mark.parametrize(
    "strategy,names",
    [
        (Strategy.STREAM, ("cat", "nl", "cut")),
        (Strategy.FANOUT, ("head", "sha256sum", "rm", "rev")),
        (
            Strategy.RELAY,
            (
                "cp",
                "mv",
                "tee",
                "diff",
                "cmp",
                "sort",
                "wc",
                "grep",
                "rg",
                "realpath",
                "awk",
                "ls",
                "sed",
            ),
        ),
    ],
)
def test_strategy_for(strategy, names):
    for name in names:
        assert strategy_for(name) is strategy


def test_is_cross_mount_true_when_operands_span_mounts():
    operands = [_on("/a/x.txt", "/a/"), _on("/b/y.txt", "/b/")]
    assert is_cross_mount("sort", operands)
    assert is_cross_mount("sha256sum", operands)


def test_is_cross_mount_false_for_single_mount_or_unknown_command():
    same = [_on("/a/x.txt", "/a/"), _on("/a/y.txt", "/a/")]
    assert not is_cross_mount("sort", same)
    spanning = [_on("/a/x.txt", "/a/"), _on("/b/y.txt", "/b/")]
    assert not is_cross_mount("nocross", spanning)
    assert not is_cross_mount("sort", spanning[:1])


def test_an_operand_outside_every_mount_crosses_nothing():
    assert not is_cross_mount(
        "sort", [_on("/a/x.txt", "/a/"), _on("/nowhere/y", None)]
    )


def test_every_generic_builder_crosses_mounts():
    spanning = [_on("/a/x.txt", "/a/"), _on("/b/y.txt", "/b/")]
    assert is_cross_mount("uniq", spanning)
    assert strategy_for("uniq") is Strategy.RELAY


async def _merge(parts):
    return b"".join(data for _, data in parts)


async def _other(parts):
    return b""


def test_aggregate_for_takes_one_shared_reducer_only():
    both = [_on("/a/x.txt", "/a/", _merge), _on("/b/y.txt", "/b/", _merge)]
    assert aggregate_for("custom", both) is _merge
    assert is_cross_mount("custom", both)
    mixed = [_on("/a/x.txt", "/a/", _merge), _on("/b/y.txt", "/b/", _other)]
    assert aggregate_for("custom", mixed) is None
    one_side = [_on("/a/x.txt", "/a/", _merge), _on("/b/y.txt", "/b/")]
    assert aggregate_for("custom", one_side) is None
    assert aggregate_for("sort", both) is None


def test_cp_crosses_for_a_source_holding_a_mount_not_the_destination():
    tree = _on("/a/d", "/a/", nests=True)
    file, into = _on("/a/f.txt", "/a/"), _on("/a/e", "/a/")
    assert is_cross_mount("cp", [tree, into])
    assert not is_cross_mount("cp", [file, tree])
    assert is_cross_mount("cp", [into, tree], [into.path])
    assert not is_cross_mount("cp", [tree, file], [tree.path])


def test_strategy_rejects_unregistered_commands():
    with pytest.raises(
        ValueError, match="Unsupported cross-mount command: unknown"
    ):
        strategy_for("unknown")
