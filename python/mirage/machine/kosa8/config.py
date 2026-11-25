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


import math
from dataclasses import dataclass

from mirage.machine.config import (
    MachineConfig,
    check_on_pause,
    nonblank,
    require_id,
)
from mirage.machine.kosa8.constants import ON_PAUSE
from mirage.machine.types import PauseAction
from mirage.types import JsonValue


@dataclass(frozen=True, slots=True, kw_only=True)
class Kosa8Config(MachineConfig):
    """How to reach a kosa8 sandbox: yours, by its id, or one Mirage
    starts at the first run that needs it.

    Args:
        sandbox_id (str | None): id of a sandbox you created (`kosa8
            sandbox create`, the dashboard or an SDK). None: Mirage starts
            one from ``template`` or ``image``.
        template (str | None): the kosa8 template Mirage starts a sandbox
            from; None is kosa8's ``base``.
        image (str | None): an OCI image Mirage starts the sandbox from
            instead of a template, booted cold.
        idle_timeout (float | None): seconds a sandbox Mirage started stays
            awake with nothing running before kosa8 puts it to sleep; the
            next line wakes it. None is ``IDLE_TIMEOUT_SECONDS``.
        network (bool | None): False lets programs on the sandbox reach
            nothing, True anything; None leaves the sandbox's own policy
            unless a list below is set.
        allowed_domains (tuple[str, ...] | None): the only hosts programs
            on the sandbox may reach: names, ``*.domain`` wildcards, IPv4
            addresses or ranges.
        denied_domains (tuple[str, ...] | None): hosts they may not reach,
            even where an allowed entry covers them.
        secrets (tuple[str, ...] | None): kosa8 secrets, by name, brokered
            to a sandbox Mirage starts: programs there see a placeholder,
            and kosa8 puts the value in on the way to the secret's host.
        api_key (str | None): kosa8 API key; None reads KOSA8_API_KEY.
        api_url (str | None): kosa8 Cloud's address; None reads
            KOSA8_CLOUD_URL, then ``https://api.kosa8.com``.
        on_pause (PauseAction | None): ``pause`` puts a sandbox you brought
            to sleep when the workspace pauses; None leaves it as it is.
    """

    sandbox_id: str | None = None
    template: str | None = None
    image: str | None = None
    idle_timeout: float | None = None
    network: bool | None = None
    allowed_domains: tuple[str, ...] | None = None
    denied_domains: tuple[str, ...] | None = None
    secrets: tuple[str, ...] | None = None
    api_key: str | None = None
    api_url: str | None = None
    on_pause: PauseAction | None = None

    def __post_init__(self) -> None:
        if self.sandbox_id is not None:
            require_id("kosa8", "sandbox_id", self.sandbox_id)
            for field, value in (
                ("template", self.template),
                ("image", self.image),
                ("idle_timeout", self.idle_timeout),
                ("secrets", self.secrets),
            ):
                if value is not None:
                    raise ValueError(
                        f"kosa8: {field} applies to a sandbox Mirage starts; "
                        "leave it out with a sandbox_id"
                    )
        for field, value in (
            ("template", self.template),
            ("image", self.image),
        ):
            if value is not None:
                require_id("kosa8", field, value)
        if self.template is not None and self.image is not None:
            raise ValueError("kosa8: give a template or an image, not both")
        idle = self.idle_timeout
        if idle is not None and (
            isinstance(idle, bool)
            or not isinstance(idle, int | float)
            or not math.isfinite(idle)
            or idle < 1
        ):
            raise ValueError(
                "kosa8: idle_timeout must be a number of seconds of at "
                f"least 1, got {idle!r}"
            )
        if self.network is not None and not isinstance(self.network, bool):
            raise ValueError(
                f"kosa8: network must be true or false, got {self.network!r}"
            )
        for field in ("allowed_domains", "denied_domains", "secrets"):
            value = getattr(self, field)
            if value is None:
                continue
            if isinstance(value, str) or not all(
                isinstance(item, str) and nonblank(item) for item in value
            ):
                raise ValueError(f"kosa8: {field} must be a list of names")
            object.__setattr__(self, field, tuple(value))
        for entry in (
            *(self.allowed_domains or ()),
            *(self.denied_domains or ()),
        ):
            if ":" in entry:
                raise ValueError(
                    f"kosa8: {entry!r}: a sandbox's network names hosts, "
                    "*.domain wildcards and IPv4 addresses or ranges, not "
                    "ports or IPv6"
                )
        if self.network is True and self.allowed_domains:
            raise ValueError(
                "kosa8: network: true lets everything out; drop it to allow "
                "only allowed_domains"
            )
        if self.network is False and self.allowed_domains:
            raise ValueError(
                "kosa8: network: false lets nothing out; drop it to allow "
                "allowed_domains"
            )
        check_on_pause("kosa8", self.on_pause, ON_PAUSE)


def egress_policy(config: Kosa8Config) -> dict[str, JsonValue] | None:
    """The kosa8 egress policy the config's network settings make, None
    when they set nothing and the sandbox keeps its own.

    Args:
        config (Kosa8Config): the machine's config.
    """
    allow = list(config.allowed_domains or ())
    deny = list(config.denied_domains or ())
    if config.network is None and config.allowed_domains is None and not deny:
        return None
    if config.network is False or "*" in deny:
        return {"internet": False}
    policy: dict[str, JsonValue] = {}
    if config.allowed_domains is not None and "*" not in allow:
        policy["internet"] = False
        policy["allow"] = list(allow)
    else:
        policy["internet"] = True
    if deny:
        policy["deny"] = list(deny)
    return policy
