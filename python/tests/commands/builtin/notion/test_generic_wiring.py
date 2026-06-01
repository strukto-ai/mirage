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

from importlib import import_module
from types import SimpleNamespace

import pytest

from mirage.types import FileStat, FileType, PathSpec

cat_mod = import_module("mirage.commands.builtin.notion.cat")
find_mod = import_module("mirage.commands.builtin.notion.find")
grep_mod = import_module("mirage.commands.builtin.notion.grep")
head_mod = import_module("mirage.commands.builtin.notion.head")
jq_mod = import_module("mirage.commands.builtin.notion.jq")
ls_mod = import_module("mirage.commands.builtin.notion.ls")
rg_mod = import_module("mirage.commands.builtin.notion.rg")
stat_mod = import_module("mirage.commands.builtin.notion.stat")
tail_mod = import_module("mirage.commands.builtin.notion.tail")
tree_mod = import_module("mirage.commands.builtin.notion.tree")
core_find_mod = import_module("mirage.core.notion.find")
stream_mod = import_module("mirage.core.notion.stream")

_DIRS = {"/db", "/db/sub"}
_FILES = {
    "/db/notes.md": b"alpha\nbeta\nalpha\n",
    "/db/data.json": b'{"a": 1, "b": [2, 3]}',
    "/db/.hidden": b"secret\n",
    "/db/sub/page.md": b"gamma\n",
    "/db/log.jsonl": b'{"x": 1}\n{"x": 2}\n',
    "/db/empty.jsonl": b"",
}

_ACCESSOR = SimpleNamespace(config=SimpleNamespace())


def _key(path: object) -> str:
    raw = path.original if isinstance(path, PathSpec) else str(path)
    stripped = raw.strip("/")
    return "/" + stripped if stripped else "/"


def _children(key: str) -> list[str]:
    base = key.rstrip("/") or "/"
    out = set()
    for candidate in list(_DIRS) + list(_FILES):
        parent = candidate.rsplit("/", 1)[0] or "/"
        if parent == base and candidate != base:
            out.add(candidate)
    return sorted(out)


async def _fake_resolve_glob(accessor, paths, index):
    resolved = []
    for p in paths:
        spec = PathSpec.from_str_path(p) if isinstance(p, str) else p
        resolved.append(
            PathSpec(original=spec.original,
                     directory=spec.directory,
                     resolved=True,
                     prefix=spec.prefix))
    return resolved


async def _fake_readdir(accessor, path, index=None):
    return _children(_key(path))


async def _fake_stat(accessor, path, index=None):
    key = _key(path)
    name = key.rsplit("/", 1)[-1] or "/"
    if key in _DIRS:
        return FileStat(name=name, type=FileType.DIRECTORY)
    if key in _FILES:
        return FileStat(name=name, type=FileType.TEXT, size=len(_FILES[key]))
    raise FileNotFoundError(key)


async def _fake_read(accessor, path, index=None):
    key = _key(path)
    if key not in _FILES:
        raise FileNotFoundError(key)
    return _FILES[key]


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    read_mods = (cat_mod, head_mod, tail_mod, jq_mod, grep_mod, rg_mod)
    for mod in (cat_mod, head_mod, tail_mod, jq_mod, grep_mod, rg_mod, ls_mod,
                tree_mod, stat_mod, find_mod):
        monkeypatch.setattr(mod, "resolve_glob", _fake_resolve_glob)
    for mod in read_mods:
        monkeypatch.setattr(mod, "notion_read", _fake_read)
    for mod in (ls_mod, tree_mod):
        monkeypatch.setattr(mod, "readdir", _fake_readdir)
        monkeypatch.setattr(mod, "stat", _fake_stat)
    monkeypatch.setattr(stat_mod, "notion_stat", _fake_stat)
    monkeypatch.setattr(stream_mod, "notion_read", _fake_read)
    monkeypatch.setattr(find_mod, "stat_core", _fake_stat)
    monkeypatch.setattr(core_find_mod, "readdir", _fake_readdir)
    monkeypatch.setattr(core_find_mod, "stat", _fake_stat)
    for mod in (grep_mod, rg_mod):
        monkeypatch.setattr(mod, "_readdir", _fake_readdir)
        monkeypatch.setattr(mod, "_stat", _fake_stat)


async def _collect(result) -> bytes:
    body, _io = result
    if body is None:
        return b""
    if isinstance(body, bytes):
        return body
    chunks = [chunk async for chunk in body]
    return b"".join(chunks)


def _paths(*originals: str) -> list[PathSpec]:
    return [PathSpec.from_str_path(o) for o in originals]


# ── ls ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_ls_lists_entries_and_hides_dotfiles():
    out = await _collect(await ls_mod.ls(_ACCESSOR, _paths("/db")))
    names = set(out.decode().splitlines())
    assert names == {
        "notes.md", "data.json", "sub", "log.jsonl", "empty.jsonl"
    }


@pytest.mark.asyncio
async def test_ls_a_shows_dotfiles():
    out = await _collect(await ls_mod.ls(_ACCESSOR, _paths("/db"), a=True))
    assert ".hidden" in out.decode().split("\n")


@pytest.mark.asyncio
async def test_ls_long_includes_size():
    out = await _collect(await ls_mod.ls(_ACCESSOR, _paths("/db"),
                                         args_l=True))
    text = out.decode()
    assert "notes.md" in text
    assert str(len(_FILES["/db/notes.md"])) in text


