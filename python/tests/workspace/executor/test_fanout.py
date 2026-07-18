import asyncio
from types import SimpleNamespace

import pytest

from mirage.io import IOResult
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.executor.fanout import (_adjust_depth_texts,
                                              _fan_out_traversal,
                                              _synthesize_find_mount_entries)


class TraversalMount:

    def __init__(self,
                 prefix: str,
                 output: bytes = b"",
                 exit_code: int = 0,
                 error: Exception | None = None) -> None:
        self.prefix = prefix
        self.output = output
        self.exit_code = exit_code
        self.error = error
        self.command_safeguards = {}

    async def execute_cmd(self, *args, **kwargs):
        if self.error is not None:
            raise self.error
        stderr = b"backend failed\n" if self.exit_code else None
        return self.output, IOResult(exit_code=self.exit_code, stderr=stderr)


class TraversalRegistry:

    def __init__(self, descendants: list[TraversalMount]) -> None:
        self._descendants = descendants

    def descendant_mounts(self, path: str) -> list[TraversalMount]:
        return self._descendants


def _mounts(*prefixes):
    return [SimpleNamespace(prefix=p) for p in prefixes]


def test_synthesize_no_expression_emits_all():
    desc = _mounts("/ram/", "/disk/")
    assert _synthesize_find_mount_entries("/", desc, []) == "/ram\n/disk"


def test_synthesize_positive_name():
    desc = _mounts("/ram/", "/disk/")
    assert _synthesize_find_mount_entries("/", desc,
                                          ["-name", "ram"]) == "/ram"


def test_synthesize_honors_not():
    desc = _mounts("/ram/", "/disk/", "/notes/")
    out = _synthesize_find_mount_entries("/", desc, ["-not", "-name", "ram"])
    assert out == "/disk\n/notes"


def test_synthesize_honors_or():
    desc = _mounts("/ram/", "/disk/", "/notes/")
    out = _synthesize_find_mount_entries(
        "/", desc, ["-name", "ram", "-o", "-name", "disk"])
    assert out == "/ram\n/disk"


def test_synthesize_type_file_excludes_mount_dirs():
    desc = _mounts("/ram/", "/disk/")
    assert _synthesize_find_mount_entries("/", desc, ["-type", "f"]) == ""


def test_synthesize_type_dir_includes_mount_dirs():
    desc = _mounts("/ram/", "/disk/")
    assert _synthesize_find_mount_entries("/", desc,
                                          ["-type", "d"]) == "/ram\n/disk"


def test_synthesize_maxdepth_window():
    desc = _mounts("/ram/", "/a/b/")
    assert _synthesize_find_mount_entries("/", desc,
                                          ["-maxdepth", "1"]) == "/ram"


def test_adjust_depth_texts_reduces_maxdepth_by_delta():
    out = _adjust_depth_texts(["-maxdepth", "3", "-name", "x"], "/",
                              "/data/sub")
    assert out == ["-maxdepth", "1", "-name", "x"]


def test_adjust_depth_texts_clamps_mindepth_at_zero():
    out = _adjust_depth_texts(["-mindepth", "1"], "/", "/data")
    assert out == ["-mindepth", "0"]


def test_adjust_depth_texts_no_depth_tokens_unchanged():
    out = _adjust_depth_texts(["-name", "x", "-o", "-name", "y"], "/", "/data")
    assert out == ["-name", "x", "-o", "-name", "y"]


def test_adjust_depth_texts_same_mount_unchanged():
    assert _adjust_depth_texts(["-maxdepth", "3"], "/data",
                               "/data") == ["-maxdepth", "3"]


def test_maxdepth_applies_to_child_mount_depth_end_to_end():
    parent = RAMResource()
    child = RAMResource()
    child._store.dirs.add("/a")
    child._store.files["/a/b.txt"] = b"deep\n"
    ws = Workspace(resources={
        "/": (parent, MountMode.EXEC),
        "/data/": (child, MountMode.EXEC),
    }, )
    io = asyncio.run(ws.execute("find / -maxdepth 2"))
    out = (io.stdout if isinstance(io.stdout, bytes) else b"").decode()
    assert "/data/a" in out
    assert "/data/a/b.txt" not in out


def test_fanout_preserves_partial_failure_exit_code():
    primary = TraversalMount("/", output=b"root\n")
    child = TraversalMount("/data/", exit_code=1)
    path = PathSpec.from_str_path("/")
    _, io, _ = asyncio.run(
        _fan_out_traversal("tree", [path], [], {}, TraversalRegistry([child]),
                           primary, "/", "tree /", None))
    assert io.exit_code == 1
    assert io.stderr == b"backend failed\n"


def test_fanout_propagates_unexpected_backend_error():
    primary = TraversalMount("/", output=b"root\n")
    child = TraversalMount("/data/", error=RuntimeError("backend exploded"))
    path = PathSpec.from_str_path("/")
    with pytest.raises(RuntimeError, match="backend exploded"):
        asyncio.run(
            _fan_out_traversal("tree", [path], [], {},
                               TraversalRegistry([child]), primary, "/",
                               "tree /", None))
