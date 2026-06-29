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

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource


def _make_ws():
    resource = RAMResource()
    store = resource._store
    store.dirs.add("/")
    store.dirs.add("/subdir")
    store.dirs.add("/subdir/nested")
    store.files["/subdir/file.txt"] = b"hello"
    store.modified["/subdir/file.txt"] = "2024-01-01"
    store.files["/subdir/nested/deep.txt"] = b"deep"
    store.modified["/subdir/nested/deep.txt"] = "2024-01-01"
    return Workspace({"/ram/": resource}, mode=MountMode.WRITE)


def _make_ws_special_chars():
    resource = RAMResource()
    store = resource._store
    store.dirs.add("/")
    store.dirs.add("/Zecheng's Server")
    store.files["/Zecheng's Server/image.png"] = b"PNG"
    store.modified["/Zecheng's Server/image.png"] = "2024-01-01"
    return Workspace({"/ram/": resource}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_pwd_default():
    ws = _make_ws()
    r = await ws.execute("pwd")
    assert (await r.stdout_str()).strip() != ""


@pytest.mark.asyncio
async def test_cd_and_pwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram && pwd")
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_subdir_and_pwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram/subdir && pwd")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_cd_dotdot_and_pwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram/subdir && cd .. && pwd")
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_slash_and_pwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram/subdir && cd / && pwd")
    assert (await r.stdout_str()).strip() == "/"


@pytest.mark.asyncio
async def test_cd_tilde_unset_home_errors():
    ws = _make_ws()
    r = await ws.execute("cd /ram/subdir && cd ~")
    assert r.exit_code != 0


@pytest.mark.asyncio
async def test_cd_no_args_unset_home_errors():
    ws = _make_ws()
    r = await ws.execute("cd /ram/subdir && cd")
    assert r.exit_code == 1
    assert "HOME not set" in await r.stderr_str()


@pytest.mark.asyncio
async def test_cd_no_args_with_home():
    ws = _make_ws()
    r = await ws.execute("export HOME=/ram/subdir && cd /ram && cd && pwd")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_cd_relative_and_pwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram && cd subdir && pwd")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_ls_no_args_uses_cwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram/subdir && ls")
    assert "file.txt" in await r.stdout_str()


@pytest.mark.asyncio
async def test_ls_no_args_root():
    ws = _make_ws()
    r = await ws.execute("cd /ram && ls")
    assert "subdir" in await r.stdout_str()


@pytest.mark.asyncio
async def test_cd_relative_nested():
    ws = _make_ws()
    r = await ws.execute("cd /ram/subdir && cd nested && pwd")
    assert (await r.stdout_str()).strip() == "/ram/subdir/nested"


@pytest.mark.asyncio
async def test_cd_dotdot_twice():
    ws = _make_ws()
    r = await ws.execute('cd /ram/subdir/nested && cd ../.. && pwd')
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_ls_backslash_escaped():
    ws = _make_ws_special_chars()
    r = await ws.execute(r"ls /ram/Zecheng\'s\ Server/")
    assert "image.png" in await r.stdout_str()


@pytest.mark.asyncio
async def test_ls_quoted():
    ws = _make_ws_special_chars()
    r = await ws.execute('ls "/ram/Zecheng\'s Server/"')
    assert "image.png" in await r.stdout_str()


@pytest.mark.asyncio
async def test_cd_backslash_escaped_and_ls():
    ws = _make_ws_special_chars()
    r = await ws.execute(r"cd /ram/Zecheng\'s\ Server && ls")
    assert "image.png" in await r.stdout_str()


@pytest.mark.asyncio
async def test_cd_quoted_and_ls():
    ws = _make_ws_special_chars()
    r = await ws.execute('cd "/ram/Zecheng\'s Server" && ls')
    assert "image.png" in await r.stdout_str()


@pytest.mark.asyncio
async def test_cd_backslash_escaped_and_pwd():
    ws = _make_ws_special_chars()
    r = await ws.execute(r"cd /ram/Zecheng\'s\ Server && pwd")
    assert (await r.stdout_str()).strip() == "/ram/Zecheng's Server"


@pytest.mark.asyncio
async def test_pwd_default_root():
    ws = _make_ws()
    r = await ws.execute("pwd")
    assert (await r.stdout_str()).strip() == "/"


