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

import asyncio
from unittest.mock import MagicMock

from mirage.commands.cli.types import CLISpec
from mirage.commands.config import RegisteredCommand
from mirage.commands.spec.types import CommandSpec, Option
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.executor.builtins import (_collect_man_hits,
                                                _render_man_entry,
                                                _render_man_index, handle_man)
from mirage.workspace.session import Session


def _mk_cmd(name, spec, filetype=None, resource="ram"):
    return RegisteredCommand(
        name=name,
        spec=spec,
        resource=resource,
        filetype=filetype,
        fn=lambda *a, **kw: None,
    )


def _mk_mount(prefix, kind, cmds=None, general=None):
    mount = MagicMock()
    mount.prefix = prefix
    mount.resource = MagicMock()
    mount.resource.name = kind
    cmds = cmds or {}
    general = general or {}

    def _resolve(name, extension=None):
        if name in cmds:
            return cmds[name]
        if name in general:
            return general[name]
        return None

    def _is_general(name):
        return name in general and name not in cmds

    def _all():
        seen = set()
        out = []
        for rc in cmds.values():
            if rc.name in seen:
                continue
            seen.add(rc.name)
            out.append(rc)
        for rc in general.values():
            if rc.name in seen:
                continue
            seen.add(rc.name)
            out.append(rc)
        return out

    mount.resolve_command = MagicMock(side_effect=_resolve)
    mount.is_general_command = MagicMock(side_effect=_is_general)
    mount.all_commands = MagicMock(side_effect=_all)
    return mount


def _mk_registry(mounts, cwd_mount=None):
    reg = MagicMock()
    reg.clis = CLIRegistry()
    reg.mounts = MagicMock(return_value=mounts)

    reg.try_mount_for = MagicMock(return_value=cwd_mount)
    return reg


def test_collect_man_hits_skips_dev():
    spec = CommandSpec(description="x")
    cat_cmd = _mk_cmd("cat", spec)
    mount_dev = _mk_mount("/dev/", "dev", cmds={"cat": cat_cmd})
    mount_ram = _mk_mount("/ram/", "ram", cmds={"cat": cat_cmd})
    reg = _mk_registry([mount_dev, mount_ram])
    hits = _collect_man_hits("cat", reg)
    assert len(hits) == 1
    assert hits[0].mount is mount_ram


def test_render_man_entry_no_options():
    spec = CommandSpec(description="Concatenate files.")
    cat_cmd = _mk_cmd("cat", spec)
    mount = _mk_mount("/ram/", "ram", cmds={"cat": cat_cmd})
    hits = _collect_man_hits("cat", _mk_registry([mount]))
    out = _render_man_entry("cat", hits)
    assert out.startswith("# cat\n")
    assert "Concatenate files." in out
    assert "## OPTIONS" not in out
    assert "## RESOURCES\n\n- ram\n" in out


def test_render_man_entry_with_options():
    spec = CommandSpec(
        description="Print a sequence.",
        options=(
            Option(short="-s", type="str", description="separator"),
            Option(short="-w", description="zero-pad"),
        ),
    )
    cmd = _mk_cmd("seq", spec)
    mount = _mk_mount("/ram/", "ram", cmds={"seq": cmd})
    hits = _collect_man_hits("seq", _mk_registry([mount]))
    out = _render_man_entry("seq", hits)
    assert "## OPTIONS" in out
    assert "| short | long | value | description |" in out
    assert "| -s |  | str | separator |" in out
    assert "| -w |  | bool | zero-pad |" in out


def test_render_man_entry_dedupes_by_kind_and_filetype():
    spec = CommandSpec(description="cat")
    plain = _mk_cmd("cat", spec)
    parquet = _mk_cmd("cat", spec, filetype=".parquet")
    m1 = _mk_mount("/a/", "ram", cmds={"cat": plain})
    m2 = _mk_mount("/b/", "ram", cmds={"cat": plain})
    m3 = _mk_mount("/c/", "ram", cmds={"cat": parquet})
    reg = _mk_registry([m1, m2, m3])
    hits = _collect_man_hits("cat", reg)
    out = _render_man_entry("cat", hits)
    assert out.count("- ram\n") == 1
    assert "- ram (filetype: .parquet)" in out


