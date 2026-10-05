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
    is_cross_mount,
    strategy_for,
)
from mirage.commands.builtin.generic.crossmount.types import Cmd, Strategy
from mirage.types import PathSpec


class _Mount:
    def __init__(self, prefix: str):
        self.prefix = prefix


class _Registry:
    def __init__(self, prefixes: dict[str, str]):
        self._prefixes = prefixes

    def try_mount_for(self, virtual: str) -> _Mount | None:
        for prefix in self._prefixes.values():
            if virtual.startswith(prefix.rstrip("/") + "/"):
                return _Mount(prefix)
        return None

    def descendant_mounts(self, virtual: str) -> list[_Mount]:
        below = virtual.rstrip("/") + "/"
        return [
            _Mount(prefix)
            for prefix in self._prefixes.values()
            if prefix.startswith(below) and prefix != below
        ]


def _scope(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual[: virtual.rfind("/") + 1],
        vfs_path="",
        resolved=True,
    )


def test_sets_are_disjoint():
    assert not STREAM_COMMANDS & FANOUT_COMMANDS
    assert not STREAM_COMMANDS & RELAY_COMMANDS
    assert not FANOUT_COMMANDS & RELAY_COMMANDS
    assert CROSS_MOUNT_COMMANDS == set(Cmd)
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
    registry = _Registry({"a": "/a/", "b": "/b/"})
    scopes = [_scope("/a/x.txt"), _scope("/b/y.txt")]
    assert is_cross_mount("sort", scopes, registry)
    assert is_cross_mount("sha256sum", scopes, registry)


def test_is_cross_mount_false_for_single_mount_or_unknown_command():
    registry = _Registry({"a": "/a/", "b": "/b/"})
    same = [_scope("/a/x.txt"), _scope("/a/y.txt")]
    assert not is_cross_mount("sort", same, registry)
    spanning = [_scope("/a/x.txt"), _scope("/b/y.txt")]
    assert not is_cross_mount("uniq", spanning, registry)
    assert not is_cross_mount("sort", spanning[:1], registry)


def test_cp_crosses_for_a_source_holding_a_mount_not_the_destination():
    registry = _Registry({"a": "/a/", "n": "/a/d/n/"})
    tree, file, into = _scope("/a/d"), _scope("/a/f.txt"), _scope("/a/e")
    assert is_cross_mount("cp", [tree, into], registry)
    assert not is_cross_mount("cp", [file, tree], registry)
    assert is_cross_mount("cp", [into, tree], registry, [into])
    assert not is_cross_mount("cp", [tree, file], registry, [tree])


def test_strategy_rejects_unregistered_commands():
    with pytest.raises(
        ValueError, match="Unsupported cross-mount command: unknown"
    ):
        strategy_for("unknown")
