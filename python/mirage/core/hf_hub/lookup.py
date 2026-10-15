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

import logging
from collections.abc import Iterator
from contextlib import contextmanager

from mirage.core.hf_hub.client import HfHubError
from mirage.core.hf_hub.constants import ABSENT_STATUSES
from mirage.errors.fs import eacces
from mirage.types import PathSpec

log = logging.getLogger(__name__)


@contextmanager
def refusals_denied(
    path_spec: PathSpec, statuses: frozenset[int] = ABSENT_STATUSES
) -> Iterator[None]:
    """Report a repository the Hub will not show as permission denied.

    A 401, 403 or 404 for the repository or revision is the Hub declining
    to show the listing, so the path answers the way a directory the caller
    may not open does: every file tool already reports that and steps past
    it, where a raw Hub error would stop a walk across other mounts. It is
    never absence, which reconcile would turn into a delete.

    Args:
        path_spec (PathSpec): the path the operation was asked about.
        statuses (frozenset[int]): the refusal statuses; a download narrows
            them to REFUSED_STATUSES.
    """
    try:
        yield
    except HfHubError as exc:
        if exc.status not in statuses:
            raise
        log.debug("hf %s refused: %s", path_spec.virtual, exc)
        raise eacces(path_spec) from exc
