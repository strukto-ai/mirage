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

from pathlib import Path

import pytest
from dulwich.objects import Commit, Tag
from dulwich.refs import Ref
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git.tag import (parse_flags, render_listing,
                                                 selected_names, tag_names)
from mirage.commands.spec.types import FlagView
from tests.commands.cli.builtin.git.conftest import mounted_rw, pack_refs


async def run(ws, line: str) -> tuple[int, bytes, bytes]:
    """Run one git line against the mounted repository.

    Args:
        ws (Workspace): workspace with the repository and CLI.
        line (str): the command line, without the leading directory.
    """
    result = await ws.execute(f"git -C /repo {line}")
    return result.exit_code, result.stdout or b"", result.stderr or b""


def tag_object(repo_path: Path, name: str):
    """What a tag ref points at, read straight off disk.

    Args:
        repo_path (Path): the repository's working tree.
        name (str): the tag name.
    """
    with Repo(str(repo_path)) as repo:
        return repo[repo.refs[f"refs/tags/{name}".encode()]]


def test_a_bare_n_means_one_line():
    assert parse_flags(FlagView({"n": True})).lines == 1


def test_an_attached_count_is_read():
    assert parse_flags(FlagView({"n": "2"})).lines == 2


def test_no_n_means_no_message_lines():
    assert parse_flags(FlagView({})).lines is None


def test_minus_one_is_where_gits_own_counter_starts():
    # -1 is the sentinel git's parser initialises the count to, so
    # ``-n-1`` says nothing at all rather than asking for -1 lines.
    assert parse_flags(FlagView({"n": "-1"})).lines is None


def test_a_count_below_the_sentinel_is_kept_for_the_refusal():
    assert parse_flags(FlagView({"n": "-2"})).lines == -2


def test_a_message_implies_an_annotated_tag():
    parsed = parse_flags(FlagView({"message": ["m"]}))
    assert parsed.annotate and parsed.message == "m"


def test_several_messages_are_paragraphs():
    assert parse_flags(FlagView({"message": ["one",
                                             "two"]})).message == "one\n\ntwo"


def test_tag_names_sort_in_byte_order():
    known = {
        Ref(b"refs/tags/a10"),
        Ref(b"refs/tags/a9"),
        Ref(b"refs/tags/B"),
        Ref(b"refs/heads/main")
    }
    assert tag_names(known) == ["B", "a10", "a9"]


def test_patterns_keep_any_match():
    assert selected_names(["v0.9", "v1.0", "w"], ("v1*", "w")) == ["v1.0", "w"]


def test_no_pattern_keeps_everything():
    assert selected_names(["a", "b"], ()) == ["a", "b"]


def test_listing_pads_the_name_and_indents_continuations():
    rendered = render_listing(["v1", "v2"], {
        "v1": ["first", "second"],
        "v2": []
    }, 2)
    assert rendered == (b"v1              first\n"
                        b"    second\n"
                        b"v2              \n")


@pytest.mark.asyncio
async def test_a_bare_name_makes_a_lightweight_tag(git_rw, repo_path: Path):
    assert await run(git_rw, "tag v1.0") == (0, b"", b"")
    assert isinstance(tag_object(repo_path, "v1.0"), Commit)
    assert (await run(git_rw, "tag"))[1] == b"v1.0\n"


@pytest.mark.asyncio
async def test_a_tag_points_where_it_is_told(git_rw, repo_path: Path):
    await run(git_rw, "tag old HEAD~1")
    with Repo(str(repo_path)) as repo:
        parent = repo[repo.refs[b"refs/heads/main"]].parents[0]
        assert repo.refs[b"refs/tags/old"] == parent


@pytest.mark.asyncio
async def test_a_message_writes_a_tag_object(git_rw, repo_path: Path):
    assert await run(git_rw, "tag -a v1.1 -m 'first release'") == (0, b"", b"")
    written = tag_object(repo_path, "v1.1")
    assert isinstance(written, Tag)
    assert written.message == b"first release\n"
    assert written.tagger == b"mirage <mirage@localhost>"
    assert (await run(git_rw,
                      "tag -n"))[1] == b"v1.1            first release\n"


@pytest.mark.asyncio
async def test_annotated_needs_a_message(git_rw):
    code, _out, err = await run(git_rw, "tag -a v1.2")
    assert code == 128
    assert err == (b"fatal: no tag message supplied (mirage has no editor "
                   b"to open; pass -m)\n")


