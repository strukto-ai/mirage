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
import re

from mirage.accessor.gridfs import GridFSAccessor, GridFSConfig
from mirage.core.gridfs import driver as gridfs_driver
from mirage.core.gridfs.client import prefix_query
from mirage.core.gridfs.driver import build_query, glob_regex
from mirage.core.gridfs.find import find
from mirage.types import PathSpec


def _matches(query_regex: dict, value: str) -> bool:
    flags = re.I if query_regex.get("$options") == "i" else 0
    return re.search(query_regex["$regex"], value, flags) is not None


def test_glob_regex_star_stays_within_segment():
    rx = glob_regex("*.csv")
    assert rx is not None
    assert re.fullmatch(rx, "b.csv")
    assert not re.fullmatch(rx, "sub/b.csv")


def test_glob_regex_question_mark():
    rx = glob_regex("a?.txt")
    assert rx is not None
    assert re.fullmatch(rx, "ab.txt")
    assert not re.fullmatch(rx, "a.txt")


def test_glob_regex_escapes_literals():
    rx = glob_regex("a+b.txt")
    assert rx is not None
    assert re.fullmatch(rx, "a+b.txt")
    assert not re.fullmatch(rx, "aab.txt")


def test_glob_regex_bails_on_char_class():
    assert glob_regex("[ab].txt") is None


def test_build_query_prefix_only():
    query = build_query("data/", None, None, None, None, None, True)
    assert query == {"filename": {"$regex": "^" + re.escape("data/")}}


def test_build_query_name_matches_files_and_markers():
    query = build_query("data/", "*.csv", None, None, None, None, True)
    name_cond = query["$and"][1]["filename"]
    assert _matches(name_cond, "data/b.csv")
    assert _matches(name_cond, "data/sub/deep.csv")
    assert _matches(name_cond, "data/sub.csv/")
    assert not _matches(name_cond, "data/b.txt")


def test_build_query_iname_case_insensitive():
    query = build_query("", None, "*.CSV", None, None, None, True)
    name_cond = query["filename"]
    assert name_cond["$options"] == "i"
    assert _matches(name_cond, "b.csv")


def test_build_query_type_conditions():
    files_only = build_query("", None, None, "f", None, None, True)
    assert files_only == {"filename": {"$not": {"$regex": "/$"}}}
    dirs_only = build_query("", None, None, "d", None, None, True)
    assert dirs_only == {"filename": {"$regex": "/$"}}


def test_build_query_size_lets_markers_through():
    query = build_query("", None, None, None, 1, 100, True)
    branches = query["$or"]
    assert {"length": {"$gte": 1, "$lte": 100}} in branches
    assert {"filename": {"$regex": "/$"}} in branches


def test_build_query_no_pushdown_keeps_prefix_only():
    query = build_query("data/", "*.csv", None, "f", 1, 100, False)
    assert query == {"filename": {"$regex": "^" + re.escape("data/")}}


def test_build_query_unpushable_glob_falls_back_to_prefix():
    query = build_query("data/", "[ab].csv", None, None, None, None, True)
    assert query == {"filename": {"$regex": "^" + re.escape("data/")}}


async def _docs_gen(docs):
    for doc in docs:
        yield doc


class _FakeIterLatest:

    def __init__(self, docs):
        self.docs = docs
        self.queries = []

    def __call__(self, accessor, query):
        self.queries.append(query)
        return _docs_gen(self.docs)


def _run_find(monkeypatch, docs, **kwargs):
    fake = _FakeIterLatest([{
        "filename": filename,
        "length": length
    } for filename, length in docs])
    monkeypatch.setattr(gridfs_driver, "iter_latest", fake)
    accessor = GridFSAccessor(
        GridFSConfig(uri="mongodb://localhost:27017", database="db"))
    spec = PathSpec(virtual="/mnt/data", directory="/mnt/", vfs_path="data")
    out = asyncio.run(find(accessor, spec, **kwargs))
    return out, fake.queries


def test_find_synthesizes_implicit_dirs_without_narrowing(monkeypatch):
    out, queries = _run_find(monkeypatch, [("data/a/b.txt", 3)], type="d")
    assert out == ["/data", "/data/a"]
    assert queries == [prefix_query("data/")]


def test_find_name_without_type_scans_prefix_only(monkeypatch):
    out, queries = _run_find(monkeypatch, [("data/logs/x.txt", 1)],
                             name="logs")
    assert out == ["/data/logs"]
    assert queries == [prefix_query("data/")]


def test_find_type_f_keeps_pushdown(monkeypatch):
    out, queries = _run_find(monkeypatch, [("data/a/b.txt", 3)],
                             type="f",
                             name="*.txt")
    assert out == ["/data/a/b.txt"]
    assert "$and" in queries[0]


def test_find_unordered_marker_and_file_no_duplicates(monkeypatch):
    out, _ = _run_find(monkeypatch, [("data/a/x.txt", 1), ("data/a/", 0)],
                       type="d")
    assert out == ["/data", "/data/a"]


def test_find_file_shadowed_by_implicit_dir_emits_once(monkeypatch):
    docs = [("data/a", 1), ("data/a/b.txt", 2)]
    assert _run_find(monkeypatch,
                     docs)[0] == ["/data", "/data/a", "/data/a/b.txt"]
    assert _run_find(monkeypatch, docs, type="d")[0] == ["/data", "/data/a"]
    assert _run_find(monkeypatch, docs,
                     type="f")[0] == ["/data/a", "/data/a/b.txt"]


def test_find_empty_matches_marker_only_start(monkeypatch):
    out, _ = _run_find(monkeypatch, [("data/", 0)], empty=True)
    assert out == ["/data"]


def test_find_empty_rejects_populated_start(monkeypatch):
    out, _ = _run_find(monkeypatch, [("data/x.txt", 3)], empty=True)
    assert out == []
