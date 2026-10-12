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

import asyncio
import errno

import pytest

from mirage.core.dev.pipe import DevicePipe
from mirage.types import MountMode
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _with_pipe() -> tuple[DevFiles, str]:
    files = DevFiles("owner")
    path, _ = files.allocate_input(DevicePipe(True))
    return files, path[4:]


def test_contains_dev_names_with_or_without_slash():
    files = DevFiles()
    assert "/null" in files
    assert "null" in files
    assert "/zero" in files
    assert "zero" in files
    assert "/other" not in files


def test_synthetic_devices_use_empty_store_placeholders():
    files = DevFiles()
    assert files["/null"] == b""
    assert files["/zero"] == b""
    with pytest.raises(KeyError):
        files["/missing"]


def test_set_on_active_device_is_discarded():
    files = DevFiles()
    files["/null"] = b"overwrite"
    assert files["/null"] == b""
    assert files["/zero"] == b""


def test_delete_tombstones_a_synthetic_device():
    files = DevFiles()
    del files["/null"]
    assert "/null" not in files
    assert list(files.keys()) == ["/zero"]
    assert len(files) == 1
    with pytest.raises(KeyError):
        files["/null"]
    with pytest.raises(KeyError):
        del files["/null"]


def test_set_after_delete_stores_real_bytes():
    files = DevFiles()
    del files["/null"]
    files["/null"] = b"recreated"
    assert "/null" in files
    assert files["/null"] == b"recreated"
    assert list(files.keys()) == ["/zero", "/null"]
    assert len(files) == 2


def test_delete_of_recreated_file_removes_it_again():
    files = DevFiles()
    del files["/null"]
    files["/null"] = b"recreated"
    del files["/null"]
    assert "/null" not in files
    assert list(files.keys()) == ["/zero"]


def test_non_device_names_store_for_real():
    files = DevFiles()
    files["/custom"] = b"bytes"
    assert "/custom" in files
    assert files["/custom"] == b"bytes"
    assert list(files.keys()) == ["/null", "/zero", "/custom"]
    del files["/custom"]
    assert "/custom" not in files


def test_pop_mirrors_delete_semantics():
    files = DevFiles()
    assert files.pop("/null") == b""
    assert "/null" not in files
    assert files.pop("/null", b"gone") == b"gone"
    files["/null"] = b"real"
    assert files.pop("/null") == b"real"
    assert "/null" not in files
    assert files.pop("/missing", None) is None
    assert files.pop("/missing", 42) == 42
    with pytest.raises(KeyError):
        files.pop("/missing")


def test_iterates_synthetic_then_real():
    files = DevFiles()
    assert list(files) == ["/null", "/zero"]
    assert len(files) == 2


def test_dev_store_starts_with_synthetic_files_and_root():
    store = DevStore()
    assert list(store.files.keys()) == ["/null", "/zero"]
    assert "/" in store.dirs
    assert store.modified == {}


def test_pipe_row_has_no_byte_buffer():
    files, key = _with_pipe()
    for access in (
        lambda: files[key],
        lambda: files.get(key),
        lambda: files.__setitem__(key, b"lost"),
    ):
        with pytest.raises(OSError) as caught:
            access()
        assert caught.value.errno == errno.EINVAL
    assert files.state.inputs[key].data == b""


def test_pipe_row_is_listed_and_counted_empty():
    files, key = _with_pipe()
    assert key in files
    assert list(files) == ["/null", "/zero", key]
    assert len(files) == 3
    assert files.items()[-1] == (key, b"")
    assert files.values()[-1] == b""


def test_removing_a_pipe_row_is_eperm_and_keeps_it():
    files, key = _with_pipe()
    for remove in (lambda: files.__delitem__(key), lambda: files.pop(key)):
        with pytest.raises(PermissionError) as caught:
            remove()
        assert caught.value.errno == errno.EPERM
    assert files.pipe_of(key) is not None


def test_descriptor_row_without_a_pipe_keeps_its_bytes():
    files = DevFiles("owner")
    path, allocation = files.allocate_input()
    files.set_input(path, allocation, b"data")
    assert files[path[4:]] == b"data"
    del files[path[4:]]
    assert path[4:] not in files


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        (
            "f() { ls -l /dev/fd | awk 'NR > 1 { print $1, $5, $NF }'; }; "
            "f <(true)",
            "prw------- 0 63\n",
        ),
        (
            "f() { ls -lL \"$1\" | awk '{ print $1, $5 }'; }; f <(true)",
            "prw------- 0\n",
        ),
        (
            "f() { find /dev -type p > /dev/null; echo find=$?; }; f <(true)",
            "find=0\n",
        ),
        (
            "f() { find /dev -type p; find /dev -size -1; }; f <(true)",
            "/dev/fd/63\n/dev/fd/63\n",
        ),
        ("f() { du -a /dev/fd; }; f <(true)", "0\t/dev/fd/63\n0\t/dev/fd\n"),
        (
            'f() { rm "$1"; mv "$1" /dev/x; echo "st=$?"; }; f <(true) 2>&1',
            (
                "rm: cannot remove '/dev/fd/63': Operation not permitted\n"
                "mv: cannot move '/dev/fd/63' to '/dev/x': "
                "Operation not permitted\nst=1\n"
            ),
        ),
    ],
)
async def test_listing_an_open_substitution(command, expected):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(ws.shell(command), 5)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, expected, "")
    finally:
        await ws.close()
