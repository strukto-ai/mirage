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
"""Tests for find's action flags (-delete, -print0, -ls).

Per-resource find handlers only emit matched paths. The dispatcher
(`mirage/workspace/executor/find_action_dispatch.py:_apply_find_actions`)
reads the parsed action flags and applies the corresponding side
effect or output reformat.
"""
import asyncio
import re

import pytest

from mirage.policy import Deny, Policy
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.executor.find_action_dispatch import depth_first_key


def _ws() -> Workspace:
    return Workspace({"/": RAMResource()}, mode=MountMode.WRITE)


def _ws_two_mounts() -> Workspace:
    return Workspace({
        "/a": (RAMResource(), MountMode.WRITE),
        "/b": (RAMResource(), MountMode.WRITE),
    })


def _run(coro):
    return asyncio.run(coro)


async def _setup_html_files(ws: Workspace) -> None:
    ws.create_session("s")
    await ws.execute("mkdir -p /a/b", session_id="s")
    await ws.execute("touch /foo.html /bar.htm /a/b/baz.html", session_id="s")


# ── -delete ────────────────────────────────────────────────────


def test_delete_removes_matched_files() -> None:

    async def _go():
        ws = _ws()
        await _setup_html_files(ws)
        r = await ws.execute("find / -name '*.html' -delete", session_id="s")
        assert r.exit_code == 0
        assert await r.stdout_str() == ""
        assert await r.stderr_str() == ""
        # html files gone
        check = await ws.execute("find / -name '*.html'", session_id="s")
        assert await check.stdout_str() == ""
        # htm preserved
        htm = await ws.execute("find / -name '*.htm'", session_id="s")
        assert "/bar.htm" in await htm.stdout_str()

    _run(_go())


def test_delete_silent_unless_print() -> None:

    async def _go():
        ws = _ws()
        await _setup_html_files(ws)
        r = await ws.execute("find / -name '*.html' -delete", session_id="s")
        assert await r.stdout_str() == ""

    _run(_go())


def test_delete_with_print_emits_matches() -> None:

    async def _go():
        ws = _ws()
        await _setup_html_files(ws)
        r = await ws.execute("find / -name '*.html' -print -delete",
                             session_id="s")
        out = await r.stdout_str()
        assert "/foo.html" in out
        assert "/a/b/baz.html" in out

    _run(_go())


def test_delete_skips_mount_roots() -> None:
    # A mount root in the match set must not be unlinked: mounts
    # are structural metadata.
    async def _go():
        ws = _ws_two_mounts()
        ws.create_session("s")
        await ws.execute("touch /a/x.html /b/y.html", session_id="s")
        # Force mount roots into the match set via -type d, then
        # -delete must skip them while still listing them in find.
        # Without a -name pattern the synthetic /a and /b appear.
        await ws.execute("find / -type d -delete", session_id="s")
        # Mount roots survive (delete may report errors for other
        # dir entries, that's fine).
        ls = await ws.execute("ls /", session_id="s")
        out = await ls.stdout_str()
        assert "a" in out
        assert "b" in out

    _run(_go())


def test_delete_deepest_first() -> None:
    # Children deleted before parents so non-empty-dir errors
    # don't fire.
    async def _go():
        ws = _ws()
        ws.create_session("s")
        await ws.execute("mkdir -p /tmp/a/b", session_id="s")
        await ws.execute("touch /tmp/a/b/file.txt", session_id="s")
        r = await ws.execute("find /tmp -name '*.txt' -delete", session_id="s")
        assert r.exit_code == 0

    _run(_go())


# ── -print0 ────────────────────────────────────────────────────


def test_print0_separates_with_nul() -> None:

    async def _go():
        ws = _ws()
        await _setup_html_files(ws)
        r = await ws.execute("find / -name '*.html' -print0", session_id="s")
        out = await r.stdout_str()
        assert "\x00" in out
        assert "\n" not in out.replace("\x00", "")
        assert out.endswith("\x00")

    _run(_go())


# ── -ls ────────────────────────────────────────────────────────


