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

from mirage.commands.cli.builtin.gws import GWS
from mirage.core.google.config import GoogleConfig


def leaf(*path: str):
    node = GWS.spec
    for name in path:
        node = next(c for c in node.subcommands if c.name == name)
    return node


def test_tree_lists_every_service():
    assert GWS.spec.name == "gws"
    assert GWS.config_model is GoogleConfig
    assert [g.name for g in GWS.spec.subcommands] == [
        "drive",
        "sheets",
        "docs",
        "slides",
        "calendar",
        "forms",
        "gmail",
    ]


def test_passthroughs_nest_by_discovery_resource():
    assert [v.name for v in leaf("drive", "files").subcommands] == [
        "list",
        "get",
        "create",
        "update",
        "copy",
        "delete",
        "export",
    ]
    assert [v.name for v in leaf("slides").subcommands] == ["presentations"]
    assert [v.name for v in leaf("slides", "presentations").subcommands] == [
        "get",
        "create",
        "batchUpdate",
    ]
    assert [v.name for v in leaf("drive", "permissions").subcommands] == [
        "create",
        "list",
        "delete",
    ]
    assert [
        v.name for v in leaf("gmail", "users", "messages").subcommands
    ] == ["list", "get", "send", "trash", "attachments"]
    assert GWS.handlers["gmail users messages attachments get"].fn is not None


def test_bespoke_verbs_drop_the_plus_marker():
    assert [v.name for v in leaf("gmail").subcommands][-6:] == [
        "send",
        "read",
        "reply",
        "reply-all",
        "forward",
        "triage",
    ]
    assert [v.name for v in leaf("sheets").subcommands][-3:] == [
        "read",
        "write",
        "append",
    ]
    assert GWS.handlers["docs write"].write


def test_writes_follow_http_semantics():
    assert not GWS.handlers["drive files list"].write
    assert not GWS.handlers["slides presentations get"].write
    assert GWS.handlers["slides presentations create"].write
    assert GWS.handlers["slides presentations batchUpdate"].write
    assert GWS.handlers["drive files delete"].write
    assert not GWS.handlers["drive permissions list"].write
    assert GWS.handlers["drive permissions create"].write
    assert GWS.handlers["drive permissions delete"].write
    assert GWS.handlers["sheets spreadsheets batchUpdate"].write
    assert GWS.handlers["gmail users messages trash"].write
    assert not GWS.handlers["gmail triage"].write


def test_calendar_passthroughs_nest_by_discovery_resource():
    assert [v.name for v in leaf("calendar").subcommands] == [
        "calendarList",
        "calendars",
        "events",
        "freebusy",
    ]
    assert [v.name for v in leaf("calendar", "events").subcommands] == [
        "list",
        "get",
        "insert",
        "patch",
        "delete",
    ]
    assert not GWS.handlers["calendar events list"].write
    assert GWS.handlers["calendar events insert"].write
    assert GWS.handlers["calendar events delete"].write
    # freebusy.query is a POST that mutates nothing, but write follows the
    # HTTP verb everywhere else in the tree and a second rule would be worse.
    assert GWS.handlers["calendar freebusy query"].write


def test_forms_passthroughs_nest_by_discovery_resource():
    assert [v.name for v in leaf("forms").subcommands] == ["forms"]
    assert [v.name for v in leaf("forms", "forms").subcommands] == [
        "create",
        "get",
        "batchUpdate",
        "responses",
    ]
    assert [
        v.name for v in leaf("forms", "forms", "responses").subcommands
    ] == ["list", "get"]
    assert not GWS.handlers["forms forms get"].write
    assert GWS.handlers["forms forms create"].write
