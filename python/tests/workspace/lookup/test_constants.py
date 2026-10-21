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

from mirage.types import LsLinkMode, PathSpec
from mirage.workspace.lookup.constants import (
    NO_FOLLOW_COMMANDS,
    changes_files,
    dereferences,
    follows_last_component,
    line_flags,
    ls_link_mode,
    reads_subtrees,
    walks_mounts,
)


def _walks(words: list[str]) -> bool:
    return walks_mounts(words[0], line_flags(words[0], words))


def _reads_subtrees(words: list[str]) -> bool:
    return reads_subtrees(words[0], line_flags(words[0], words))


def test_stat_is_a_no_follow_command():
    """GNU stat lstats, so its operands must not be rewritten."""
    assert "stat" in NO_FOLLOW_COMMANDS


def test_bare_dash_l_dereferences():
    assert dereferences("stat", ["stat", "-L", "/data/link"]) is True


def test_clustered_short_flag_dereferences():
    assert dereferences("stat", ["stat", "-Lc", "%n", "/data/link"]) is True


def test_long_form_dereferences():
    assert (
        dereferences("stat", ["stat", "--dereference", "/data/link"]) is True
    )


def test_absent_flag_does_not_dereference():
    assert dereferences("stat", ["stat", "/data/link"]) is False


def test_an_l_inside_a_format_value_does_not_dereference():
    """Only option words count, so `-c '%L'` must not trip the check."""
    assert dereferences("stat", ["stat", "-c", "%L", "/data/link"]) is False


def test_a_command_with_no_dereference_flag_is_never_affected():
    assert dereferences("rm", ["rm", "-L", "/data/link"]) is False


def test_flags_after_end_of_options_are_operands():
    assert dereferences("stat", ["stat", "--", "-L"]) is False


def test_a_pathspec_operand_is_not_read_as_a_flag():
    """Operands arrive classified as PathSpec, not str."""
    spec = PathSpec.from_str_path("/data/-L")
    assert dereferences("stat", ["stat", spec]) is False


@pytest.mark.parametrize(
    "words, mode",
    [
        (["ls", "-l", "/data/link"], LsLinkMode.NONE),
        (["ls", "-d", "/data/link"], LsLinkMode.NONE),
        (["ls", "-la", "/data/link"], LsLinkMode.NONE),
        (["ls", "-g", "/data/link"], LsLinkMode.NONE),
        (["ls", "-F", "/data/link"], LsLinkMode.NONE),
        (["ls", "--cl", "/data/link"], LsLinkMode.NONE),
        (["ls", "--indicator-style=classify", "/data/link"], LsLinkMode.NONE),
        (["ls", "/data/link"], LsLinkMode.DIRECTORY),
        (["ls", "-p", "/data/link"], LsLinkMode.DIRECTORY),
        (["ls", "--file-type", "/data/link"], LsLinkMode.DIRECTORY),
        (["ls", "--classify=never", "/data/link"], LsLinkMode.DIRECTORY),
        (["ls", "-l", "-L", "/data/link"], LsLinkMode.ALL),
        (["ls", "-F", "-H", "/data/link"], LsLinkMode.ALL),
        (
            [
                "ls",
                "-H",
                "--dereference-command-line-symlink-to-dir",
                "/data/link",
            ],
            LsLinkMode.DIRECTORY,
        ),
    ],
)
def test_ls_link_mode_is_gnus_command_line_rule(words, mode):
    # coreutils 9.7: the last of -L, -H and
    # --dereference-command-line-symlink-to-dir wins; without one, -d, a
    # long format or the classify style (abbreviated or valued) resolve
    # no command-line link, and anything else resolves a link to a
    # directory. -p and --file-type are not classify.
    assert ls_link_mode(words) is mode


def test_a_command_with_no_no_follow_flag_is_never_affected():
    # Only ls reads -l as a request to report the link itself.
    assert follows_last_component("cat", ["cat", "-l", "/data/link"]) is True


def test_file_lstats_like_stat():
    """GNU file describes a link; -L is what follows it."""
    assert "file" in NO_FOLLOW_COMMANDS
    assert dereferences("file", ["file", "-L", "/data/link"]) is True


def test_du_does_not_follow_a_link_operand():
    assert "du" in NO_FOLLOW_COMMANDS
    assert dereferences("du", ["du", "-L", "/data/link"]) is True


def test_find_link_options_are_last_wins():
    # GNU takes the last of -P/-H/-L: `find -L -P x` does not follow,
    # `find -P -L x` does.
    assert dereferences("find", ["find", "-L", "-P", "/data/link"]) is False
    assert dereferences("find", ["find", "-P", "-L", "/data/link"]) is True
    assert (
        dereferences("find", ["find", "-L", "-P", "-L", "/data/link"]) is True
    )
    assert dereferences("find", ["find", "-H", "/data/link"]) is True
    assert dereferences("find", ["find", "/data/link"]) is False


def test_find_link_options_only_count_before_the_operand():
    # -L after the start point is a predicate position, not a policy one.
    assert dereferences("find", ["find", "/data/link", "-L"]) is False


def test_long_form_abbreviated_dereferences():
    # coreutils 9.7: `stat --deref` is --dereference.
    assert dereferences("stat", ["stat", "--deref", "/data/link"]) is True


