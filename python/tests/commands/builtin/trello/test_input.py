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

from mirage.commands.builtin.trello._input import file_operand
from mirage.commands.builtin.trello.trello_card_update import SPEC
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec
from mirage.workspace.executor.command.flags import parse_flags


def _view(argv: list[str]) -> FlagView:
    return FlagView(parse_flags(argv, SPEC, "trello card update",
                                "/").flag_kwargs,
                    spec=SPEC)


def test_file_flag_reads_the_promoted_path():
    """A `--*_file` operand arrives as PathSpec, not as a string.

    The executor promotes PATH-typed flag values, so reading one with
    `as_str` yields None and the operand is silently never read.
    """
    spec = file_operand(_view(["--desc_file", "/data/d.txt"]), "desc_file")
    assert spec is not None
    assert spec.virtual == "/data/d.txt"


def test_file_flag_keeps_the_mount_relative_path():
    """The backend reader is addressed by resource_path, not by virtual.

    Handing the trello reader `/board/workspaces/...` makes every read
    miss: it keys off the path with the mount prefix already taken off,
    which only survives if the promotion hands back the executor's own
    scoped spec rather than a synthesized one.
    """
    scoped = PathSpec(virtual="/board/w/x.json",
                      directory="/board/w/",
                      resource_path="w/x.json",
                      raw_path="/board/w/x.json",
                      resolved=True)
    parsed = parse_flags(["--desc_file", scoped], SPEC, "trello card update",
                         "/")
    spec = file_operand(FlagView(parsed.flag_kwargs, spec=SPEC), "desc_file")
    assert spec is not None
    assert spec.resource_path == "w/x.json"
    assert spec.virtual == "/board/w/x.json"


def test_absent_file_flag_is_none():
    assert file_operand(_view([]), "desc_file") is None
