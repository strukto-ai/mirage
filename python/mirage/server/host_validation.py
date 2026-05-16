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

import os
from collections.abc import Iterable

DEFAULT_ALLOWED_HOSTS: tuple[str, ...] = ("127.0.0.1", "localhost", "::1")

ENV_VAR = "MIRAGE_ALLOWED_HOSTS"


def parse_allowed_hosts(value: str | None) -> list[str]:
    """Parse a CSV ``MIRAGE_ALLOWED_HOSTS`` value into a host list.

    Empty / missing values fall back to ``DEFAULT_ALLOWED_HOSTS``.

    Args:
        value (str | None): raw env var value.

    Returns:
        list[str]: parsed host list.
    """
    if value is None:
        return list(DEFAULT_ALLOWED_HOSTS)
    items = [h.strip() for h in value.split(",") if h.strip()]
    return items or list(DEFAULT_ALLOWED_HOSTS)


def resolve_allowed_hosts(
    allowed_hosts: Iterable[str] | None = None,
) -> list[str]:
    """Resolve allowed hosts from explicit arg or env var.

    Args:
        allowed_hosts (Iterable[str] | None): explicit list. If
            ``None``, falls back to ``$MIRAGE_ALLOWED_HOSTS`` env var,
            then ``DEFAULT_ALLOWED_HOSTS``.

    Returns:
        list[str]: resolved host list.
    """
    if allowed_hosts is not None:
        return list(allowed_hosts)
    return parse_allowed_hosts(os.environ.get(ENV_VAR))