@pytest.mark.parametrize(
    "words, follows",
    [
        (["file", "-h", "/data/link"], False),
        (["file", "-L", "-h", "/data/link"], False),
        (["file", "-h", "-L", "/data/link"], True),
        (["file", "-Lh", "/data/link"], False),
        (["du", "-LP", "/data/link"], False),
        (["du", "-PL", "/data/link"], True),
        (["du", "-L", "-P", "/data/link"], False),
    ],
)
def test_the_last_link_option_wins(words, follows):
    # file 5.46 and coreutils 9.7: the later of -L and its take-back
    # (-h, -P) decides.
    assert dereferences(words[0], words) is follows


@pytest.mark.parametrize(
    "words, walks",
    [
        (["find", "/data"], True),
        (["du", "/data"], True),
        (["du", "-x", "/data"], False),
        (["tree"], True),
        (["tree", "-x", "/data"], False),
        (["rg", "x"], True),
        (["rg", "--one-file-system", "x", "/data"], False),
        (["grep", "x", "/data"], False),
        (["grep", "-rn", "x", "/data"], True),
        (["grep", "--recursive", "x"], True),
        (["grep", "--recur", "x", "/data"], True),
        (["grep", "-d", "recurse", "x", "/data"], True),
        (["grep", "--directories=recurse", "x", "/data"], True),
        (["grep", "--dereference-recursive", "x", "/data"], True),
        (["grep", "-r", "-d", "skip", "x", "/data"], False),
        (["grep", "-ephrase", "/data/x"], False),
        (["grep", "-frules.txt", "/data/x"], False),
        (["grep", "--", "-r"], False),
        (["egrep", "-r", "x"], True),
        (["fgrep", "x", "/data"], False),
        (["ls", "-R", "/data"], True),
        (["ls", "--recur", "/data"], True),
        (["ls", "-l", "/data"], False),
        (["cat", "/data/x"], False),
        (["tar", "-cf", "/out.tar", "/data"], False),
    ],
)
def test_walkers_are_read_off_the_parsed_line(words, walks):
    # grep 3.11, coreutils 9.7: a long option's prefix, -d recurse and an
    # option's attached value read as grep reads them, and the last of
    # -r and -d wins.
    assert _walks(words) is walks


@pytest.mark.parametrize(
    "words, reads",
    [
        (["tar", "-cf", "/out.tar", "/data"], True),
        (["tar", "cf", "/out.tar", "/data"], True),
        (["tar", "--create", "-f", "/out.tar", "/data"], True),
        (["tar", "-xf", "/out.tar"], False),
        (["zip", "-r", "/out.zip", "/data"], True),
        (["cp", "-r", "/data", "/copy"], True),
        (["cp", "-a", "/data", "/copy"], True),
        (["cp", "--archive", "/data", "/copy"], True),
        (["cp", "--recur", "/data", "/copy"], True),
        (["cp", "/data/a", "/copy"], False),
        (["grep", "-r", "x", "/data"], True),
    ],
)
def test_subtree_readers_cover_the_archivers_and_recursive_copy(words, reads):
    # tar -c (dashless too), zip -r and cp -r or -a read below their
    # operands but stop at a mount boundary, so they read subtrees
    # without walking mounts.
    assert _reads_subtrees(words) is reads


@pytest.mark.parametrize(
    "words, writes",
    [
        (["sort", "/data/a"], False),
        (["sort", "-o", "/data/b", "/data/a"], True),
        (["sort", "--out=/data/b", "/data/a"], True),
        (["shuf", "/data/a"], False),
        (["shuf", "-o", "/data/b", "/data/a"], True),
        (["iconv", "-f", "utf-8", "/data/a"], False),
        (["iconv", "-o", "/data/b", "/data/a"], True),
        (["uniq", "/data/a"], False),
        (["uniq", "/data/a", "/data/b"], True),
        (["xxd", "/data/a"], False),
        (["xxd", "-r", "/data/a", "/data/b"], True),
        (["tee"], False),
        (["tee", "/data/a"], True),
        (["mktemp", "-u"], False),
        (["mktemp"], True),
        (["tar", "-tf", "/data/a.tar"], False),
        (["tar", "-xOf", "/data/a.tar"], False),
        (["tar", "-xf", "/data/a.tar"], True),
        (["tar", "cf", "/data/a.tar", "/data/d"], True),
        (["unzip", "-l", "/data/a.zip"], False),
        (["unzip", "-p", "/data/a.zip"], False),
        (["unzip", "/data/a.zip"], True),
        (["gzip"], False),
        (["gzip", "-c", "/data/a"], False),
        (["gzip", "/data/a"], True),
        (["gunzip", "-t", "/data/a.gz"], False),
        (["gunzip", "/data/a.gz"], True),
        (["sed", "-n", "p", "/data/a"], False),
        (["sed", "-i", "s/a/b/", "/data/a"], True),
        (["sed", "w /data/out", "/data/a"], True),
        (["sed", "-e", "s/a/b/w /data/out", "/data/a"], True),
        (["sed", "-f", "/data/script", "/data/a"], True),
        (["sed", "w /data/out\nq q", "/data/a"], True),
        (["awk", "1", "/data/a"], True),
        (["cp", "/data/a", "/data/b"], True),
    ],
)
def test_a_builtin_writes_only_when_its_line_can(words, writes):
    # sed 4.9 opens a w file while it reads the script, before it
    # refuses a later command.
    assert changes_files(words[0], words) is writes
