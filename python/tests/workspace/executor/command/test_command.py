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

from mirage.accessor.base import NOOPAccessor
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.io.types import IOResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


@pytest.mark.asyncio
async def test_the_empty_name_routes_nowhere():
    # Its `virtual` is the working directory, here the root mount, which
    # used to make the line span mounts it never names.
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    await ws.shell("echo a > /data/a.txt")
    r = await ws.shell("cd / && cat '' /data/a.txt")
    assert r.exit_code == 1
    assert r.stdout == b"a\n"
    assert r.stderr == b"cat: '': No such file or directory\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,err",
    [
        ("cmp -s", "cmp: missing operand after '-s'\n"),
        ("cmp -n 5 --", "cmp: missing operand after '--'\n"),
        ("diff -u", "diff: missing operand after '-u'\n"),
        ("cd /data && join a.txt -t ,", "join: missing operand after ','\n"),
    ],
)
async def test_a_handler_sees_the_words_the_line_spelled(line, err):
    # The words after the command name reach the handler as typed, which
    # is where GNU's `missing operand after '<word>'` reads its word.
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    await ws.shell("echo a > /data/a.txt")
    r = await ws.shell(line)
    assert (r.stderr or b"").decode().startswith(err)


# jq's --rawfile/--slurpfile are read and curl's -o/-D written through
# the dispatcher, so a file on another mount, or a process substitution
# under /dev, is no cross-mount line (DISPATCH_FLAG_KEYS). Positional
# operands still route.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,out",
    [
        (
            "jq -c -n --slurpfile t /work/t.json "
            "--slurpfile f <(echo '{\"x\":1}') '[$t, $f]'",
            b'[[{"a":1}],[{"x":1}]]\n',
        ),
        (
            "jq -c --slurpfile t /work/t.json '[., $t]' /data/d.json",
            b'[{"b":2},[{"a":1}]]\n',
        ),
        ("cd /work && jq -c -n --rawfile r /data/r.txt '$r'", b'"raw\\n"\n'),
    ],
)
async def test_dispatch_options_route_nothing(line, out):
    ws = Workspace(
        {
            "/data": (RAMVFS(), MountMode.WRITE),
            "/work": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    await ws.shell(
        "echo '{\"a\":1}' > /work/t.json; "
        "echo '{\"b\":2}' > /data/d.json; echo raw > /data/r.txt"
    )
    r = await ws.shell(line)
    assert (r.exit_code, r.stdout, r.stderr or b"") == (0, out, b"")


@pytest.mark.asyncio
async def test_a_cross_mount_sed_in_place_keeps_both_edited_files_cached():
    # The run_sed relay is its own write path, apart from run_dispatch: it
    # claims each -i file, and the line keeps the edited bytes on both
    # mounts, which then serve a cat after the backend changes.
    left, right = RAMVFS(), RAMVFS()
    left.caches_reads = right.caches_reads = True
    left.load_state({"files": {"/f": b"a1\n"}})
    right.load_state({"files": {"/g": b"a2\n"}})
    ws = Workspace({"/a": left, "/b": right}, mode=MountMode.WRITE)
    try:
        result = await ws.shell("sed -i s/a/b/ /a/f /b/g")
        assert result.exit_code == 0
        assert await ws.cache.get("/a/f") == b"b1\n"
        assert await ws.cache.get("/b/g") == b"b2\n"
        left.load_state({"files": {"/f": b"changed\n"}})
        again = await ws.shell("cat /a/f")
        assert await again.materialize_stdout() == b"b1\n"
    finally:
        await ws.close()


# A session that may run egrep runs it, though egrep runs grep.
@pytest.mark.asyncio
async def test_an_allowed_wrapper_runs_without_the_program_it_names():
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    await ws.shell("printf 'a|b\\nx\\n' > /data/e.txt")
    ws.create_session("narrow", profile={"commands": {"allow": ["egrep"]}})
    io = await ws.shell("egrep 'a|x' /data/e.txt", session_id="narrow")
    assert (io.exit_code, io.stdout) == (0, b"a|b\nx\n")
    io = await ws.shell("grep x /data/e.txt", session_id="narrow")
    assert (io.exit_code, io.stderr) == (126, b"grep: Permission denied\n")


@command("egrep", vfs="ram", spec=SPECS["grep"])
async def _own_egrep(accessor=NOOPAccessor(), paths=None, *texts, **_extra):
    return b"own egrep\n", IOResult()


# A mount that registers its own egrep runs it; the wrapper is only the
# fallback for a name no mount registers.
@pytest.mark.asyncio
async def test_a_mounts_own_egrep_runs_ahead_of_the_wrapper():
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    try:
        ws.mount("/data").register_commands([_own_egrep])
        await ws.shell("echo x > /data/e.txt")
        io = await ws.shell("egrep x /data/e.txt")
        assert (io.exit_code, io.stdout) == (0, b"own egrep\n")
        io = await ws.shell("fgrep x /data/e.txt")
        assert (io.exit_code, io.stdout) == (0, b"x\n")
    finally:
        await ws.close()


# egrep -r walks as grep -r does, so a child mount's rule on egrep speaks
# on the ancestor operand.
@pytest.mark.asyncio
async def test_a_recursive_wrapper_meets_a_child_mounts_rule():
    ws = Workspace(
        {
            "/scratch/": (RAMVFS(), MountMode.WRITE),
            "/scratch/child/": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        profiles={
            "default": {
                "mounts": {
                    "/scratch/child": {
                        "commands": {
                            "deny": [
                                {"reason": "boxed", "commands": ["egrep"]}
                            ]
                        }
                    }
                }
            }
        },
    )
    try:
        await ws.shell("echo x > /scratch/a && echo x > /scratch/child/c")
        io = await ws.shell("egrep -r x /scratch")
        assert (io.exit_code, io.stdout, io.stderr) == (
            126,
            b"",
            b"egrep: Permission denied\n",
        )
    finally:
        await ws.close()


# The whole-line gate reads fgrep's words with grep's spec, so its pattern
# is no path, while a file operand still is.
@pytest.mark.asyncio
async def test_a_wrappers_pattern_is_no_path_to_a_path_rule():
    ws = Workspace(
        {
            "/private/": (RAMVFS(), MountMode.WRITE),
            "/public/": (RAMVFS(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        profiles={
            "default": {
                "commands": {
                    "deny": [
                        {
                            "reason": "sealed",
                            "commands": {"fgrep": ["/private/*"]},
                        }
                    ]
                }
            }
        },
    )
    try:
        await ws.shell(
            "echo /private/token > /public/log && echo s > /private/token"
        )
        io = await ws.shell("fgrep '/private/token' /public/log; echo done")
        assert (io.exit_code, io.stdout) == (0, b"/private/token\ndone\n")
        io = await ws.shell("fgrep s /private/token; echo done")
        assert (io.exit_code, io.stdout, io.stderr) == (
            1,
            b"",
            b"fgrep: /private/token: Permission denied\n",
        )
    finally:
        await ws.close()
