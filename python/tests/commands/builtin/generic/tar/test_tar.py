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

import gzip
import io
import tarfile

import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _tar(members: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        for name, data in members.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


OK = gzip.compress(_tar({"d/a.txt": b"hello\n", "d/b.txt": b"bee\n"}), mtime=0)


async def _shell(line: str, seed: dict[str, bytes]):
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    for path, data in seed.items():
        await ws.shell(f"tee {path} > /dev/null", stdin=data)
    r = await ws.shell(line)
    return (
        r.exit_code,
        await r.materialize_stdout(),
        await r.materialize_stderr(),
    )


@pytest.mark.asyncio
async def test_lists_the_member_a_cut_short_stream_reaches():
    # The stream holds the first header and no data block: GNU lists the
    # member it reached, then stops there without its child's status
    # (tar 1.35, same bytes).
    r = await _shell("tar -tzf /data/cut.tgz", {"/data/cut.tgz": OK[:-40]})
    assert r == (
        2,
        b"d/a.txt\n",
        b"\ngzip: stdin: unexpected end of file\n"
        b"tar: Unexpected EOF in archive\n"
        b"tar: Error is not recoverable: exiting now\n",
    )


@pytest.mark.asyncio
async def test_stdout_archive_needs_no_writable_root_and_does_not_create_dash():
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.READ)
    await ws.shell("printf hello > /data/a")
    result = await ws.shell("tar -cvf - -C /data a | tar -xOf -")
    assert result.exit_code == 0
    assert await result.materialize_stdout() == b"hello"
    assert await result.materialize_stderr() == b"a\n"
    assert (await ws.shell("test ! -e /-")).exit_code == 0
    await ws.close()


SEEDED = "cd /data && printf '1\\n' > a; printf '2\\n' > b; "


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        pytest.param(
            "printf 'a\\n\\nb\\n' > l; printf 'a\\0b\\0' > n; tar -cf o.tar "
            "-T l; tar -tf o.tar; tar -cf n.tar --null -T n; tar -tf n."
            "tar",
            (0, b"a\nb\na\nb\n", b""),
            id="names_lists",
        ),
        pytest.param(
            "printf 'a\\n' > x; tar -cf o.tar -X x a b; tar -tf o.tar",
            (0, b"b\n", b""),
            id="exclude_list",
        ),
        pytest.param(
            "tar -cf o.tar -X nope a; echo rc=$?; wc -c < o.tar",
            (
                0,
                b"rc=2\n0\n",
                (
                    b"tar: nope: No such file or directory\ntar: Er"
                    b"ror is not recoverable: exiting now\n"
                ),
            ),
            id="unreadable_exclude_list",
        ),
        pytest.param(
            "tar -caf o.tgz a; tar -tzf o.tgz",
            (0, b"a\n", b""),
            id="codec_from_suffix",
        ),
        pytest.param(
            "touch -d 2001-02-03T04:05:06Z a; chmod 640 a; tar -cf o.ta"
            "r a; tar -tvf o.tar | cut -c1-10; tar -tvf o.tar | grep -c"
            " '2001-02-03 04:05 a'; tar --mtime=@0 -cf m.tar a; tar -tv"
            "f m.tar | grep -c '1970-01-01 00:00 a'",
            (0, b"-rw-r-----\n1\n1\n", b""),
            id="records_time_and_mode",
        ),
        pytest.param(
            "tar -cf o.tar a; tar -rf o.tar b; tar -tf o.tar; tar --del"
            "ete -f o.tar a; tar -tf o.tar",
            (0, b"a\nb\nb\n", b""),
            id="append_and_delete",
        ),
        pytest.param(
            "tar -cf o.tar a; echo KEEP > a; tar -xkf o.tar; echo rc=$?"
            "; cat a; tar --skip-old-files -xf o.tar; echo rc=$?; cat a",
            (
                0,
                b"rc=2\nKEEP\nrc=0\nKEEP\n",
                (
                    b"tar: a: Cannot open: File exists\ntar: Exitin"
                    b"g with failure status due to previous errors"
                    b"\n"
                ),
            ),
            id="keep_and_skip_old_files",
        ),
        pytest.param(
            "tar -cf o.tar a; mkdir o; tar -C o --transform=s/a/z/ -xf "
            "o.tar; ls o",
            (0, b"z\n", b""),
            id="transform",
        ),
        pytest.param(
            "mkdir .git; echo 1 > .git/c; tar --exclude-vcs -cf o.tar ."
            "git a; tar -tf o.tar",
            (0, b"a\n", b""),
            id="exclude_vcs",
        ),
    ],
)
@pytest.mark.asyncio
async def test_tar_options_behave_as_pinned(
    line: str, expected: tuple[int, bytes, bytes]
) -> None:
    assert await _shell(SEEDED + line, {}) == expected


async def _mounted(line: str) -> tuple[int, bytes, bytes]:
    ws = Workspace(
        {"/data": RAMVFS(), "/m": RAMVFS()},
        mode=MountMode.WRITE,
    )
    try:
        r = await ws.shell(line)
        return (
            r.exit_code,
            await r.materialize_stdout(),
            await r.materialize_stderr(),
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mount_root_on_a_names_list_is_refused_like_an_operand():
    line = "cd /data; printf '/m\\n' > l; tar -cf o.tar -T l; echo rc=$?"
    assert await _mounted(line) == (
        0,
        b"rc=2\n",
        b"tar: /m: Cannot open: Device or resource busy\n"
        b"tar: Error is not recoverable: exiting now\n",
    )
