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

import functools
import inspect
from collections.abc import Callable
from typing import NamedTuple

import pytest

from mirage.types import Follow, MountMode, PathSpec
from mirage.vfs.call import VfsCall, declared_calls
from mirage.vfs.ram import RAMVFS
from mirage.vfs.types import Effect
from mirage.workspace import Workspace
from mirage.workspace.lookup.constants import changes_files, line_facts


def _follows(words: list[str | PathSpec]) -> Follow:
    return line_facts(str(words[0]), words).follows


@pytest.mark.parametrize(
    "words, follows",
    [
        (["stat", "/data/link"], Follow.NONE),
        (["stat", "-L", "/data/link"], Follow.LAST),
        (["stat", "-Lc", "%n", "/data/link"], Follow.LAST),
        (["stat", "--dereference", "/data/link"], Follow.LAST),
        (["stat", "--deref", "/data/link"], Follow.LAST),
        (["stat", "-c", "%L", "/data/link"], Follow.NONE),
        (["stat", "--", "-L"], Follow.NONE),
        (["rm", "-L", "/data/link"], Follow.NONE),
        (["cat", "-l", "/data/link"], Follow.LAST),
        (["file", "/data/link"], Follow.NONE),
        (["file", "-L", "/data/link"], Follow.LAST),
        (["file", "-h", "/data/link"], Follow.NONE),
        (["file", "-L", "-h", "/data/link"], Follow.NONE),
        (["file", "-h", "-L", "/data/link"], Follow.LAST),
        (["file", "-Lh", "/data/link"], Follow.NONE),
        (["du", "/data/link"], Follow.NONE),
        (["du", "-L", "/data/link"], Follow.LAST),
        (["du", "-LP", "/data/link"], Follow.NONE),
        (["du", "-PL", "/data/link"], Follow.LAST),
        (["du", "-L", "-P", "/data/link"], Follow.NONE),
        (["find", "/data/link"], Follow.NONE),
        (["find", "-H", "/data/link"], Follow.LAST),
        (["find", "-L", "-P", "/data/link"], Follow.NONE),
        (["find", "-P", "-L", "/data/link"], Follow.LAST),
        (["find", "-L", "-P", "-L", "/data/link"], Follow.LAST),
        (["find", "/data/link", "-L"], Follow.NONE),
        (["tar", "-chf", "/out.tar", "/data/link"], Follow.NONE),
        (["zip", "-r", "/out.zip", "/data/link"], Follow.NONE),
        (["mv", "/data/link", "/x"], Follow.NONE),
        (["rmdir", "/data/link"], Follow.NONE),
        (["unlink", "/data/link"], Follow.NONE),
        (["mkdir", "-p", "/data/link"], Follow.NONE),
        (["touch", "/data/link"], Follow.NONE),
        (["ln", "-s", "/x", "/data/link"], Follow.NONE),
        (["readlink", "/data/link"], Follow.NONE),
    ],
)
def test_a_command_follows_a_link_operand_as_its_options_say(words, follows):
    # coreutils 9.7, file 5.46, findutils 4.10: lstat by default for
    # these, the later of -L and its take-back (-h, -P) deciding, and
    # find's -P/-H/-L only before the first start point.
    assert _follows(words) is follows


def test_a_pathspec_operand_is_not_read_as_a_flag():
    """Operands arrive classified as PathSpec, not str."""
    spec = PathSpec.from_str_path("/data/-L")
    assert _follows(["stat", spec]) is Follow.NONE


@pytest.mark.parametrize(
    "words, follows",
    [
        (["ls", "-l", "/data/link"], Follow.NONE),
        (["ls", "-d", "/data/link"], Follow.NONE),
        (["ls", "-la", "/data/link"], Follow.NONE),
        (["ls", "-g", "/data/link"], Follow.NONE),
        (["ls", "-F", "/data/link"], Follow.NONE),
        (["ls", "--cl", "/data/link"], Follow.NONE),
        (["ls", "--indicator-style=classify", "/data/link"], Follow.NONE),
        (["ls", "/data/link"], Follow.DIRECTORY),
        (["ls", "-p", "/data/link"], Follow.DIRECTORY),
        (["ls", "--file-type", "/data/link"], Follow.DIRECTORY),
        (["ls", "--classify=never", "/data/link"], Follow.DIRECTORY),
        (["ls", "-l", "-L", "/data/link"], Follow.LAST),
        (["ls", "-F", "-H", "/data/link"], Follow.LAST),
        (
            [
                "ls",
                "-H",
                "--dereference-command-line-symlink-to-dir",
                "/data/link",
            ],
            Follow.DIRECTORY,
        ),
    ],
)
def test_ls_follows_gnus_command_line_rule(words, follows):
    # coreutils 9.7: the last of -L, -H and
    # --dereference-command-line-symlink-to-dir wins; without one, -d, a
    # long format or the classify style (abbreviated or valued) resolve
    # no command-line link, and anything else resolves a link to a
    # directory. -p and --file-type are not classify.
    assert _follows(words) is follows