@pytest.mark.asyncio
async def test_a_name_that_exists_is_refused(git_rw):
    await run(git_rw, "tag v1.0")
    code, _out, err = await run(git_rw, "tag v1.0")
    assert code == 128
    assert err == b"fatal: tag 'v1.0' already exists\n"


@pytest.mark.asyncio
async def test_force_moves_the_tag(git_rw):
    await run(git_rw, "tag v1.0 HEAD~1")
    code, out, _err = await run(git_rw, "tag -f v1.0")
    assert code == 0
    assert out.startswith(b"Updated tag 'v1.0' (was ")


@pytest.mark.asyncio
async def test_an_object_it_cannot_resolve_is_fatal(git_rw):
    code, _out, err = await run(git_rw, "tag v2 nosuchrev")
    assert code == 128
    assert err == b"fatal: Failed to resolve 'nosuchrev' as a valid ref.\n"


@pytest.mark.asyncio
async def test_an_invalid_name_is_fatal(git_rw):
    code, _out, err = await run(git_rw, "tag 'bad name'")
    assert code == 128
    assert err == b"fatal: 'bad name' is not a valid tag name.\n"


@pytest.mark.asyncio
async def test_l_filters_by_pattern(git_rw):
    await run(git_rw, "tag v0.9")
    await run(git_rw, "tag v1.0")
    assert (await run(git_rw, "tag -l 'v1*'"))[1] == b"v1.0\n"


@pytest.mark.asyncio
async def test_d_deletes_and_reports_a_miss_without_stopping(git_rw):
    await run(git_rw, "tag v1.0")
    code, out, err = await run(git_rw, "tag -d nosuch v1.0")
    assert code == 1
    assert out.startswith(b"Deleted tag 'v1.0' (was ")
    assert err == b"error: tag 'nosuch' not found.\n"
    assert (await run(git_rw, "tag"))[1] == b""


@pytest.mark.asyncio
async def test_l_and_d_cannot_mix(git_rw):
    code, _out, err = await run(git_rw, "tag -d -l")
    assert code == 129
    assert err == b"error: options '-l' and '-d' cannot be used together\n"


@pytest.mark.asyncio
async def test_a_tag_on_a_tag_points_at_the_tag_object(git_rw,
                                                       repo_path: Path):
    await run(git_rw, "tag -a v1 -m m")
    await run(git_rw, "tag alias v1")
    assert isinstance(tag_object(repo_path, "alias"), Tag)


