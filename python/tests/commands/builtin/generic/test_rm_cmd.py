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

from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.generic.rm_cmd import make_rm
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.context import (reset_current_session, reset_mount_gate,
                            set_current_session, set_mount_gate)
from mirage.types import MountMode, PathSpec, ShowEntry, ShownPaths
from mirage.workspace.session import SessionState


class FakeAccessor:
    pass


def _make_rm(files: set[str], calls: list[tuple]):

    async def resolve_glob(accessor, paths, index):
        return paths

    async def unlink(accessor, path, index=NULL_INDEX):
        calls.append((accessor, path, index))
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        files.remove(path.virtual)

    return make_rm(vfs="gdocs", glob_fn=resolve_glob, unlink=unlink)


@pytest.mark.asyncio
async def test_rm_threads_accessor_and_index_into_unlink():
    calls: list[tuple] = []
    accessor = FakeAccessor()
    rm = _make_rm({"/owned/a.gdoc.json"}, calls)
    path = PathSpec.from_str_path("/owned/a.gdoc.json")
    _, result = await rm(accessor, [path], [], CommandOpts(index=NULL_INDEX))
    assert result.exit_code == 0
    assert calls == [(accessor, path, NULL_INDEX)]


@pytest.mark.asyncio
async def test_rm_missing_operand():
    rm = _make_rm(set(), [])
    with pytest.raises(UsageError) as info:
        await rm(FakeAccessor(), [], [], CommandOpts())
    assert str(info.value) == ("rm: missing operand\n"
                               "Try 'rm --help' for more information.")
    assert info.value.exit_code == 1


@pytest.mark.asyncio
async def test_rm_force_without_operands_does_nothing():
    calls: list[tuple] = []
    rm = _make_rm(set(), calls)
    out, result = await rm(FakeAccessor(), [], [],
                           CommandOpts(flags={"f": True}))
    assert (out, result.exit_code, result.stderr) == (None, 0, None)
    assert calls == []


@pytest.mark.asyncio
async def test_rm_enoent_reports_and_continues_without_force():
    files = {"/owned/b.json"}
    calls: list[tuple] = []
    rm = _make_rm(files, calls)
    paths = [
        PathSpec.from_str_path("/owned/x.json"),
        PathSpec.from_str_path("/owned/b.json"),
    ]
    _, result = await rm(FakeAccessor(), paths, [], CommandOpts())
    assert result.exit_code == 1
    assert result.stderr == (b"rm: cannot remove '/owned/x.json': "
                             b"No such file or directory\n")
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_rm_holds_each_path_to_its_regions_mode():
    # The bound unlink rides the same guard chain as the generic rm's
    # slots: the command gate admits rm because one region grants
    # writes, and each unlink still answers for its own path.
    files = {"/gdocs/plain.json", "/gdocs/build/a.json"}
    calls: list[tuple] = []
    rm = _make_rm(files, calls)
    sess = SessionState(
        session_id="agent",
        mount_modes={"/gdocs": MountMode.READ},
        shown_paths=ShownPaths(
            entries=(ShowEntry("/gdocs/build", MountMode.WRITE), )))
    session_token = set_current_session(sess)
    gate_token = set_mount_gate("/gdocs", MountMode.WRITE)
    try:
        _, result = await rm(FakeAccessor(), [
            PathSpec.from_str_path("/gdocs/plain.json"),
            PathSpec.from_str_path("/gdocs/build/a.json"),
        ], [], CommandOpts())
    finally:
        reset_mount_gate(gate_token)
        reset_current_session(session_token)
    assert result.exit_code == 1
    assert result.stderr == (b"rm: cannot remove '/gdocs/plain.json': "
                             b"Read-only file system\n")
    # The refused path never reached the backend; the granted one did.
    assert [c[1].virtual for c in calls] == ["/gdocs/build/a.json"]
    assert files == {"/gdocs/plain.json"}


@pytest.mark.asyncio
async def test_rm_force_swallows_enoent():
    calls: list[tuple] = []
    rm = _make_rm(set(), calls)
    _, result = await rm(FakeAccessor(),
                         [PathSpec.from_str_path("/owned/x.json")], [],
                         CommandOpts(flags={"f": True}))
    assert result.exit_code == 0
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_rm_verbose_reports_each_removal():
    files = {"/owned/a.gdoc.json", "/owned/b.gdoc.json"}
    rm = _make_rm(files, [])
    paths = [
        PathSpec.from_str_path("/owned/a.gdoc.json"),
        PathSpec.from_str_path("/owned/b.gdoc.json"),
    ]
    output, result = await rm(FakeAccessor(), paths, [],
                              CommandOpts(flags={"v": True}))
    assert isinstance(output, bytes)
    text = output.decode()
    assert "removed '/owned/a.gdoc.json'" in text
    assert "removed '/owned/b.gdoc.json'" in text
    assert result.exit_code == 0
    assert not files
