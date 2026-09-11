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

from pathlib import Path

import pytest

pytest.importorskip("openhands")

from mirage.agents.openhands import MirageWorkspace  # noqa: E402
from mirage.policy import Action, CommandContext, Deny, Policy  # noqa: E402
from mirage.resource.ram import RAMResource  # noqa: E402
from mirage.types import MountMode  # noqa: E402
from mirage.workspace import Workspace  # noqa: E402


class _NoDeletes(Policy):

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "rm":
            return Deny(reason="no deletes")
        return None


def _make_backing() -> Workspace:
    ram = RAMResource()
    return Workspace({"/": (ram, MountMode.WRITE)}, mode=MountMode.WRITE)


def test_execute_command_basic():
    with MirageWorkspace(workspace=_make_backing()) as mw:
        result = mw.execute_command("echo hello")
        assert result.exit_code == 0
        assert "hello" in result.stdout
        assert result.command == "echo hello"
        assert result.timeout_occurred is False


def test_execute_command_with_cwd():
    with MirageWorkspace(workspace=_make_backing()) as mw:
        mw.execute_command("echo data > /file.txt")
        result = mw.execute_command("cat file.txt", cwd="/")
        assert result.exit_code == 0, result.stderr
        assert "data" in result.stdout


def test_execute_command_nonzero_exit():
    with MirageWorkspace(workspace=_make_backing()) as mw:
        result = mw.execute_command("cat /no/such/path")
        assert result.exit_code != 0


def test_file_upload_then_download(tmp_path: Path):
    src = tmp_path / "src.bin"
    src.write_bytes(b"abc 123")
    with MirageWorkspace(workspace=_make_backing()) as mw:
        up = mw.file_upload(src, "/uploaded.bin")
        assert up.success is True
        assert up.file_size == 7

        cat = mw.execute_command("cat /uploaded.bin")
        assert cat.exit_code == 0
        assert "abc 123" in cat.stdout

        out = tmp_path / "out.bin"
        dn = mw.file_download("/uploaded.bin", out)
        assert dn.success is True
        assert dn.file_size == 7
        assert out.read_bytes() == b"abc 123"


def test_file_upload_into_nested_dir(tmp_path: Path):
    src = tmp_path / "src.txt"
    src.write_bytes(b"nested")
    with MirageWorkspace(workspace=_make_backing()) as mw:
        up = mw.file_upload(src, "/sub/dir/file.txt")
        assert up.success is True

        cat = mw.execute_command("cat /sub/dir/file.txt")
        assert cat.exit_code == 0
        assert "nested" in cat.stdout


def test_file_download_missing_source_returns_error(tmp_path: Path):
    out = tmp_path / "out.txt"
    with MirageWorkspace(workspace=_make_backing()) as mw:
        dn = mw.file_download("/does/not/exist.txt", out)
        assert dn.success is False
        assert dn.error
        assert out.exists() is False


def test_context_manager_closes_backing_workspace():
    backing = _make_backing()
    with MirageWorkspace(workspace=backing) as mw:
        result = mw.execute_command("echo ctx")
        assert result.exit_code == 0
    assert backing._closed is True


def test_git_methods_not_supported():
    with MirageWorkspace(workspace=_make_backing()) as mw:
        with pytest.raises(NotImplementedError):
            mw.git_changes("/")
        with pytest.raises(NotImplementedError):
            mw.git_diff("/some/path")


def test_execute_command_names_the_reason_beside_a_refusal():
    # stderr is bash's bare `Permission denied`; the reason rides the
    # refusal record, and a text surface appends it as one more line.
    backing = Workspace({"/": (RAMResource(), MountMode.WRITE)},
                        mode=MountMode.WRITE,
                        policies=[_NoDeletes()])
    with MirageWorkspace(workspace=backing) as mw:
        result = mw.execute_command("rm /x")
        assert result.exit_code == 126
        assert result.stderr == (
            "rm: Permission denied\npolicy denied: no deletes\n")
