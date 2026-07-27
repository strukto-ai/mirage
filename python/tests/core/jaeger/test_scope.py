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

from mirage.core.jaeger.scope import detect_scope

TRACE = "a" * 32


@pytest.mark.parametrize(
    "path,level",
    [
        ("", "root"),
        ("/", "root"),
        ("services", "services"),
        ("services/checkout", "service"),
        ("services/checkout/operations.json", "operations"),
        ("services/checkout/traces", "traces"),
        (f"services/checkout/traces/{TRACE}.json", "trace"),
        ("traces", "unknown"),
        ("services/checkout/traces/deep/nested.json", "unknown"),
        ("services/checkout/unknown.json", "unknown"),
    ],
)
def test_detect_scope_levels(path, level):
    assert detect_scope(path).level == level


def test_detect_scope_carries_service_and_trace_id():
    scope = detect_scope(f"services/checkout/traces/{TRACE}.json")
    assert scope.service == "checkout"
    assert scope.trace_id == TRACE


def test_detect_scope_service_without_trace():
    scope = detect_scope("services/checkout/traces")
    assert scope.service == "checkout"
    assert scope.trace_id is None
