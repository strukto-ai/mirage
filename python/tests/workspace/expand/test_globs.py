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
from unittest.mock import MagicMock, patch

from mirage.cache.index import RAMIndexCacheStore
from mirage.resource.ram import RAMResource
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace.expand.globs import resolve_globs


def _mock_registry(resolve_result=None):
    mount = MagicMock()
    mount.prefix = "/data/"

    async def _resolve_glob(scopes, prefix=""):
        if resolve_result is not None:
            return resolve_result
        return scopes

    mount.resource = MagicMock()
    mount.resource.resolve_glob = _resolve_glob

    reg = MagicMock()
    reg.mount_for = MagicMock(return_value=mount)
    return reg


def _run(coro):
    return asyncio.run(coro)


def test_text_passes_through():
    reg = _mock_registry()
    classified = ["grep", "pattern"]
    result = _run(resolve_globs(classified, reg))
    assert result == ["grep", "pattern"]


def test_pathspec_without_pattern_preserved():
    reg = _mock_registry()
    ps = PathSpec(resource_path="data/file.txt",
                  virtual="/data/file.txt",
                  directory="/data/",
                  resolved=True)
    classified = ["cat", ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert result[0] == "cat"
    assert isinstance(result[1], PathSpec)
    assert result[1] is ps


def test_glob_pathspec_resolved_to_pathspec():
    resolved_ps = PathSpec(
        resource_path=mount_key("/data/a.txt", "/data"),
        virtual="/data/a.txt",
        directory="/data/",
        resolved=True,
    )
    reg = _mock_registry(resolve_result=[resolved_ps])
    glob_ps = PathSpec(
        resource_path="data/*.txt",
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    classified = ["cat", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert result[0] == "cat"
    assert isinstance(result[1], PathSpec)
    assert result[1] is resolved_ps


def test_glob_multiple_matches_expand():
    matches = [
        PathSpec(resource_path="data/a.txt",
                 virtual="/data/a.txt",
                 directory="/data/",
                 resolved=True),
        PathSpec(resource_path="data/b.txt",
                 virtual="/data/b.txt",
                 directory="/data/",
                 resolved=True),
    ]
    reg = _mock_registry(resolve_result=matches)
    glob_ps = PathSpec(
        resource_path="data/*.txt",
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    classified = ["ls", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 3
    assert result[0] == "ls"
    assert all(isinstance(r, PathSpec) for r in result[1:])
    assert result[1].virtual == "/data/a.txt"
    assert result[2].virtual == "/data/b.txt"


def test_glob_string_result_wrapped_in_pathspec():
    reg = _mock_registry(resolve_result=["/a.txt"])
    glob_ps = PathSpec(
        resource_path="data/*.txt",
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    classified = ["cat", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert isinstance(result[1], PathSpec)
    assert result[1].virtual == "/data/a.txt"


def test_glob_no_match_returns_original_pathspec():
    reg = _mock_registry(resolve_result=[])
    glob_ps = PathSpec(
        resource_path="data/*.xyz",
        virtual="/data/*.xyz",
        directory="/data/",
        pattern="*.xyz",
        resolved=False,
    )
    classified = ["cat", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 1
    assert result[0] == "cat"


def test_text_args_skip_glob_resolution():
    reg = _mock_registry()
    glob_ps = PathSpec(
        resource_path="data/*.txt",
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    classified = ["grep", glob_ps]
    result = _run(resolve_globs(classified, reg, text_args={"/data/*.txt"}))
    assert len(result) == 2
    assert result[0] == "grep"
    assert result[1] == "/data/*.txt"
    assert isinstance(result[1], str)


def test_mixed_text_and_pathspec():
    reg = _mock_registry()
    ps = PathSpec(resource_path="data/file.txt",
                  virtual="/data/file.txt",
                  directory="/data/",
                  resolved=True)
    classified = ["grep", "-i", "pattern", ps]
    result = _run(resolve_globs(classified, reg))
    assert result[0] == "grep"
    assert result[1] == "-i"
    assert result[2] == "pattern"
    assert isinstance(result[3], PathSpec)
    assert result[3] is ps


def test_resolve_error_returns_original_pathspec():
    reg = _mock_registry()
    reg.mount_for = MagicMock(side_effect=ValueError("no mount"))
    glob_ps = PathSpec(
        resource_path="unknown/*.txt",
        virtual="/unknown/*.txt",
        directory="/unknown/",
        pattern="*.txt",
        resolved=False,
    )
    classified = ["cat", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert isinstance(result[1], PathSpec)


def test_pathspec_dir_carries_pattern():
    ps = PathSpec(
        resource_path=mount_key("/data/*.txt", "/data"),
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    d = ps.dir
    assert d.virtual == "/data/"
    assert d.pattern == "*.txt"
    assert d.resource_path == ""


def test_pathspec_dir_no_pattern():
    ps = PathSpec(
        resource_path="data/file.txt",
        virtual="/data/file.txt",
        directory="/data/",
        resolved=True,
    )
    d = ps.dir
    assert d.virtual == "/data/"
    assert d.pattern is None


def test_scope_error_truncates_instead_of_crash():
    from mirage.core.ram.glob import resolve_glob as ram_resolve_glob

    resource = RAMResource()
    for i in range(20):
        resource._store.files[f"/f{i:02d}.txt"] = b""
    resource._store.dirs.add("/")
    index = RAMIndexCacheStore()
    glob_ps = PathSpec(
        resource_path="*.txt",
        virtual="/*.txt",
        directory="/",
        pattern="*.txt",
        resolved=False,
    )

    async def _run():
        with patch("mirage.core.ram.glob.SCOPE_ERROR", 5):
            result = await ram_resolve_glob(resource.accessor, [glob_ps],
                                            index)
        return result

    result = asyncio.run(_run())
    assert len(result) == 5
