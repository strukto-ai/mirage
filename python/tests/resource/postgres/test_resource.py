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

from mirage.resource.postgres import PostgresConfig, PostgresResource


def test_resource_name():
    res = PostgresResource(PostgresConfig(dsn="postgres://localhost/db"))
    assert res.name == "postgres"
    assert res.is_remote is True


def test_resource_registers_three_ops():
    res = PostgresResource(PostgresConfig(dsn="postgres://localhost/db"))
    op_names = {ro.name for ro in res.ops_list()}
    assert {"read", "readdir", "stat"} <= op_names


def test_resource_registers_commands():
    res = PostgresResource(PostgresConfig(dsn="postgres://localhost/db"))
    cmd_names = {rc.name for rc in res.commands()}
    expected = {
        "cat", "find", "head", "jq", "ls", "stat", "tail", "tree", "wc",
        "grep", "rg"
    }
    assert expected <= cmd_names


def test_resource_in_registry():
    from mirage.resource.registry import REGISTRY, build_resource

    assert "postgres" in REGISTRY
    res = build_resource("postgres", config={"dsn": "postgres://localhost/db"})
    assert res.name == "postgres"


def test_resource_get_state_redacts_dsn():
    res = PostgresResource(PostgresConfig(dsn="postgres://user:pw@host/db"))
    state = res.get_state()
    assert state["type"] == "postgres"
    assert state["config"]["dsn"] == "<REDACTED>"
    assert "redacted_fields" not in state


def test_resource_load_state_noop():
    res = PostgresResource(PostgresConfig(dsn="postgres://localhost/db"))
    res.load_state({"type": "postgres"})
