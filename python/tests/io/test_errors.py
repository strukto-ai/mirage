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

import errno

from mirage.commands.builtin.utils.limit import LimitExceededError
from mirage.io import CompletedOpError
from mirage.policy import PolicyDenied


def test_nothing_ran_by_default():
    assert CompletedOpError().completed is False
    assert CompletedOpError().op_source is None
    assert CompletedOpError().op_bytes is None


def test_every_door_error_is_caught_by_the_one_name():
    # The facade records off this base rather than an allowlist of
    # types, so a door error that already ran opts in by inheriting it.
    for error in (PolicyDenied(errno.EACCES, "no",
                               "/m/x"), LimitExceededError("cap")):
        assert isinstance(error, CompletedOpError)


def test_a_policy_deny_stays_a_permission_error():
    # The second base must not disturb the OSError construction the
    # shell and the FUSE bridge read.
    denied = PolicyDenied(errno.EACCES, "no", "/m/x")
    assert isinstance(denied, PermissionError)
    assert denied.errno == errno.EACCES
    assert denied.filename == "/m/x"


def test_a_hard_cap_says_it_ran():
    # apply_op_limit only ever caps a result that exists, so the bytes
    # were moved before the caller was refused them.
    assert LimitExceededError("cap").completed is True


def test_a_pre_gate_deny_did_not_run():
    assert PolicyDenied(errno.EACCES, "no", "/m/x").completed is False
