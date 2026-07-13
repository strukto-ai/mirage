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

from mirage.commands.builtin.generic.crossmount.constants import (
    CROSS_MOUNT_COMMANDS, FANOUT_COMMANDS, RELAY_COMMANDS, STREAM_COMMANDS)
from mirage.commands.builtin.generic.crossmount.detect import (is_cross_mount,
                                                               strategy_for)
from mirage.commands.builtin.generic.crossmount.types import Strategy
from mirage.types import PathSpec


class _Mount:

    def __init__(self, prefix: str):
        self.prefix = prefix


class _Registry:

    def __init__(self, prefixes: dict[str, str]):
        self._prefixes = prefixes

    def mount_for(self, virtual: str) -> _Mount:
        for prefix in self._prefixes.values():
            if virtual.startswith(prefix.rstrip("/") + "/"):
                return _Mount(prefix)
        raise ValueError(virtual)


def _scope(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1],
                    resource_path="",
                    resolved=True)


def test_sets_are_disjoint():
    assert not STREAM_COMMANDS & FANOUT_COMMANDS
    assert not STREAM_COMMANDS & RELAY_COMMANDS
    assert not FANOUT_COMMANDS & RELAY_COMMANDS
    assert CROSS_MOUNT_COMMANDS == (STREAM_COMMANDS | FANOUT_COMMANDS
                                    | RELAY_COMMANDS)


def test_strategy_for_stream_commands():
    for name in ("cat", "nl", "sort", "cut", "rev"):
        assert strategy_for(name, {}) is Strategy.STREAM


def test_strategy_for_fanout_commands():
    for name in ("grep", "wc", "sha256sum", "ls", "rm", "tee"):
        assert strategy_for(name, {}) is Strategy.FANOUT


def test_strategy_for_relay_commands():
    for name in ("cp", "mv", "diff", "cmp"):
        assert strategy_for(name, {}) is Strategy.RELAY


def test_sed_default_streams_but_in_place_fans_out():
    assert strategy_for("sed", {}) is Strategy.STREAM
    assert strategy_for("sed", {"i": True}) is Strategy.FANOUT


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
