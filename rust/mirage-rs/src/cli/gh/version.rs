use super::accessor::Out;
use crate::core::github::client::Account;

pub(crate) fn version(account: &Account) -> Out {
    Out::text(format!("gh version {} (Mirage)\n", account.version))
}
