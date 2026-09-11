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

from collections.abc import Mapping

from pydantic import ValidationError

# Past this many, what came back is not a secret's shape, and reciting
# a host's names back to the agent is neither a useful hint nor ours to
# print.
MAX_LISTED_FIELDS = 12

# Sources whose fields are the host's shape rather than a secret's, and
# are never named back however few of them there are: a hardened
# container starts from `env -i` plus a handful of credentials, so a
# count threshold alone would recite exactly the environment worth
# hiding.
OPAQUE_FIELD_SOURCES = frozenset({"env"})


def field_summary(fields: Mapping[str, str], source: str) -> str:
    """How a refusal names the fields the secret did carry.

    Its own module because both planes word this refusal -- the config
    plane's `resolve_sources` and the env plane's `fill_env`, from
    different packages -- and `errors.py` is for the package's
    exception types.

    Args:
        fields (Mapping[str, str]): the fetched secret's fields.
        source (str): the source they came from.

    Returns:
        str: what follows "has" in the message -- the labels for a
            secret of ordinary size, a bare count for the process
            environment or for anything big enough to be one.
    """
    if source in OPAQUE_FIELD_SOURCES or len(fields) > MAX_LISTED_FIELDS:
        return f"{len(fields)} fields"
    return "{" + ", ".join(sorted(fields)) + "}"


def error_summary(exc: ValidationError) -> str:
    """How a refusal names what a config model rejected.

    The field path and the error type per issue, and nothing else. Not
    pydantic's rendered message: the values it refused ride `str(exc)`
    as `input_value`, and a `value_error` or `union_tag_invalid` message
    spells the input inside the message itself. Every config this plane
    validates is one a fetched credential may have just landed in -- a
    source's own, a mount's, an account CLI's -- and the create route
    answers `str(e)` as its 400 detail, so the summary is what any of
    them may say. A caller raises its own type over it and chains
    `from None`, because the original carries the value in `__cause__`
    and a logged traceback would print it.

    Args:
        exc (ValidationError): what the model raised.

    Returns:
        str: `loc: type` per issue, joined by `; `. An issue with no
            location (a model-level validator) is reported as `config`.
    """
    parts = []
    for err in exc.errors(include_input=False, include_url=False):
        loc = ".".join(str(part) for part in err["loc"]) or "config"
        parts.append(f"{loc}: {err['type']}")
    return "; ".join(parts)
