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

import pytest

from mirage.commands.cli.builtin.git.discover import discover
from mirage.commands.cli.builtin.git.errors import AmbiguousArgumentError
from mirage.commands.cli.builtin.git.repo import open_repo
from mirage.commands.cli.builtin.git.revparse import (resolve_commit,
                                                      split_revision)

from .conftest import repo_facts


def test_bare_revision_has_no_steps():
    base, steps = split_revision("HEAD")
    assert base == "HEAD"
    assert steps == ()


def test_bare_suffix_counts_as_one():
    base, steps = split_revision("HEAD~")
    assert base == "HEAD"
    assert [(s.first_parent, s.count) for s in steps] == [(True, 1)]


def test_numeric_suffix_is_read():
    _base, steps = split_revision("main~3")
    assert [(s.first_parent, s.count) for s in steps] == [(True, 3)]


def test_unicode_digit_suffix_is_not_a_count():
    # python's \d and int() both read '٣' as 3, which TypeScript's [0-9]
    # scan never consumes — the ancestry count stops at ASCII digits in
    # both languages.
    _base, steps = split_revision("main~٣")
    assert [(s.first_parent, s.count) for s in steps] == [(True, 1),
                                                          (False, 1)]


def test_parent_suffix_is_distinguished_from_ancestor():
    _base, steps = split_revision("HEAD^2")
    assert [(s.first_parent, s.count) for s in steps] == [(False, 2)]


def test_suffixes_chain():
    base, steps = split_revision("HEAD~2^2~1")
    assert base == "HEAD"
    assert [(s.first_parent, s.count)
            for s in steps] == [(True, 2), (False, 2), (True, 1)]


def test_a_bare_suffix_string_means_head():
    base, _steps = split_revision("~1")
    assert base == "HEAD"


@pytest.mark.asyncio
async def test_resolves_refs_shas_and_ancestry(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)

    head = resolve_commit(repo, "HEAD")
    assert head.message == b"third"
    assert resolve_commit(repo, "main").id == head.id
    assert resolve_commit(repo, head.id.decode()).id == head.id
    assert resolve_commit(repo, head.id.decode()[:7]).id == head.id
    assert resolve_commit(repo, "HEAD~1").message == b"second"
    assert resolve_commit(repo, "HEAD^").message == b"second"
    assert resolve_commit(repo, "HEAD~2").message == b"first"
    assert resolve_commit(repo, "HEAD^0").id == head.id


@pytest.mark.asyncio
async def test_walking_off_the_end_of_history_is_gits_fatal(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    with pytest.raises(AmbiguousArgumentError) as excinfo:
        resolve_commit(repo, "HEAD~99")
    assert str(excinfo.value).startswith(
        "ambiguous argument 'HEAD~99': unknown revision or path not in "
        "the working tree.")


@pytest.mark.asyncio
async def test_unknown_ref_is_gits_fatal(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    with pytest.raises(AmbiguousArgumentError):
        resolve_commit(repo, "nosuchref")


@pytest.mark.asyncio
async def test_second_parent_of_a_linear_commit_is_refused(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    with pytest.raises(AmbiguousArgumentError):
        resolve_commit(repo, "HEAD^2")
