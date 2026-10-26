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

from mirage.vfs.redis import RedisVFS

URL = "redis://localhost:6379/0"


def test_url_spellings_of_one_keyspace_are_one_location():
    a = RedisVFS(url=URL, key_prefix="p:")
    b = RedisVFS(url="redis://127.0.0.1:6379", key_prefix="p:")
    assert a.storage_location() == b.storage_location()


def test_nested_prefixes_are_distinct_keyspaces():
    # Keys are {prefix}file:{path}: p/ holds p/file:/sub/x, p/sub/ holds
    # p/sub/file:/x, so /sub/x under one is not /x under the other.
    outer = RedisVFS(url=URL, key_prefix="p/").storage_location()
    inner = RedisVFS(url=URL, key_prefix="p/sub/").storage_location()
    assert outer + "/sub/x" != inner + "/x"


def test_a_trailing_slash_is_another_prefix():
    a = RedisVFS(url=URL, key_prefix="p").storage_location()
    b = RedisVFS(url=URL, key_prefix="p/").storage_location()
    assert a != b


def test_the_password_stays_out():
    vfs = RedisVFS(url="redis://u:secret@cache:6379/0")
    assert "secret" not in vfs.storage_location()