@pytest.mark.asyncio
async def test_ls_size_sort_orders_largest_first():
    out = await _collect(await ls_mod.ls(_ACCESSOR, _paths("/db"), S=True))
    lines = out.decode().split("\n")
    assert lines.index("data.json") < lines.index("notes.md")


@pytest.mark.asyncio
async def test_ls_classify_marks_directory():
    out = await _collect(await ls_mod.ls(_ACCESSOR, _paths("/db"), F=True))
    assert "sub/" in out.decode().split("\n")


@pytest.mark.asyncio
async def test_ls_time_flag_does_not_error():
    body, io = await ls_mod.ls(_ACCESSOR, _paths("/db"), t=True)
    assert io.exit_code == 0


# ── cat / head / tail ──────────────────────────


@pytest.mark.asyncio
async def test_cat_returns_file_bytes():
    out = await _collect(await cat_mod.cat(_ACCESSOR, _paths("/db/notes.md")))
    assert out == _FILES["/db/notes.md"]


@pytest.mark.asyncio
async def test_cat_number_lines():
    out = await _collect(await cat_mod.cat(_ACCESSOR,
                                           _paths("/db/notes.md"),
                                           n=True))
    text = out.decode()
    assert "1\talpha" in text
    assert "2\tbeta" in text


@pytest.mark.asyncio
async def test_head_n_limits_lines():
    out = await _collect(await head_mod.head(_ACCESSOR,
                                             _paths("/db/notes.md"),
                                             n="2"))
    assert out.decode().splitlines() == ["alpha", "beta"]


@pytest.mark.asyncio
async def test_tail_n_limits_lines():
    out = await _collect(await tail_mod.tail(_ACCESSOR,
                                             _paths("/db/notes.md"),
                                             n="1"))
    assert out.decode().splitlines() == ["alpha"]


# ── stat / tree ────────────────────────────────


@pytest.mark.asyncio
async def test_stat_reports_name():
    out = await _collect(await stat_mod.stat(_ACCESSOR,
                                             _paths("/db/notes.md")))
    assert "notes.md" in out.decode()


@pytest.mark.asyncio
async def test_tree_lists_nested_entries():
    out = await _collect(await tree_mod.tree(_ACCESSOR, _paths("/db")))
    text = out.decode()
    assert "notes.md" in text
    assert "page.md" in text


# ── find ───────────────────────────────────────


@pytest.mark.asyncio
async def test_find_type_file():
    out = await _collect(await find_mod.find(_ACCESSOR,
                                             _paths("/db"),
                                             type="f"))
    found = set(out.decode().splitlines())
    assert "/db/notes.md" in found
    assert "/db/sub/page.md" in found
    assert "/db" not in found


@pytest.mark.asyncio
async def test_find_name_glob():
    out = await _collect(await find_mod.find(_ACCESSOR,
                                             _paths("/db"),
                                             name="*.md"))
    found = set(out.decode().splitlines())
    assert found == {"/db/notes.md", "/db/sub/page.md"}


@pytest.mark.asyncio
async def test_find_maxdepth():
    out = await _collect(await find_mod.find(_ACCESSOR,
                                             _paths("/db"),
                                             maxdepth="1"))
    assert "/db/sub/page.md" not in out.decode().split("\n")


# ── jq ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_jq_object_field():
    out = await _collect(await jq_mod.jq(_ACCESSOR, _paths("/db/data.json"),
                                         ".a"))
    assert out.decode().strip() == "1"


@pytest.mark.asyncio
async def test_jq_jsonl_stream_uses_read_stream():
    out = await _collect(await jq_mod.jq(_ACCESSOR, _paths("/db/log.jsonl"),
                                         ".x"))
    assert out.decode().split() == ["1", "2"]


@pytest.mark.asyncio
async def test_jq_empty_jsonl_yields_nothing():
    out = await _collect(await jq_mod.jq(_ACCESSOR, _paths("/db/empty.jsonl"),
                                         ".x"))
    assert out == b""


# ── grep / rg ──────────────────────────────────


@pytest.mark.asyncio
async def test_grep_native_branch(monkeypatch):
    monkeypatch.setattr(grep_mod, "detect_scope",
                        lambda p: SimpleNamespace(use_native=True))

    async def _fake_search(config, pattern, page_size):
        return ["hit"]

    monkeypatch.setattr(grep_mod, "search_page_content", _fake_search)
    monkeypatch.setattr(grep_mod, "format_grep_results",
                        lambda results, prefix: ["/db/notes.md:alpha"])
    out = await _collect(await grep_mod.grep(_ACCESSOR, _paths("/db"),
                                             "alpha"))
    assert out.decode().strip() == "/db/notes.md:alpha"


@pytest.mark.asyncio
async def test_grep_byte_scan_fallback(monkeypatch):
    monkeypatch.setattr(grep_mod, "detect_scope",
                        lambda p: SimpleNamespace(use_native=False))
    out = await _collect(await grep_mod.grep(_ACCESSOR, _paths("/db/notes.md"),
                                             "alpha"))
    assert out.decode().splitlines() == ["alpha", "alpha"]


@pytest.mark.asyncio
async def test_rg_byte_scan_fallback(monkeypatch):
    monkeypatch.setattr(rg_mod, "detect_scope",
                        lambda p: SimpleNamespace(use_native=False))
    out = await _collect(await rg_mod.rg(_ACCESSOR, _paths("/db/notes.md"),
                                         "beta"))
    assert "beta" in out.decode()