def test_render_man_entry_general_first():
    spec = CommandSpec(description="x")
    cmd = _mk_cmd("bc", spec, resource=None)
    mount = _mk_mount("/ram/", "ram", general={"bc": cmd})
    hits = _collect_man_hits("bc", _mk_registry([mount]))
    out = _render_man_entry("bc", hits)
    assert out.endswith("- general\n")


def test_handle_man_missing_entry():
    reg = _mk_registry([])
    out, io, node = asyncio.run(
        handle_man(["nope"], Session(session_id="t"), reg))
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"man: no entry for nope\n"
    assert node.exit_code == 1


def test_handle_man_index_cwd_first():
    spec_a = CommandSpec(description="ls files")
    spec_b = CommandSpec(description="cat files")
    ls = _mk_cmd("ls", spec_a)
    cat = _mk_cmd("cat", spec_b)
    mount_z = _mk_mount("/z/", "zfs", cmds={"ls": ls})
    mount_r = _mk_mount("/ram/", "ram", cmds={"cat": cat})
    reg = _mk_registry([mount_z, mount_r], cwd_mount=mount_r)
    out, io, node = asyncio.run(
        handle_man([], Session(session_id="t", cwd="/ram/x"), reg))
    assert io.exit_code == 0
    text = out.decode()
    ram_pos = text.index("# ram")
    zfs_pos = text.index("# zfs")
    assert ram_pos < zfs_pos


def test_render_man_index_dedupes_general_across_mounts():
    spec_g = CommandSpec(description="bc desc")
    bc = _mk_cmd("bc", spec_g, resource=None)
    spec_a = CommandSpec(description="ls files")
    ls = _mk_cmd("ls", spec_a)
    m1 = _mk_mount("/a/", "ram", cmds={"ls": ls}, general={"bc": bc})
    m2 = _mk_mount("/b/", "s3", cmds={"ls": ls}, general={"bc": bc})
    reg = _mk_registry([m1, m2])
    text = _render_man_index(Session(session_id="t"), reg)
    assert text.count("- bc \u2014 bc desc") == 1


def _cli_tree() -> CLISpec:
    return CLISpec(
        name="linear",
        description="Linear API client",
        subcommands=(CLISpec(name="issue",
                             description="Manage issues",
                             aliases=("i", ),
                             subcommands=(CLISpec(name="create",
                                                  description="Create one",
                                                  fn=lambda: None), )), ),
    )


def _cli_registry(mounts=None):
    reg = _mk_registry(mounts or [])
    reg.clis.install("linear", _cli_tree())
    return reg


def test_handle_man_renders_an_installed_cli():
    out, io, _node = asyncio.run(
        handle_man(["linear"], Session(session_id="t"), _cli_registry()))
    assert io.exit_code == 0
    text = out.decode()
    assert "Usage: linear" in text
    assert "issue" in text


def test_handle_man_descends_a_verb_path_and_resolves_aliases():
    reg = _cli_registry()
    text = asyncio.run(
        handle_man(["linear", "issue", "create"], Session(session_id="t"),
                   reg))[0].decode()
    assert "Usage: linear issue create" in text
    aliased = asyncio.run(
        handle_man(["linear", "i", "create"], Session(session_id="t"),
                   reg))[0].decode()
    assert aliased == text


def test_handle_man_unknown_verb_names_the_whole_line():
    out, io, node = asyncio.run(
        handle_man(["linear", "bogus"], Session(session_id="t"),
                   _cli_registry()))
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"man: no entry for linear bogus\n"
    assert node.exit_code == 1


def test_handle_man_prints_the_cli_before_a_colliding_mount_command():
    spec = CommandSpec(description="mount side")
    mount = _mk_mount("/ram/", "ram", cmds={"linear": _mk_cmd("linear", spec)})
    reg = _cli_registry([mount])
    text = asyncio.run(handle_man(["linear"], Session(session_id="t"),
                                  reg))[0].decode()
    assert text.index("Usage: linear") < text.index("mount side")


def test_render_man_index_lists_installed_clis():
    text = _render_man_index(Session(session_id="t"), _cli_registry())
    assert "# clis" in text
    assert "- linear \u2014 Linear API client" in text
    assert text.index("# clis") < text.index("# general")


def test_render_man_index_omits_the_cli_section_when_none_installed():
    assert "# clis" not in _render_man_index(Session(session_id="t"),
                                             _mk_registry([]))
