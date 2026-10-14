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

from mirage.vfs.gridfs.config import GridFSConfig
from mirage.vfs.gridfs.gridfs import GridFSVFS


def _location(uri: str) -> str | None:
    config = GridFSConfig(uri=uri, database="d", bucket="b")
    return GridFSVFS(config).storage_location()


def test_a_bucket_is_one_store_whatever_login_reaches_it():
    one = _location("mongodb://ada:secret@h1:27017,h2:27017/admin?tls=true")
    assert one == _location("mongodb://bob:other@h1:27017,h2:27017/")
    assert "secret" not in (one or "")