@pytest.mark.parametrize(
    "words, walks",
    [
        (["find", "/data"], True),
        (["du", "/data"], True),
        (["du", "-x", "/data"], False),
        (["tree"], True),
        (["tree", "-x", "/data"], False),
        (["rg", "x"], True),
        (["rg", "--one-file-system", "x", "/data"], False),
        (["rg", "--type-list"], False),
        (["grep", "x", "/data"], False),
        (["grep", "-rn", "x", "/data"], True),
        (["grep", "--recursive", "x"], True),
        (["grep", "--recur", "x", "/data"], True),
        (["grep", "-d", "recurse", "x", "/data"], True),
        (["grep", "--directories=recurse", "x", "/data"], True),
        (["grep", "--dereference-recursive", "x", "/data"], True),
        (["grep", "-r", "-d", "skip", "x", "/data"], False),
        (["grep", "-d", "bogus", "x", "/data"], False),
        (["grep", "-ephrase", "/data/x"], False),
        (["grep", "-frules.txt", "/data/x"], False),
        (["grep", "--", "-r"], False),
        (["egrep", "-r", "x"], True),
        (["fgrep", "x", "/data"], False),
        (["ls", "-R", "/data"], True),
        (["ls", "--recur", "/data"], True),
        (["ls", "-l", "/data"], False),
        (["cat", "/data/x"], False),
        (["tar", "-cf", "/out.tar", "/data"], False),
    ],
)
def test_walkers_are_read_off_the_parsed_line(words, walks):
    # grep 3.11, coreutils 9.7: a long option's prefix, -d recurse and an
    # option's attached value read as grep reads them, the last of -r
    # and -d wins, and a -d word grep refuses walks nothing.
    assert line_facts(words[0], words).walks is walks


@pytest.mark.parametrize(
    "words, reads",
    [
        (["tar", "-cf", "/out.tar", "/data"], True),
        (["tar", "cf", "/out.tar", "/data"], True),
        (["tar", "--create", "-f", "/out.tar", "/data"], True),
        (["tar", "-xf", "/out.tar"], False),
        (["zip", "-r", "/out.zip", "/data"], True),
        (["zip", "/out.zip", "/data/a"], False),
        (["cp", "-r", "/data", "/copy"], True),
        (["cp", "-a", "/data", "/copy"], True),
        (["cp", "--archive", "/data", "/copy"], True),
        (["cp", "--recur", "/data", "/copy"], True),
        (["cp", "/data/a", "/copy"], False),
        (["grep", "-r", "x", "/data"], True),
        (["du", "-x", "/data"], True),
        (["tree", "-x", "/data"], True),
        (["rg", "--one-file-system", "x", "/data"], True),
        (["find", "/data"], True),
        (["ls", "-l", "/data"], False),
    ],
)
def test_subtree_readers_cover_the_archivers_and_recursive_copy(words, reads):
    # tar -c (dashless too), zip -r and cp -r or -a read below their
    # operands but stop at a mount boundary, so they read subtrees
    # without walking mounts; a walk kept to one mount still reads its
    # subtree.
    assert line_facts(words[0], words).reads_subtree is reads


@pytest.mark.parametrize(
    "words, writes",
    [
        (["sort", "/data/a"], False),
        (["sort", "-o", "/data/b", "/data/a"], True),
        (["sort", "--out=/data/b", "/data/a"], True),
        (["shuf", "/data/a"], False),
        (["shuf", "-o", "/data/b", "/data/a"], True),
        (["iconv", "-f", "utf-8", "/data/a"], False),
        (["iconv", "-o", "/data/b", "/data/a"], True),
        (["uniq", "/data/a"], False),
        (["uniq", "/data/a", "/data/b"], True),
        (["xxd", "/data/a"], False),
        (["xxd", "-r", "/data/a", "/data/b"], True),
        (["tee"], False),
        (["tee", "/data/a"], True),
        (["mktemp", "-u"], False),
        (["mktemp"], True),
        (["tar", "-tf", "/data/a.tar"], False),
        (["tar", "-xOf", "/data/a.tar"], False),
        (["tar", "-xf", "/data/a.tar"], True),
        (["tar", "cf", "/data/a.tar", "/data/d"], True),
        (["unzip", "-l", "/data/a.zip"], False),
        (["unzip", "-p", "/data/a.zip"], False),
        (["unzip", "/data/a.zip"], True),
        (["gzip"], False),
        (["gzip", "-c", "/data/a"], False),
        (["gzip", "/data/a"], True),
        (["gunzip", "-t", "/data/a.gz"], False),
        (["gunzip", "/data/a.gz"], True),
        (["sed", "-n", "p", "/data/a"], False),
        (["sed", "-i", "s/a/b/", "/data/a"], True),
        (["sed", "w /data/out", "/data/a"], True),
        (["sed", "-e", "s/a/b/w /data/out", "/data/a"], True),
        (["sed", "-f", "/data/script", "/data/a"], True),
        (["sed", "w /data/out\nq q", "/data/a"], True),
        (["awk", "1", "/data/a"], True),
        (["cp", "/data/a", "/data/b"], True),
    ],
)
def test_a_builtin_writes_only_when_its_line_can(words, writes):
    # sed 4.9 opens a w file while it reads the script, before it
    # refuses a later command.
    assert changes_files(words[0], words) is writes


