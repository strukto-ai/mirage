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

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from mirage.policy.builtin.output_cap import (
    ALL_COMMANDS,
    DEFAULT_COMMAND_LIMITS,
    LINE_TIMEOUT_SECONDS,
    check_command_limits,
    line_timeout,
    resolve_limit,
    resolve_producer,
)
from mirage.types import Limit, OnExceed, Producer


def test_defaults():
    sg = Limit()
    assert sg.max_bytes is None
    assert sg.max_lines is None
    assert sg.on_exceed == OnExceed.TRUNCATE


def test_on_exceed_coerces_from_string():
    sg = Limit(on_exceed="truncate")
    assert sg.on_exceed is OnExceed.TRUNCATE


def test_rejects_unknown_on_exceed():
    with pytest.raises(ValidationError):
        Limit(on_exceed="explode")


def test_rejects_negative_limits():
    with pytest.raises(ValidationError):
        Limit(max_bytes=-1)
    with pytest.raises(ValidationError):
        Limit(max_lines=-5)


def _lines(*args):
    resolved = resolve_limit("cat", [], *args)
    assert resolved is not None
    return resolved.max_lines


def test_resolve_walks_profile_mount_workspace_declared_then_table():
    profile = {"cat": Limit(max_lines=1)}
    mount = Limit(max_lines=2)
    workspace = {"cat": Limit(max_lines=3)}
    declared = Limit(max_lines=4)
    assert _lines(declared, mount, workspace, profile) == 1
    assert _lines(declared, mount, workspace, {}) == 2
    assert _lines(declared, None, workspace, {}) == 3
    assert _lines(declared, None, {}, {}) == 4
    assert (
        _lines(None, None, {}, {}) == DEFAULT_COMMAND_LIMITS["cat"].max_lines
    )
    assert _lines(None, None, workspace, {"head": Limit()}) == 3


def _mount(table=None, walk=1000):
    return SimpleNamespace(
        command_limits=table or {}, default_limit=Limit(walk_limit=walk)
    )


def test_a_layer_naming_one_bound_inherits_the_rest():
    resolved = resolve_limit(
        "cat", workspace_limits={"cat": Limit(max_bytes=5)}
    )
    assert resolved is not None
    assert (resolved.max_bytes, resolved.max_lines) == (
        5,
        DEFAULT_COMMAND_LIMITS["cat"].max_lines,
    )


def test_every_command_entry_sits_below_each_layers_own():
    workspace = {
        ALL_COMMANDS: Limit(max_lines=9, walk_limit=7),
        "find": Limit(walk_limit=50),
    }
    mount = _mount({ALL_COMMANDS: Limit(max_lines=5)})
    find = resolve_limit("find", [mount], workspace_limits=workspace)
    ls = resolve_limit("ls", [mount], workspace_limits=workspace)
    assert find is not None and ls is not None
    assert (find.max_lines, find.walk_limit) == (5, 50)
    assert (ls.max_lines, ls.walk_limit) == (5, 7)


def test_the_mount_walk_default_is_last_and_mounts_keep_the_tightest():
    spread = resolve_limit("ls", [_mount(), _mount(walk=-1), _mount(walk=200)])
    assert spread is not None and spread.walk_limit == 200
    uncapped = resolve_limit("ls", [_mount(walk=-1)])
    assert uncapped is not None and uncapped.walk_limit == -1


def test_rejects_negative_or_infinite_timeouts():
    for seconds in (-1, float("inf"), float("nan")):
        with pytest.raises(ValidationError):
            Limit(timeout_seconds=seconds)


def test_resolve_unknown_command_has_no_bound():
    assert resolve_limit("nl") is None


def test_the_line_timeout_defaults_to_600_seconds():
    assert LINE_TIMEOUT_SECONDS == 600
    assert line_timeout() == LINE_TIMEOUT_SECONDS
    assert line_timeout({"cat": Limit(max_lines=3)}, {"line": Limit()}) == 600


def test_a_profile_line_entry_overrides_the_workspaces():
    workspace = {"line": Limit(timeout_seconds=30)}
    assert line_timeout(workspace) == 30
    assert line_timeout(workspace, {"line": Limit(timeout_seconds=5)}) == 5
    assert line_timeout(workspace, {"cat": Limit(max_lines=1)}) == 30


@pytest.mark.parametrize("seconds", [None, 0])
def test_a_line_entry_of_none_or_zero_lifts_the_deadline(seconds):
    lifted = {"line": Limit(timeout_seconds=seconds)}
    assert line_timeout(lifted) is None
    assert line_timeout({"line": Limit(timeout_seconds=30)}, lifted) is None


@pytest.mark.parametrize(
    "limits,where,refusal",
    [
        (
            {"sleep": Limit(timeout_seconds=1)},
            "workspace",
            "workspace: command_limits['sleep'].timeout_seconds: a line"
            " has one time limit, set it on 'line'",
        ),
        (
            {"line": Limit(timeout_seconds=1, max_lines=3)},
            "profile",
            "profile: command_limits['line'] takes only timeout_seconds,"
            " not max_lines",
        ),
        (
            {"line": Limit(timeout_seconds=1)},
            "mount /data",
            "mount /data: command_limits['line']: a line spans mounts,"
            " set it on the workspace or a profile",
        ),
    ],
)
def test_check_command_limits_refuses_time_where_none_applies(
    limits, where, refusal
):
    with pytest.raises(ValueError) as refused:
        check_command_limits(
            limits, where, takes_line=not where.startswith("mount")
        )
    assert str(refused.value) == refusal


def test_check_command_limits_takes_a_line_entry_and_untimed_commands():
    check_command_limits(
        {"line": Limit(timeout_seconds=None), "cat": Limit(max_lines=3)},
        "workspace",
        takes_line=True,
    )


def _mounts(table):
    return lambda prefix: (
        _mount(table.get(prefix)) if prefix in table else None
    )


def test_resolve_producer_prefers_the_mount_override():
    producer = Producer(
        command="cat", prefixes=("/a/",), declared=Limit(max_lines=50)
    )
    resolved = resolve_producer(
        producer, _mounts({"/a/": {"cat": Limit(max_lines=4)}})
    )
    assert resolved is not None
    assert resolved.max_lines == 4


def test_resolve_producer_falls_back_to_declared_then_table():
    declared = Producer(
        command="cat", prefixes=(), declared=Limit(max_lines=50)
    )
    resolved = resolve_producer(declared, _mounts({}))
    assert resolved is not None
    assert resolved.max_lines == 50
    table = resolve_producer(Producer(command="cat"), _mounts({}))
    assert table is not None
    assert table.max_lines == DEFAULT_COMMAND_LIMITS["cat"].max_lines


def test_resolve_producer_aggregates_tightest_across_prefixes():
    producer = Producer(command="cat", prefixes=("/a/", "/b/"))
    resolved = resolve_producer(
        producer,
        _mounts(
            {
                "/a/": {"cat": Limit(max_lines=9)},
                "/b/": {"cat": Limit(max_lines=3)},
            }
        ),
    )
    assert resolved is not None
    assert resolved.max_lines == 3


def test_resolve_producer_empty_command_has_no_bound():
    assert resolve_producer(Producer(command=""), _mounts({})) is None
