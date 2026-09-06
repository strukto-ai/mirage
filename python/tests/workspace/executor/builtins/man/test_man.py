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
import re
from unittest.mock import MagicMock

from mirage.commands.cli.builtin.ntn import NTN
from mirage.commands.cli.skill import skill_for
from mirage.commands.cli.types import CLISpec
from mirage.commands.config import RegisteredCommand
from mirage.commands.spec.types import CommandSpec, Option
from mirage.policy.types import AdmissionRules
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.executor.builtins.man import (ManEntry, _command_entry,
                                                    _render_man_index,
                                                    _render_page, handle_man)
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
    mount.all_commands = MagicMock(side_effect=_all)
    return mount


_SESSION = Session(session_id="s")


def _mk_registry(mounts):
    reg = MagicMock()
    reg.clis = CLIRegistry()
    reg.mounts = MagicMock(return_value=mounts)
    return reg


def test_command_entry_skips_dev():
    spec = CommandSpec(description="x")
    cat_cmd = _mk_cmd("cat", spec)
    mount_dev = _mk_mount("/dev/", "dev", cmds={"cat": cat_cmd})
    reg = _mk_registry([mount_dev])
    assert _command_entry("cat", reg) is None
    mount_ram = _mk_mount("/ram/", "ram", cmds={"cat": cat_cmd})
    entry = _command_entry("cat", _mk_registry([mount_dev, mount_ram]))
    assert entry == ManEntry(name="cat", spec=spec)


def test_command_entry_is_the_first_registration_found():
    spec = CommandSpec(description="cat")
    plain = _mk_cmd("cat", spec)
    parquet = _mk_cmd("cat", spec, filetype=".parquet")
    m1 = _mk_mount("/a/", "ram", cmds={"cat": plain})
    m2 = _mk_mount("/b/", "s3", cmds={"cat": parquet})
    assert _command_entry("cat", _mk_registry([m1,
                                               m2])) == ManEntry(name="cat",
                                                                 spec=spec)
    assert _command_entry("nope", _mk_registry([m1, m2])) is None


def test_render_page_no_options():
    spec = CommandSpec(description="Concatenate files.")
    out = _render_page(ManEntry(name="cat", spec=spec))
    assert out == "# cat\n\nConcatenate files.\n"
    assert "## OPTIONS" not in out
    assert "RESOURCES" not in out


def test_render_page_with_options():
    spec = CommandSpec(
        description="Print a sequence.",
        options=(
            Option(short="-s", type="str", description="separator"),
            Option(short="-w", description="zero-pad"),
        ),
    )
    out = _render_page(ManEntry(name="seq", spec=spec))
    assert out.startswith("# seq\n\nPrint a sequence.\n\n## OPTIONS\n\n")
    assert "| short | long | value | description |" in out
    assert "| -s |  | str | separator |" in out
    assert out.endswith("| -w |  | bool | zero-pad |\n")


def test_render_page_placeholder_description():
    out = _render_page(ManEntry(name="bc", spec=CommandSpec()))
    assert out == "# bc\n\n(no description)\n"


def test_handle_man_missing_entry():
    reg = _mk_registry([])
    out, io, node = asyncio.run(handle_man(["nope"], reg, _SESSION))
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"man: no entry for nope\n"
    assert node.exit_code == 1


def test_handle_man_page_carries_no_resource():
    spec = CommandSpec(description="cat files")
    cat = _mk_cmd("cat", spec)
    m1 = _mk_mount("/a/", "ram", cmds={"cat": cat})
    m2 = _mk_mount("/b/", "s3", cmds={"cat": cat})
    out, io, _node = asyncio.run(
        handle_man(["cat"], _mk_registry([m1, m2]), _SESSION))
    assert io.exit_code == 0
    assert out.decode() == "# cat\n\ncat files\n"


def test_handle_man_documents_bash_and_sh_from_the_bash_spec():
    out, io, _node = asyncio.run(
        handle_man(["bash"], _mk_registry([]), _SESSION))
    assert io.exit_code == 0
    text = out.decode()
    assert text.startswith("# bash\n")
    assert "-c" in text
    assert "RESOURCES" not in text
    sh, io2, _node = asyncio.run(handle_man(["sh"], _mk_registry([]),
                                            _SESSION))
    assert io2.exit_code == 0
    assert sh.decode().startswith("# sh\n")


def test_render_man_index_lists_every_name_once_sorted():
    spec_g = CommandSpec(description="bc desc")
    bc = _mk_cmd("bc", spec_g, resource=None)
    spec_a = CommandSpec(description="ls files")
    ls = _mk_cmd("ls", spec_a)
    spec_c = CommandSpec(description="cat files")
    cat = _mk_cmd("cat", spec_c)
    m1 = _mk_mount("/a/", "ram", cmds={"ls": ls}, general={"bc": bc})
    m2 = _mk_mount("/b/", "s3", cmds={"cat": cat}, general={"bc": bc})
    text = _render_man_index(_mk_registry([m1, m2]), _SESSION)
    assert text == ("# commands\n\n"
                    "- bc \u2014 bc desc\n"
                    "- cat \u2014 cat files\n"
                    "- ls \u2014 ls files\n")
    assert "ram" not in text and "s3" not in text


def test_render_man_index_skips_dev_and_is_empty_with_nothing_to_list():
    cat = _mk_cmd("cat", CommandSpec(description="x"))
    dev = _mk_mount("/dev/", "dev", cmds={"cat": cat})
    assert _render_man_index(_mk_registry([dev]), _SESSION) == ""
    assert _render_man_index(_mk_registry([]), _SESSION) == ""


