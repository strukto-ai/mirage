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
from pydantic import ValidationError

from mirage.policy.builtin.output_cap import (DEFAULT_COMMAND_LIMITS,
                                              OutputCapPolicy, resolve_limit,
                                              resolve_producer)
from mirage.policy.types import OpsResultContext
from mirage.types import Limit, OnExceed, PathSpec, Producer


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


def test_resolve_prefers_mount_override():
    override = Limit(max_lines=5)
    default = Limit(max_lines=50)
    assert resolve_limit("cat",
                         command_default=default,
                         mount_override=override) is override


def test_resolve_falls_back_to_command_default():
    default = Limit(max_lines=50)
    assert resolve_limit("cat", command_default=default) is default


def test_resolve_falls_back_to_central_default():
    assert resolve_limit("cat") is DEFAULT_COMMAND_LIMITS["cat"]


def test_resolve_unknown_command_returns_fallback_limit():
    from mirage.policy.builtin.output_cap import FALLBACK_LIMIT
    assert resolve_limit("nl") is FALLBACK_LIMIT
    assert FALLBACK_LIMIT.timeout_seconds is not None


def _override_table(table):
    return lambda prefix, name: table.get((prefix, name))


def test_resolve_producer_prefers_the_mount_override():
    producer = Producer(command="cat",
                        prefixes=("/a/", ),
                        declared=Limit(max_lines=50))
    resolved = resolve_producer(
        producer, _override_table({("/a/", "cat"): Limit(max_lines=4)}))
    assert resolved is not None
    assert resolved.max_lines == 4


def test_resolve_producer_falls_back_to_declared_then_table():
    declared = Producer(command="cat",
                        prefixes=(),
                        declared=Limit(max_lines=50))
    resolved = resolve_producer(declared, _override_table({}))
    assert resolved is not None
    assert resolved.max_lines == 50
    table = resolve_producer(Producer(command="cat"), _override_table({}))
    assert table is not None
    assert table.max_lines == DEFAULT_COMMAND_LIMITS["cat"].max_lines


def test_resolve_producer_aggregates_tightest_across_prefixes():
    producer = Producer(command="cat", prefixes=("/a/", "/b/"))
    resolved = resolve_producer(
        producer,
        _override_table({
            ("/a/", "cat"): Limit(max_lines=9),
            ("/b/", "cat"): Limit(max_lines=3),
        }))
    assert resolved is not None
    assert resolved.max_lines == 3


def test_resolve_producer_empty_command_has_no_bound():
    assert resolve_producer(Producer(command=""), _override_table({})) is None


@pytest.mark.asyncio
async def test_output_cap_policy_answers_post_ops_from_the_op_table():
    policy = OutputCapPolicy(
        _override_table({("/a/", "read"): Limit(max_bytes=4)}))
    capped = await policy.post_ops(
        OpsResultContext(op="read",
                         path=PathSpec.from_str_path("/a/x"),
                         write=False,
                         prefix="/a/",
                         result=b"payload"))
    assert isinstance(capped, Limit)
    assert capped.max_bytes == 4
    silent = await policy.post_ops(
        OpsResultContext(op="write",
                         path=PathSpec.from_str_path("/a/x"),
                         write=True,
                         prefix="/a/",
                         result=None))
    assert silent is None
