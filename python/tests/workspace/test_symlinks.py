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

import errno

import pytest

from mirage.policy import Deny
from mirage.policy.base import Policy
from mirage.types import FileStat, FileType, MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws():
    return Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


@pytest.mark.asyncio
@pytest.mark.parametrize("command", ["stat -c %F", "stat -L -c %F", "file -b"])
@pytest.mark.parametrize("path", ["/data/virtual", "/data/virtual/deep"])
async def test_report_link_only_namespace_directory(command, path):
    ws = _ws()
    await ws.namespace.symlink("/data/virtual/deep/link", "/data/target", 0)
    result = await ws.shell(f"{command} {path}")
    assert result.exit_code == 0
    assert result.stdout.decode() == "directory\n"
    await ws.close()


@pytest.mark.asyncio
async def test_ln_readlink_verbatim():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    r = await ws.shell("ln -s /data/a.txt /data/link.txt")
    assert r.exit_code == 0
    r = await ws.shell("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_ln_relative_target_kept_verbatim():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s a.txt /data/link.txt")
    r = await ws.shell("readlink /data/link.txt")
    assert r.stdout.decode() == "a.txt\n"


@pytest.mark.asyncio
async def test_ln_sf_overwrites():
    ws = _ws()
    await ws.shell("echo a > /data/a.txt")
    await ws.shell("echo b > /data/b.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    await ws.shell("ln -s -f /data/b.txt /data/link.txt")
    r = await ws.shell("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/b.txt\n"


@pytest.mark.asyncio
async def test_ln_no_force_refuses_existing_link():
    ws = _ws()
    await ws.shell("echo a > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("ln -s /data/a.txt /data/link.txt")
    assert r.exit_code == 1
    assert b"File exists" in r.stderr


@pytest.mark.asyncio
async def test_ln_sr_stores_relative_target():
    ws = _ws()
    await ws.shell("mkdir -p /data/a /data/b")
    await ws.shell("echo hi > /data/a/f.txt")
    r = await ws.shell("ln -sr /data/a/f.txt /data/b/link")
    assert r.exit_code == 0
    assert (await ws.shell("readlink /data/b/link")).stdout.decode() == \
        "../a/f.txt\n"
    # the relative link resolves back to the file
    assert (await ws.shell("cat /data/b/link")).stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_ln_srv_reports_relative_link():
    ws = _ws()
    await ws.shell("mkdir -p /data/a /data/b")
    await ws.shell("echo hi > /data/a/f.txt")
    r = await ws.shell("ln -srv /data/a/f.txt /data/b/link")
    assert r.stdout.decode() == "'/data/b/link' -> '../a/f.txt'\n"


@pytest.mark.asyncio
async def test_ln_sn_and_sT_are_accepted_noops():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    assert (await ws.shell("ln -sn /data/a.txt /data/l1")).exit_code == 0
    assert (await ws.shell("ln -sT /data/a.txt /data/l2")).exit_code == 0
    assert (await ws.shell("readlink /data/l1")).stdout.decode() == \
        "/data/a.txt\n"


@pytest.mark.asyncio
async def test_cd_through_symlink_keeps_the_name_it_was_given():
    # GNU bash 5.2: `cd /data/slink && pwd` prints the link, not the
    # target. The logical name is what the shell reports and what the
    # next `cd ..` acts on; `pwd -P` is how you ask for the target.
    ws = _ws()
    await ws.shell("mkdir -p /data/real")
    await ws.shell("ln -s /data/real /data/slink")
    r = await ws.shell("cd /data/slink && pwd")
    assert r.stdout.decode() == "/data/slink\n"
    r = await ws.shell("cd /data/slink && pwd -P")
    assert r.stdout.decode() == "/data/real\n"


# Every row pinned in GNU bash 5.2 (debian:stable-slim) against the same
# fixture this test builds: /data/deep/real/sub, /data/lk -> /data/deep/real.
# The shell keeps two names for the cwd -- the logical one you typed and
# the physical one it resolves to -- and each row says which one a given
# surface reports.
LOGICAL_CWD_ROWS = [
    # `pwd` and `$PWD` report the logical name; `pwd -P` the physical one.
    ("cd /data/lk && pwd", "/data/lk\n"),
    ("cd /data/lk && pwd -L", "/data/lk\n"),
    ("cd /data/lk && pwd -P", "/data/deep/real\n"),
    ('cd /data/lk && echo "$PWD"', "/data/lk\n"),
    # Last flag wins, exactly as `cd -L -P` does.
    ("cd /data/lk && pwd -L -P", "/data/deep/real\n"),
    ("cd /data/lk && pwd -P -L", "/data/lk\n"),
    # A relative operand joins the logical name under -L, the physical
    # one under -P. This is the row where the two disagree about which
    # directory you end up in, not just how it is spelled.
    ("cd /data/lk && cd .. && pwd", "/data\n"),
    ("cd /data/lk && cd -P .. && pwd", "/data/deep\n"),
    ("cd /data/lk && cd sub && pwd", "/data/lk/sub\n"),
    ("cd /data/lk && cd -P sub && pwd", "/data/deep/real/sub\n"),
    # -P collapses the pair, so it re-spells the cwd without moving.
    ("cd /data/lk && cd -P . && pwd", "/data/deep/real\n"),
    ("cd -P /data/lk && pwd", "/data/deep/real\n"),
    # $OLDPWD stores the logical name, so `cd -` returns to that spelling.
    ('cd /data/lk && cd /data && echo "$OLDPWD"', "/data/lk\n"),
    ("cd /data/lk && cd /data && cd -", "/data/lk\n"),
    # Everything that is not a shell builtin stays physical, the way a
    # real child process does: bash's own `ls ..` lists /data/deep here.
    ("cd /data/lk && ls ..", "real\n"),
    # `-P` announces the path as selected and lands on the target: the
    # printed name and the resulting cwd deliberately disagree.
    ("cd /data/lk && cd /data && cd -P -", "/data/lk\n"),
    ("cd /data/lk && cd /data && cd -P - && pwd",
     "/data/lk\n/data/deep/real\n"),
    # `set -P` is the session-wide `-P`, and GNU applies it to `cd` and
    # `pwd` alike. With no logical name ever recorded, `pwd -L` has
    # nothing else to report.
    ("set -P; cd /data/lk; pwd", "/data/deep/real\n"),
    ("set -P; cd /data/lk; pwd -L", "/data/deep/real\n"),
    ('set -P; cd /data/lk; echo "$PWD"', "/data/deep/real\n"),
    ("set -o physical; cd /data/lk; pwd", "/data/deep/real\n"),
    ("set -P; set +P; cd /data/lk; pwd", "/data/lk\n"),
    # A relative operand follows the session mode too.
    ("set -P; cd /data/lk; cd ..; pwd", "/data/deep\n"),
]


@pytest.mark.parametrize("command,expected", LOGICAL_CWD_ROWS)
@pytest.mark.asyncio
async def test_logical_and_physical_cwd(command: str, expected: str):
    ws = _ws()
    await ws.shell("mkdir -p /data/deep/real/sub")
    await ws.shell("ln -s /data/deep/real /data/lk")
    r = await ws.shell(command)
    assert r.exit_code == 0, r.stderr.decode()
    assert r.stdout.decode() == expected


@pytest.mark.asyncio
async def test_pwd_rejects_an_unknown_option():
    ws = _ws()
    r = await ws.shell("pwd -x")
    assert r.exit_code == 2
    assert r.stderr.decode() == ("pwd: -x: invalid option\n"
                                 "pwd: usage: pwd [-LP]\n")


@pytest.mark.asyncio
async def test_pwd_ignores_operands():
    ws = _ws()
    r = await ws.shell("cd /data && pwd extra")
    assert r.exit_code == 0
    assert r.stdout.decode() == "/data\n"


@pytest.mark.asyncio
async def test_logical_cwd_is_not_revalidated():
    # bash never re-checks the logical name: removing the link it was
    # spelled through leaves `pwd` printing it, and only `pwd -P` tells
    # you where you actually are.
    ws = _ws()
    await ws.shell("mkdir -p /data/deep/real")
    await ws.shell("ln -s /data/deep/real /data/lk")
    r = await ws.shell("cd /data/lk && rm /data/lk && pwd && pwd -P")
    assert r.exit_code == 0, r.stderr.decode()
    assert r.stdout.decode() == "/data/lk\n/data/deep/real\n"


@pytest.mark.asyncio
async def test_cdpath_hit_announces_the_spelling_not_the_target():
    # GNU prints the name it selected through $CDPATH even under -P,
    # where the directory it lands on is the link's target.
    ws = _ws()
    await ws.shell("mkdir -p /data/c/t")
    await ws.shell("ln -s /data/c/t /data/c/lnk")
    r = await ws.shell("export CDPATH=/data/c; cd -P lnk; pwd")
    assert r.exit_code == 0, r.stderr.decode()
    assert r.stdout.decode() == "/data/c/lnk\n/data/c/t\n"


@pytest.mark.asyncio
async def test_set_o_rejects_a_name_bash_does_not_have():
    ws = _ws()
    r = await ws.shell("set -o bogusname")
    assert r.exit_code == 2
    assert r.stderr.decode() == "set: bogusname: invalid option name\n"


@pytest.mark.asyncio
async def test_set_o_keeps_what_it_applied_before_the_bad_name():
    # GNU applies left to right and stops at the bad name, so an option
    # named before it stays on and one named after it never lands.
    ws = _ws()
    r = await ws.shell("set -o pipefail -o bogus -o noclobber")
    assert r.exit_code == 2
    session = ws.get_session(ws.default_session_id)
    assert session.shell_options.get("pipefail") is True
    assert "noclobber" not in session.shell_options


@pytest.mark.asyncio
async def test_cd_symlink_loop_is_eloop():
    ws = _ws()
    await ws.shell("ln -s /data/b /data/a")
    await ws.shell("ln -s /data/a /data/b")
    r = await ws.shell("cd /data/a")
    assert r.exit_code == 1
    assert b"Too many levels of symbolic links" in r.stderr


@pytest.mark.asyncio
async def test_symlink_survives_snapshot(tmp_path):
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    target = str(tmp_path / "snap.tar")
    await ws.snapshot(target)
    ws2 = await Workspace.load(target)
    r = await ws2.shell("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_cat_follows_link():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("cat /data/link.txt")
    assert r.exit_code == 0
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_read_follows_midpath_dir_link():
    ws = _ws()
    await ws.shell("mkdir -p /data/real && echo hi > /data/real/f.txt")
    await ws.shell("ln -s /data/real /data/dirlink")
    r = await ws.shell("cat /data/dirlink/f.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_read_follows_relative_target():
    ws = _ws()
    await ws.shell("mkdir -p /data/sub && echo hi > /data/sub/a.txt")
    await ws.shell("ln -s a.txt /data/sub/link.txt")
    r = await ws.shell("cat /data/sub/link.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_write_through_link_updates_target():
    ws = _ws()
    await ws.shell("echo old > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    await ws.shell("echo new > /data/link.txt")
    r = await ws.shell("cat /data/a.txt")
    assert r.stdout.decode() == "new\n"


@pytest.mark.asyncio
async def test_cat_dangling_link_errors_with_typed_name():
    ws = _ws()
    await ws.shell("ln -s /data/missing /data/dangle")
    r = await ws.shell("cat /data/dangle")
    assert r.exit_code == 1
    assert b"/data/dangle" in r.stderr
    assert b"No such file" in r.stderr


@pytest.mark.asyncio
async def test_cat_loop_is_eloop_with_operand():
    ws = _ws()
    await ws.shell("ln -s /data/b /data/a")
    await ws.shell("ln -s /data/a /data/b")
    r = await ws.shell("cat /data/a")
    assert r.exit_code == 1
    assert b"cat: /data/a: Too many levels of symbolic links" in r.stderr


@pytest.mark.asyncio
async def test_ls_lists_links():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("ls /data")
    assert "link.txt" in r.stdout.decode()
    r = await ws.shell("ls -F /data")
    assert "link.txt@" in r.stdout.decode()
    r = await ws.shell("ls -l /data")
    assert "link.txt -> /data/a.txt" in r.stdout.decode()


@pytest.mark.asyncio
async def test_ls_through_dir_link():
    ws = _ws()
    await ws.shell("mkdir -p /data/real && echo hi > /data/real/f.txt")
    await ws.shell("ln -s /data/real /data/dirlink")
    r = await ws.shell("ls /data/dirlink")
    assert r.stdout.decode() == "f.txt\n"


@pytest.mark.asyncio
async def test_rm_removes_link_not_target():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("rm /data/link.txt")
    assert r.exit_code == 0
    r = await ws.shell("readlink /data/link.txt")
    assert r.exit_code == 1
    r = await ws.shell("cat /data/a.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_rm_dangling_link():
    ws = _ws()
    await ws.shell("ln -s /data/missing /data/dangle")
    r = await ws.shell("rm /data/dangle")
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_rm_mixed_link_and_file():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt && echo x > /data/b.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("rm /data/link.txt /data/b.txt")
    assert r.exit_code == 0
    r = await ws.shell("ls /data")
    assert r.stdout.decode() == "a.txt\n"


@pytest.mark.asyncio
async def test_rm_target_leaves_link_dangling():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    await ws.shell("rm /data/a.txt")
    r = await ws.shell("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"
    r = await ws.shell("cat /data/link.txt")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_rm_r_purges_links_under_dir():
    ws = _ws()
    await ws.shell("mkdir -p /data/sub && echo hi > /data/sub/f.txt")
    await ws.shell("ln -s /data/sub/f.txt /data/sub/inner")
    r = await ws.shell("rm -r /data/sub")
    assert r.exit_code == 0
    r = await ws.shell("readlink /data/sub/inner")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_mv_renames_link_entry():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("mv /data/link.txt /data/renamed.txt")
    assert r.exit_code == 0
    r = await ws.shell("readlink /data/renamed.txt")
    assert r.stdout.decode() == "/data/a.txt\n"
    r = await ws.shell("readlink /data/link.txt")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_mv_link_into_existing_dir():
    ws = _ws()
    await ws.shell("mkdir -p /data/dir && echo hi > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("mv /data/link.txt /data/dir")
    assert r.exit_code == 0
    r = await ws.shell("readlink /data/dir/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_mv_file_onto_link_replaces_entry():
    ws = _ws()
    await ws.shell("echo a > /data/a.txt && echo b > /data/b.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("mv /data/b.txt /data/link.txt")
    assert r.exit_code == 0
    r = await ws.shell("readlink /data/link.txt")
    assert r.exit_code == 1
    r = await ws.shell("cat /data/link.txt")
    assert r.stdout.decode() == "b\n"
    r = await ws.shell("cat /data/a.txt")
    assert r.stdout.decode() == "a\n"


@pytest.mark.asyncio
async def test_cross_mount_link_follow():
    ws = Workspace(
        {
            "/data": (RAMVFS(), MountMode.WRITE),
            "/other": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE)
    await ws.shell("echo remote > /other/g.txt")
    await ws.shell("ln -s /other/g.txt /data/xlink")
    r = await ws.shell("cat /data/xlink")
    assert r.stdout.decode() == "remote\n"


@pytest.mark.asyncio
async def test_cp_follows_source_link():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("cp /data/link.txt /data/copy.txt")
    assert r.exit_code == 0
    r = await ws.shell("cat /data/copy.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_grep_follows_link():
    ws = _ws()
    await ws.shell("printf 'alpha\\nbeta\\n' > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/link.txt")
    r = await ws.shell("grep beta /data/link.txt")
    assert r.exit_code == 0
    assert "beta" in r.stdout.decode()


async def _seeded():
    """A tree with one file link and one directory link."""
    ws = _ws()
    await ws.shell("mkdir -p /data/dir")
    await ws.shell("echo hello > /data/dir/real.txt")
    await ws.shell("ln -s /data/dir/real.txt /data/link.txt")
    await ws.shell("ln -s /data/dir /data/dlink")
    return ws


@pytest.mark.asyncio
async def test_find_lists_symlinks():
    """GNU find reports links; they were invisible to the walk before."""
    ws = await _seeded()
    r = await ws.shell("find /data")
    assert r.stdout.decode().splitlines() == [
        "/data",
        "/data/dir",
        "/data/dir/real.txt",
        "/data/dlink",
        "/data/link.txt",
    ]


@pytest.mark.asyncio
async def test_find_type_l_matches_only_links():
    ws = await _seeded()
    r = await ws.shell("find /data -type l")
    assert r.stdout.decode().splitlines() == ["/data/dlink", "/data/link.txt"]


@pytest.mark.asyncio
async def test_find_type_f_excludes_links():
    """A link is kind 'l', never 'f', matching GNU's default -P."""
    ws = await _seeded()
    r = await ws.shell("find /data -type f")
    assert r.stdout.decode().splitlines() == ["/data/dir/real.txt"]


@pytest.mark.asyncio
async def test_find_type_d_excludes_a_link_to_a_directory():
    ws = await _seeded()
    r = await ws.shell("find /data -type d")
    assert r.stdout.decode().splitlines() == ["/data", "/data/dir"]


@pytest.mark.asyncio
async def test_find_name_matches_a_link():
    ws = await _seeded()
    r = await ws.shell("find /data -name 'link*'")
    assert r.stdout.decode().splitlines() == ["/data/link.txt"]


@pytest.mark.asyncio
async def test_find_does_not_descend_through_a_directory_link():
    """Without -L, GNU reports the link and never walks through it, so
    the target's contents appear once, under the real directory."""
    ws = await _seeded()
    r = await ws.shell("find /data -name real.txt")
    assert r.stdout.decode().splitlines() == ["/data/dir/real.txt"]


@pytest.mark.asyncio
async def test_find_maxdepth_prunes_links_too():
    ws = _ws()
    await ws.shell("mkdir -p /data/sub")
    await ws.shell("ln -s /data/t /data/sub/deep.txt")
    r = await ws.shell("find /data -maxdepth 1")
    assert "/data/sub/deep.txt" not in r.stdout.decode()


@pytest.mark.asyncio
async def test_find_size_compares_the_target_string_length():
    """A link's size is len(target), the way lstat reports it."""
    ws = _ws()
    await ws.shell("ln -s /data/abc /data/l")
    r = await ws.shell("find /data -type l -size -2c")
    assert r.stdout.decode() == ""
    r = await ws.shell("find /data -type l -size +2c")
    assert r.stdout.decode().splitlines() == ["/data/l"]


@pytest.mark.asyncio
async def test_ls_long_renders_a_link_the_way_gnu_does():
    """lrwxrwxrwx, the target string's length as the size, name -> target."""
    ws = await _seeded()
    r = await ws.shell("ls -l /data")
    lines = r.stdout.decode().splitlines()
    link_line = next(x for x in lines if "link.txt" in x)
    assert link_line.startswith("lrwxrwxrwx 1 ")
    assert link_line.endswith("link.txt -> /data/dir/real.txt")
    assert f" {len('/data/dir/real.txt')} " in link_line


@pytest.mark.asyncio
async def test_ls_classify_marks_links_with_an_at_sign():
    ws = await _seeded()
    r = await ws.shell("ls -F /data")
    assert "link.txt@" in r.stdout.decode()


@pytest.mark.asyncio
async def test_stat_reports_the_link_and_dash_l_reports_the_target():
    ws = await _seeded()
    r = await ws.shell("stat /data/link.txt")
    assert "type=symlink" in r.stdout.decode()
    assert f"size={len('/data/dir/real.txt')}" in r.stdout.decode()
    r = await ws.shell("stat -L /data/link.txt")
    assert "type=text" in r.stdout.decode()
    assert "size=6" in r.stdout.decode()


@pytest.mark.asyncio
async def test_stat_format_directives_on_a_link():
    ws = await _seeded()
    r = await ws.shell("stat -c '%F %A' /data/link.txt")
    assert r.stdout.decode().strip() == "symbolic link lrwxrwxrwx"


@pytest.mark.asyncio
async def test_stat_percent_n_renders_the_link_arrow():
    """GNU: ``'name' -> 'target'`` for a link, bare quoted name otherwise."""
    ws = await _seeded()
    r = await ws.shell("stat -c '%N' /data/link.txt")
    assert r.stdout.decode() == "'/data/link.txt' -> '/data/dir/real.txt'\n"
    r = await ws.shell("stat -c '%N' /data/dir/real.txt")
    assert r.stdout.decode() == "'/data/dir/real.txt'\n"
    # %n is the bare name even for a link.
    r = await ws.shell("stat -c '%n' /data/link.txt")
    assert r.stdout.decode() == "/data/link.txt\n"
    # -L reports the target, which is not a link, so no arrow.
    r = await ws.shell("stat -L -c '%N' /data/link.txt")
    assert r.stdout.decode() == "'/data/link.txt'\n"


@pytest.mark.asyncio
async def test_stat_percent_n_arrow_on_a_dangling_link():
    ws = await _dangling()
    r = await ws.shell("stat -c '%N' /data/dangle")
    assert r.stdout.decode() == "'/data/dangle' -> '/data/nope'\n"


@pytest.mark.asyncio
async def test_stat_percent_n_quotes_each_side_on_its_own():
    ws = _ws()
    await ws.shell("echo hi > \"/data/it's\"")
    await ws.shell("ln -s \"/data/it's\" /data/plain")
    r = await ws.shell("stat -c '%N' /data/plain")
    assert r.stdout.decode() == "'/data/plain' -> \"/data/it's\"\n"


@pytest.mark.asyncio
async def test_stat_percent_n_target_holding_shell_metacharacters():
    """A target with an apostrophe next to a live character goes back to
    single quotes, so replaying the line cannot expand ``$c``."""
    ws = _ws()
    await ws.shell("""ln -s "/data/a'b\\$c" /data/meta""")
    r = await ws.shell("stat -c '%N' /data/meta")
    assert r.stdout.decode() == "'/data/meta' -> '/data/a'\\''b$c'\n"


@pytest.mark.asyncio
async def test_stat_percent_n_modifiers_drop_quotes_and_pad_each_side():
    """GNU quotes %N only when the directive carries no modifier, and a
    width or precision applies to the name and the target separately."""
    ws = await _seeded()
    r = await ws.shell("stat -c '[%20N]' /data/link.txt")
    assert r.stdout.decode() == (
        "[      /data/link.txt ->   /data/dir/real.txt]\n")
    r = await ws.shell("stat -c '[%-20N]' /data/link.txt")
    assert r.stdout.decode() == (
        "[/data/link.txt       -> /data/dir/real.txt  ]\n")
    r = await ws.shell("stat -c '[%.6N]' /data/link.txt")
    assert r.stdout.decode() == "[/data/ -> /data/]\n"
    r = await ws.shell("stat -c '[%20N]' /data/dir/real.txt")
    assert r.stdout.decode() == "[  /data/dir/real.txt]\n"


async def _dangling():
    """The seeded tree plus a link whose target does not exist."""
    ws = await _seeded()
    await ws.shell("ln -s /data/nope /data/dangle")
    return ws


@pytest.mark.asyncio
async def test_ls_long_reports_a_link_operand_without_following_it():
    """GNU ls -l names a command-line link, never its target."""
    ws = await _seeded()
    r = await ws.shell("ls -l /data/link.txt")
    assert r.exit_code == 0
    line = r.stdout.decode().strip()
    assert line.startswith("lrwxrwxrwx")
    assert line.endswith("/data/link.txt -> /data/dir/real.txt")


@pytest.mark.asyncio
async def test_ls_long_on_a_dangling_link_succeeds():
    """A broken link used to fail the whole listing with exit 2."""
    ws = await _dangling()
    r = await ws.shell("ls -l /data/dangle")
    assert r.exit_code == 0
    assert not r.stderr
    assert r.stdout.decode().strip().endswith("/data/dangle -> /data/nope")


@pytest.mark.asyncio
async def test_ls_long_on_a_directory_link_shows_the_link():
    """GNU: -l suppresses the command-line dereference bare ls does."""
    ws = await _seeded()
    r = await ws.shell("ls -l /data/dlink")
    assert r.stdout.decode().strip().endswith("/data/dlink -> /data/dir")


@pytest.mark.asyncio
async def test_bare_ls_still_dereferences_a_directory_link():
    """Without -l/-d GNU lists what the link points at."""
    ws = await _seeded()
    r = await ws.shell("ls /data/dlink")
    assert r.stdout.decode() == "real.txt\n"


@pytest.mark.asyncio
async def test_ls_recursive_lists_links_and_does_not_descend_them():
    ws = await _dangling()
    r = await ws.shell("ls -R /data")
    out = r.stdout.decode()
    assert out.split("\n")[:5] == [
        "/data:", "dangle", "dir", "dlink", "link.txt"
    ]
    # dir is descended, dlink is not: one group header per real directory.
    assert "/data/dir:" in out
    assert "/data/dlink:" not in out


@pytest.mark.asyncio
async def test_readlink_e_fails_on_a_dangling_link():
    """GNU -e requires the whole resolved path to exist."""
    ws = await _dangling()
    r = await ws.shell("readlink -e /data/dangle")
    assert r.exit_code == 1
    assert r.stdout.decode() == ""


@pytest.mark.asyncio
async def test_readlink_f_prints_a_dangling_target():
    """GNU -f only requires the parent, so a broken link still prints."""
    ws = await _dangling()
    r = await ws.shell("readlink -f /data/dangle")
    assert r.exit_code == 0
    assert r.stdout.decode() == "/data/nope\n"


@pytest.mark.asyncio
async def test_readlink_f_fails_when_the_parent_is_missing():
    ws = await _seeded()
    r = await ws.shell("readlink -f /data/missing/x")
    assert r.exit_code == 1
    assert r.stdout.decode() == ""


@pytest.mark.asyncio
async def test_readlink_m_requires_nothing_to_exist():
    ws = await _seeded()
    r = await ws.shell("readlink -m /data/missing/x")
    assert r.exit_code == 0
    assert r.stdout.decode() == "/data/missing/x\n"


@pytest.mark.asyncio
async def test_file_describes_a_link_instead_of_following_it():
    ws = await _seeded()
    r = await ws.shell("file /data/link.txt")
    assert r.stdout.decode() == (
        "/data/link.txt: symbolic link to /data/dir/real.txt\n")


@pytest.mark.asyncio
async def test_file_calls_a_dangling_link_broken():
    ws = await _dangling()
    r = await ws.shell("file /data/dangle")
    assert r.exit_code == 0
    assert r.stdout.decode() == (
        "/data/dangle: broken symbolic link to /data/nope\n")


@pytest.mark.asyncio
async def test_file_keeps_a_relative_target_verbatim():
    """GNU prints the stored target, not a resolved one."""
    ws = _ws()
    await ws.shell("echo world > /data/rel.txt")
    await ws.shell("ln -s rel.txt /data/relative")
    r = await ws.shell("file /data/relative")
    assert r.stdout.decode() == "/data/relative: symbolic link to rel.txt\n"


@pytest.mark.asyncio
async def test_file_dash_l_follows_the_link():
    ws = await _seeded()
    r = await ws.shell("file -L /data/link.txt")
    assert "symbolic link" not in r.stdout.decode()
    assert "text" in r.stdout.decode()


@pytest.mark.asyncio
async def test_file_mime_reports_the_link_inode_type():
    ws = await _seeded()
    r = await ws.shell("file -i /data/link.txt")
    assert r.stdout.decode() == (
        "/data/link.txt: inode/symlink; charset=binary\n")


@pytest.mark.asyncio
async def test_du_a_accounts_for_links():
    """Links were invisible to du; GNU lists one line per link under -a."""
    ws = await _dangling()
    r = await ws.shell("du -a /data")
    listed = [line.split("\t")[1] for line in r.stdout.decode().splitlines()]
    assert "/data/dangle" in listed
    assert "/data/dlink" in listed
    assert "/data/link.txt" in listed


@pytest.mark.asyncio
async def test_du_without_a_omits_link_lines():
    """Links are files: GNU prints a line per directory unless -a."""
    ws = await _dangling()
    r = await ws.shell("du /data")
    listed = [line.split("\t")[1] for line in r.stdout.decode().splitlines()]
    assert listed == ["/data/dir", "/data"]


@pytest.mark.asyncio
async def test_du_sizes_a_link_by_its_target_length():
    """Deliberate divergence: GNU counts blocks (0), mirage counts bytes."""
    ws = await _seeded()
    r = await ws.shell("du /data/link.txt")
    size, name = r.stdout.decode().strip().split("\t")
    assert name == "/data/link.txt"
    assert int(size) == len("/data/dir/real.txt")


@pytest.mark.asyncio
async def test_du_does_not_follow_a_link_operand():
    """GNU du reports the link itself without -L."""
    ws = await _seeded()
    r = await ws.shell("du /data/dlink")
    lines = r.stdout.decode().strip().split("\n")
    assert len(lines) == 1
    assert lines[0].split("\t")[1] == "/data/dlink"


@pytest.mark.asyncio
async def test_du_totals_include_links():
    ws = await _seeded()
    r = await ws.shell("du -s /data")
    total = int(r.stdout.decode().split("\t")[0])
    # hello\n plus both link targets.
    assert total == 6 + len("/data/dir/real.txt") + len("/data/dir")


@pytest.mark.asyncio
async def test_find_dash_l_classifies_a_link_by_its_target():
    ws = _ws()
    await ws.shell("mkdir -p /data/d/sub")
    await ws.shell("echo hello > /data/d/real.txt")
    await ws.shell("echo inner > /data/d/sub/inner.txt")
    await ws.shell("ln -s /data/d/real.txt /data/d/flink")
    await ws.shell("ln -s /data/d/sub /data/d/dlink")
    await ws.shell("ln -s /data/nowhere /data/d/dangle")

    r = await ws.shell("find -L /data/d -type f")
    assert r.stdout.decode().splitlines() == [
        "/data/d/flink",
        "/data/d/real.txt",
        "/data/d/sub/inner.txt",
    ]
    r = await ws.shell("find -L /data/d -type d")
    assert r.stdout.decode().splitlines() == [
        "/data/d",
        "/data/d/dlink",
        "/data/d/sub",
    ]
    # Only a dangling link stays type l under -L.
    r = await ws.shell("find -L /data/d -type l")
    assert r.stdout.decode().splitlines() == ["/data/d/dangle"]


@pytest.mark.asyncio
async def test_find_without_dash_l_reports_every_link_as_l():
    ws = _ws()
    await ws.shell("mkdir -p /data/d/sub")
    await ws.shell("echo hello > /data/d/real.txt")
    await ws.shell("ln -s /data/d/real.txt /data/d/flink")
    await ws.shell("ln -s /data/d/sub /data/d/dlink")
    r = await ws.shell("find /data/d -type l")
    assert r.stdout.decode().splitlines() == [
        "/data/d/dlink",
        "/data/d/flink",
    ]
    r = await ws.shell("find /data/d -type f")
    assert r.stdout.decode().splitlines() == ["/data/d/real.txt"]


# ── POSIX pathname resolution ────────────────────────────────────────
# `x/` is `x/.`, so a trailing slash resolves the final symlink even for
# a command that otherwise lstats its operand, and then requires what it
# found to be a directory. Every expectation below is GNU coreutils 9.4 /
# tar 1.35 on debian:stable-slim, probed per case from a fresh tree:
#
#   base/dlink  -> base/sub   (emptydir/, f2 = 7 bytes, l2 -> 14-byte target)
#   base/flink  -> base/reg   (a 6-byte regular file)
#   base/dangle -> base/nope  (nothing)


async def _slash_ws():
    ws = _ws()
    await ws.shell("mkdir -p /data/base/sub/emptydir")
    await ws.shell("printf 'abcdef\\n' > /data/base/sub/f2")
    await ws.shell("printf 'hello\\n' > /data/base/reg")
    await ws.shell("ln -s 12345678901234 /data/base/sub/l2")
    await ws.shell("ln -s sub /data/base/dlink")
    await ws.shell("ln -s reg /data/base/flink")
    await ws.shell("ln -s nope /data/base/dangle")
    return ws


@pytest.mark.asyncio
async def test_link_prefix_resolves_for_no_follow_commands():
    """Only the LAST component is exempt from resolution, never the prefix.

    GNU: `stat dlink/f2` is a regular file, because dlink was resolved on
    the way to f2. Every no-follow command sees the same path.
    """
    ws = await _slash_ws()
    r = await ws.shell("stat -c '%F' /data/base/dlink/f2")
    assert r.stdout.decode() == "regular file\n"
    r = await ws.shell("du /data/base/dlink/f2")
    assert r.stdout.decode() == "7\t/data/base/dlink/f2\n"
    r = await ws.shell("find /data/base/dlink/f2")
    assert r.stdout.decode() == "/data/base/dlink/f2\n"
    r = await ws.shell("readlink /data/base/dlink/l2")
    assert r.stdout.decode() == "12345678901234\n"
    r = await ws.shell("rmdir /data/base/dlink/f2")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("rmdir: failed to remove "
                                 "'/data/base/dlink/f2': Not a directory\n")


@pytest.mark.asyncio
async def test_trailing_slash_resolves_a_directory_link():
    ws = await _slash_ws()
    r = await ws.shell("stat -c '%F' /data/base/dlink")
    assert r.stdout.decode() == "symbolic link\n"
    r = await ws.shell("stat -c '%F' /data/base/dlink/")
    assert r.stdout.decode() == "directory\n"
    # The link's own target-string length, then the target's contents.
    r = await ws.shell("du /data/base/dlink")
    assert r.stdout.decode() == "3\t/data/base/dlink\n"
    r = await ws.shell("du /data/base/dlink/")
    assert r.stdout.decode() == "21\t/data/base/dlink/\n"
    r = await ws.shell("file /data/base/dlink/")
    assert r.stdout.decode() == "/data/base/dlink/: directory\n"
    r = await ws.shell("ls /data/base/dlink/")
    assert r.stdout.decode().splitlines() == ["emptydir", "f2", "l2"]


@pytest.mark.asyncio
async def test_trailing_slash_walks_the_target_under_find():
    ws = await _slash_ws()
    r = await ws.shell("find /data/base/dlink/")
    assert r.stdout.decode().splitlines() == [
        "/data/base/dlink/",
        "/data/base/dlink/emptydir",
        "/data/base/dlink/f2",
        "/data/base/dlink/l2",
    ]
    r = await ws.shell("find /data/base/dlink/ -type f")
    assert r.stdout.decode() == "/data/base/dlink/f2\n"


@pytest.mark.asyncio
async def test_readlink_of_a_slashed_link_is_a_silent_failure():
    """GNU: the slash resolved it, so there is no link left to read."""
    ws = await _slash_ws()
    r = await ws.shell("readlink /data/base/dlink")
    assert r.stdout.decode() == "sub\n"
    r = await ws.shell("readlink /data/base/dlink/")
    assert r.exit_code == 1
    assert r.stdout is None or r.stdout == b""


@pytest.mark.asyncio
async def test_trailing_slash_requires_a_directory():
    """A link to a file, a dangling link and a plain file all refuse."""
    ws = await _slash_ws()
    for operand, detail in (("flink", "Not a directory"), ("reg",
                                                           "Not a directory"),
                            ("dangle", "No such file or directory")):
        path = f"/data/base/{operand}/"
        r = await ws.shell(f"cat {path}")
        assert r.exit_code == 1, operand
        assert r.stderr.decode() == f"cat: {path}: {detail}\n"
        r = await ws.shell(f"wc -c {path}")
        assert r.exit_code == 1, operand
        assert r.stderr.decode() == f"wc: {path}: {detail}\n"
        r = await ws.shell(f"ls {path}")
        assert r.exit_code == 2, operand
        assert r.stderr.decode() == f"ls: cannot access '{path}': {detail}\n"
        r = await ws.shell(f"du {path}")
        assert r.exit_code == 1, operand
        assert r.stderr.decode() == f"du: cannot access '{path}': {detail}\n"
        r = await ws.shell(f"find {path}")
        assert r.exit_code == 1, operand
        assert r.stderr.decode() == f"find: '{path}': {detail}\n"


@pytest.mark.asyncio
async def test_rmdir_words_a_link_apart_from_a_slashed_link():
    """The two GNU messages rmdir has for a symlink operand."""
    ws = await _slash_ws()
    r = await ws.shell("rmdir /data/base/dlink")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("rmdir: failed to remove '/data/base/dlink': "
                                 "Not a directory\n")
    r = await ws.shell("rmdir /data/base/dlink/")
    assert r.exit_code == 1
    assert r.stderr.decode() == (
        "rmdir: failed to remove '/data/base/dlink/': "
        "Symbolic link not followed\n")
    # Neither attempt touched the link.
    assert (await
            ws.shell("readlink /data/base/dlink")).stdout.decode() == "sub\n"


@pytest.mark.asyncio
async def test_a_slash_protects_a_link_from_rm_and_unlink():
    """The data-safety half: `rm dlink/` must not delete the link."""
    ws = await _slash_ws()
    r = await ws.shell("rm /data/base/dlink/")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("rm: cannot remove '/data/base/dlink/': "
                                 "Is a directory\n")
    assert (await
            ws.shell("readlink /data/base/dlink")).stdout.decode() == "sub\n"
    r = await ws.shell("rm -r /data/base/dlink/")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("rm: cannot remove '/data/base/dlink/': "
                                 "Not a directory\n")
    r = await ws.shell("unlink /data/base/dlink/")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("unlink: cannot unlink '/data/base/dlink/': "
                                 "Not a directory\n")
    assert (await
            ws.shell("readlink /data/base/dlink")).stdout.decode() == "sub\n"
    # Without the slash both remove the link itself, as GNU does.
    assert (await ws.shell("rm /data/base/dlink")).exit_code == 0
    assert (await ws.shell("readlink /data/base/dlink")).exit_code == 1


@pytest.mark.asyncio
async def test_rm_f_suppresses_enotdir_but_not_eisdir():
    ws = await _slash_ws()
    assert (await ws.shell("rm -f /data/base/flink/")).exit_code == 0
    assert (await ws.shell("rm -rf /data/base/dlink/")).exit_code == 0
    r = await ws.shell("rm -f /data/base/dlink/")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("rm: cannot remove '/data/base/dlink/': "
                                 "Is a directory\n")


@pytest.mark.asyncio
async def test_unlink_removes_a_bare_link():
    ws = await _slash_ws()
    assert (await ws.shell("unlink /data/base/dlink")).exit_code == 0
    assert (await ws.shell("readlink /data/base/dlink")).exit_code == 1


@pytest.mark.asyncio
async def test_mkdir_collides_with_a_link_it_cannot_see():
    """mkdir lstats the name, so a link occupying it is EEXIST.

    Not a trailing-slash rule: `mkdir -p dangle` collides too, and used
    to create the link's missing target instead.
    """
    ws = await _slash_ws()
    for line in ("mkdir -p /data/base/dangle", "mkdir /data/base/dangle",
                 "mkdir -p /data/base/dangle/"):
        r = await ws.shell(line)
        assert r.exit_code == 1, line
        assert "File exists" in r.stderr.decode(), line
        assert (await ws.shell("ls /data/base/nope")).exit_code != 0
    # A link that already leads to a directory satisfies -p.
    assert (await ws.shell("mkdir -p /data/base/dlink")).exit_code == 0
    r = await ws.shell("mkdir -p /data/base/flink")
    assert r.exit_code == 1
    assert "File exists" in r.stderr.decode()


@pytest.mark.asyncio
async def test_touch_never_creates_through_a_trailing_slash():
    ws = await _slash_ws()
    assert (await ws.shell("touch /data/base/dlink/")).exit_code == 0
    r = await ws.shell("touch /data/base/flink/")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("touch: setting times of "
                                 "'/data/base/flink/': Not a directory\n")
    r = await ws.shell("touch /data/base/dangle/")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("touch: setting times of "
                                 "'/data/base/dangle/': "
                                 "No such file or directory\n")


@pytest.mark.asyncio
async def test_tar_ignores_a_trailing_slash():
    """GNU tar strips it before it stats, so the link is archived.

    The one command a trailing slash does not reach; -h is still how you
    ask tar to descend.
    """
    ws = await _slash_ws()
    assert (
        await
        ws.shell("tar -cf /data/a.tar -C /data/base dlink/")).exit_code == 0
    assert (await
            ws.shell("tar -cf /data/b.tar -C /data/base dlink")).exit_code == 0
    slashed = (await ws.shell("tar -tf /data/a.tar")).stdout.decode()
    assert slashed == (await ws.shell("tar -tf /data/b.tar")).stdout.decode()
    assert slashed.splitlines() == ["dlink"]


@pytest.mark.asyncio
async def test_removal_validates_the_line_before_it_drops_a_link():
    """GNU removes nothing from a line it refuses.

    The link entry lives in the namespace, so the dispatcher drops it
    before the command layer parses; a line that layer would reject has
    to leave it alone. Pinned against GNU coreutils 9.7: `unlink a b` is
    "extra operand", an undeclared option is "unrecognized option", and
    both leave every operand in place.
    """
    ws = await _slash_ws()
    r = await ws.shell("unlink /data/base/dlink /data/base/flink")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("unlink: extra operand '/data/base/flink'\n"
                                 "Try 'unlink --help' for more information.\n")
    r = await ws.shell("unlink --bogus /data/base/dlink")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("unlink: unrecognized option '--bogus'\n"
                                 "Try 'unlink --help' for more information.\n")
    r = await ws.shell("rm --bogus /data/base/dlink")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("rm: unrecognized option '--bogus'\n"
                                 "Try 'rm --help' for more information.\n")
    # Every link the refused lines named is still there.
    for name in ("dlink", "flink"):
        assert (await ws.shell(f"readlink /data/base/{name}")).exit_code == 0
    # The well-formed lines still remove the link entry itself.
    assert (await ws.shell("unlink /data/base/flink")).exit_code == 0
    assert (await ws.shell("rm /data/base/dlink")).exit_code == 0
    assert (await ws.shell("readlink /data/base/dlink")).exit_code == 1


@pytest.mark.asyncio
async def test_mv_refuses_a_slashed_link_instead_of_renaming_it():
    """rename(2) never follows, so `mv dlink/` is refused, not resolved.

    A bare `mv dlink out` renames the link entry; the slash asks for a
    directory the call will not resolve, and GNU answers with four
    wordings in mv's own order (source stat, then destination type, then
    the rename). All pinned against GNU coreutils 9.7.
    """
    ws = await _slash_ws()
    await ws.shell("mkdir /data/outdir")
    await ws.shell("printf 'x\\n' > /data/outfile")

    r = await ws.shell("mv /data/base/dlink/ /data/out")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("mv: cannot move '/data/base/dlink/' to "
                                 "'/data/out': Not a directory\n")
    r = await ws.shell("mv /data/base/flink/ /data/out")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("mv: cannot stat '/data/base/flink/': "
                                 "Not a directory\n")
    r = await ws.shell("mv /data/base/dangle/ /data/out")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("mv: cannot stat '/data/base/dangle/': "
                                 "No such file or directory\n")
    # A directory destination names where the move would have landed.
    r = await ws.shell("mv /data/base/dlink/ /data/outdir")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("mv: cannot move '/data/base/dlink/' to "
                                 "'/data/outdir/dlink': Not a directory\n")
    r = await ws.shell("mv /data/base/dlink/ /data/outfile")
    assert r.exit_code == 1
    assert r.stderr.decode() == (
        "mv: cannot overwrite non-directory '/data/outfile' "
        "with directory '/data/base/dlink/'\n")
    # Nothing moved, and the bare spelling still renames the link.
    assert (await ws.shell("ls /data/out")).exit_code != 0
    assert (await ws.shell("mv /data/base/dlink /data/out")).exit_code == 0
    assert (await ws.shell("readlink /data/out")).stdout.decode() == "sub\n"


@pytest.mark.asyncio
async def test_mv_resolves_a_link_prefix_before_refusing_the_last():
    """The prefix resolves for mv too, so an aliased parent behaves alike."""
    ws = await _slash_ws()
    await ws.shell("ln -s /data/base /data/alias")
    r = await ws.shell("mv /data/alias/dlink/ /data/out")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("mv: cannot move '/data/alias/dlink/' to "
                                 "'/data/out': Not a directory\n")
    assert (await ws.shell("readlink /data/base/dlink")).exit_code == 0


# readlink(2) splits its two misses and callers read them differently:
# EINVAL means "there, but not a link", ENOENT means "not there". Pinned
# against real Linux (python:3.13-slim): a file, a directory and a mount
# root all answer EINVAL, and a missing path answers ENOENT whether or
# not its parent exists.
@pytest.mark.asyncio
async def test_readlink_answers_the_target_for_a_link():
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s a.txt /data/l")
    assert await ws.vfs.readlink("/data/l") == "a.txt"


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/data/a.txt", "/data/d", "/data"])
async def test_readlink_of_something_that_is_there_is_einval(path: str):
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("mkdir /data/d")
    with pytest.raises(OSError) as caught:
        await ws.vfs.readlink(path)
    assert caught.value.errno == errno.EINVAL
    assert not isinstance(caught.value, FileNotFoundError)


@pytest.mark.asyncio
@pytest.mark.parametrize("path",
                         ["/data/missing", "/data/d/deep/missing", "/nomount"])
async def test_readlink_of_something_absent_is_enoent(path: str):
    # FileNotFoundError, not a bare OSError: a guest's `except
    # FileNotFoundError` is what has to catch this.
    ws = _ws()
    await ws.shell("mkdir /data/d")
    with pytest.raises(FileNotFoundError) as caught:
        await ws.vfs.readlink(path)
    assert caught.value.errno == errno.ENOENT


@pytest.mark.asyncio
async def test_readlink_reads_the_listing_channel_for_a_marker_less_dir():
    # A prefix store keeps no directory object, so stat misses what the
    # parent's listing reports: reading only the first channel would
    # report an implicit directory as absent.
    ws = _ws()
    await ws.shell("mkdir /data/d")
    await ws.shell("echo x > /data/d/under.txt")
    mount = ws._registry.try_mount_for("/data/d")
    original = mount.execute_op

    async def prefix_store(op_name, path, *args, **kwargs):
        if op_name == "stat":
            raise FileNotFoundError(path)
        entries = await original(op_name, path, *args, **kwargs)
        if op_name != "readdir":
            return entries
        # A name with no keys under it is in no listing either, which is
        # how such a store says a directory is not there. Two different
        # answers with stat silenced is what proves the listing is the
        # channel being read.
        return [
            e for e in entries
            if str(e).rstrip("/").rsplit("/", 1)[-1] != "hollow"
        ]

    mount.execute_op = prefix_store
    with pytest.raises(OSError) as caught:
        await ws.vfs.readlink("/data/d")
    assert caught.value.errno == errno.EINVAL
    await ws.shell("mkdir /data/hollow")
    with pytest.raises(FileNotFoundError):
        await ws.vfs.readlink("/data/hollow")


@pytest.mark.asyncio
async def test_readlink_does_not_probe_past_a_policy_that_denies_stat():
    """The probe reads on the caller's behalf, never past a refusal.

    A policy that denies ``stat`` must not be reachable through a
    readlink. A channel that refuses is not evidence of absence either,
    so the errno collapses to the EINVAL every miss answered before the
    split rather than claiming a path is gone.
    """

    class NoStat(Policy):

        async def pre_ops(self, ctx):
            if ctx.op in ("stat", "readdir"):
                return Deny(reason="no probing")
            return None

    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   policies=[NoStat()])
    with pytest.raises(OSError) as caught:
        await ws.vfs.readlink("/data/missing")
    assert caught.value.errno == errno.EINVAL


@pytest.mark.asyncio
async def test_ln_refuses_a_name_a_file_already_holds():
    """GNU refuses an occupied destination; the node table alone cannot.

    ``ln`` checked only its own table, so the link node landed on top of
    a live file: the bytes stayed in the backend, unreachable, and the
    name read as a dangling link. The door owns the rule now, because it
    is the only layer that sees both planes.
    """
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt")
    r = await ws.shell("ln -s /data/other /data/a.txt")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("ln: failed to create symbolic link "
                                 "'/data/a.txt': File exists\n")
    assert (await ws.shell("cat /data/a.txt")).stdout == b"hi\n"


@pytest.mark.asyncio
async def test_ln_into_a_synthesized_tree_is_not_an_occupied_name():
    """A directory an API tree invents is not evidence the name is taken.

    Those trees answer for a path nobody has created: a postgres schema
    directory lists ``tables/`` and ``views/`` before anything asks
    whether the schema is there, and a grouping mount stats every path
    under a live collection as a directory. Refusing on either reading
    denied the ordinary case of adding a link inside a mounted tree.
    """
    ws = _ws()
    mount = ws._registry.try_mount_for("/data")
    original = mount.execute_op

    async def synthesized(op_name, path, *args, **kwargs):
        if op_name == "stat":
            return FileStat(name=path.rsplit("/", 1)[-1],
                            type=FileType.DIRECTORY)
        if op_name == "readdir":
            return ["tables", "views"]
        return await original(op_name, path, *args, **kwargs)

    mount.execute_op = synthesized
    r = await ws.shell("ln -s /data/x /data/meta_link")
    assert r.exit_code == 0
    assert not r.stderr
    mount.execute_op = original
    assert (await ws.shell("readlink /data/meta_link")).stdout == b"/data/x\n"


@pytest.mark.asyncio
async def test_ln_sf_replaces_a_regular_file():
    # GNU -f removes the destination and then links, so it replaces a
    # regular file and not only a link (pinned against coreutils 9.7).
    ws = _ws()
    await ws.shell("echo hi > /data/a.txt; echo t > /data/t.txt")
    r = await ws.shell("ln -sf /data/t.txt /data/a.txt")
    assert r.exit_code == 0
    assert (await ws.shell("readlink /data/a.txt")).stdout == b"/data/t.txt\n"
    assert (await ws.shell("cat /data/a.txt")).stdout == b"t\n"


@pytest.mark.asyncio
async def test_mv_of_a_link_passes_the_admission_gate():
    """The link rename is the door's, so a policy that denies it wins.

    mv used to move the node itself, which meant the one write in the
    shell that no admission policy could see.
    """

    class NoRename(Policy):

        async def pre_ops(self, ctx):
            if ctx.op == "rename":
                return Deny(reason="frozen")
            return None

    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   policies=[NoRename()])
    await ws.shell("echo hi > /data/a.txt")
    await ws.shell("ln -s /data/a.txt /data/lk")
    r = await ws.shell("mv /data/lk /data/lk2")
    assert r.exit_code == 1
    assert r.stderr.decode() == ("mv: cannot move '/data/lk' to "
                                 "'/data/lk2': Permission denied\n")
    assert (await ws.shell("readlink /data/lk")).stdout == b"/data/a.txt\n"


# ── ln: GNU operand grammar, backups, and the hard-link tier ──────


async def _seed_ln(ws) -> None:
    await ws.shell("mkdir -p /data/d /data/e")
    await ws.shell("echo hi > /data/a.txt; echo yo > /data/b.txt")


@pytest.mark.asyncio
async def test_ln_s_links_into_a_directory_destination():
    ws = _ws()
    await _seed_ln(ws)
    r = await ws.shell("ln -sv /data/a.txt /data/d")
    assert r.exit_code == 0
    assert r.stdout == b"'/data/d/a.txt' -> '/data/a.txt'\n"
    assert (await ws.shell("readlink /data/d/a.txt")).stdout == \
        b"/data/a.txt\n"
    r = await ws.shell("ln -sr /data/b.txt /data/d/")
    assert r.exit_code == 0
    assert (await ws.shell("readlink /data/d/b.txt")).stdout == \
        b"../b.txt\n"


@pytest.mark.asyncio
async def test_ln_s_target_directory_flag_links_every_operand():
    ws = _ws()
    await _seed_ln(ws)
    r = await ws.shell("ln -s -t /data/d /data/a.txt /data/b.txt")
    assert r.exit_code == 0
    assert (await ws.shell("readlink /data/d/a.txt")).stdout == \
        b"/data/a.txt\n"
    assert (await ws.shell("readlink /data/d/b.txt")).stdout == \
        b"/data/b.txt\n"
    r = await ws.shell("ln -s /data/a.txt /data/b.txt /data/e")
    assert r.exit_code == 0
    assert (await ws.shell("readlink /data/e/b.txt")).stdout == \
        b"/data/b.txt\n"


@pytest.mark.asyncio
async def test_ln_s_single_operand_links_into_the_cwd():
    ws = _ws()
    await _seed_ln(ws)
    r = await ws.shell("cd /data/d && ln -s ../a.txt && readlink a.txt")
    assert r.exit_code == 0
    assert r.stdout == b"../a.txt\n"
    r = await ws.shell("cd /data/d && ln -s ../a.txt")
    assert r.exit_code == 1
    assert (r.stderr or b"") == \
        b"ln: failed to create symbolic link './a.txt': File exists\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stderr",
    [
        ("ln -s -t /data/nodir /data/a.txt",
         "ln: failed to access '/data/nodir': No such file or directory\n"),
        ("ln -s -t /data/b.txt /data/a.txt",
         "ln: target '/data/b.txt' is not a directory\n"),
        ("ln -s -t /data/d -T /data/a.txt",
         "ln: cannot combine --target-directory and "
         "--no-target-directory\n"),
        ("ln -s /data/a.txt /data/b.txt /data/nodir",
         "ln: target '/data/nodir': No such file or directory\n"),
        ("ln -s /data/a.txt /data/d/x /data/b.txt",
         "ln: target '/data/b.txt': Not a directory\n"),
        ("ln -sT /data/a.txt /data/d",
         "ln: failed to create symbolic link '/data/d': File exists\n"),
        ("ln -sT /data/a.txt /data/b.txt /data/c",
         "ln: extra operand '/data/c'\n"
         "Try 'ln --help' for more information.\n"),
        ("ln -sT /data/a.txt",
         "ln: missing destination file operand after '/data/a.txt'\n"
         "Try 'ln --help' for more information.\n"),
        ("ln", "ln: missing file operand\n"
         "Try 'ln --help' for more information.\n"),
        ("ln -x /data/a.txt /data/l", "ln: invalid option -- 'x'\n"
         "Try 'ln --help' for more information.\n"),
        ("ln --bogus /data/a.txt /data/l",
         "ln: unrecognized option '--bogus'\n"
         "Try 'ln --help' for more information.\n"),
        ("ln -s --backup=bogus /data/a.txt /data/l",
         "ln: invalid argument 'bogus' for 'backup type'\n"
         "Valid arguments are:\n"
         "  - 'none', 'off'\n"
         "  - 'simple', 'never'\n"
         "  - 'existing', 'nil'\n"
         "  - 'numbered', 't'\n"
         "Try 'ln --help' for more information.\n"),
        ("ln /data/missing /data/h",
         "ln: failed to access '/data/missing': No such file or directory\n"),
        ("ln /data/d /data/hd",
         "ln: /data/d: hard link not allowed for directory\n"),
        ("ln -d /data/d /data/hd",
         "ln: failed to create hard link '/data/hd' => '/data/d': "
         "Operation not permitted\n"),
        ("ln -F /data/d /data/hd",
         "ln: failed to create hard link '/data/hd' => '/data/d': "
         "Operation not permitted\n"),
    ],
)
async def test_ln_refuses_in_gnu_words(line, stderr):
    ws = _ws()
    await _seed_ln(ws)
    r = await ws.shell(line)
    assert r.exit_code == 1
    assert (r.stderr or b"").decode() == stderr


@pytest.mark.asyncio
async def test_ln_sb_moves_the_occupant_aside():
    ws = _ws()
    await _seed_ln(ws)
    await ws.shell("ln -s /data/a.txt /data/l")
    r = await ws.shell("ln -sbv /data/b.txt /data/l")
    assert r.exit_code == 0
    assert r.stdout == b"'/data/l~' ~ '/data/l' -> '/data/b.txt'\n"
    assert (await ws.shell("readlink /data/l")).stdout == b"/data/b.txt\n"
    assert (await ws.shell("readlink /data/l~")).stdout == b"/data/a.txt\n"
    r = await ws.shell("ln -s -S .bak /data/a.txt /data/b.txt")
    assert r.exit_code == 0
    assert (await ws.shell("cat /data/b.txt.bak")).stdout == b"yo\n"
    assert (await ws.shell("readlink /data/b.txt")).stdout == \
        b"/data/a.txt\n"


@pytest.mark.asyncio
async def test_ln_numbered_backups_and_backup_none():
    ws = _ws()
    await _seed_ln(ws)
    await ws.shell("echo n > /data/l")
    r = await ws.shell("ln -s --backup=numbered /data/a.txt /data/l")
    assert r.exit_code == 0
    assert (await ws.shell("cat '/data/l.~1~'")).stdout == b"n\n"
    r = await ws.shell("ln -s --backup=none /data/b.txt /data/l")
    assert r.exit_code == 1
    assert (r.stderr or b"") == \
        b"ln: failed to create symbolic link '/data/l': File exists\n"


@pytest.mark.asyncio
async def test_ln_s_dereferences_a_link_to_a_directory_unless_n():
    ws = _ws()
    await _seed_ln(ws)
    await ws.shell("ln -s /data/d /data/dl")
    assert (await ws.shell("ln -s /data/a.txt /data/dl")).exit_code == 0
    assert (await ws.shell("readlink /data/d/a.txt")).stdout == \
        b"/data/a.txt\n"
    r = await ws.shell("ln -sn /data/b.txt /data/dl")
    assert r.exit_code == 1
    assert (r.stderr or b"") == \
        b"ln: failed to create symbolic link '/data/dl': File exists\n"
    assert (await ws.shell("ln -sfn /data/b.txt /data/dl")).exit_code == 0
    assert (await ws.shell("readlink /data/dl")).stdout == b"/data/b.txt\n"
    for line in ("ln -sL /data/a.txt /data/l1", "ln -sP /data/a.txt /data/l2",
                 "ln -sd /data/a.txt /data/l3"):
        assert (await ws.shell(line)).exit_code == 0


@pytest.mark.asyncio
async def test_ln_hard_copies_bytes_and_refuses_an_occupied_name():
    ws = _ws()
    await _seed_ln(ws)
    r = await ws.shell("ln -v /data/a.txt /data/h")
    assert r.exit_code == 0
    assert r.stdout == b"'/data/h' => '/data/a.txt'\n"
    assert (await ws.shell("cat /data/h")).stdout == b"hi\n"
    r = await ws.shell("ln /data/b.txt /data/h")
    assert r.exit_code == 1
    assert (r.stderr or b"") == \
        b"ln: failed to create hard link '/data/h': File exists\n"
    assert (await ws.shell("ln -f /data/b.txt /data/h")).exit_code == 0
    assert (await ws.shell("cat /data/h")).stdout == b"yo\n"
    r = await ws.shell("ln -bv /data/a.txt /data/h")
    assert r.stdout == b"'/data/h~' ~ '/data/h' => '/data/a.txt'\n"
    assert (await ws.shell("cat /data/h~")).stdout == b"yo\n"
    assert (await
            ws.shell("ln -t /data/e /data/a.txt /data/b.txt")).exit_code == 0
    assert (await ws.shell("cat /data/e/b.txt")).stdout == b"yo\n"
    r = await ws.shell("ln /data/missing /data/a.txt /data/d")
    assert r.exit_code == 1
    assert (await ws.shell("cat /data/d/a.txt")).stdout == b"hi\n"


@pytest.mark.asyncio
async def test_ln_hard_of_a_link_keeps_the_link_unless_L():
    ws = _ws()
    await _seed_ln(ws)
    await ws.shell("ln -s /data/a.txt /data/lnk")
    assert (await ws.shell("ln /data/lnk /data/h1")).exit_code == 0
    assert (await ws.shell("readlink /data/h1")).stdout == b"/data/a.txt\n"
    assert (await ws.shell("ln -L /data/lnk /data/h2")).exit_code == 0
    assert (await ws.shell("readlink /data/h2")).exit_code == 1
    assert (await ws.shell("cat /data/h2")).stdout == b"hi\n"
    await ws.shell("ln -s /data/nope /data/dang")
    r = await ws.shell("ln -L /data/dang /data/h3")
    assert r.exit_code == 1
    assert (r.stderr or b"") == \
        b"ln: failed to access '/data/dang': No such file or directory\n"
    assert (await ws.shell("ln /data/dang /data/h4")).exit_code == 0
    assert (await ws.shell("readlink /data/h4")).stdout == b"/data/nope\n"


@pytest.mark.asyncio
async def test_ln_last_of_logical_and_physical_wins():
    ws = _ws()
    await _seed_ln(ws)
    await ws.shell("ln -s /data/a.txt /data/lnk")
    assert (await ws.shell("ln -LP /data/lnk /data/hp")).exit_code == 0
    assert (await ws.shell("readlink /data/hp")).stdout == b"/data/a.txt\n"
    assert (await ws.shell("ln -PL /data/lnk /data/hl")).exit_code == 0
    assert (await ws.shell("readlink /data/hl")).exit_code == 1
    assert (await ws.shell("cat /data/hl")).stdout == b"hi\n"
    r = await ws.shell("ln --logical --physical /data/lnk /data/hp2")
    assert r.exit_code == 0
    assert (await ws.shell("readlink /data/hp2")).stdout == b"/data/a.txt\n"


@pytest.mark.asyncio
async def test_ln_relative_needs_symbolic_after_the_operand_count():
    ws = _ws()
    await _seed_ln(ws)
    r = await ws.shell("ln -r /data/a.txt /data/rel")
    assert r.exit_code == 1
    assert r.stderr == b"ln: cannot do --relative without --symbolic\n"
    assert (await ws.shell("test -e /data/rel")).exit_code == 1
    r = await ws.shell("ln -r")
    assert r.stderr == (b"ln: missing file operand\n"
                        b"Try 'ln --help' for more information.\n")
    r = await ws.shell("ln -r -T -t /data/d /data/a.txt /data/x")
    assert r.stderr == b"ln: cannot do --relative without --symbolic\n"
    r = await ws.shell("ln -T -t /data/d")
    assert r.stderr == (b"ln: missing file operand\n"
                        b"Try 'ln --help' for more information.\n")
    assert (await ws.shell("ln -rs /data/a.txt /data/d/rel")).exit_code == 0
    assert (await ws.shell("readlink /data/d/rel")).stdout == b"../a.txt\n"
