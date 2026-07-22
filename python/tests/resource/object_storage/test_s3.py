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
from pydantic import ValidationError

from mirage.resource.s3 import S3Config


def test_s3config_defaults():
    c = S3Config(bucket="my-bucket")
    assert c.region is None
    assert c.timeout == 30


def test_s3config_immutable():
    c = S3Config(bucket="x")
    with pytest.raises(ValidationError):
        c.bucket = "y"


def test_s3_write_commands_tagged():
    from mirage.commands.builtin.s3 import COMMANDS
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
    }
    for fn in COMMANDS:
        for rc in fn._registered_commands:
            if rc.name in write_names:
                assert rc.write is True, (f"{rc.name} should be write=True")
            else:
                assert rc.write is False, (f"{rc.name} should be write=False")


def test_s3_write_ops_tagged():
    from mirage.ops.s3 import OPS
    write_op_names = {
        "write",
        "unlink",
        "rmdir",
        "mkdir",
        "create",
        "truncate",
        "rename",
    }
    for ro in OPS:
        if ro.name in write_op_names:
            assert ro.write is True, (f"op {ro.name} should be write=True")
        else:
            assert ro.write is False, (f"op {ro.name} should be write=False")
