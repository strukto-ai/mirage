import pytest
from pydantic import ValidationError

from mirage.core.databricks_volume.path import backend_path, virtual_path
from mirage.resource.databricks_volume import DatabricksVolumeConfig
from mirage.types import PathSpec


def test_backend_path_uses_volume_root_and_strips_mount_prefix(
        databricks_config):
    path = PathSpec(
        original="/volume/reports/latest.md",
        directory="/volume/reports",
        prefix="/volume",
    )
    assert backend_path(
        databricks_config,
        path) == ("/Volumes/main/default/agent_files/root/reports/latest.md")


def test_backend_path_allows_normalized_path_inside_root(databricks_config):
    path = PathSpec(
        original="/volume/reports/../latest.md",
        directory="/volume/reports",
        prefix="/volume",
    )
    assert backend_path(
        databricks_config,
        path) == ("/Volumes/main/default/agent_files/root/latest.md")


def test_backend_path_rejects_escape_above_configured_root(databricks_config):
    path = PathSpec(
        original="/volume/../../other_schema/other_volume/secret.txt",
        directory="/volume",
        prefix="/volume",
    )
    with pytest.raises(ValueError, match="escapes Databricks volume root"):
        backend_path(databricks_config, path)


def test_config_rejects_parent_segments_in_root_path():
    with pytest.raises(ValidationError):
        DatabricksVolumeConfig(
            catalog="main",
            schema="default",
            volume="agent_files",
            root_path="/root/../other",
        )


def test_virtual_path_rejects_backend_outside_root(databricks_config):
    with pytest.raises(ValueError, match="outside Databricks volume root"):
        virtual_path(
            databricks_config,
            "/Volumes/main/default/other_volume/secret.txt",
            "/volume",
        )
