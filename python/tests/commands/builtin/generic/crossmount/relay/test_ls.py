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

from mirage.commands.builtin.generic.crossmount.relay.ls import run_ls
from mirage.ops.types import MountView, NamespaceView
from mirage.types import ContentType, FileStat, FileType, PathSpec

# Two mounts, /a/ and /b/, as a plain virtual-path tree. The relayed
# primitives route by full virtual path, so one table stands for both,
# and readdir answers in full paths the way a backend's does.
TREE = {
    "/a": ["/a/one", "/a/z.txt"],
    "/a/one": ["/a/one/x.txt"],
    "/b": ["/b/two"],
    "/b/two": ["/b/two/y.txt"],
}


class Calls:

    def __init__(self):
        self.readdir: list[str] = []
        self.stat: list[str] = []
        self.indexes: list[object] = []


def make_dispatch(calls: Calls, roots: frozenset[str] = frozenset()):
    """A dispatcher over TREE that records what it was asked.

    Args:
        calls (Calls): Recorder the returned dispatcher appends to.
        roots (frozenset[str]): Paths that are another mount's root, and
            so answer stat with that mount's own name for itself.
    """

    async def dispatch(name: str, path: PathSpec, **kwargs: object):
        virtual = path.virtual.rstrip("/") or "/"
        if name == "readdir":
            calls.readdir.append(virtual)
            calls.indexes.append(kwargs.get("index"))
            if virtual not in TREE:
                raise NotADirectoryError(errno.ENOTDIR, "Not a directory",
                                         virtual)
            return list(TREE[virtual]), None
        calls.stat.append(virtual)
        calls.indexes.append(kwargs.get("index"))
        is_dir = virtual in TREE
        own = "/" if virtual in roots else virtual.rsplit("/", 1)[-1]
        return FileStat(name=own,
                        size=0 if is_dir else 3,
                        type=FileType.DIRECTORY if is_dir else FileType.FILE,
                        content=None if is_dir else ContentType.TEXT,
                        mode=0o755 if is_dir else 0o644), None

    return dispatch


def scope(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual[:virtual.rfind("/") + 1],
                    vfs_path=virtual.lstrip("/"),
                    resolved=True)


def run(scopes, flags=None, ns=None, roots=frozenset()):
    calls = Calls()
    out, io = asyncio.run(
        run_ls([scope(s) for s in scopes], flags or {},
               make_dispatch(calls, roots), ns))
    return out.decode(), io, calls


def test_operands_on_different_mounts_are_headed_and_sorted_together():
    # GNU: `ls a b` names each directory, sorted, blank line between.
    out, io, _ = run(["/a/one", "/b/two"])
    assert out == "/a/one:\nx.txt\n\n/b/two:\ny.txt\n"
    assert io.exit_code == 0


def test_command_line_order_does_not_survive_the_global_sort():
    # GNU prints `ls b a` identically to `ls a b`.
    assert run(["/b", "/a"])[0] == run(["/a", "/b"])[0]
    assert run(["/a", "/b"])[0] == "/a:\none\nz.txt\n\n/b:\ntwo\n"


def test_a_file_operand_prints_first_unheaded():
    out, _, _ = run(["/b/two", "/a/z.txt"])
    assert out == "/a/z.txt\n\n/b/two:\ny.txt\n"


def test_the_callers_index_is_never_relayed_to_another_mount():
    # An index belongs to one mount, so operand A's index cannot answer
    # for mount B; the relayed op consults its own mount's index.
    _, _, calls = run(["/a", "/b"])
    assert calls.readdir == ["/a", "/b"]
    assert all(i is None for i in calls.indexes)


def test_the_namespace_attr_overlay_still_reaches_the_rows():
    # A naive relay would report the raw backend mode and silently lose
    # a chmod the namespace holds.
    def overlay(virtual: str, st: FileStat) -> FileStat:
        if virtual != "/a/z.txt":
            return st
        return st.model_copy(update={"mode": 0o600})

    out, _, _ = run(["/a", "/b"],
                    flags={"args_l": True},
                    ns=NamespaceView(stat_overlay=overlay))
    assert "-rw-------" in out
    assert out.count("-rw-------") == 1


def test_a_missing_namespace_lists_the_same_names():
    assert run(["/a", "/b"], ns=None)[0] == run(["/a", "/b"],
                                                ns=NamespaceView())[0]


def test_recursive_interleaves_each_operands_subtree():
    out, _, _ = run(["/a", "/b"], flags={"recursive": True})
    assert out == ("/a:\none\nz.txt\n\n/a/one:\nx.txt\n\n"
                   "/b:\ntwo\n\n/b/two:\ny.txt\n")


def test_list_dir_prints_bare_rows_with_no_headers():
    assert run(["/a", "/b"], flags={"directory": True})[0] == "/a\n/b\n"


def test_a_lone_operand_still_reaches_the_generic_unheaded():
    # run_ls is only reached for multi-mount lines, but the generic's
    # own rule is operand count, so a single operand must stay bare.
    assert run(["/a/one"])[0] == "x.txt\n"


def test_a_nested_mount_root_keeps_the_name_its_parent_lists_it_by():
    # A mount answers its own root with its own name for it ("/"), so a
    # relayed stat that crossed the boundary has to be renamed from the
    # path it was asked about. Left alone the row renders as "/", and -R
    # then descends into "/a" + "/" -- which is /a again, unbounded.
    nested = frozenset({"/a/one"})
    assert run(["/a", "/b"], roots=nested)[0] == run(["/a", "/b"])[0]
    out, _, _ = run(["/a", "/b"], flags={"recursive": True}, roots=nested)
    assert out == ("/a:\none\nz.txt\n\n/a/one:\nx.txt\n\n"
                   "/b:\ntwo\n\n/b/two:\ny.txt\n")


def test_a_full_namespace_does_not_stop_the_relay_at_a_mount_root():
    """The mount table names the boundaries a walk's readdir cannot
    cross, and a relayed one crosses them: readdir and stat route per
    path. Handed the whole namespace -- which is what the workspace
    offers -- the relay must still descend `/a/one` and render its
    group, because nothing runs behind a relay to contribute it the way
    the fan-out does for a single-mount run.
    """
    nested = frozenset({"/a/one"})
    ns = NamespaceView(mounts=MountView(
        descendants=lambda p: [],
        visible_descendants=lambda p: [],
        is_root=lambda p: p.rstrip("/") in nested,
        root_of=lambda p: "/"),
                       child_mounts=lambda p: ["one"] if p == "/a" else [])
    out, io, _ = run(["/a", "/b"],
                     flags={"recursive": True},
                     ns=ns,
                     roots=nested)
    assert io.exit_code == 0
    assert out == ("/a:\none\nz.txt\n\n/a/one:\nx.txt\n\n"
                   "/b:\ntwo\n\n/b/two:\ny.txt\n")


def test_each_operand_is_listed_once():
    # Relaying replaces a native run per operand; it must not turn into
    # a listing per operand per mount.
    _, _, calls = run(["/a", "/b"])
    assert calls.readdir == ["/a", "/b"]
