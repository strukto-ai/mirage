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
from mirage.commands.cli.builtin.git.revparse import (object_at,
                                                      resolve_commit,
                                                      resolve_object,
                                                      split_operators)
from mirage.commands.cli.builtin.git.types import AncestryStep, PeelStep

from .conftest import repo_facts


def test_bare_revision_has_no_steps():
    base, steps = split_operators("HEAD")
    assert base == "HEAD"
    assert steps == ()


def test_bare_suffix_counts_as_one():
    base, steps = split_operators("HEAD~")
    assert base == "HEAD"
    assert [(s.first_parent, s.count) for s in steps] == [(True, 1)]


def test_numeric_suffix_is_read():
    _base, steps = split_operators("main~3")
    assert [(s.first_parent, s.count) for s in steps] == [(True, 3)]


def test_unicode_digit_suffix_is_not_a_count():
    # python's \d and int() both read '٣' as 3, which TypeScript's [0-9]
    # scan never consumes: the ancestry count stops at ASCII digits in
    # both languages. What is left over is not another step either, so
    # the whole expression is refused, which is git's own answer.
    with pytest.raises(AmbiguousArgumentError):
        split_operators("main~٣")


@pytest.mark.parametrize("revision",
                         ["HEAD^x", "HEAD~x", "HEAD^-1", "HEAD~1z"])
def test_a_suffix_that_is_not_a_step_is_refused(revision: str):
    # Every character used to count as another first-parent hop, so
    # ``HEAD^x`` resolved to ``HEAD^^`` and a tag was written at a
    # commit nobody named.
    with pytest.raises(AmbiguousArgumentError):
        split_operators(revision)


@pytest.mark.parametrize(
    "revision",
    ["HEAD^", "HEAD~", "HEAD^0", "HEAD^~", "HEAD~2^2~1", "HEAD^12"])
def test_the_steps_git_does_take_still_parse(revision: str):
    split_operators(revision)


def test_parent_suffix_is_distinguished_from_ancestor():
    _base, steps = split_operators("HEAD^2")
    assert [(s.first_parent, s.count) for s in steps] == [(False, 2)]


def test_suffixes_chain():
    base, steps = split_operators("HEAD~2^2~1")
    assert base == "HEAD"
    assert [(s.first_parent, s.count)
            for s in steps] == [(True, 2), (False, 2), (True, 1)]


def test_a_bare_suffix_string_means_head():
    base, _steps = split_operators("~1")
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


def test_a_revision_with_no_peel_carries_only_its_steps():
    assert split_operators("HEAD~2") == ("HEAD", (AncestryStep(True, 2), ))


def test_a_bare_peel_carries_an_empty_type():
    assert split_operators("v1^{}") == ("v1", (PeelStep(""), ))


def test_a_typed_peel_carries_its_word():
    assert split_operators("HEAD^{tree}") == ("HEAD", (PeelStep("tree"), ))


def test_a_peel_is_not_an_ancestry_step():
    # Read as one it is `^` with no digits, which means the first
    # parent: the caller was handed another commit without a word.
    _base, ops = split_operators("HEAD^{tree}")
    assert ops == (PeelStep("tree"), )


def test_a_peel_chains_with_the_steps_around_it():
    # git reads a revision left to right, so a peel is an operator like
    # any other rather than something that has to come last.
    assert split_operators("HEAD^{commit}~1") == ("HEAD",
                                                  (PeelStep("commit"),
                                                   AncestryStep(True, 1)))
    assert split_operators("v1~1^{tree}") == ("v1", (AncestryStep(True, 1),
                                                     PeelStep("tree")))


def test_a_peel_that_is_never_closed_is_refused():
    with pytest.raises(AmbiguousArgumentError):
        split_operators("HEAD^{commit")


