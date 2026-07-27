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

from mirage.commands.builtin.gws.help import (GWS_SERVICE_HELP_COMMANDS,
                                              ROOT_SPEC, gws_root,
                                              render_service_methods,
                                              render_services, service_names)
from mirage.commands.builtin.gws.methods import GWS_METHODS
from mirage.commands.spec.help import render_help
from mirage.io.stream import materialize


def test_service_names_follow_the_display_order():
    assert service_names() == ["drive", "sheets", "docs", "slides", "gmail"]


def test_render_services_counts_every_method():
    out = render_services()
    assert out.splitlines()[0] == "Services:"
    for name in service_names():
        count = sum(1 for m in GWS_METHODS if m.service == name)
        assert f"{name}" in out
        assert f"{count} API methods" in out
    assert out.endswith("Run 'gws <service> --help' to list a service's "
                        "commands.")


def test_render_service_methods_lists_methods_and_helpers():
    out = render_service_methods("sheets")
    assert out.splitlines()[0] == "Methods:"
    assert "gws sheets spreadsheets get" in out
    assert "GET /spreadsheets/{spreadsheetId}" in out
    assert "Helpers:" in out
    assert "gws sheets +read" in out
    assert out.endswith("Run '<command> --help' for one command's flags.")


def test_a_service_without_helpers_omits_the_helper_block():
    assert "Helpers:" not in render_service_methods("slides")


def test_root_help_renders_the_service_index_as_the_epilog():
    out = render_help("gws", ROOT_SPEC)
    assert out.startswith("gws: Google Workspace API commands")
    assert render_services() in out


def test_one_help_command_is_registered_per_service():
    names = {
        rc.name
        for cmd in GWS_SERVICE_HELP_COMMANDS
        for rc in cmd._registered_commands
    }
    assert names == {f"gws {s}" for s in service_names()}


@pytest.mark.asyncio
async def test_gws_root_prints_the_service_index():
    out, io = await gws_root(None, [])
    assert io.exit_code == 0
    assert await materialize(out) == (render_services() + "\n").encode()
