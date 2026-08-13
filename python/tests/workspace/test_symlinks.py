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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _ws():
    return Workspace({"/data": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_ln_readlink_verbatim():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    r = await ws.execute("ln -s /data/a.txt /data/link.txt")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_ln_relative_target_kept_verbatim():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s a.txt /data/link.txt")
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "a.txt\n"


@pytest.mark.asyncio
async def test_ln_sf_overwrites():
    ws = _ws()
    await ws.execute("echo a > /data/a.txt")
    await ws.execute("echo b > /data/b.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    await ws.execute("ln -s -f /data/b.txt /data/link.txt")
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/b.txt\n"


@pytest.mark.asyncio
async def test_ln_no_force_refuses_existing_link():
    ws = _ws()
    await ws.execute("echo a > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("ln -s /data/a.txt /data/link.txt")
    assert r.exit_code == 1
    assert b"File exists" in r.stderr


@pytest.mark.asyncio
async def test_ln_sr_stores_relative_target():
    ws = _ws()
    await ws.execute("mkdir -p /data/a /data/b")
    await ws.execute("echo hi > /data/a/f.txt")
    r = await ws.execute("ln -sr /data/a/f.txt /data/b/link")
    assert r.exit_code == 0
    assert (await ws.execute("readlink /data/b/link")).stdout.decode() == \
        "../a/f.txt\n"
    # the relative link resolves back to the file
    assert (await ws.execute("cat /data/b/link")).stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_ln_srv_reports_relative_link():
    ws = _ws()
    await ws.execute("mkdir -p /data/a /data/b")
    await ws.execute("echo hi > /data/a/f.txt")
    r = await ws.execute("ln -srv /data/a/f.txt /data/b/link")
    assert r.stdout.decode() == "'/data/b/link' -> '../a/f.txt'\n"


@pytest.mark.asyncio
async def test_ln_sn_and_sT_are_accepted_noops():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    assert (await ws.execute("ln -sn /data/a.txt /data/l1")).exit_code == 0
    assert (await ws.execute("ln -sT /data/a.txt /data/l2")).exit_code == 0
    assert (await ws.execute("readlink /data/l1")).stdout.decode() == \
        "/data/a.txt\n"


@pytest.mark.asyncio
async def test_cd_through_symlink_keeps_the_name_it_was_given():
    # GNU bash 5.2: `cd /data/slink && pwd` prints the link, not the
    # target. The logical name is what the shell reports and what the
    # next `cd ..` acts on; `pwd -P` is how you ask for the target.
    ws = _ws()
    await ws.execute("mkdir -p /data/real")
    await ws.execute("ln -s /data/real /data/slink")
    r = await ws.execute("cd /data/slink && pwd")
    assert r.stdout.decode() == "/data/slink\n"
    r = await ws.execute("cd /data/slink && pwd -P")
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
    await ws.execute("mkdir -p /data/deep/real/sub")
    await ws.execute("ln -s /data/deep/real /data/lk")
    r = await ws.execute(command)
    assert r.exit_code == 0, r.stderr.decode()
    assert r.stdout.decode() == expected


@pytest.mark.asyncio
async def test_pwd_rejects_an_unknown_option():
    ws = _ws()
    r = await ws.execute("pwd -x")
    assert r.exit_code == 2
    assert r.stderr.decode() == ("pwd: -x: invalid option\n"
                                 "pwd: usage: pwd [-LP]\n")


@pytest.mark.asyncio
async def test_pwd_ignores_operands():
    ws = _ws()
    r = await ws.execute("cd /data && pwd extra")
    assert r.exit_code == 0
    assert r.stdout.decode() == "/data\n"


@pytest.mark.asyncio
async def test_logical_cwd_is_not_revalidated():
    # bash never re-checks the logical name: removing the link it was
    # spelled through leaves `pwd` printing it, and only `pwd -P` tells
    # you where you actually are.
    ws = _ws()
    await ws.execute("mkdir -p /data/deep/real")
    await ws.execute("ln -s /data/deep/real /data/lk")
    r = await ws.execute("cd /data/lk && rm /data/lk && pwd && pwd -P")
    assert r.exit_code == 0, r.stderr.decode()
    assert r.stdout.decode() == "/data/lk\n/data/deep/real\n"


@pytest.mark.asyncio
async def test_cdpath_hit_announces_the_spelling_not_the_target():
    # GNU prints the name it selected through $CDPATH even under -P,
    # where the directory it lands on is the link's target.
    ws = _ws()
    await ws.execute("mkdir -p /data/c/t")
    await ws.execute("ln -s /data/c/t /data/c/lnk")
    r = await ws.execute("export CDPATH=/data/c; cd -P lnk; pwd")
    assert r.exit_code == 0, r.stderr.decode()
    assert r.stdout.decode() == "/data/c/lnk\n/data/c/t\n"


@pytest.mark.asyncio
async def test_set_o_rejects_a_name_bash_does_not_have():
    ws = _ws()
    r = await ws.execute("set -o bogusname")
    assert r.exit_code == 2
    assert r.stderr.decode() == "set: bogusname: invalid option name\n"


@pytest.mark.asyncio
async def test_set_o_keeps_what_it_applied_before_the_bad_name():
    # GNU applies left to right and stops at the bad name, so an option
    # named before it stays on and one named after it never lands.
    ws = _ws()
    r = await ws.execute("set -o pipefail -o bogus -o noclobber")
    assert r.exit_code == 2
    session = ws.get_session(ws.default_session_id)
    assert session.shell_options.get("pipefail") is True
    assert "noclobber" not in session.shell_options


@pytest.mark.asyncio
async def test_cd_symlink_loop_is_eloop():
    ws = _ws()
    await ws.execute("ln -s /data/b /data/a")
    await ws.execute("ln -s /data/a /data/b")
    r = await ws.execute("cd /data/a")
    assert r.exit_code == 1
    assert b"Too many levels of symbolic links" in r.stderr


@pytest.mark.asyncio
async def test_symlink_survives_snapshot(tmp_path):
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    target = str(tmp_path / "snap.tar")
    await ws.snapshot(target)
    ws2 = await Workspace.load(target)
    r = await ws2.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_cat_follows_link():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("cat /data/link.txt")
    assert r.exit_code == 0
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_read_follows_midpath_dir_link():
    ws = _ws()
    await ws.execute("mkdir -p /data/real && echo hi > /data/real/f.txt")
    await ws.execute("ln -s /data/real /data/dirlink")
    r = await ws.execute("cat /data/dirlink/f.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_read_follows_relative_target():
    ws = _ws()
    await ws.execute("mkdir -p /data/sub && echo hi > /data/sub/a.txt")
    await ws.execute("ln -s a.txt /data/sub/link.txt")
    r = await ws.execute("cat /data/sub/link.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_write_through_link_updates_target():
    ws = _ws()
    await ws.execute("echo old > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    await ws.execute("echo new > /data/link.txt")
    r = await ws.execute("cat /data/a.txt")
    assert r.stdout.decode() == "new\n"


@pytest.mark.asyncio
async def test_cat_dangling_link_errors_with_typed_name():
    ws = _ws()
    await ws.execute("ln -s /data/missing /data/dangle")
    r = await ws.execute("cat /data/dangle")
    assert r.exit_code == 1
    assert b"/data/dangle" in r.stderr
    assert b"No such file" in r.stderr


@pytest.mark.asyncio
async def test_cat_loop_is_eloop_with_operand():
    ws = _ws()
    await ws.execute("ln -s /data/b /data/a")
    await ws.execute("ln -s /data/a /data/b")
    r = await ws.execute("cat /data/a")
    assert r.exit_code == 1
    assert b"cat: /data/a: Too many levels of symbolic links" in r.stderr


@pytest.mark.asyncio
async def test_ls_lists_links():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("ls /data")
    assert "link.txt" in r.stdout.decode()
    r = await ws.execute("ls -F /data")
    assert "link.txt@" in r.stdout.decode()
    r = await ws.execute("ls -l /data")
    assert "link.txt -> /data/a.txt" in r.stdout.decode()


@pytest.mark.asyncio
async def test_ls_through_dir_link():
    ws = _ws()
    await ws.execute("mkdir -p /data/real && echo hi > /data/real/f.txt")
    await ws.execute("ln -s /data/real /data/dirlink")
    r = await ws.execute("ls /data/dirlink")
    assert r.stdout.decode() == "f.txt\n"


@pytest.mark.asyncio
async def test_rm_removes_link_not_target():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("rm /data/link.txt")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/link.txt")
    assert r.exit_code == 1
    r = await ws.execute("cat /data/a.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_rm_dangling_link():
    ws = _ws()
    await ws.execute("ln -s /data/missing /data/dangle")
    r = await ws.execute("rm /data/dangle")
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_rm_mixed_link_and_file():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt && echo x > /data/b.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("rm /data/link.txt /data/b.txt")
    assert r.exit_code == 0
    r = await ws.execute("ls /data")
    assert r.stdout.decode() == "a.txt\n"


@pytest.mark.asyncio
async def test_rm_target_leaves_link_dangling():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    await ws.execute("rm /data/a.txt")
    r = await ws.execute("readlink /data/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"
    r = await ws.execute("cat /data/link.txt")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_rm_r_purges_links_under_dir():
    ws = _ws()
    await ws.execute("mkdir -p /data/sub && echo hi > /data/sub/f.txt")
    await ws.execute("ln -s /data/sub/f.txt /data/sub/inner")
    r = await ws.execute("rm -r /data/sub")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/sub/inner")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_mv_renames_link_entry():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("mv /data/link.txt /data/renamed.txt")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/renamed.txt")
    assert r.stdout.decode() == "/data/a.txt\n"
    r = await ws.execute("readlink /data/link.txt")
    assert r.exit_code == 1


@pytest.mark.asyncio
async def test_mv_link_into_existing_dir():
    ws = _ws()
    await ws.execute("mkdir -p /data/dir && echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("mv /data/link.txt /data/dir")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/dir/link.txt")
    assert r.stdout.decode() == "/data/a.txt\n"


@pytest.mark.asyncio
async def test_mv_file_onto_link_replaces_entry():
    ws = _ws()
    await ws.execute("echo a > /data/a.txt && echo b > /data/b.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("mv /data/b.txt /data/link.txt")
    assert r.exit_code == 0
    r = await ws.execute("readlink /data/link.txt")
    assert r.exit_code == 1
    r = await ws.execute("cat /data/link.txt")
    assert r.stdout.decode() == "b\n"
    r = await ws.execute("cat /data/a.txt")
    assert r.stdout.decode() == "a\n"


@pytest.mark.asyncio
async def test_cross_mount_link_follow():
    ws = Workspace(
        {
            "/data": (RAMResource(), MountMode.WRITE),
            "/other": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE)
    await ws.execute("echo remote > /other/g.txt")
    await ws.execute("ln -s /other/g.txt /data/xlink")
    r = await ws.execute("cat /data/xlink")
    assert r.stdout.decode() == "remote\n"


@pytest.mark.asyncio
async def test_cp_follows_source_link():
    ws = _ws()
    await ws.execute("echo hi > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("cp /data/link.txt /data/copy.txt")
    assert r.exit_code == 0
    r = await ws.execute("cat /data/copy.txt")
    assert r.stdout.decode() == "hi\n"


@pytest.mark.asyncio
async def test_grep_follows_link():
    ws = _ws()
    await ws.execute("printf 'alpha\\nbeta\\n' > /data/a.txt")
    await ws.execute("ln -s /data/a.txt /data/link.txt")
    r = await ws.execute("grep beta /data/link.txt")
    assert r.exit_code == 0
    assert "beta" in r.stdout.decode()


async def _seeded():
    """A tree with one file link and one directory link."""
    ws = _ws()
    await ws.execute("mkdir -p /data/dir")
    await ws.execute("echo hello > /data/dir/real.txt")
    await ws.execute("ln -s /data/dir/real.txt /data/link.txt")
    await ws.execute("ln -s /data/dir /data/dlink")
    return ws


@pytest.mark.asyncio
async def test_find_lists_symlinks():
    """GNU find reports links; they were invisible to the walk before."""
    ws = await _seeded()
    r = await ws.execute("find /data")
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
    r = await ws.execute("find /data -type l")
    assert r.stdout.decode().splitlines() == ["/data/dlink", "/data/link.txt"]


@pytest.mark.asyncio
async def test_find_type_f_excludes_links():
    """A link is kind 'l', never 'f', matching GNU's default -P."""
    ws = await _seeded()
    r = await ws.execute("find /data -type f")
    assert r.stdout.decode().splitlines() == ["/data/dir/real.txt"]


@pytest.mark.asyncio
async def test_find_type_d_excludes_a_link_to_a_directory():
    ws = await _seeded()
    r = await ws.execute("find /data -type d")
    assert r.stdout.decode().splitlines() == ["/data", "/data/dir"]


@pytest.mark.asyncio
async def test_find_name_matches_a_link():
    ws = await _seeded()
    r = await ws.execute("find /data -name 'link*'")
    assert r.stdout.decode().splitlines() == ["/data/link.txt"]


@pytest.mark.asyncio
async def test_find_does_not_descend_through_a_directory_link():
    """Without -L, GNU reports the link and never walks through it, so
    the target's contents appear once, under the real directory."""
    ws = await _seeded()
    r = await ws.execute("find /data -name real.txt")
    assert r.stdout.decode().splitlines() == ["/data/dir/real.txt"]


@pytest.mark.asyncio
async def test_find_maxdepth_prunes_links_too():
    ws = _ws()
    await ws.execute("mkdir -p /data/sub")
    await ws.execute("ln -s /data/t /data/sub/deep.txt")
    r = await ws.execute("find /data -maxdepth 1")
    assert "/data/sub/deep.txt" not in r.stdout.decode()


@pytest.mark.asyncio
async def test_find_size_compares_the_target_string_length():
    """A link's size is len(target), the way lstat reports it."""
    ws = _ws()
    await ws.execute("ln -s /data/abc /data/l")
    r = await ws.execute("find /data -type l -size -2c")
    assert r.stdout.decode() == ""
    r = await ws.execute("find /data -type l -size +2c")
    assert r.stdout.decode().splitlines() == ["/data/l"]


@pytest.mark.asyncio
async def test_ls_long_renders_a_link_the_way_gnu_does():
    """lrwxrwxrwx, the target string's length as the size, name -> target."""
    ws = await _seeded()
    r = await ws.execute("ls -l /data")
    lines = r.stdout.decode().splitlines()
    link_line = next(x for x in lines if "link.txt" in x)
    assert link_line.startswith("lrwxrwxrwx 1 ")
    assert link_line.endswith("link.txt -> /data/dir/real.txt")
    assert f" {len('/data/dir/real.txt')} " in link_line


@pytest.mark.asyncio
async def test_ls_classify_marks_links_with_an_at_sign():
    ws = await _seeded()
    r = await ws.execute("ls -F /data")
    assert "link.txt@" in r.stdout.decode()


@pytest.mark.asyncio
async def test_stat_reports_the_link_and_dash_l_reports_the_target():
    ws = await _seeded()
    r = await ws.execute("stat /data/link.txt")
    assert "type=symlink" in r.stdout.decode()
    assert f"size={len('/data/dir/real.txt')}" in r.stdout.decode()
    r = await ws.execute("stat -L /data/link.txt")
    assert "type=text" in r.stdout.decode()
    assert "size=6" in r.stdout.decode()


@pytest.mark.asyncio
async def test_stat_format_directives_on_a_link():
    ws = await _seeded()
    r = await ws.execute("stat -c '%F %A' /data/link.txt")
    assert r.stdout.decode().strip() == "symbolic link lrwxrwxrwx"


@pytest.mark.asyncio
async def test_stat_percent_n_renders_the_link_arrow():
    """GNU: ``'name' -> 'target'`` for a link, bare quoted name otherwise."""
    ws = await _seeded()
    r = await ws.execute("stat -c '%N' /data/link.txt")
    assert r.stdout.decode() == "'/data/link.txt' -> '/data/dir/real.txt'\n"
    r = await ws.execute("stat -c '%N' /data/dir/real.txt")
    assert r.stdout.decode() == "'/data/dir/real.txt'\n"
    # %n is the bare name even for a link.
    r = await ws.execute("stat -c '%n' /data/link.txt")
    assert r.stdout.decode() == "/data/link.txt\n"
    # -L reports the target, which is not a link, so no arrow.
    r = await ws.execute("stat -L -c '%N' /data/link.txt")
    assert r.stdout.decode() == "'/data/link.txt'\n"


@pytest.mark.asyncio
async def test_stat_percent_n_arrow_on_a_dangling_link():
    ws = await _dangling()
    r = await ws.execute("stat -c '%N' /data/dangle")
    assert r.stdout.decode() == "'/data/dangle' -> '/data/nope'\n"


@pytest.mark.asyncio
async def test_stat_percent_n_quotes_each_side_on_its_own():
    ws = _ws()
    await ws.execute("echo hi > \"/data/it's\"")
    await ws.execute("ln -s \"/data/it's\" /data/plain")
    r = await ws.execute("stat -c '%N' /data/plain")
    assert r.stdout.decode() == "'/data/plain' -> \"/data/it's\"\n"


@pytest.mark.asyncio
async def test_stat_percent_n_target_holding_shell_metacharacters():
    """A target with an apostrophe next to a live character goes back to
    single quotes, so replaying the line cannot expand ``$c``."""
    ws = _ws()
    await ws.execute("""ln -s "/data/a'b\\$c" /data/meta""")
    r = await ws.execute("stat -c '%N' /data/meta")
    assert r.stdout.decode() == "'/data/meta' -> '/data/a'\\''b$c'\n"


@pytest.mark.asyncio
async def test_stat_percent_n_modifiers_drop_quotes_and_pad_each_side():
    """GNU quotes %N only when the directive carries no modifier, and a
    width or precision applies to the name and the target separately."""
    ws = await _seeded()
    r = await ws.execute("stat -c '[%20N]' /data/link.txt")
    assert r.stdout.decode() == (
        "[      /data/link.txt ->   /data/dir/real.txt]\n")
    r = await ws.execute("stat -c '[%-20N]' /data/link.txt")
    assert r.stdout.decode() == (
        "[/data/link.txt       -> /data/dir/real.txt  ]\n")
    r = await ws.execute("stat -c '[%.6N]' /data/link.txt")
    assert r.stdout.decode() == "[/data/ -> /data/]\n"
    r = await ws.execute("stat -c '[%20N]' /data/dir/real.txt")
    assert r.stdout.decode() == "[  /data/dir/real.txt]\n"


async def _dangling():
    """The seeded tree plus a link whose target does not exist."""
    ws = await _seeded()
    await ws.execute("ln -s /data/nope /data/dangle")
    return ws


@pytest.mark.asyncio
async def test_ls_long_reports_a_link_operand_without_following_it():
    """GNU ls -l names a command-line link, never its target."""
    ws = await _seeded()
    r = await ws.execute("ls -l /data/link.txt")
    assert r.exit_code == 0
    line = r.stdout.decode().strip()
    assert line.startswith("lrwxrwxrwx")
    assert line.endswith("/data/link.txt -> /data/dir/real.txt")


@pytest.mark.asyncio
async def test_ls_long_on_a_dangling_link_succeeds():
    """A broken link used to fail the whole listing with exit 2."""
    ws = await _dangling()
    r = await ws.execute("ls -l /data/dangle")
    assert r.exit_code == 0
    assert not r.stderr
    assert r.stdout.decode().strip().endswith("/data/dangle -> /data/nope")


@pytest.mark.asyncio
async def test_ls_long_on_a_directory_link_shows_the_link():
    """GNU: -l suppresses the command-line dereference bare ls does."""
    ws = await _seeded()
    r = await ws.execute("ls -l /data/dlink")
    assert r.stdout.decode().strip().endswith("/data/dlink -> /data/dir")


@pytest.mark.asyncio
async def test_bare_ls_still_dereferences_a_directory_link():
    """Without -l/-d GNU lists what the link points at."""
    ws = await _seeded()
    r = await ws.execute("ls /data/dlink")
    assert r.stdout.decode() == "real.txt\n"


@pytest.mark.asyncio
async def test_ls_recursive_lists_links_and_does_not_descend_them():
    ws = await _dangling()
    r = await ws.execute("ls -R /data")
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
    r = await ws.execute("readlink -e /data/dangle")
    assert r.exit_code == 1
    assert r.stdout.decode() == ""


@pytest.mark.asyncio
async def test_readlink_f_prints_a_dangling_target():
    """GNU -f only requires the parent, so a broken link still prints."""
    ws = await _dangling()
    r = await ws.execute("readlink -f /data/dangle")
    assert r.exit_code == 0
    assert r.stdout.decode() == "/data/nope\n"


@pytest.mark.asyncio
async def test_readlink_f_fails_when_the_parent_is_missing():
    ws = await _seeded()
    r = await ws.execute("readlink -f /data/missing/x")
    assert r.exit_code == 1
    assert r.stdout.decode() == ""


@pytest.mark.asyncio
async def test_readlink_m_requires_nothing_to_exist():
    ws = await _seeded()
    r = await ws.execute("readlink -m /data/missing/x")
    assert r.exit_code == 0
    assert r.stdout.decode() == "/data/missing/x\n"


@pytest.mark.asyncio
async def test_file_describes_a_link_instead_of_following_it():
    ws = await _seeded()
    r = await ws.execute("file /data/link.txt")
    assert r.stdout.decode() == (
        "/data/link.txt: symbolic link to /data/dir/real.txt\n")


@pytest.mark.asyncio
async def test_file_calls_a_dangling_link_broken():
    ws = await _dangling()
    r = await ws.execute("file /data/dangle")
    assert r.exit_code == 0
    assert r.stdout.decode() == (
        "/data/dangle: broken symbolic link to /data/nope\n")


@pytest.mark.asyncio
async def test_file_keeps_a_relative_target_verbatim():
    """GNU prints the stored target, not a resolved one."""
    ws = _ws()
    await ws.execute("echo world > /data/rel.txt")
    await ws.execute("ln -s rel.txt /data/relative")
    r = await ws.execute("file /data/relative")
    assert r.stdout.decode() == "/data/relative: symbolic link to rel.txt\n"


@pytest.mark.asyncio
async def test_file_dash_l_follows_the_link():
    ws = await _seeded()
    r = await ws.execute("file -L /data/link.txt")
    assert "symbolic link" not in r.stdout.decode()
    assert "text" in r.stdout.decode()


@pytest.mark.asyncio
async def test_file_mime_reports_the_link_inode_type():
    ws = await _seeded()
    r = await ws.execute("file -i /data/link.txt")
    assert r.stdout.decode() == (
        "/data/link.txt: inode/symlink; charset=binary\n")


@pytest.mark.asyncio
async def test_du_a_accounts_for_links():
    """Links were invisible to du; GNU lists one line per link under -a."""
    ws = await _dangling()
    r = await ws.execute("du -a /data")
    listed = [line.split("\t")[1] for line in r.stdout.decode().splitlines()]
    assert "/data/dangle" in listed
    assert "/data/dlink" in listed
    assert "/data/link.txt" in listed


@pytest.mark.asyncio
async def test_du_without_a_omits_link_lines():
    """Links are files: GNU prints a line per directory unless -a."""
    ws = await _dangling()
    r = await ws.execute("du /data")
    listed = [line.split("\t")[1] for line in r.stdout.decode().splitlines()]
    assert listed == ["/data/dir", "/data"]


@pytest.mark.asyncio
async def test_du_sizes_a_link_by_its_target_length():
    """Deliberate divergence: GNU counts blocks (0), mirage counts bytes."""
    ws = await _seeded()
    r = await ws.execute("du /data/link.txt")
    size, name = r.stdout.decode().strip().split("\t")
    assert name == "/data/link.txt"
    assert int(size) == len("/data/dir/real.txt")


@pytest.mark.asyncio
async def test_du_does_not_follow_a_link_operand():
    """GNU du reports the link itself without -L."""
    ws = await _seeded()
    r = await ws.execute("du /data/dlink")
    lines = r.stdout.decode().strip().split("\n")
    assert len(lines) == 1
    assert lines[0].split("\t")[1] == "/data/dlink"


@pytest.mark.asyncio
async def test_du_totals_include_links():
    ws = await _seeded()
    r = await ws.execute("du -s /data")
    total = int(r.stdout.decode().split("\t")[0])
    # hello\n plus both link targets.
    assert total == 6 + len("/data/dir/real.txt") + len("/data/dir")


@pytest.mark.asyncio
async def test_find_dash_l_classifies_a_link_by_its_target():
    ws = _ws()
    await ws.execute("mkdir -p /data/d/sub")
    await ws.execute("echo hello > /data/d/real.txt")
    await ws.execute("echo inner > /data/d/sub/inner.txt")
    await ws.execute("ln -s /data/d/real.txt /data/d/flink")
    await ws.execute("ln -s /data/d/sub /data/d/dlink")
    await ws.execute("ln -s /data/nowhere /data/d/dangle")

    r = await ws.execute("find -L /data/d -type f")
    assert r.stdout.decode().splitlines() == [
        "/data/d/flink",
        "/data/d/real.txt",
        "/data/d/sub/inner.txt",
    ]
    r = await ws.execute("find -L /data/d -type d")
    assert r.stdout.decode().splitlines() == [
        "/data/d",
        "/data/d/dlink",
        "/data/d/sub",
    ]
    # Only a dangling link stays type l under -L.
    r = await ws.execute("find -L /data/d -type l")
    assert r.stdout.decode().splitlines() == ["/data/d/dangle"]


@pytest.mark.asyncio
async def test_find_without_dash_l_reports_every_link_as_l():
    ws = _ws()
    await ws.execute("mkdir -p /data/d/sub")
    await ws.execute("echo hello > /data/d/real.txt")
    await ws.execute("ln -s /data/d/real.txt /data/d/flink")
    await ws.execute("ln -s /data/d/sub /data/d/dlink")
    r = await ws.execute("find /data/d -type l")
    assert r.stdout.decode().splitlines() == [
        "/data/d/dlink",
        "/data/d/flink",
    ]
    r = await ws.execute("find /data/d -type f")
    assert r.stdout.decode().splitlines() == ["/data/d/real.txt"]
