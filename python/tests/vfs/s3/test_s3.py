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

from mirage.core.s3.client import _client_kwargs
from mirage.vfs.s3 import S3VFS, S3Config
from tests.fixtures.mount_commands import mount_commands


def test_s3_client_kwargs_route_through_proxy():
    config = S3Config(
        bucket="b", proxy="http://proxy-user:proxy-secret@localhost:8080"
    )
    proxies = _client_kwargs(config)["config"].proxies
    assert proxies == {
        "http": "http://proxy-user:proxy-secret@localhost:8080",
        "https": "http://proxy-user:proxy-secret@localhost:8080",
    }


def test_s3_client_kwargs_treat_empty_proxy_as_disabled():
    config = S3Config(bucket="b", proxy="")
    assert _client_kwargs(config)["config"].proxies is None


def test_s3_state_redacts_proxy_credentials():
    vfs = S3VFS(
        S3Config(bucket="b", proxy="http://proxy-user:proxy-secret@host:8080")
    )
    blob = repr(vfs.get_state())
    assert "proxy-user" not in blob
    assert "proxy-secret" not in blob
    assert "<REDACTED>" in blob


def test_s3_write_commands_tagged():
    write_names = {
        "rm",
        "rmdir",
        "unlink",
        "mkdir",
        "touch",
        "cp",
        "mv",
        "ln",
        "tee",
        "mktemp",
        "split",
        "csplit",
        "gzip",
        "gunzip",
        "zip",
        "unzip",
        "tar",
        "patch",
        "iconv",
        "truncate",
        "sort",
        "shuf",
        "sed",
        "uniq",
        "xxd",
        "awk",
    }
    for registered in mount_commands(S3VFS(S3Config(bucket="b"))):
        if registered.name in write_names:
            assert registered.write is True, (
                f"{registered.name} should be write=True"
            )
        else:
            assert registered.write is False, (
                f"{registered.name} should be write=False"
            )
