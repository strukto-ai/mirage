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

from mirage.commands.builtin.gws.help import (gws_help_commands,
                                              render_service_methods,
                                              render_services, run_help,
                                              service_names)
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


def _names(resource):
    return {
        rc.name
        for cmd in gws_help_commands(resource)
        for rc in cmd._registered_commands
    }


def _resources(resource):
    return {
        rc.resource
        for cmd in gws_help_commands(resource)
        for rc in cmd._registered_commands
    }


def test_root_help_renders_the_service_index_as_the_epilog():
    root = gws_help_commands("gdrive")[0]
    spec = root._registered_commands[0].spec
    out = render_help("gws", spec)
    assert out.startswith(f"gws: {spec.description}")
    assert render_services() in out


def test_a_drive_mount_reaches_every_service():
    assert _names("gdrive") == {
        "gws", "gws drive", "gws sheets", "gws docs", "gws slides"
    }
    assert _resources("gdrive") == {"gdrive"}


@pytest.mark.parametrize("resource,expected", [
    ("gdocs", {"gws", "gws docs"}),
    ("gmail", {"gws", "gws gmail"}),
    ("gslides", {"gws", "gws slides"}),
    ("gsheets", {"gws", "gws sheets"}),
])
def test_a_single_service_mount_registers_only_what_it_reaches(
        resource, expected):
    # A gdocs-only mount must not answer `gws gmail` or `gws drive`.
    assert _names(resource) == expected
    assert _resources(resource) == {resource}


@pytest.mark.asyncio
async def test_run_help_prints_the_bound_listing():
    out, io = await run_help(render_services(), None, [])
    assert io.exit_code == 0
    assert await materialize(out) == (render_services() + "\n").encode()