def _cli_tree() -> CLISpec:
    # The spec's own name, not the installed head word below, is what
    # skill_for keys on; "acmeapi" is deliberately not a real skilled
    # CLI's name so this fixture never picks up a real skill body.
    return CLISpec(
        name="acmeapi",
        description="Linear API client",
        subcommands=(
            CLISpec(name="issue",
                    description="Manage issues",
                    aliases=("i", ),
                    subcommands=(CLISpec(name="create",
                                         description="Create one",
                                         fn=lambda: None), )),
            CLISpec(name="team", description="Manage one", fn=lambda: None),
        ),
    )


def _scoped(*allow: str) -> Session:
    session = Session(session_id="scoped")
    session.commands = AdmissionRules(allow=allow)
    return session


def _cli_registry(mounts=None):
    reg = _mk_registry(mounts or [])
    reg.clis.install("linear", _cli_tree())
    return reg


def test_handle_man_renders_an_installed_cli():
    out, io, _node = asyncio.run(
        handle_man(["linear"], _cli_registry(), _SESSION))
    assert io.exit_code == 0
    text = out.decode()
    assert "Usage: linear" in text
    assert "issue" in text


def test_handle_man_descends_a_verb_path_and_resolves_aliases():
    reg = _cli_registry()
    text = asyncio.run(handle_man(["linear", "issue", "create"], reg,
                                  _SESSION))[0].decode()
    assert "Usage: linear issue create" in text
    aliased = asyncio.run(handle_man(["linear", "i", "create"], reg,
                                     _SESSION))[0].decode()
    assert aliased == text


def test_handle_man_lists_only_the_verbs_the_allow_list_reaches():
    reg = _cli_registry()
    session = _scoped("linear issue create")
    top = asyncio.run(handle_man(["linear"], reg, session))[0].decode()
    assert "issue" in top
    assert "team" not in top
    # The same narrowing one level down, where the pattern names the
    # only leaf the profile holds.
    inner = asyncio.run(handle_man(["linear", "issue"], reg,
                                   session))[0].decode()
    assert "create" in inner
    # A verb no pattern reaches has no page, in man's own words.
    out, io, node = asyncio.run(handle_man(["linear", "team"], reg, session))
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"man: no entry for linear team\n"
    assert node.exit_code == 1
    # A session with no list still reads the whole tree, and so does the
    # head word for the narrowed one: some line of it runs.
    assert "team" in asyncio.run(handle_man(["linear"], reg,
                                            _SESSION))[0].decode()


def test_handle_man_unknown_verb_names_the_whole_line():
    out, io, node = asyncio.run(
        handle_man(["linear", "bogus"], _cli_registry(), _SESSION))
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"man: no entry for linear bogus\n"
    assert node.exit_code == 1


def test_handle_man_prints_the_cli_before_a_colliding_mount_command():
    spec = CommandSpec(description="mount side")
    mount = _mk_mount("/ram/", "ram", cmds={"linear": _mk_cmd("linear", spec)})
    reg = _cli_registry([mount])
    text = asyncio.run(handle_man(["linear"], reg, _SESSION))[0].decode()
    assert text.index("Usage: linear") < text.index("mount side")


def test_render_man_index_lists_installed_clis_after_commands():
    cat = _mk_cmd("cat", CommandSpec(description="cat files"))
    mount = _mk_mount("/ram/", "ram", cmds={"cat": cat})
    text = _render_man_index(_cli_registry([mount]), _SESSION)
    assert text == ("# commands\n\n- cat \u2014 cat files\n\n"
                    "# clis\n\n- linear \u2014 Linear API client\n")


def test_render_man_index_omits_the_cli_section_when_none_installed():
    assert "# clis" not in _render_man_index(_mk_registry([]), _SESSION)


def _ntn_registry(mounts=None) -> None:
    reg = _mk_registry(mounts or [])
    reg.clis.install("ntn", NTN, {"api_key": "secret_fake"})
    return reg


def test_handle_man_leads_with_the_skill_body_for_a_skilled_cli():
    skill = skill_for(NTN)
    assert skill is not None
    first_heading = next(line for line in skill.body.splitlines()
                         if line.startswith("#"))
    text = asyncio.run(handle_man(["ntn"], _ntn_registry(),
                                  _SESSION))[0].decode()
    assert text.startswith(first_heading)
    # The verb listing (the ordinary --help rendering) is still there,
    # right behind the skill body.
    assert "Usage: ntn" in text


def test_handle_man_verb_page_has_no_skill_body():
    skill = skill_for(NTN)
    assert skill is not None
    body_first_line = skill.body.splitlines()[0]
    text = asyncio.run(handle_man(["ntn", "pages"], _ntn_registry(),
                                  _SESSION))[0].decode()
    assert "Usage: ntn pages" in text
    assert body_first_line not in text


def test_handle_man_respells_the_skill_for_a_renamed_install():
    # The spec is ``ntn``; installed as ``ntn-prod`` the manual must
    # teach ``ntn-prod`` lines, not lines that run another install.
    reg = _mk_registry([])
    reg.clis.install("ntn-prod", NTN, {"api_key": "secret_fake"})
    text = asyncio.run(handle_man(["ntn-prod"], reg, _SESSION))[0].decode()
    assert text.startswith("# ntn-prod")
    assert "ntn-prod pages get" in text
    assert re.search(r"(?:^|[^\w/.-])ntn(?![\w-])", text, re.MULTILINE) is None
    assert "Usage: ntn-prod" in text
