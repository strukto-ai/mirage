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

from mirage.utils.naming import (SEPARATOR, fit_id_name, make_id_name,
                                 parse_id_name)
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_len

CJK = "会議の記録" * 40
SLACK_ID = "C01ABCDEFGH"


def test_make_id_name_sanitizes_by_default():
    assert make_id_name("general", "C123456") == "general__C123456"
    assert make_id_name("My Project!", "uuid-abc") == "My_Project__uuid-abc"


def test_make_id_name_path_safe_keeps_the_spelling():
    assert make_id_name("Zecheng's Server", "G1",
                        path_safe=True) == "Zecheng's Server__G1"


def test_make_id_name_takes_the_suffix_as_an_argument():
    # Appending `.json` afterwards spends bytes the budget never saw, which
    # is how a name that just fits became one that does not.
    assert make_id_name("notes", "U1", suffix=".json") == "notes__U1.json"


@pytest.mark.parametrize("path_safe", [False, True])
def test_a_cjk_label_fits_name_max(path_safe):
    # sanitize_name caps at 100 characters and path_safe_name does not cap
    # at all, so this reached 313 and 621 bytes against a 255-byte NAME_MAX
    # and the filesystem refused the name.
    name = make_id_name(CJK, SLACK_ID, path_safe=path_safe)
    assert byte_len(name) <= NAME_MAX_BYTES
    # The cut lands on a character boundary, never mid-sequence.
    assert "\ufffd" not in name


def test_a_truncated_label_still_round_trips():
    name = make_id_name(CJK, SLACK_ID, suffix=".json")
    assert byte_len(name) <= NAME_MAX_BYTES
    assert parse_id_name(name, suffix=".json")[1] == SLACK_ID


def test_the_id_is_never_trimmed_to_make_room():
    # The label is what gives: a shortened id would stop addressing the
    # VFS, so an id too wide to name is over budget rather than
    # silently mangled. Same rule as gcal's event filenames.
    long_id = "v" * (NAME_MAX_BYTES + 10)
    name = make_id_name("Some Name", long_id)
    assert byte_len(name) > NAME_MAX_BYTES
    assert name == f"{SEPARATOR}{long_id}"
    assert parse_id_name(name)[1] == long_id


def test_a_short_name_is_untouched():
    assert make_id_name("hello", "G1") == "hello__G1"
    # An underscore the caller meant to keep survives, because the trim only
    # runs when the budget is actually exceeded.
    assert make_id_name("hello_", "G1", path_safe=True) == "hello___G1"


def test_fit_id_name_does_not_re_sanitize_the_label():
    # Linear's team directory joins two sanitized parts with the separator
    # itself; running sanitize_name over that would collapse `__` to `_`
    # and change the name's shape, which is why the budget takes an
    # already-transformed label.
    assert fit_id_name("ENG__Engineering", "t1") == "ENG__Engineering__t1"


def test_fit_id_name_leaves_no_trailing_underscore_from_the_cut():
    name = fit_id_name("a" * 300 + "_" * 5, "id1")
    assert byte_len(name) <= NAME_MAX_BYTES
    assert "___" not in name


def test_parse_id_name_recovers_the_id():
    assert parse_id_name("general__C123456") == ("general", "C123456")
    assert parse_id_name("team__uuid.json", suffix=".json") == ("team", "uuid")


@pytest.mark.parametrize("name", ["nosep", "trailing__", "wrong.txt"])
def test_parse_id_name_refuses_a_name_it_did_not_build(name):
    with pytest.raises(FileNotFoundError):
        parse_id_name(name)
