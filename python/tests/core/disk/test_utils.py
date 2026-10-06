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
import threading

import pytest

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