def test_ls_renders_finds_own_layout_per_match() -> None:
    # GNU findutils 4.10 `-ls` is not `ls -l`: inode and 1K blocks lead,
    # and every column has a fixed width (inode 9, blocks 6, links 3,
    # owner and group 8 left-aligned, size 8). A VFS has neither an
    # inode nor a block allocation, so those two columns carry `?`, the
    # answer `stat %i` and `%b` already give.
    async def _go():
        ws = _ws()
        await _setup_html_files(ws)
        r = await ws.execute("find / -name '*.html' -ls", session_id="s")
        out = await r.stdout_str()
        lines = [ln for ln in out.split("\n") if ln]
        assert len(lines) >= 2
        for line in lines:
            assert re.fullmatch(
                r"        \?      \? -rw-r--r--   1 -        -        "
                r" {7}\d [A-Z][a-z]{2} [ \d]\d \d\d:\d\d /.*\.html",
                line), line

    _run(_go())


# ── default behavior unchanged ─────────────────────────────────


def test_no_action_flag_unchanged() -> None:
    # find without action flags must behave as before.
    async def _go():
        ws = _ws()
        await _setup_html_files(ws)
        r = await ws.execute("find / -name '*.html'", session_id="s")
        out = await r.stdout_str()
        assert "/foo.html" in out
        assert "/a/b/baz.html" in out
        assert "\x00" not in out

    _run(_go())


# ── synthetic mount entries honor -name ───────────────────────


def test_mount_entries_filtered_by_name() -> None:
    # Without -type filter, mount roots are synthesized as dir
    # entries. -name must still apply to those entries so user
    # intent ("find files matching X") isn't overridden by
    # spurious mount listings.
    async def _go():
        ws = _ws_two_mounts()
        ws.create_session("s")
        # /a and /b are mounts; -name 'a' should match only /a.
        r = await ws.execute("find / -name 'a' -type d", session_id="s")
        lines = (await r.stdout_str()).strip().split("\n")
        assert "/a" in lines
        assert "/b" not in lines

    _run(_go())


def test_delete_removes_emptied_directories() -> None:

    async def _go():
        ws = _ws()
        ws.create_session("s")
        await ws.execute("mkdir -p /tree/deep", session_id="s")
        await ws.execute("touch /tree/deep/f.txt", session_id="s")
        r = await ws.execute("find /tree -delete", session_id="s")
        assert r.exit_code == 0
        assert await r.stderr_str() == ""
        check = await ws.execute("find / -name tree", session_id="s")
        assert await check.stdout_str() == ""
        await ws.close()

    _run(_go())


# ── -exec ──────────────────────────────────────────────────


async def _exec_ws() -> Workspace:
    ws = _ws()
    ws.create_session("s")
    await ws.execute(
        "mkdir -p /w/d/sub; printf 'a\\n' > /w/d/a.txt; "
        "printf 'bb\\n' > /w/d/b.txt; printf x > /w/d/sub/c.txt; cd /w",
        session_id="s")
    return ws


async def _run_line(ws: Workspace, line: str) -> tuple[str, str, int]:
    r = await ws.execute(line, session_id="s")
    return await r.stdout_str(), await r.stderr_str(), r.exit_code


@pytest.mark.asyncio
@pytest.mark.parametrize("line,stdout,stderr,code", [
    (r'find d -name "*.txt" -exec echo got {} \;',
     "got d/a.txt\ngot d/b.txt\ngot d/sub/c.txt\n", "", 0),
    ('find d -name "*.txt" -exec echo got {} +',
     "got d/a.txt d/b.txt d/sub/c.txt\n", "", 0),
    (r'find d -name "*.txt" -exec false \;', "", "", 0),
    ('find d -name "*.txt" -exec false {} +', "", "", 1),
    (r'find d -name "*.txt" -exec false \; -print', "", "", 0),
    (r'find d -name "*.txt" -exec echo {} \; -print',
     "d/a.txt\nd/a.txt\nd/b.txt\nd/b.txt\nd/sub/c.txt\nd/sub/c.txt\n", "", 0),
    (r'find d -name "*.txt" -exec nosuchcmd {} \;', "",
     "find: 'nosuchcmd': No such file or directory\n" * 3, 0),
    (r'find d -name "*.txt" -exec echo x{}y \;',
     "xd/a.txty\nxd/b.txty\nxd/sub/c.txty\n", "", 0),
    (r'find d -name "*.txt" -exec echo pre {} \; -exec echo post {} \;',
     "pre d/a.txt\npost d/a.txt\npre d/b.txt\npost d/b.txt\n"
     "pre d/sub/c.txt\npost d/sub/c.txt\n", "", 0),
    (r'find d -name "*.txt" -exec echo "a b" {} \;',
     "a b d/a.txt\na b d/b.txt\na b d/sub/c.txt\n", "", 0),
    ('find d -name "*.txt" -exec sh -c "echo err >&2; exit 3" {} +', "",
     "err\n", 1),
    (r'find d -name "*.txt" -exec echo {} \; -exec false \; -print',
     "d/a.txt\nd/b.txt\nd/sub/c.txt\n", "", 0),
    (r'find d -name "*.txt" -exec grep -q x {} \; -print', "d/sub/c.txt\n", "",
     0),
    ('find d -name "*.txt" -exec echo {} + -print',
     "d/a.txt\nd/b.txt\nd/sub/c.txt\nd/a.txt d/b.txt d/sub/c.txt\n", "", 0),
    ('find d -name nomatch -exec echo batch {} +', "", "", 0),
    ('find d \\( -name a.txt -o -name b.txt \\) -exec echo {} \\;',
     "d/a.txt\nd/b.txt\n", "", 0),
    (r'find -name a.txt -exec echo {} \;', "./d/a.txt\n", "", 0),
    (r'find /w/d -name b.txt -exec echo abs {} \;', "abs /w/d/b.txt\n", "", 0),
])
async def test_exec_matches_gnu(line, stdout, stderr, code):
    # Pinned against GNU findutils on debian:stable-slim.
    ws = await _exec_ws()
    assert await _run_line(ws, line) == (stdout, stderr, code)


