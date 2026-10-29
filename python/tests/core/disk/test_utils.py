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
import os
import stat
import threading
from types import SimpleNamespace

import pytest

import mirage.core.disk.utils as disk_utils
from mirage.core.disk.utils import resolve_inside, resolve_inside_sync
from mirage.types import PathSpec


@pytest.fixture
def tree(tmp_path):
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    (root / "lib").mkdir(parents=True)
    (root / "lib" / "a.txt").write_text("a")
    outside.mkdir()
    (outside / "secret.txt").write_text("s")
    (root / "lib64").symlink_to("lib")
    (root / "abs").symlink_to(outside / "secret.txt")
    (root / "dangling").symlink_to("../nope/python3")
    return root


def test_answers_the_host_path_with_no_link_in_it(tree):
    assert (
        resolve_inside_sync(
            tree, PathSpec.from_str_path("/lib/a.txt"), "/lib/a.txt"
        )
        == tree / "lib" / "a.txt"
    )


def test_answers_a_path_past_an_absent_component(tree):
    assert (
        resolve_inside_sync(
            tree, PathSpec.from_str_path("/new/x.txt"), "/new/x.txt"
        )
        == tree / "new" / "x.txt"
    )


def test_refuses_a_directory_link_on_the_way_naming_the_operand(tree):
    with pytest.raises(FileNotFoundError) as caught:
        resolve_inside_sync(
            tree, PathSpec.from_str_path("/data/lib64/a.txt"), "/lib64/a.txt"
        )
    assert caught.value.filename == "/data/lib64/a.txt"


def test_refuses_a_link_out_of_the_root_as_the_leaf(tree):
    with pytest.raises(FileNotFoundError):
        resolve_inside_sync(tree, PathSpec.from_str_path("/abs"), "/abs")


def test_refuses_a_dangling_link(tree):
    with pytest.raises(FileNotFoundError):
        resolve_inside_sync(
            tree, PathSpec.from_str_path("/dangling"), "/dangling"
        )


def test_still_refuses_a_dotdot_escape(tree):
    with pytest.raises(ValueError, match="escapes root"):
        resolve_inside_sync(
            tree, PathSpec.from_str_path("/../escaped"), "/../escaped"
        )


def test_a_permission_error_names_the_operand_not_the_host(tree):
    locked = tree / "locked"
    locked.mkdir()
    (locked / "f.txt").write_text("x")
    locked.chmod(0)
    try:
        with pytest.raises(PermissionError) as caught:
            resolve_inside_sync(
                tree,
                PathSpec.from_str_path("/data/locked/f.txt"),
                "/locked/f.txt",
            )
    finally:
        locked.chmod(0o755)
    assert caught.value.filename == "/data/locked/f.txt"
    assert str(tree) not in str(caught.value)


