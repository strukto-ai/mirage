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

from mirage.core.email.readdir import _msg_filename
from mirage.core.email.search import _build_vfs_path, build_search_criteria
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_len

CJK_SUBJECT = "会議の記録" * 40


def test_a_hit_names_the_file_readdir_created():
    # Composed here from a bare `_sanitize`, a hit pointed at a path that
    # does not exist as soon as the subject was long enough to be trimmed:
    # readdir budgets the subject against the uid and the suffix, and this
    # did not, so the two names differed.
    msg = {
        "subject": CJK_SUBJECT,
        "uid": "7",
        "date": "Mon, 5 Jan 2026 10:00:00 +0000"
    }
    path = _build_vfs_path("/mail", "INBOX", msg)
    assert path.endswith("/" + _msg_filename(CJK_SUBJECT, "7"))


def test_a_hits_filename_fits_name_max():
    msg = {
        "subject": CJK_SUBJECT,
        "uid": "7",
        "date": "Mon, 5 Jan 2026 10:00:00 +0000"
    }
    name = _build_vfs_path("/mail", "INBOX", msg).rsplit("/", 1)[-1]
    assert byte_len(name) <= NAME_MAX_BYTES
    assert "\ufffd" not in name


def test_search_criteria_escape_quotes_and_backslashes():
    # A grep pattern holding a quote used to end the quoted string early, so
    # the rest of the pattern was read as IMAP search keys (#1067).
    assert build_search_criteria(text='say "hi"') == 'TEXT "say \\"hi\\""'
    assert build_search_criteria(subject="a\\b") == 'SUBJECT "a\\\\b"'
    assert build_search_criteria(
        from_addr='"Al" <a@x>') == 'FROM "\\"Al\\" <a@x>"'
    assert build_search_criteria(to_addr='x"y') == 'TO "x\\"y"'


def test_search_criteria_keep_spaces_and_unicode():
    assert build_search_criteria(
        text="quarterly review") == 'TEXT "quarterly review"'
    cjk = "会議の記録"
    assert build_search_criteria(subject=cjk) == f'SUBJECT "{cjk}"'


def test_search_criteria_join_keys_and_leave_dates_bare():
    assert build_search_criteria() == "ALL"
    assert build_search_criteria(
        unseen=True, since="05-Jan-2026",
        before="07-Jan-2026") == "UNSEEN SINCE 05-Jan-2026 BEFORE 07-Jan-2026"
