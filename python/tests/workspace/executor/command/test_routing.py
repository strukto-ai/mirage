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

from mirage.commands.cli.specs import cli_spec_for
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.command.routing import (merge_scopes,
                                                       path_flag_scopes,
                                                       program_tokens)


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    vfs_path="",
                    resolved=True)


def test_merge_scopes_keeps_operand_order_and_dedupes():
    a, b = _path("/m/a"), _path("/m/b")
    dup = _path("/m/a")
    merged = merge_scopes([a, b], [dup, _path("/m/c")])
    assert [p.virtual for p in merged] == ["/m/a", "/m/b", "/m/c"]


def test_path_flag_scopes_reads_path_valued_flags():
    scopes = path_flag_scopes("shuf", ["--output=/dst/out", "/src/in"], "/")
    assert [s.virtual for s in scopes] == ["/dst/out"]


def test_path_flag_scopes_unknown_command_is_empty():
    assert path_flag_scopes("nosuchcmd", ["-x", "/a"], "/") == []


def test_program_tokens_walks_a_cli_verb_path_and_keeps_the_rest_raw():
    ws = Workspace(mounts={"/ram": (RAMVFS(), MountMode.WRITE)})
    try:
        ws.register_cli("git", cli_spec_for("git"))
        reg = ws._registry
        # Options before the verb are not the verb; an alias reads as
        # its canonical name; the leaf's own words follow untouched.
        assert program_tokens(reg, "git",
                              ["-C", "/r", "reset", "--hard", "HEAD"],
                              "/") == (("git", "reset", "--hard", "HEAD"),
                                       ("git", "reset"))
        assert program_tokens(reg, "git", ["log", "-1"],
                              "/") == (("git", "log", "-1"), ("git", "log"))
        # A walk the tree refuses (unknown verb, bare head) reads raw.
        assert program_tokens(reg, "git", ["frobnicate", "x"],
                              "/") == (("git", "frobnicate", "x"), ("git", ))
        assert program_tokens(reg, "git", [], "/") == (("git", ), ("git", ))
        # Anything else is the name and the raw argv.
        assert program_tokens(reg, "rm", ["-rf", "/x"],
                              "/") == (("rm", "-rf", "/x"), ("rm", ))
    finally:
        import asyncio
        asyncio.run(ws.close())
