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

import json
from pathlib import Path

from botocore.exceptions import ClientError

LOST_CODES = json.loads(
    (
        Path(__file__).resolve().parents[4]
        / "integ/fixtures/write/lost_codes.json"
    ).read_text()
)


def client_error(code: str, status: int, op: str) -> ClientError:
    """A botocore error carrying ``code`` and ``status``.

    Args:
        code (str): the error's Code.
        status (int): the HTTP status.
        op (str): the operation name.
    """
    return ClientError(
        {
            "Error": {"Code": code},
            "ResponseMetadata": {"HTTPStatusCode": status},
        },
        op,
    )
