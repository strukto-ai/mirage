// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The slides commands the package dispatcher runs.

use super::super::errors::{Fail, SetFail};
use super::super::node::Node;
use super::super::package::Pkg;
use super::deck::Deck;
use super::edit;

pub(in super::super) fn get(pkg: &Pkg<'_>, path: &str, depth: usize) -> Result<Node, Fail> {
    Deck::new(pkg).get(path, depth)
}

pub(in super::super) fn query(pkg: &Pkg<'_>, selector: &str) -> Result<Vec<Node>, Fail> {
    Deck::new(pkg).query(selector)
}

pub(in super::super) fn set(
    pkg: &mut Pkg<'_>,
    path: &str,
    props: &[(String, String)],
) -> Result<(String, Vec<String>), SetFail> {
    edit::set(pkg, path, props)
}

pub(in super::super) fn remove(
    pkg: &mut Pkg<'_>,
    path: &str,
) -> Result<(String, Vec<String>), Fail> {
    edit::remove(pkg, path)
}