@pytest.mark.asyncio
async def test_exec_with_print0_interleaves():
    ws = await _exec_ws()
    out, _, code = await _run_line(
        ws, r'find d -name a.txt -exec echo {} \; -print0')
    assert out == "d/a.txt\nd/a.txt\0"
    assert code == 0


@pytest.mark.asyncio
async def test_exec_then_delete_removes_accepted_rows():
    ws = await _exec_ws()
    out, err, code = await _run_line(
        ws, r'find d -name "*.txt" -exec cat {} \; -delete')
    assert (out, err, code) == ("a\nbb\nx", "", 0)
    listing, _, _ = await _run_line(ws, "find d -type f")
    assert listing == ""


@pytest.mark.asyncio
async def test_delete_runs_at_its_position():
    # GNU: the row is gone before the next action sees it, so cat fails,
    # its failure ends the chain, and -print never fires.
    ws = await _exec_ws()
    out, err, code = await _run_line(
        ws, r'find d -type f -delete -exec cat {} \; -print')
    assert (out, err,
            code) == ("", "cat: d/a.txt: No such file or directory\n"
                      "cat: d/b.txt: No such file or directory\n"
                      "cat: d/sub/c.txt: No such file or directory\n", 0)
    listing, _, _ = await _run_line(ws, "find d -type f")
    assert listing == ""


@pytest.mark.asyncio
async def test_delete_orders_a_directory_after_its_contents():
    # -delete implies -depth, so every action runs in that order.
    ws = await _exec_ws()
    out, err, code = await _run_line(
        ws, r'find d -exec echo saw {} \; -delete -print')
    assert (out, err, code) == (
        "saw d/a.txt\nd/a.txt\nsaw d/b.txt\nd/b.txt\nsaw d/sub/c.txt\n"
        "d/sub/c.txt\nsaw d/sub\nd/sub\nsaw d\nd\n", "", 0)
    assert await _run_line(ws, "test -e d") == ("", "", 1)


@pytest.mark.asyncio
async def test_depth_reorders_the_implicit_print():
    ws = await _exec_ws()
    post = "d/a.txt\nd/b.txt\nd/sub/c.txt\nd/sub\nd\n"
    assert await _run_line(ws, "find d -depth") == (post, "", 0)
    assert await _run_line(ws, "find d -depth -print") == (post, "", 0)
    assert await _run_line(
        ws, "find d") == ("d\nd/a.txt\nd/b.txt\nd/sub\nd/sub/c.txt\n", "", 0)


@pytest.mark.asyncio
async def test_depth_orders_each_start_point_on_its_own():
    # GNU findutils 4.10 walks each start point to completion, so
    # `find b a -depth` is b's tree post-order, then a's: one sort over
    # every row put a's tree first, and -delete removed in that order.
    ws = await _exec_ws()
    await ws.execute("mkdir -p b a; printf x > b/x; printf y > a/y",
                     session_id="s")
    assert await _run_line(ws,
                           "find b a -depth") == ("b/x\nb\na/y\na\n", "", 0)
    assert await _run_line(
        ws, "find b a -depth -print -delete") == ("b/x\nb\na/y\na\n", "", 0)
    assert await _run_line(ws, "test -e a -o -e b") == ("", "", 1)


