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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


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


def test_ls_emits_long_format_per_match() -> None:

    async def _go():
        ws = _ws()
        await _setup_html_files(ws)
        r = await ws.execute("find / -name '*.html' -ls", session_id="s")
        out = await r.stdout_str()
        # ls -ld output per match: starts with permission bits.
        lines = [ln for ln in out.split("\n") if ln]
        assert len(lines) >= 2
        for line in lines:
            assert line.startswith(("-", "d", "l"))

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
