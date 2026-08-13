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

from mirage.commands.spec.help import option_metavar, render_help
from mirage.commands.spec.types import CommandSpec, Operand, Option, UsageStyle


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


def test_clap_heads_the_page_with_a_bare_description():
    # argparse prefixes the program path; clap does not. Pinned against
    # ntn 0.21.9's own `--help`.
    spec = CommandSpec(description="Manage pages")
    argparse_first = render_help("ntn pages", spec).split("\n")[0]
    clap_first = render_help("ntn pages", spec,
                             style=UsageStyle.CLAP).split("\n")[0]
    assert argparse_first == "ntn pages: Manage pages"
    assert clap_first == "Manage pages"


def test_clap_usage_line_spells_options_and_command_its_own_way():
    spec = CommandSpec(description="Manage pages",
                       options=(Option(long="--json", type="bool"), ))
    rows = (("get", "Retrieve a page"), )
    text = render_help("ntn pages", spec, rows, UsageStyle.CLAP)
    assert "Usage: ntn pages [OPTIONS] <COMMAND>" in text
    plain = render_help("ntn pages", spec, rows)
    assert "Usage: ntn pages [flags] <command> [<args>]" in plain


def test_clap_names_operand_slots_and_marks_optional_ones():
    spec = CommandSpec(
        description="Retrieve a page",
        positional=(Operand(type="str", name="PAGE_ID", required=True), ),
    )
    assert "Usage: ntn pages get <PAGE_ID>" in render_help(
        "ntn pages get", spec, style=UsageStyle.CLAP)
    loose = CommandSpec(description="Call the API",
                        rest=Operand(type="str", name="PATH"))
    assert "Usage: ntn api [PATH]..." in render_help("ntn api",
                                                     loose,
                                                     style=UsageStyle.CLAP)


def test_clap_keeps_subcommands_in_declaration_order():
    # An author's ordering carries information an alphabet loses, and
    # clap preserves it; every other style sorts.
    spec = CommandSpec(description="Manage pages")
    rows = (("get", "one"), ("create", "two"), ("edit", "three"))
    clap = render_help("ntn pages", spec, rows, UsageStyle.CLAP)
    listed = [
        line.split()[0] for line in clap.split("\n") if line.startswith("  ")
    ]
    assert listed == ["get", "create", "edit"]
    plain = render_help("ntn pages", spec, rows)
    sorted_rows = [
        line.split()[0] for line in plain.split("\n") if line.startswith("  ")
    ]
    assert sorted_rows == ["create", "edit", "get"]


def test_clap_heads_the_option_list_options_not_flags():
    spec = CommandSpec(description="x",
                       options=(Option(long="--json", type="bool"), ))
    assert "Options:" in render_help("ntn whoami", spec, style=UsageStyle.CLAP)
    assert "Flags:" in render_help("ntn whoami", spec)


def test_option_metavar_derives_from_the_long_spelling():
    derived = Option(long="--start-cursor", type="str")
    assert option_metavar(derived) == "START_CURSOR"
    # Declared wins, which is the only reason the field exists: four of
    # ntn's options override the derived name.
    assert option_metavar(
        Option(long="--notion-version", type="str",
               metavar="VERSION")) == "VERSION"
