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

from mirage.commands.spec.help import render_help
from mirage.commands.spec.types import CommandSpec, Option


def test_renders_name_description_usage_and_flags():
    spec = CommandSpec(
        description="Send a thing.",
        options=(
            Option(long="--to", type="str", description="Recipient"),
            Option(long="--help", type="bool", description="Show help"),
        ),
    )
    out = render_help("gws thing send", spec)
    assert "gws thing send: Send a thing." in out
    assert "Usage: gws thing send [flags]" in out
    assert "--to <text>" in out
    assert "Recipient" in out
    assert "--help" in out


def test_falls_back_to_bare_name_without_description():
    spec = CommandSpec()
    out = render_help("foo", spec)
    assert out.splitlines()[0] == "foo"


def test_epilog_trails_the_flag_table_after_a_blank_line():
    spec = CommandSpec(
        options=(Option(long="--help", type="bool",
                        description="Show help"), ),
        epilog="Services:\n  drive\n",
    )
    out = render_help("gws", spec)
    assert out.endswith("\n  --help  Show help\n\nServices:\n  drive\n")


def test_epilog_is_omitted_when_absent():
    out = render_help("foo", CommandSpec())
    assert out == "foo\n\nUsage: foo\n"


def test_render_help_with_subcommands_lists_commands():
    spec = CommandSpec(
        description="Google Workspace",
        options=(Option(short="-C",
                        long="--cwd",
                        type="str",
                        description="run as if started there"), ),
    )
    rows = [("gmail", "Gmail messages\nlong tail ignored"), ("docs", "")]
    assert render_help(
        "gws", spec,
        subcommands=rows) == ("gws: Google Workspace\n"
                              "\n"
                              "Usage: gws [flags] <command> [<args>]\n"
                              "\n"
                              "Commands:\n"
                              "  docs\n"
                              "  gmail  Gmail messages\n"
                              "\n"
                              "Flags:\n"
                              "  -C, --cwd <text>  run as if started there\n")


def test_render_help_with_subcommands_minimal():
    assert render_help("tool", CommandSpec(), subcommands=[
        ("run", "")
    ]) == ("tool\n"
           "\n"
           "Usage: tool <command> [<args>]\n"
           "\n"
           "Commands:\n"
           "  run\n")
