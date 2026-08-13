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

import re
from io import BytesIO
from unittest.mock import MagicMock

from mirage.resource.s3 import S3Config, S3Resource


def _mock_backend(data: bytes) -> S3Resource:
    config = S3Config(
        bucket="test-bucket",
        region="us-east-1",
        aws_access_key_id="fake",
        aws_secret_access_key="fake",
    )
    backend = S3Resource.__new__(S3Resource)
    backend.config = config
    backend._prefix = ""
    backend._event_handlers = []

    mock_client = MagicMock()
    body = BytesIO(data)
    mock_client.get_object.return_value = {"Body": body}
    backend._client = mock_client
    return backend


def test_grep_file_uses_streaming():
    from mirage.commands.builtin.grep_helper import grep_lines
    data = b"hello world\nfoo bar\nhello again\n"
    compiled = re.compile("hello")
    results = grep_lines("test.txt",
                         data.decode(errors="replace").splitlines(),
                         compiled,
                         invert=False,
                         line_numbers=False,
                         count_only=False,
                         files_only=False,
                         only_matching=False,
                         max_count=None)
    assert len(results) == 2
    assert "hello world" in results[0]


def test_grep_file_max_count():
    from mirage.commands.builtin.grep_helper import grep_lines
    lines = [f"match line {i}".encode() for i in range(100)]
    data = b"\n".join(lines) + b"\n"
    compiled = re.compile("match")
    results = grep_lines("test.txt",
                         data.decode(errors="replace").splitlines(),
                         compiled,
                         invert=False,
                         line_numbers=False,
                         count_only=False,
                         files_only=False,
                         only_matching=False,
                         max_count=3)
    assert len(results) == 3
