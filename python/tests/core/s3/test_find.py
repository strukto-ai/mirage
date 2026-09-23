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
from functools import partial

from mirage.accessor.s3 import S3Accessor, S3Config
from mirage.core.s3 import driver as s3_driver
from mirage.core.s3.find import find
from mirage.types import PathSpec


async def _pages_gen(pages):
    for page in pages:
        yield page


class _FakeClient:

    def __init__(self, pages):
        self._pages = pages

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def get_paginator(self, name):
        return self

    def paginate(self, **kwargs):
        return _pages_gen(self._pages)


class _FakeSession:

    def __init__(self, pages):
        self._pages = pages

    def client(self, **kwargs):
        return _FakeClient(self._pages)


def _session_for(pages, config):
    return _FakeSession(pages)


def _spec(vfs_path):
    if vfs_path:
        return PathSpec(virtual="/mnt/" + vfs_path,
                        directory="/mnt/",
                        vfs_path=vfs_path)
    return PathSpec(virtual="/mnt", directory="/", vfs_path="")


def _run_find(monkeypatch, keys, vfs_path="data", **kwargs):
    pages = [{"Contents": [{"Key": key, "Size": size} for key, size in keys]}]
    monkeypatch.setattr(s3_driver, "async_session",
                        partial(_session_for, pages))
    accessor = S3Accessor(S3Config(bucket="b"))
    return asyncio.run(find(accessor, _spec(vfs_path), **kwargs))


def test_find_synthesizes_implicit_dirs(monkeypatch):
    out = _run_find(monkeypatch, [("data/a/b.txt", 3)], type="d")
    assert out == ["/data", "/data/a"]


def test_find_type_f_drops_synthesized_dirs(monkeypatch):
    out = _run_find(monkeypatch, [("data/a/b.txt", 3)], type="f")
    assert out == ["/data/a/b.txt"]


def test_find_orphan_marker_gets_parents(monkeypatch):
    out = _run_find(monkeypatch, [("data/a/b/", 0)], type="d")
    assert out == ["/data", "/data/a", "/data/a/b"]


def test_find_marker_plus_files_no_duplicates(monkeypatch):
    out = _run_find(monkeypatch, [("data/a/", 0), ("data/a/x.txt", 1)],
                    type="d")
    assert out == ["/data", "/data/a"]


def test_find_file_shadowed_by_implicit_dir_emits_once(monkeypatch):
    keys = [("data/a", 1), ("data/a/b.txt", 2)]
    assert _run_find(monkeypatch,
                     keys) == ["/data", "/data/a", "/data/a/b.txt"]
    assert _run_find(monkeypatch, keys, type="d") == ["/data", "/data/a"]
    assert _run_find(monkeypatch, keys,
                     type="f") == ["/data/a", "/data/a/b.txt"]


def test_find_empty_matches_marker_only_start(monkeypatch):
    out = _run_find(monkeypatch, [("data/", 0)], empty=True)
    assert out == ["/data"]


def test_find_empty_rejects_populated_start(monkeypatch):
    out = _run_find(monkeypatch, [("data/x.txt", 3)], empty=True)
    assert out == []


def test_find_empty_still_matches_empty_files(monkeypatch):
    out = _run_find(monkeypatch, [("data/x.txt", 0)], empty=True)
    assert out == ["/data/x.txt"]


def test_find_maxdepth_prunes_synthesized_dirs(monkeypatch):
    out = _run_find(monkeypatch, [("data/a/b/c.txt", 1)], maxdepth=1)
    assert out == ["/data", "/data/a"]


def test_find_name_matches_implicit_dir(monkeypatch):
    out = _run_find(monkeypatch, [("data/logs/x.txt", 1)], name="logs")
    assert out == ["/data/logs"]


def test_find_root_start_synthesizes_to_root(monkeypatch):
    out = _run_find(monkeypatch, [("a/b.txt", 2)], vfs_path="", type="d")
    assert out == ["/", "/a"]