@pytest.mark.asyncio
async def test_a_peel_to_a_commit_is_the_commit(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    head = resolve_commit(repo, "HEAD")
    assert resolve_commit(repo, "HEAD^{}").id == head.id
    assert resolve_commit(repo, "HEAD^{commit}").id == head.id


@pytest.mark.asyncio
async def test_a_peel_to_another_type_is_no_commit(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    with pytest.raises(AmbiguousArgumentError):
        resolve_commit(repo, "HEAD^{tree}")


@pytest.mark.asyncio
async def test_an_object_expression_reaches_a_tree(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    head = resolve_commit(repo, "HEAD")
    assert resolve_object(repo, "HEAD^{tree}").id == head.tree


@pytest.mark.asyncio
async def test_an_object_expression_reaches_a_blob(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    found = resolve_object(repo, "HEAD:a.txt")
    assert found.type_name == b"blob"
    assert found.data == b"one changed\n"


@pytest.mark.asyncio
async def test_an_ancestry_suffix_still_reads_inside_a_path(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    assert resolve_object(repo, "HEAD~2:a.txt").data == b"one\n"


@pytest.mark.asyncio
async def test_a_bare_object_id_is_itself(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    tree = resolve_commit(repo, "HEAD").tree.decode()
    assert resolve_object(repo, tree).id.decode() == tree
    assert object_at(repo, tree[:7]).id.decode() == tree


@pytest.mark.asyncio
async def test_a_path_the_tree_lacks_is_unresolvable(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    with pytest.raises(AmbiguousArgumentError):
        resolve_object(repo, "HEAD:nosuch")


@pytest.mark.asyncio
async def test_a_peel_naming_the_wrong_type_is_refused(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    with pytest.raises(AmbiguousArgumentError):
        resolve_object(repo, "HEAD^{blob}")


@pytest.mark.asyncio
async def test_a_typed_tag_peel_is_the_tag_itself(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    found = resolve_object(repo, "v1^{tag}")
    assert found.type_name == b"tag"
    assert found.id == repo.refs[b"refs/tags/v1"]


@pytest.mark.asyncio
async def test_a_bare_peel_still_unwraps_the_tag(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    assert resolve_object(repo, "v1^{}").id == resolve_commit(repo, "HEAD").id


@pytest.mark.asyncio
async def test_a_commit_peel_still_unwraps_the_tag(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    found = resolve_object(repo, "v1^{commit}")
    assert found.id == resolve_commit(repo, "HEAD").id


@pytest.mark.asyncio
async def test_a_lightweight_tag_has_no_tag_to_peel_to(git_rw):
    await git_rw.execute("git -C /repo tag light")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    with pytest.raises(AmbiguousArgumentError):
        resolve_object(repo, "light^{tag}")


@pytest.mark.asyncio
async def test_a_bare_tag_id_is_the_tag_object(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    held = repo.refs[b"refs/tags/v1"]
    # git reads a bare id as that exact object, so the commit-ish
    # reading must not peel it: ``git tag nested <tag-id>`` records the
    # tag, which is the nested tag git warns about.
    found = resolve_object(repo, held.decode())
    assert found.type_name == b"tag"
    assert found.id == held


@pytest.mark.asyncio
async def test_a_tag_name_still_peels_where_an_id_does_not(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    # The split is git's own and is observable: a name resolves as a
    # commit-ish, an id as itself.
    assert resolve_object(repo, "v1").type_name == b"commit"


@pytest.mark.asyncio
async def test_a_path_reads_through_a_bare_tag_id(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    held = repo.refs[b"refs/tags/v1"].decode()
    # The rev half of a path expression is a tree-ish, so the tag comes
    # off on the way exactly as it does for ``v1:a.txt``.
    found = resolve_object(repo, f"{held}:a.txt")
    assert found.type_name == b"blob"
    assert found.id == resolve_object(repo, "v1:a.txt").id


@pytest.mark.asyncio
async def test_a_peel_through_a_bare_tag_id_still_reaches_the_tree(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    held = repo.refs[b"refs/tags/v1"].decode()
    assert resolve_object(repo, f"{held}^{{tree}}").type_name == b"tree"
    assert resolve_object(repo, f"{held}^{{}}").type_name == b"commit"


@pytest.mark.asyncio
async def test_an_object_peel_keeps_whatever_type_it_finds(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    # ``^{object}`` is an existence check, not a type: every object
    # reports a concrete type name, so comparing one against the word
    # would refuse every expression that spells it.
    assert resolve_object(repo, "HEAD^{object}").type_name == b"commit"
    assert resolve_object(repo, "HEAD^{tree}^{object}").type_name == b"tree"


@pytest.mark.asyncio
async def test_an_object_peel_leaves_an_annotated_tag_wrapped(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    # The one thing that separates it from ``^{}``: the named object is
    # returned, so a tag stays a tag rather than being unwrapped.
    found = resolve_object(repo, "v1^{object}")
    assert found.type_name == b"tag"
    assert found.id == repo.refs[b"refs/tags/v1"]
    assert resolve_object(repo, "v1^{}").type_name == b"commit"


@pytest.mark.asyncio
async def test_a_commit_ish_still_reads_an_object_peel(git_rw):
    await git_rw.execute("git -C /repo tag -a v1 -m annotated")
    location = await discover(*repo_facts(git_rw), "/repo")
    repo = await open_repo(git_rw.dispatch, location)
    head = resolve_commit(repo, "HEAD")
    # A caller that wants a commit takes the wrapper off, which is what
    # lets ``git branch nb v1^{object}`` work.
    assert resolve_commit(repo, "HEAD^{object}").id == head.id
    assert resolve_commit(repo, "v1^{object}").id == head.id


@pytest.mark.asyncio
async def test_a_peel_followed_by_a_step_walks_from_the_peeled_commit(
        workspace):
    # A peel used to be read only at the end of a revision, so every
    # chain that went on after one was refused although git takes it.
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    assert resolve_commit(repo, "HEAD^{commit}~1").message == b"second"
    assert resolve_commit(repo, "HEAD^{}^").message == b"second"
    assert resolve_object(repo, "HEAD^{commit}~1").id == resolve_commit(
        repo, "HEAD~1").id


@pytest.mark.asyncio
async def test_a_step_followed_by_a_peel_reads_that_commit(workspace):
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    parent = resolve_commit(repo, "HEAD~1")
    assert resolve_object(repo, "HEAD~1^{tree}").id == parent.tree
    assert resolve_object(repo, "HEAD^{commit}~1^{tree}").id == parent.tree


@pytest.mark.asyncio
async def test_a_step_off_a_tree_is_refused(workspace):
    # git dies here too: a tree has no parent, so the step has nothing
    # to walk.
    location = await discover(*repo_facts(workspace), "/repo")
    repo = await open_repo(workspace.dispatch, location)
    with pytest.raises(AmbiguousArgumentError):
        resolve_object(repo, "HEAD^{tree}~1")