@pytest.mark.asyncio
async def test_a_tag_resolves_as_a_revision(git_rw):
    await run(git_rw, "tag old HEAD~1")
    assert (await run(git_rw,
                      "log --oneline -n 1 old"))[1].endswith(b" second\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["tag -a", "tag -m msg", "tag -f"])
async def test_a_creation_option_needs_a_name(git_rw, line: str):
    code, _out, err = await run(git_rw, line)
    assert code == 129
    assert err == (b"usage: git tag [-a] [-f] [-m <msg>] <tagname> "
                   b"[<commit> | <object>]\n"
                   b"   or: git tag -d <tagname>...\n"
                   b"   or: git tag [-n[<num>]] -l [<pattern>...]\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["tag -l -a v1", "tag -d -a v1", "tag -n -f"])
async def test_a_creation_option_cannot_list_or_delete(git_rw, line: str):
    code, _out, err = await run(git_rw, line)
    assert code == 129
    assert err.startswith(b"usage: git tag [-a] [-f] [-m <msg>]")


@pytest.mark.asyncio
async def test_listing_and_deleting_still_take_no_name(git_rw):
    assert await run(git_rw, "tag") == (0, b"", b"")
    assert await run(git_rw, "tag -d") == (0, b"", b"")


@pytest.mark.asyncio
async def test_force_still_creates_when_a_name_is_given(git_rw):
    assert await run(git_rw, "tag -f v1") == (0, b"", b"")
    assert (await run(git_rw, "tag"))[1] == b"v1\n"


@pytest.mark.asyncio
async def test_deleting_a_packed_tag_removes_it(repo_path: Path):
    with mounted_rw(repo_path) as ws:
        await run(ws, "tag lw")
        await run(ws, "tag -a ann -m msg")
    pack_refs(repo_path)
    loose = repo_path / ".git" / "refs" / "tags"
    assert not loose.exists() or not any(loose.iterdir())
    with mounted_rw(repo_path) as ws:
        code, out, _err = await run(ws, "tag -d lw")
        assert (code, out.split(b" (was")[0]) == (0, b"Deleted tag 'lw'")
        assert (await run(ws, "tag -d ann"))[0] == 0
        assert (await run(ws, "tag"))[1] == b""
    packed = (repo_path / ".git" / "packed-refs").read_text()
    assert "refs/tags/" not in packed
    assert "^" not in packed
    assert "refs/heads/main" in packed


@pytest.mark.asyncio
async def test_n0_prints_bare_names(git_rw):
    await run(git_rw, "tag -a v1 -m msg")
    await run(git_rw, "tag lw")
    assert (await run(git_rw, "tag -n0"))[1] == b"lw\nv1\n"
    assert (await run(git_rw, "tag -n1"))[1] == (b"lw              third\n"
                                                 b"v1              msg\n")


@pytest.mark.asyncio
async def test_a_tag_can_point_at_a_blob(git_rw, repo_path: Path):
    with Repo(str(repo_path)) as repo:
        blob = repo.get_object(repo[b"HEAD"].tree).lookup_path(
            repo.get_object, b"a.txt")[1].decode()
    assert await run(git_rw, f"tag blobtag {blob}") == (0, b"", b"")
    assert tag_object(repo_path, "blobtag").id.decode() == blob
    assert (await run(git_rw, "tag -n0"))[1] == b"blobtag\n"


@pytest.mark.asyncio
async def test_an_annotated_tag_records_the_blob_type(git_rw, repo_path: Path):
    with Repo(str(repo_path)) as repo:
        blob = repo.get_object(repo[b"HEAD"].tree).lookup_path(
            repo.get_object, b"a.txt")[1].decode()
    assert await run(git_rw, f"tag -a annblob -m m {blob}") == (0, b"", b"")
    written = tag_object(repo_path, "annblob")
    assert isinstance(written, Tag)
    assert written.object[0].type_name == b"blob"
    assert written.object[1].decode() == blob


@pytest.mark.asyncio
async def test_a_target_that_is_no_object_is_still_refused(git_rw):
    code, _out, err = await run(git_rw, "tag v2 nosuchrev")
    assert code == 128
    assert err == b"fatal: Failed to resolve 'nosuchrev' as a valid ref.\n"


@pytest.mark.asyncio
async def test_a_tree_expression_is_a_tag_target(git_rw, repo_path: Path):
    assert await run(git_rw, "tag treetag HEAD^{tree}") == (0, b"", b"")
    with Repo(str(repo_path)) as repo:
        head = repo[b"HEAD"]
        assert repo.refs[b"refs/tags/treetag"] == head.tree


@pytest.mark.asyncio
async def test_a_path_expression_is_a_tag_target(git_rw, repo_path: Path):
    assert await run(git_rw, "tag blobtag HEAD:a.txt") == (0, b"", b"")
    with Repo(str(repo_path)) as repo:
        held = repo[repo.refs[b"refs/tags/blobtag"]]
        assert held.type_name == b"blob"
        assert held.data == b"one changed\n"


@pytest.mark.asyncio
async def test_an_annotated_tag_records_the_expressions_type(
        git_rw, repo_path: Path):
    assert (await run(git_rw, "tag -a -m msg noted HEAD:a.txt"))[0] == 0
    with Repo(str(repo_path)) as repo:
        tag = repo[repo.refs[b"refs/tags/noted"]]
        assert tag.object[0].type_name == b"blob"


@pytest.mark.asyncio
async def test_an_expression_that_resolves_to_nothing_is_refused(git_rw):
    code, _out, err = await run(git_rw, "tag missed HEAD:nosuch")
    assert code == 128
    assert err == (b"fatal: Failed to resolve 'HEAD:nosuch' as a valid "
                   b"ref.\n")


@pytest.mark.asyncio
async def test_a_lightweight_tag_naming_a_blob_keeps_its_type(
        git_rw, repo_path: Path):
    # A lightweight tag is a ref like any other and points at whatever
    # it was made from, so the annotated tag records the type read
    # rather than assuming a commit: `type commit` beside a blob id is a
    # tag object git show and git fsck reject.
    assert (await run(git_rw, "tag blobtag HEAD:a.txt"))[0] == 0
    assert await run(git_rw, "tag -a release -m x blobtag") == (0, b"", b"")
    written = tag_object(repo_path, "release")
    assert isinstance(written, Tag)
    assert written.object[0].type_name == b"blob"


@pytest.mark.asyncio
async def test_a_lightweight_tag_naming_a_tree_keeps_its_type(
        git_rw, repo_path: Path):
    assert (await run(git_rw, "tag treetag HEAD^{tree}"))[0] == 0
    assert await run(git_rw, "tag -a treerel -m x treetag") == (0, b"", b"")
    written = tag_object(repo_path, "treerel")
    assert isinstance(written, Tag)
    assert written.object[0].type_name == b"tree"


@pytest.mark.asyncio
async def test_a_bare_tag_id_makes_a_nested_tag(git_rw, repo_path: Path):
    assert (await run(git_rw, "tag -a v1 -m annotated"))[0] == 0
    with Repo(str(repo_path)) as repo:
        held = repo.refs[b"refs/tags/v1"].decode()
    assert (await run(git_rw, f"tag -a nested -m x {held}"))[0] == 0
    written = tag_object(repo_path, "nested")
    assert isinstance(written, Tag)
    # git reads a bare id as that exact object, so the new tag points at
    # the tag rather than at the commit behind it.
    assert written.object[0].type_name == b"tag"
    assert written.object[1].decode() == held


@pytest.mark.asyncio
async def test_n_is_refused_on_a_line_that_deletes(git_rw):
    assert await run(git_rw, "tag v") == (0, b"", b"")
    code, out, err = await run(git_rw, "tag -d -n1 v")
    assert (code, out) == (128, b"")
    assert err == b"fatal: the '-n' option is only allowed in list mode\n"
    assert (await run(git_rw, "tag -l"))[1] == b"v\n"


@pytest.mark.asyncio
async def test_n_still_implies_a_listing_on_its_own(git_rw):
    # The refusal above is about -d having already chosen the mode: with
    # nothing else on the line -n makes it a listing, so an operand is a
    # pattern and one that matches nothing prints nothing at exit 0.
    assert await run(git_rw, "tag v") == (0, b"", b"")
    assert await run(git_rw, "tag -n1 nosuch") == (0, b"", b"")
    assert (await run(git_rw, "tag -l"))[1] == b"v\n"


@pytest.mark.asyncio
async def test_the_incompatible_pair_outranks_the_n_refusal(git_rw):
    # Ranking, not wording: git reaches the -d/-l pair first and exits
    # 129 there rather than dying on -n. (It names the two options in
    # the order they were typed, where this build has one fixed order.)
    code, _out, err = await run(git_rw, "tag -l -d -n1 v")
    assert code == 129
    assert err == (b"error: options '-l' and '-d' cannot be used "
                   b"together\n")


@pytest.mark.asyncio
async def test_a_tag_named_twice_deletes_nothing(git_rw):
    assert await run(git_rw, "tag v") == (0, b"", b"")
    assert await run(git_rw, "tag w") == (0, b"", b"")
    code, out, err = await run(git_rw, "tag -d v w v")
    assert (code, out) == (1, b"")
    assert err == (b"error: could not delete references: multiple updates "
                   b"for ref 'refs/tags/v' not allowed\n")
    assert (await run(git_rw, "tag -l"))[1] == b"v\nw\n"


@pytest.mark.asyncio
async def test_a_name_that_is_not_there_is_reported_before_the_conflict(
        git_rw):
    # A name no ref answers never reaches the transaction, so it is an
    # ordinary report and the conflict is found among what is left.
    assert await run(git_rw, "tag v") == (0, b"", b"")
    code, out, err = await run(git_rw, "tag -d v v nosuch")
    assert (code, out) == (1, b"")
    assert err == (b"error: tag 'nosuch' not found.\n"
                   b"error: could not delete references: multiple updates "
                   b"for ref 'refs/tags/v' not allowed\n")
    assert (await run(git_rw, "tag -l"))[1] == b"v\n"


@pytest.mark.asyncio
async def test_a_missing_name_twice_is_two_reports(git_rw):
    code, out, err = await run(git_rw, "tag -d nosuch nosuch")
    assert (code, out) == (1, b"")
    assert err == (b"error: tag 'nosuch' not found.\n"
                   b"error: tag 'nosuch' not found.\n")


@pytest.mark.asyncio
async def test_the_blamed_ref_is_the_first_in_ref_order(git_rw):
    # The transaction sorts its updates before it looks for the repeat,
    # so `-d w w v v` blames v although w was typed first.
    for name in ("v", "w"):
        assert await run(git_rw, f"tag {name}") == (0, b"", b"")
    _code, _out, err = await run(git_rw, "tag -d w w v v")
    assert err == (b"error: could not delete references: multiple updates "
                   b"for ref 'refs/tags/v' not allowed\n")


@pytest.mark.asyncio
async def test_a_tag_cannot_be_made_below_one_that_exists(git_rw):
    assert (await run(git_rw, "tag foo"))[0] == 0
    code, _out, err = await run(git_rw, "tag foo/bar")
    assert code == 128
    assert err == (b"fatal: cannot lock ref 'refs/tags/foo/bar': "
                   b"'refs/tags/foo' exists; cannot create "
                   b"'refs/tags/foo/bar'\n")
    assert (await run(git_rw, "tag -l"))[1] == b"foo\n"


@pytest.mark.asyncio
async def test_a_tag_cannot_be_made_above_one_that_exists(git_rw):
    assert (await run(git_rw, "tag baz/qux"))[0] == 0
    code, _out, err = await run(git_rw, "tag baz")
    assert code == 128
    assert err == (b"fatal: cannot lock ref 'refs/tags/baz': "
                   b"'refs/tags/baz/qux' exists; cannot create "
                   b"'refs/tags/baz'\n")


@pytest.mark.asyncio
async def test_force_does_not_open_a_colliding_path(git_rw):
    assert (await run(git_rw, "tag foo"))[0] == 0
    # The obstacle is the path, not the value, so -f has nothing to
    # overwrite.
    code, _out, err = await run(git_rw, "tag -f foo/bar")
    assert code == 128
    assert b"cannot lock ref 'refs/tags/foo/bar'" in err


@pytest.mark.asyncio
async def test_a_negative_count_is_fatal(git_rw):
    # git parses the count while building the format it lists with, so
    # the refusal names the format field rather than the option.
    assert await run(git_rw, "tag v") == (0, b"", b"")
    code, out, err = await run(git_rw, "tag -n-2")
    assert (code, out) == (128, b"")
    assert err == b"fatal: positive value expected contents:lines=-2\n"


@pytest.mark.asyncio
async def test_the_count_is_read_before_any_tag_is(git_rw):
    # A pattern matching nothing would exit 0 on its own; the format is
    # parsed first, so the refusal stands whatever the line selects.
    code, _out, err = await run(git_rw, "tag -n-5 nosuch")
    assert code == 128
    assert err == b"fatal: positive value expected contents:lines=-5\n"


@pytest.mark.asyncio
async def test_the_list_mode_refusal_outranks_the_count(git_rw):
    assert await run(git_rw, "tag v") == (0, b"", b"")
    code, _out, err = await run(git_rw, "tag -d -n-2 v")
    assert code == 128
    assert err == b"fatal: the '-n' option is only allowed in list mode\n"
    assert (await run(git_rw, "tag -l"))[1] == b"v\n"


@pytest.mark.asyncio
async def test_minus_n_one_is_not_an_n_at_all(git_rw):
    # The sentinel reads as "-n was never given", so the two refusals a
    # real -n earns here do not apply: the line deletes, and creates.
    assert await run(git_rw, "tag v") == (0, b"", b"")
    code, out, _err = await run(git_rw, "tag -d -n-1 v")
    assert (code, out.startswith(b"Deleted tag 'v' (was ")) == (0, True)
    assert await run(git_rw, "tag -n-1 -a later -m m") == (0, b"", b"")
    assert (await run(git_rw, "tag -l"))[1] == b"later\n"


@pytest.mark.asyncio
async def test_minus_n_one_lists_names_alone(git_rw):
    assert await run(git_rw, "tag -a v -m body") == (0, b"", b"")
    assert (await run(git_rw, "tag -n-1"))[1] == b"v\n"


@pytest.mark.asyncio
async def test_a_suffix_that_is_not_a_step_writes_no_tag(git_rw):
    # Every character used to count as another first-parent hop, so
    # ``HEAD^x`` resolved to ``HEAD^^`` and the tag landed on a commit
    # nobody named. git refuses the expression instead.
    code, out, err = await run(git_rw, "tag release HEAD^x")
    assert (code, out) == (128, b"")
    assert err == b"fatal: Failed to resolve 'HEAD^x' as a valid ref.\n"
    assert (await run(git_rw, "tag -l"))[1] == b""


@pytest.mark.asyncio
async def test_the_steps_git_does_take_still_tag(git_rw):
    assert await run(git_rw, "tag first HEAD^") == (0, b"", b"")
    assert await run(git_rw, "tag here HEAD^0") == (0, b"", b"")
    assert await run(git_rw, "tag mixed HEAD^~") == (0, b"", b"")
    assert (await run(git_rw, "tag -l"))[1] == b"first\nhere\nmixed\n"