@pytest.mark.asyncio
async def test_guard_does_not_block_the_event_loop(tree, monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    original = resolve_inside_sync.__globals__["os"].lstat
    loop_thread = threading.get_ident()

    def blocked_stat(path, *args, **kwargs):
        assert threading.get_ident() != loop_thread
        entered.set()
        assert release.wait(2)
        return original(path, *args, **kwargs)

    monkeypatch.setattr("mirage.core.disk.utils.os.lstat", blocked_stat)
    task = asyncio.create_task(
        resolve_inside(tree, PathSpec.from_str_path("/lib/a.txt"))
    )
    try:
        assert await asyncio.to_thread(entered.wait, 2)
    finally:
        release.set()
    assert await task == tree / "lib/a.txt"


def test_root_alias_is_infrastructure(tree, tmp_path):
    alias = tmp_path / "alias"
    alias.symlink_to(tree)
    assert (
        resolve_inside_sync(alias, PathSpec.from_str_path("/lib/a.txt"))
        == alias / "lib/a.txt"
    )
    with pytest.raises(FileNotFoundError):
        resolve_inside_sync(alias, PathSpec.from_str_path("/lib64/a.txt"))


@pytest.mark.parametrize("key", ["LIB/a.txt", "lib/A.TXT", "LIB/new.txt"])
def test_case_alias_is_absent_even_before_a_missing_child(
    tree, monkeypatch, key
):
    original = resolve_inside_sync.__globals__["os"].lstat

    def folded_stat(path, *args, **kwargs):
        candidate = str(path)
        if candidate.startswith(str(tree)):
            candidate = str(tree) + candidate[len(str(tree)) :].lower()
        return original(candidate, *args, **kwargs)

    monkeypatch.setattr("mirage.core.disk.utils.os.lstat", folded_stat)
    spec = PathSpec.from_str_path("/data/" + key)
    with pytest.raises(FileNotFoundError) as caught:
        resolve_inside_sync(tree, spec, "/" + key)
    assert caught.value.filename == spec.virtual


@pytest.mark.asyncio
async def test_folded_native_names_do_not_rescan_siblings(tree, monkeypatch):
    if not (tree / "LIB").exists():
        return
    original = resolve_inside_sync.__globals__["os"].listdir
    scans = []

    def listing(path):
        scans.append(path)
        return original(path)

    for i in range(40):
        (tree / "lib" / f"file{i}.txt").write_text("x")
    monkeypatch.setattr("mirage.core.disk.utils.os.listdir", listing)
    for i in range(40):
        key = f"/lib/file{i}.txt"
        assert await resolve_inside(
            tree, PathSpec.from_str_path(key)
        ) == tree / key.lstrip("/")
    assert scans == []


@pytest.mark.parametrize("native", ["preserved", "unsupported"])
def test_unproven_native_paths_fall_back_and_refuse_aliases(
    tree, monkeypatch, native
):
    def canonical(path):
        if native == "unsupported":
            raise OSError(errno.ENOTSUP, "unsupported")
        return path

    monkeypatch.setattr("mirage.core.disk.utils.native_realpath", canonical)
    assert (
        resolve_inside_sync(tree, PathSpec.from_str_path("/lib/a.txt"))
        == tree / "lib/a.txt"
    )
    if (tree / "LIB").exists():
        with pytest.raises(FileNotFoundError):
            resolve_inside_sync(tree, PathSpec.from_str_path("/LIB/a.txt"))


def test_native_proof_checks_parent_listing_permission(tree, monkeypatch):
    original = os.scandir

    def denied(path):
        if str(path) == str(tree):
            raise PermissionError(errno.EACCES, "denied")
        return original(path)

    monkeypatch.setattr("mirage.core.disk.utils.os.scandir", denied)
    monkeypatch.setattr("mirage.core.disk.utils.os.listdir", denied)
    with pytest.raises(PermissionError) as caught:
        resolve_inside_sync(tree, PathSpec.from_str_path("/lib/a.txt"))
    assert caught.value.filename == "/lib/a.txt"


@pytest.mark.parametrize(
    "proof",
    [
        "canonical",
        "preserved",
        "wrong_leaf",
        "different_path",
        "symlink",
        "inode",
        "denied",
        "permission",
    ],
)
def test_native_proof_requires_convergence_and_same_nonlink_entry(
    tree, monkeypatch, proof
):
    target = tree / "file.txt"
    target.write_text("x")
    info = os.lstat(target)
    alias = SimpleNamespace(
        st_mode=stat.S_IFLNK if proof == "symlink" else info.st_mode,
        st_ino=info.st_ino + (proof == "inode"),
        st_dev=info.st_dev,
    )
    scans = []
    original = os.listdir

    def listing(path):
        scans.append(path)
        if proof == "permission":
            raise PermissionError(errno.EACCES, "denied")
        return original(path)

    def denied(path):
        raise PermissionError(errno.EACCES, "denied")

    def canonical(path):
        if proof == "denied":
            raise PermissionError(errno.EACCES, "denied")
        if proof == "preserved":
            return path
        if proof == "wrong_leaf":
            return str(tree / "FILE.TXT")
        if proof == "different_path" and path.endswith("File.txt"):
            return str(tree / "other" / "file.txt")
        return str(target)

    monkeypatch.setattr(disk_utils, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(disk_utils, "native_realpath", canonical)
    monkeypatch.setattr(disk_utils.os, "lstat", lambda path: alias)
    monkeypatch.setattr(disk_utils.os, "listdir", listing)
    if proof == "permission":
        monkeypatch.setattr(disk_utils.os, "scandir", denied)
        with pytest.raises(PermissionError):
            disk_utils.exact_name(str(tree), "file.txt", info)
    else:
        assert disk_utils.exact_name(str(tree), "file.txt", info)
    assert len(scans) == (0 if proof == "canonical" else 1)
