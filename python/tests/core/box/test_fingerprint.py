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

import hashlib

import pytest

from mirage.cache.index.config import IndexEntry
from mirage.core.box.fingerprint import entry_token, read_token, token_of

SHA = hashlib.sha1(b"hello").hexdigest()


def _entry(**extra) -> IndexEntry:
    return IndexEntry(
        id="F1",
        name="a.txt",
        resource_type="box/file",
        remote_time="2026-04-01T00:00:00+00:00",
        extra=extra,
    )


@pytest.mark.parametrize("value", [None, "", 5, {}])
def test_only_a_non_empty_string_is_a_token(value):
    assert token_of(value) is None


def test_a_sha1_string_is_its_own_token():
    assert token_of(SHA) == SHA


def test_the_entry_token_is_the_listed_sha1():
    assert entry_token(_entry(sha1=SHA)) == SHA


def test_a_sha1_less_entry_has_no_token_never_its_modified_stamp():
    # modified_at is no content token: two same-size edits in one second
    # share it on the real service.
    assert entry_token(_entry()) is None


def test_a_foreign_row_with_a_non_string_sha1_has_no_token():
    assert entry_token(_entry(sha1=5)) is None


def test_a_read_stamps_the_listed_sha1_only_when_the_bytes_hash_to_it():
    assert read_token(_entry(sha1=SHA), SHA) == SHA
    other = hashlib.sha1(b"other").hexdigest()
    assert read_token(_entry(sha1=SHA), other) is None


def test_a_read_through_a_sha1_less_entry_stamps_nothing():
    assert read_token(_entry(), hashlib.sha1(b"").hexdigest()) is None
