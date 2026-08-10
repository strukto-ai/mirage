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


class PolicyError(Exception):
    """A policy returned something a hook may not return.

    Raised loudly at the seam (never silently dropped): an illegal
    Action kind for the hook, or a value that is not an Action at all,
    is a programming error in the policy, not a refusal.
    """


class PolicyDenied(PermissionError):
    """An op refused by an admission policy at an op door.

    A PermissionError subclass so every existing consumer keeps
    working: FUSE adapters classify it to EACCES, programmatic callers
    catch PermissionError, and the shell renders the GNU
    ``<cmd>: <path>: Permission denied`` line. The distinct type lets
    handlers that special-case mount-mode refusals (the read-only
    wording) tell a policy deny apart without guessing from errno.

    ``completed`` says whether the refused op had already run against
    the backend: a post_ops deny suppresses the result, not the effect,
    so the door's caller must still account for the op (the ops facade
    records it). A pre_ops deny leaves it False, the class default.
    """

    completed = False