@pytest.mark.asyncio
async def test_depth_walks_a_nested_or_repeated_start_point_on_its_own():
    # GNU findutils 4.10 finishes `d` before it begins `d/sub` again, and
    # walks a repeated start point twice; the rows arrive as one run per
    # start point, so no sort can fold the two traversals together.
    ws = await _exec_ws()
    post = "d/a.txt\nd/b.txt\nd/sub/c.txt\nd/sub\nd\n"
    assert await _run_line(
        ws,
        "find d d/sub -depth -print") == (post + "d/sub/c.txt\nd/sub\n", "", 0)
    assert await _run_line(ws, "find d d -depth") == (post + post, "", 0)
    assert await _run_line(
        ws, "find d d/sub -depth -exec echo saw {} \\;") == ("".join(
            f"saw {r}\n"
            for r in (post + "d/sub/c.txt\nd/sub\n").split()), "", 0)


@pytest.mark.asyncio
async def test_ls_escapes_the_name_as_findutils_does():
    # GNU findutils 4.10 `-ls` keeps one row on one line: a space, a
    # backslash and a double quote take a backslash, a newline is `\n`,
    # and a byte outside ASCII is octal; `-print` stays raw.
    ws = await _exec_ws()
    await ws.execute(
        "touch 'd/a b' 'd/c\\d' 'd/e\"f' \"d/n\nl\" 'd/ü'; "
        "ln -s 'a b' 'd/li nk'",
        session_id="s")
    out, err, code = await _run_line(ws, "find d -mindepth 1 -ls | sort")
    assert (err, code) == ("", 0)
    names = sorted(
        re.sub(r"^.*? \d\d:\d\d ", "", row) for row in out.splitlines())
    assert names == sorted([
        "d/a.txt", "d/a\\ b", "d/b.txt", "d/c\\\\d", 'd/e\\"f',
        "d/li\\ nk -> a\\ b", "d/n\\nl", "d/sub", "d/sub/c.txt", "d/\\303\\274"
    ])
    assert await _run_line(ws, "find d -name 'a b'") == ("d/a b\n", "", 0)


@pytest.mark.asyncio
async def test_depth_orders_a_trailing_slash_start_point_after_its_tree():
    # `find d/` prints its root as `d/` and the rest as `d/a`; the slash
    # left an empty final component that sorted the directory first, so
    # `find d/ -delete` refused the non-empty directory and exited 1.
    ws = await _exec_ws()
    assert await _run_line(
        ws, "find d/ -depth") == ("d/a.txt\nd/b.txt\nd/sub/c.txt\nd/sub\nd/\n",
                                  "", 0)
    assert await _run_line(ws, "find d/ -delete") == ("", "", 0)
    assert await _run_line(ws, "test -e d") == ("", "", 1)


def test_depth_first_key_drops_a_trailing_slash():
    assert depth_first_key("d/") == depth_first_key("d")
    assert depth_first_key("d/a") < depth_first_key("d/")
    assert depth_first_key("/a") < depth_first_key("/")


@pytest.mark.asyncio
async def test_delete_failure_ends_the_chain_in_gnus_words():
    ws = await _exec_ws()
    out, err, code = await _run_line(ws, "find d ! -name c.txt -delete -print")
    assert (out, err,
            code) == ("d/a.txt\nd/b.txt\n",
                      "find: cannot delete 'd/sub': Directory not empty\n"
                      "find: cannot delete 'd': Directory not empty\n", 1)
    out, err, code = await _run_line(
        ws, "find d -name c.txt -delete -delete -print")
    assert (out, err, code) == (
        "", "find: cannot delete 'd/sub/c.txt': No such file or directory\n",
        1)


@pytest.mark.asyncio
async def test_exec_line_substitution():
    from mirage.commands.builtin.types import ExecAction
    from mirage.workspace.executor.find_action_dispatch import exec_line
    per = ExecAction(("echo", "x{}y", "{}"), batch=False)
    assert exec_line(per, ["a b"]) == "echo 'xa by' 'a b'"
    batch = ExecAction(("echo", "{}", "tail"), batch=True)
    assert exec_line(batch, ["a", "b c"]) == "echo a 'b c' tail"


