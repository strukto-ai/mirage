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

from mirage.commands.cli.builtin.hf import HF
from mirage.commands.cli.builtin.hf.accessor import hub_for, repo_type_of
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagView, UsageStyle
from mirage.core.hf_hub.config import HfConfig
from tests.commands.cli.builtin.hf.conftest import inv


def test_registers_itself_under_the_head_word_hf():
    assert cli_spec_for("hf") is HF


def test_declares_a_config_model_because_it_is_an_account_cli():
    """An account CLI reaches a service and consults no mount, which is
    exactly what declaring a config_model and no mount says."""
    assert HF.config_model is HfConfig


def test_uses_the_argparse_dialect():
    """Upstream `hf` is argparse, not clap, so there is no dialect to
    add for it: the default already words its refusals."""
    assert HF.usage_style is UsageStyle.ARGPARSE


def test_the_verb_tree_is_the_one_upstream_offers():
    assert [c.name for c in HF.subcommands] == [
        "auth", "repo", "repo-files", "download", "upload", "env", "version"
    ]


def test_write_verbs_are_marked_write():
    by_name = {c.name: c for c in HF.subcommands}
    assert by_name["upload"].write is True
    assert by_name["download"].write is True
    assert by_name["env"].write is False


def test_repo_type_defaults_to_model():
    assert repo_type_of(FlagView({})) == "model"


def test_repo_type_reads_the_flag():
    assert repo_type_of(FlagView({"repo_type": "dataset"})) == "dataset"


def test_repo_type_refuses_an_unknown_kind():
    with pytest.raises(UsageError):
        repo_type_of(FlagView({"repo_type": "bucket"}))


def test_hub_for_carries_the_installs_credential_and_endpoint():
    accessor = hub_for(inv(), "acme/widget", "dataset", "v2")
    assert accessor.repo_type == "dataset"
    assert accessor.repo_id == "acme/widget"
    assert accessor.revision == "v2"
    assert accessor.token is not None


def test_hub_for_defaults_the_revision_to_main():
    assert hub_for(inv(), "a/b", "model").revision == "main"
