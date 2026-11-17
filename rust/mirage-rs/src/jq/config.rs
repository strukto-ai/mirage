#[derive(Default, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(super) struct BeginConfig {
    pub(super) discard: bool,
}