MUTATE = "sh -c 'echo \"$KEEP:$PWD\"; KEEP=child; cd /'"
MUTATE_EXIT = "sh -c 'KEEP=child; cd /; exit 7'"
BATCH = "sh -c 'KEEP=child; cd /; set -- child; set -u'"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action,terminator",
    [(action, r"\;")
     for action in ("sh -c 'cd /'", "sh -c 'unset KEEP'",
                    "sh -c 'export KEEP=child'", "sh -c 'set -- child'",
                    "sh -c 'set -u'", MUTATE, MUTATE_EXIT)] +
    [(action, '{} +') for action in (BATCH, MUTATE, MUTATE_EXIT)])
async def test_exec_isolates_each_invocation(action, terminator):
    # The mutating programs are `sh -c` lines: GNU's -exec sees no shell
    # function, so a function head would not run at all.
    ws = await _exec_ws()
    try:
        await ws.execute('KEEP=parent; set -- original', session_id='s')
        io = await ws.execute(
            f'find d -name "*.txt" -exec {action} {terminator}; '
            'echo "$KEEP:$PWD:$1"; echo "${UNSET_FOR_TEST}"',
            session_id='s')
        out = await io.stdout_str()
        assert out.endswith('parent:/w:original\n\n')
        if action == MUTATE and terminator == '\\;':
            assert out == 'parent:/w\n' * 3 + 'parent:/w:original\n\n'
        assert await io.stderr_str() == ''
        assert io.exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_exec_child_exit_127_is_not_a_missing_command():
    ws = await _exec_ws()
    try:
        out, err, code = await _run_line(
            ws,
            "find d -maxdepth 0 -exec sh -c 'echo ownerr >&2; exit 127' \\;"
            "; echo rc=$?")
        assert (out, err, code) == ('rc=0\n', 'ownerr\n', 0)
        out, err, code = await _run_line(
            ws, 'find d -maxdepth 0 -exec nosuchcmd {} \\; ; echo rc=$?')
        assert (out, err,
                code) == ('rc=0\n',
                          "find: 'nosuchcmd': No such file or directory\n", 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("action",
                         ['-exec touch marker \\;', '-print', '-delete'])
async def test_find_refuses_a_test_after_an_action_before_side_effects(action):
    ws = await _exec_ws()
    try:
        out, err, code = await _run_line(
            ws, f"find d {action} -name '*.txt' -print")
        assert (out, err, code) == (
            '', 'find: -name: tests after actions are not supported\n', 1)
        out, err, code = await _run_line(
            ws, 'test ! -e marker && test -e d/a.txt')
        assert code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("nested", [False, True])
@pytest.mark.parametrize("action",
                         ["-exec rm {} \\;", "-exec rm {} +", "-delete"])
async def test_actions_preserve_newline_paths_and_unrelated_files(
        nested, action):
    mounts = {"/": RAMResource()}
    if nested:
        mounts["/d/nested\nmount"] = RAMResource()
    ws = Workspace(mounts, mode=MountMode.WRITE)
    root = "d/nested\nmount" if nested else "d"
    await ws.execute(f'mkdir -p "{root}"; touch "{root}/a\nb" b')
    io = await ws.execute(f"find d -type f {action}")
    assert io.exit_code == 0
    assert await io.stderr_str() == ""
    io = await ws.execute(f'test -f b && test ! -e "{root}/a\nb"')
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_print0_preserves_newlines_through_mount_fanout():
    ws = Workspace({
        "/": RAMResource(),
        "/d/nested\nmount": RAMResource()
    },
                   mode=MountMode.WRITE)
    await ws.execute('touch "/d/nested\nmount/a\nb"')
    io = await ws.execute("find /d -print0")
    assert await io.materialize_stdout(
    ) == b"/d\0/d/nested\nmount\0/d/nested\nmount/a\nb\0"
    assert await io.stderr_str() == ""


@pytest.mark.asyncio
async def test_delete_under_or_is_refused_before_any_file_is_removed():
    ws = _ws()
    await ws.execute('mkdir d; touch d/keep d/remove')
    io = await ws.execute('find d -name keep -o -delete')
    assert io.exit_code == 1
    assert "supported only in a top-level" in await io.stderr_str()
    io = await ws.execute('test -f d/keep && test -f d/remove')
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_ls_action_receives_the_whole_newline_path():
    ws = _ws()
    await ws.execute('mkdir d; touch "d/a\nb"')
    io = await ws.execute('find d -type f -ls')
    assert io.exit_code == 0
    assert await io.stderr_str() == ''
    # -ls escapes the newline, as findutils does; the row stays one line.
    assert 'd/a\\nb\n' in await io.stdout_str()


@pytest.mark.asyncio
async def test_a_repeated_print_prints_every_row_twice():
    # GNU runs both actions; one explicit -print is the implicit one.
    ws = await _exec_ws()
    assert await _run_line(
        ws,
        "find d -name a.txt -print -print") == ("d/a.txt\nd/a.txt\n", "", 0)
    assert await _run_line(ws,
                           "find d -name a.txt -print") == ("d/a.txt\n", "", 0)


@pytest.mark.asyncio
async def test_exec_runs_a_slash_head_through_the_loader():
    # bash hands a slash-carrying head to the loader, so a workspace
    # script runs; one that is not there is GNU's execvp line, per
    # match, with find's exit status untouched.
    ws = await _exec_ws()
    await ws.execute("printf '#!/bin/sh\\necho ran $1\\n' > /w/check.sh",
                     session_id="s")
    assert await _run_line(
        ws, r"find d -name a.txt -exec ./check.sh {} \; -print") == (
            "ran d/a.txt\nd/a.txt\n", "", 0)
    assert await _run_line(
        ws, r"find d -name a.txt -exec /w/check.sh {} \;") == ("ran d/a.txt\n",
                                                               "", 0)
    assert await _run_line(
        ws, r"find d -name a.txt -exec ./missing.sh {} \; -print") == (
            "", "find: './missing.sh': No such file or directory\n", 0)


@pytest.mark.asyncio
async def test_ls_renders_a_symlink_row():
    # A symlink is namespace state no backend stat can see, so the
    # delegated ls needs the link view to render the row at all.
    ws = await _exec_ws()
    await ws.execute("ln -s a.txt d/link; ln -s nowhere d/dangling",
                     session_id="s")
    out, err, code = await _run_line(ws, "find d -type l -ls")
    assert (err, code) == ("", 0)
    rows = out.splitlines()
    assert [r.split()[-3:] for r in rows] == [["d/dangling", "->", "nowhere"],
                                              ["d/link", "->", "a.txt"]]
    assert all("lrwxrwxrwx" in r for r in rows)


@pytest.mark.asyncio
async def test_delete_unlinks_a_symlink_through_the_namespace():
    # A symlink row comes from the namespace, which no backend can see,
    # so the removal goes through the op dispatcher the way `rm link`
    # does; the mount's rm would only report the row absent and leave
    # the link in place.
    ws = await _exec_ws()
    await ws.execute("ln -s a.txt d/link; ln -s nowhere d/dangling",
                     session_id="s")
    assert await _run_line(ws, "find d -type l -delete") == ("", "", 0)
    assert await _run_line(ws, "find d -type l") == ("", "", 0)
    assert await _run_line(ws, "cat d/a.txt") == ("a\n", "", 0)
    # An unfiltered -delete meets the link among the backend rows and
    # removes the whole tree, the directory holding it included.
    await ws.execute("ln -s a.txt d/sub/link", session_id="s")
    assert await _run_line(ws, "find d -delete") == ("", "", 0)
    assert await _run_line(
        ws, "find d") == ("", "find: 'd': No such file or directory\n", 1)


@pytest.mark.asyncio
async def test_batched_exec_is_one_invocation_across_mounts():
    # GNU: `-exec ... {} +` collects every start point's matches into one
    # batch; the actions run once at the command boundary, not once per
    # operand's native run.
    ws = _ws_two_mounts()
    ws.create_session("s")
    await ws.execute("touch /a/x.txt /b/y.txt", session_id="s")
    assert await _run_line(
        ws,
        "find /a /b -maxdepth 0 -exec echo batch {} +") == ("batch /a /b\n",
                                                            "", 0)
    assert await _run_line(
        ws, r"find /a /b -type f -exec echo {} \;") == ("/a/x.txt\n/b/y.txt\n",
                                                        "", 0)
    assert await _run_line(ws,
                           "find /a /b -type f -exec echo {} + -print") == (
                               "/a/x.txt\n/b/y.txt\n/a/x.txt /b/y.txt\n", "",
                               0)


@pytest.mark.asyncio
async def test_a_row_ls_cannot_list_ends_its_chain():
    # GNU find 4.9: a row -delete removed is `find: 'd/a.txt': No such
    # file or directory` at -ls, exit 1, and -print never runs for it.
    ws = await _exec_ws()
    assert await _run_line(ws, "find d -type f -delete -ls -print") == (
        "", "find: 'd/a.txt': No such file or directory\n"
        "find: 'd/b.txt': No such file or directory\n"
        "find: 'd/sub/c.txt': No such file or directory\n", 1)
    assert await _run_line(ws, "find d -type f") == ("", "", 0)


@pytest.mark.asyncio
async def test_exec_does_not_see_a_shell_only_builtin():
    # GNU findutils 4.10 finds `echo`, `true`, `printf`, `test` and the
    # like through execvp, since coreutils ships them, and nothing the
    # shell alone defines: `cd`, `export`, `read` are `No such file or
    # directory` per match, exit 0.
    ws = await _exec_ws()
    assert await _run_line(
        ws, "find d -maxdepth 0 -exec cd {} \\;; echo rc=$?") == (
            "rc=0\n", "find: 'cd': No such file or directory\n", 0)
    assert await _run_line(
        ws, "find d -maxdepth 0 -exec export X=1 \\;; find d -maxdepth 0 "
        "-exec echo hi {} \\;") == (
            "hi d\n", "find: 'export': No such file or directory\n", 0)


@pytest.mark.asyncio
async def test_exec_does_not_see_a_shell_function():
    # GNU findutils 4.10 execs the head through execvp, which sees no
    # shell function: `find: 'f': No such file or directory` per match,
    # exit 0, and the function never runs.
    ws = await _exec_ws()
    assert await _run_line(
        ws, "f() { echo BAD; }; find d -maxdepth 0 -exec f {} \\;; echo rc=$?"
    ) == ("rc=0\n", "find: 'f': No such file or directory\n", 0)


@pytest.mark.asyncio
async def test_exec_head_is_substituted_before_the_lookup():
    # GNU substitutes the match into the words and only then execs, so
    # `-exec {} \;` runs each match itself rather than looking up `{}`.
    ws = _ws()
    try:
        io = await ws.execute(
            "mkdir -p /data/fh/s; printf 'echo ran\\n' > /data/fh/s/x; "
            "chmod 700 /data/fh/s/x; cd /data/fh; "
            "find s -type f -exec {} \\; ; echo rc=$?")
        assert await io.stdout_str() == "ran\nrc=0\n"
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_delete_drops_the_rows_node_meta():
    # A chmod that lives in the namespace overlay goes with the row, as
    # it does through `rm`, so a later file at the same name does not
    # inherit the removed one's mode.
    ws = _ws()
    try:
        await ws.execute("mkdir -p /data/m; touch /data/m/f /data/m/d")
        await ws._namespace.set_attrs("/data/m/f", mode=0o600)
        await ws._namespace.set_attrs("/data/m/d", mode=0o700)
        assert ws._namespace.meta_for("/data/m/f") is not None
        io = await ws.execute("find /data/m -name f -delete; echo rc=$?")
        assert await io.stdout_str() == "rc=0\n"
        assert ws._namespace.meta_for("/data/m/f") is None
        assert ws._namespace.meta_for("/data/m/d") is not None
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_exec_runs_a_program_a_function_shadows():
    # execvp never sees a shell function, so `cat(){ ...; }` neither
    # hides the program from find nor runs in its place.
    ws = _ws()
    try:
        io = await ws.execute(
            "mkdir -p /data/sh; printf 'content\\n' > /data/sh/f; "
            "cd /data/sh; "
            "cat() { echo BAD; }; "
            "find . -type f -exec cat {} \\; ; "
            "echo rc=$?")
        assert await io.stdout_str() == "content\nrc=0\n"
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


class _NoRmdir(Policy):

    async def pre_ops(self, ctx):
        if ctx.op == "rmdir":
            return Deny(reason="no rmdir")
        return None


@pytest.mark.asyncio
async def test_delete_admits_a_directory_as_rmdir():
    # A rule that refuses rmdir and allows unlink judges `find emptydir
    # -delete` as it judges `rmdir emptydir`.
    ws = Workspace({"/": RAMResource()},
                   mode=MountMode.WRITE,
                   policies=[_NoRmdir()])
    try:
        io = await ws.execute(
            "mkdir -p /data/rd/e; touch /data/rd/f; "
            "find /data/rd/f -delete; echo rc=$?; "
            "find /data/rd/e -delete; echo rc=$?; test -d /data/rd/e; echo $?")
        assert await io.stdout_str() == "rc=0\nrc=1\n0\n"
        assert "find: cannot delete '/data/rd/e': no rmdir" in (
            await io.stderr_str())
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_exec_children_inherit_finds_stdin():
    # GNU's children inherit find's stdin, and a pipe feeds one reader:
    # the first child takes it and the next reads EOF.
    ws = _ws()
    try:
        io = await ws.execute(
            "mkdir -p /data/fi/d; touch /data/fi/d/a /data/fi/d/b; "
            "cd /data/fi; printf x | find d -maxdepth 0 -exec cat \\; ; "
            "echo rc=$?; printf y | find d -type f -exec cat \\; ; "
            "echo rc=$?; "
            "printf z | find d -maxdepth 0 -exec true \\; -exec cat \\; ; "
            "echo rc=$?; "
            "printf abc | find d -maxdepth 0 -exec head -c 1 \\; "
            "-exec cat \\; ; "
            "echo rc=$?")
        # A child that never reads (`true`) leaves the bytes for the next,
        # and one that reads part (`head -c 1`) leaves the rest.
        assert await io.stdout_str() == "xrc=0\nyrc=0\nzrc=0\nabcrc=0\n"
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_exec_runs_a_program_an_alias_shadows():
    # An alias is as invisible to execvp as a function: the program runs.
    ws = _ws()
    try:
        await ws.execute("shopt -s expand_aliases; alias cat='echo BAD'")
        io = await ws.execute(
            "mkdir -p /data/al; printf 'content\\n' > /data/al/f; "
            "cd /data/al; find . -type f -exec cat {} \\; ; echo rc=$?; "
            "command cat f")
        assert await io.stdout_str() == "content\nrc=0\ncontent\n"
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_exec_child_reads_a_slow_stdin_incrementally():
    # A source that only ever yields its first chunk after a while and
    # never ends must still feed `head -c 1` its byte: the cursor pulls
    # a chunk at a time rather than waiting for EOF.
    from mirage.workspace.executor.find_action_dispatch import _SharedStdin

    async def endless():
        yield b"ab"
        while True:
            await asyncio.sleep(3600)

    shared = _SharedStdin(endless())
    got = []
    async for chunk in shared:
        got.append(chunk)
        if len(got) == 2:
            break
    assert got == [b"a", b"b"]


@pytest.mark.asyncio
async def test_ls_renders_the_stat_find_already_holds():
    # GNU findutils 4.9: a start point is statted when the walk opens and
    # any other row only for a test that needs the inode, so `find d/f
    # -delete -ls` and `find d -name g -size -1k -delete -ls` list the
    # row they removed (exit 0) while `-type f -delete -ls` (pinned in
    # test_a_row_ls_cannot_list_ends_its_chain) reports it gone.
    ws = _ws()
    try:
        io = await ws.execute(
            "mkdir -p /data/dl; touch /data/dl/f /data/dl/g; cd /data; "
            "find dl/f -delete -ls; echo rc=$?; "
            "find dl -name g -size -1k -delete -ls; echo rc=$?; "
            "find dl -type d -delete -ls; echo rc=$?; test -e dl; echo e=$?")
        lines = (await io.stdout_str()).splitlines()
        rows = [
            line for line in lines if line.endswith((" dl/f", " dl/g", " dl"))
        ]
        assert [row.rsplit(" ", 1)[1]
                for row in rows] == ["dl/f", "dl/g", "dl"]
        assert rows[0].split()[2].startswith("-")
        assert rows[2].split()[2].startswith("d")
        assert [line for line in lines if line.startswith(("rc=", "e="))
                ] == ["rc=0", "rc=0", "rc=0", "e=1"]
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_exec_runs_the_head_as_a_program():
    # execvp answers `printf` with coreutils printf, which has no -v: the
    # word is the format (GNU adds a warning about the excess arguments,
    # which mirage's printf does not report). A nested shell the line
    # starts is a shell again, so its printf assigns.
    ws = _ws()
    try:
        io = await ws.execute(
            "mkdir -p /data/fp; touch /data/fp/f; cd /data/fp; "
            "find . -type f -exec printf -v x hi \\; ; echo \"[$x]\"; "
            "find . -type f -exec sh -c 'printf -v y hi; echo \"[$y]\"' \\; ; "
            "printf -v z hi; echo \"[$z]\"")
        assert await io.stdout_str() == "-v[]\n[hi]\n[hi]\n"
        assert await io.stderr_str() == ""
    finally:
        await ws.close()