@pytest.mark.parametrize("name", ["uniq", "xxd"])
def test_a_pattern_operand_may_name_the_output(name):
    # The backend expands a pattern after admission, so `uniq /data/p.*`
    # may hand it an input and an output; a quoted name is no pattern.
    pattern = PathSpec(
        "/data/p.*", "/data", "p.*", pattern="p.*", resolved=False
    )
    literal = PathSpec("/data/p[1]", "/data", "p[1]")
    assert changes_files(name, [name, pattern]) is True
    assert changes_files(name, [name, literal]) is False


class _Op(NamedTuple):
    mount: str
    name: str
    effect: Effect
    path: str


def _recording(mount: str, ops: list[_Op]) -> RAMVFS:
    def wrap(name: str, mark: VfsCall) -> Callable:
        base = getattr(RAMVFS, name)

        def note(args: tuple) -> None:
            for arg in args:
                if isinstance(arg, PathSpec):
                    ops.append(_Op(mount, name, mark.effect, arg.virtual))

        if inspect.iscoroutinefunction(base):

            @functools.wraps(base)
            async def call_async(self, *args, **kwargs):
                note(args)
                return await base(self, *args, **kwargs)

            return call_async

        @functools.wraps(base)
        def call(self, *args, **kwargs):
            note(args)
            return base(self, *args, **kwargs)

        return call

    methods = {
        name: wrap(name, mark)
        for name, mark in declared_calls(RAMVFS).items()
        if name in vars(RAMVFS)
    }
    return type("RecordingRAMVFS", (RAMVFS,), methods)()


_READS = frozenset({Effect.READ, Effect.METADATA})

# Commands that stat a link's target without following the link: file
# names a link whose target is gone "broken", and du asks whether its
# operand is there at all before it measures the link itself.
_PROBES_TARGET = frozenset({"file", "du"})


async def _effects(line: str) -> list[_Op]:
    ops: list[_Op] = []
    ws = Workspace(
        {
            "/": _recording("/", ops),
            "/data/inner": _recording("/data/inner", ops),
            "/far": _recording("/far", ops),
        },
        mode=MountMode.WRITE,
    )
    ws.create_session("s")
    try:
        for setup in (
            "mkdir -p /data/sub /out",
            "echo a > /data/a.txt",
            "echo b > /data/sub/b.txt",
            "echo c > /data/inner/c.txt",
            "echo t > /far/t.txt",
            "ln -s /far/t.txt /data/link",
        ):
            await ws.shell(setup, session_id="s")
        ops.clear()
        await ws.shell(line, session_id="s")
        return list(ops)
    finally:
        await ws.close()


# Lines whose declared facts the fact-vs-effect check runs against a
# recording mount. /data/inner is a descendant mount and /data/link
# points into /far, so an op on /data/inner other than a stat of its root
# is a walk and an op on /far is a follow.
_LINES = [
    "stat /data/link",
    "stat -L /data/link",
    "file /data/link",
    "file -L /data/link",
    "file -L -h /data/link",
    "du /data/link",
    "du -L /data/link",
    "du /data",
    "du -x /data",
    "find /data",
    "find /data/link",
    "find -L /data/link",
    "find /data/link -L",
    "tree /data",
    "tree -x /data",
    "grep a /data/a.txt",
    "grep -r a /data",
    "rg a /data",
    "rg --one-file-system a /data",
    "ls /data",
    "ls -R /data",
    "ls -l /data/link",
    "ls -L /data/link",
    "cat /data/link",
    "cp -r /data/sub /out",
    "tar -cf /out/x.tar /data/link",
    "zip /out/x.zip /data/link",
    "rm /data/link",
    "mv /data/link /out/l",
    "unlink /data/link",
]


@pytest.mark.parametrize("line", _LINES)
@pytest.mark.asyncio
async def test_a_lines_facts_cover_what_it_does_to_the_mounts(line):
    words = line.split()
    facts = line_facts(words[0], words)
    ops = await _effects(line)
    if not facts.writes:
        assert [op for op in ops if op.effect not in _READS] == []
    if not facts.walks:
        assert [
            op
            for op in ops
            if op.mount == "/data/inner"
            and (op.name, op.path) != ("stat", "/data/inner")
        ] == []
    if facts.follows is Follow.NONE:
        probes = Effect.METADATA if words[0] in _PROBES_TARGET else None
        assert [
            op for op in ops if op.mount == "/far" and op.effect != probes
        ] == []


@pytest.mark.parametrize(
    "line, mount",
    [
        ("stat -L /data/link", "/far"),
        ("find -L /data/link", "/far"),
        ("du /data", "/data/inner"),
        ("grep -r c /data", "/data/inner"),
    ],
)
@pytest.mark.asyncio
async def test_the_recording_sees_follows_and_walks(line, mount):
    assert any(op.mount == mount for op in await _effects(line))