@pytest.mark.asyncio
async def test_echo_pwd_tracks_cwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram/subdir && echo $PWD")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_echo_home_unset_is_empty():
    ws = _make_ws()
    r = await ws.execute('echo "[$HOME]"')
    assert (await r.stdout_str()).strip() == "[]"


@pytest.mark.asyncio
async def test_cd_updates_oldpwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram && cd /ram/subdir && echo $OLDPWD")
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_dash_returns_and_prints():
    ws = _make_ws()
    r = await ws.execute("cd /ram && cd /ram/subdir && cd -")
    out = await r.stdout_str()
    assert out.strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_dash_swaps_cwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram && cd /ram/subdir && cd - > /dev/null && pwd"
                         )
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_dash_without_oldpwd_errors():
    ws = _make_ws()
    r = await ws.execute("cd -")
    assert r.exit_code == 1
    assert "OLDPWD not set" in await r.stderr_str()


@pytest.mark.asyncio
async def test_custom_home_cd_tilde():
    ws = _make_ws()
    r = await ws.execute("export HOME=/ram/subdir && cd ~ && pwd")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_custom_home_echo():
    ws = _make_ws()
    r = await ws.execute("export HOME=/ram/subdir && echo $HOME")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_tilde_expands_for_commands():
    ws = _make_ws()
    r = await ws.execute("export HOME=/ram/subdir && cat ~/file.txt")
    assert (await r.stdout_str()) == "hello"


@pytest.mark.asyncio
async def test_quoted_tilde_not_expanded():
    ws = _make_ws()
    r = await ws.execute('export HOME=/ram/subdir && cat "~/file.txt"')
    assert r.exit_code != 0


@pytest.mark.asyncio
async def test_subshell_does_not_leak_oldpwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram && (cd /ram/subdir) && echo $OLDPWD")
    assert (await r.stdout_str()).strip() == "/"


@pytest.mark.asyncio
async def test_subshell_does_not_leak_cwd():
    ws = _make_ws()
    r = await ws.execute("cd /ram && (cd /ram/subdir) && pwd")
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_double_slash_collapses():
    ws = _make_ws()
    r = await ws.execute("cd //ram && pwd")
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_triple_slash_collapses():
    ws = _make_ws()
    r = await ws.execute("cd ///ram/subdir && pwd")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_cd_physical_flag():
    ws = _make_ws()
    r = await ws.execute("cd -P /ram/subdir && pwd")
    assert (await r.stdout_str()).strip() == "/ram/subdir"


@pytest.mark.asyncio
async def test_cd_logical_flag():
    ws = _make_ws()
    r = await ws.execute("cd -L /ram && pwd")
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_clustered_flags():
    ws = _make_ws()
    r = await ws.execute("cd -LP /ram && pwd")
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_double_dash_terminates_options():
    ws = _make_ws()
    r = await ws.execute("cd -- /ram && pwd")
    assert (await r.stdout_str()).strip() == "/ram"


@pytest.mark.asyncio
async def test_cd_invalid_option_exit2():
    ws = _make_ws()
    r = await ws.execute("cd -x /ram")
    assert r.exit_code == 2
    assert "invalid option" in await r.stderr_str()


@pytest.mark.asyncio
async def test_cd_too_many_arguments():
    ws = _make_ws()
    r = await ws.execute("cd /ram /ram/subdir")
    assert r.exit_code == 1
    assert "too many arguments" in await r.stderr_str()


@pytest.mark.asyncio
async def test_cd_quoted_tilde_is_literal():
    ws = _make_ws()
    r = await ws.execute("cd /ram && cd '~'")
    assert r.exit_code != 0


@pytest.mark.asyncio
async def test_cd_cdpath_search_and_print():
    ws = _make_ws()
    r = await ws.execute("export CDPATH=/ram && cd subdir && pwd")
    lines = (await r.stdout_str()).splitlines()
    assert lines[-1] == "/ram/subdir"
    assert "/ram/subdir" in lines[:-1]


@pytest.mark.asyncio
async def test_cd_cdpath_empty_entry_is_cwd_no_print():
    ws = _make_ws()
    r = await ws.execute("cd /ram && export CDPATH=:/ram && cd subdir && pwd")
    lines = (await r.stdout_str()).splitlines()
    assert lines[-1] == "/ram/subdir"
    assert lines == ["/ram/subdir"]
