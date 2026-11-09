// Follows the positional rules of gh 2.85.0's pkg/cmd and pkg/cmdutil (MIT;
// see licenses/third_party/gh.txt) and Cobra 1.10.2's validators (Apache-2.0;
// see licenses/third_party/cobra.txt).

use crate::core::github::client::{Failure, Result, usage, value};
use crate::core::github::json::quoted;

enum Rule {
    /// cobra.ExactArgs: a plain error either way.
    Exact(usize),
    /// cobra.MaximumNArgs.
    AtMost(usize),
    /// cobra.MinimumNArgs.
    AtLeast(usize),
    /// cobra.NoArgs: refused as an unknown command, with the usage block.
    None,
    /// cmdutil.NoArgsQuoteReminder.
    Quote,
    /// cmdutil.ExactArgs: both ways a flag error, in the command's words.
    Flagged(usize, &'static str),
}

fn rule_of(leaf: &str) -> Option<Rule> {
    Some(match leaf {
        "api"
        | "issue close"
        | "issue comment"
        | "issue delete"
        | "issue lock"
        | "issue pin"
        | "issue reopen"
        | "issue unlock"
        | "issue unpin"
        | "issue view"
        | "pr lock"
        | "pr reopen"
        | "pr unlock"
        | "release delete"
        | "release edit"
        | "repo autolink delete"
        | "repo autolink view"
        | "repo deploy-key add"
        | "repo deploy-key delete"
        | "repo gitignore view"
        | "repo license view"
        | "secret delete"
        | "variable delete"
        | "variable get" => Rule::Exact(1),
        "auth status"
        | "auth token"
        | "repo deploy-key list"
        | "repo gitignore list"
        | "repo license list"
        | "ruleset list" => Rule::Exact(0),
        "release delete-asset" => Rule::Exact(2),
        "gist rename" => Rule::Exact(3),
        "cache delete" | "gist delete" | "gist view" | "org list" | "pr checks" | "pr comment"
        | "pr diff" | "pr edit" | "pr merge" | "pr ready" | "pr review" | "pr update-branch"
        | "pr view" | "release view" | "repo archive" | "repo create" | "repo delete"
        | "repo edit" | "repo list" | "repo rename" | "repo sync" | "repo unarchive"
        | "repo view" | "ruleset check" | "ruleset view" | "run cancel" | "run delete"
        | "run rerun" | "run view" | "variable set" | "workflow disable" | "workflow enable"
        | "workflow view" => Rule::AtMost(1),
        "issue edit" => Rule::AtLeast(1),
        "cache list" | "gist list" | "label list" | "release list" | "repo autolink list"
        | "run list" | "secret list" | "variable list" | "workflow list" => Rule::None,
        "issue create" | "issue list" | "issue status" | "pr create" | "pr list" | "pr status" => {
            Rule::Quote
        }
        "label clone" => Rule::Flagged(
            1,
            "cannot clone labels: source-repository argument required",
        ),
        "label create" => Rule::Flagged(1, "cannot create label: name argument required"),
        "label delete" => Rule::Flagged(1, "cannot delete label: name argument required"),
        "label edit" => Rule::Flagged(1, "cannot update label: name argument required"),
        "pr close" => Rule::Flagged(
            1,
            "cannot close pull request: number, url, or branch required",
        ),
        "pr revert" => Rule::Flagged(
            1,
            "cannot revert pull request: number, url, or branch required",
        ),
        "issue transfer" => Rule::Flagged(2, "issue and destination repository are required"),
        "repo autolink create" => Rule::Flagged(
            2,
            "Cannot create autolink: keyPrefix and urlTemplate arguments are both required",
        ),
        _ => return Option::None,
    })
}

fn quote_reminder(texts: &[String], value_flag: bool) -> Failure {
    let mut message = match texts {
        [only] => format!("unknown argument {}", quoted(only)),
        many => format!(
            "unknown arguments [{}]",
            many.iter()
                .map(|text| quoted(text))
                .collect::<Vec<_>>()
                .join(" ")
        ),
    };
    if value_flag {
        message.push_str("; please quote all values that have spaces");
    }
    Failure::Usage(message, 1)
}

/// Cobra's refusal of a wrong word count, for a command that takes its words
/// apart after `check_args` has passed them.
pub(crate) fn wrong_count<T>(wanted: usize, texts: &[String]) -> Result<T> {
    value(format!("accepts {wanted} arg(s), received {}", texts.len()))
}

/// Refuse a line whose positional words the command does not take, before
/// it runs, as Cobra's Args validator does.
pub(crate) fn check_args(leaf: &str, texts: &[String], value_flag: bool) -> Result<()> {
    let count = texts.len();
    match rule_of(leaf) {
        Some(Rule::Exact(wanted)) if count != wanted => wrong_count(wanted, texts),
        Some(Rule::AtMost(most)) if count > most => {
            value(format!("accepts at most {most} arg(s), received {count}"))
        }
        Some(Rule::AtLeast(least)) if count < least => value(format!(
            "requires at least {least} arg(s), only received {count}"
        )),
        Some(Rule::None) if count > 0 => usage(format!(
            "unknown command {} for {}",
            quoted(&texts[0]),
            quoted(&format!("gh {leaf}"))
        )),
        Some(Rule::Quote) if count > 0 => Err(quote_reminder(texts, value_flag)),
        Some(Rule::Flagged(wanted, _)) if count > wanted => usage("too many arguments"),
        Some(Rule::Flagged(wanted, message)) if count < wanted => usage(message),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(texts: &[&str]) -> Vec<String> {
        texts.iter().map(|text| (*text).to_owned()).collect()
    }

    fn refused(leaf: &str, texts: &[&str], value_flag: bool) -> Option<(bool, String)> {
        match check_args(leaf, &words(texts), value_flag) {
            Ok(()) => None,
            Err(failure @ Failure::Usage(..)) => Some((true, failure.text())),
            Err(failure) => Some((false, failure.text())),
        }
    }

    fn plain(message: &str) -> Option<(bool, String)> {
        Some((false, message.to_owned()))
    }

    fn flagged(message: &str) -> Option<(bool, String)> {
        Some((true, message.to_owned()))
    }

    #[test]
    fn cobra_validators_are_plain_errors() {
        assert_eq!(
            refused("api", &[], false),
            plain("accepts 1 arg(s), received 0")
        );
        assert_eq!(
            refused("pr view", &["1", "2"], false),
            plain("accepts at most 1 arg(s), received 2")
        );
        assert_eq!(
            refused("issue edit", &[], false),
            plain("requires at least 1 arg(s), only received 0")
        );
    }

    #[test]
    fn no_args_reads_as_an_unknown_command() {
        assert_eq!(
            refused("run list", &["x", "y"], false),
            flagged("unknown command \"x\" for \"gh run list\"")
        );
    }

    #[test]
    fn the_quote_reminder_names_every_word_and_hints_after_a_value_flag() {
        assert_eq!(
            refused("pr list", &["a"], false),
            flagged("unknown argument \"a\"")
        );
        assert_eq!(
            refused("pr list", &["a", "b"], true),
            flagged("unknown arguments [\"a\" \"b\"]; please quote all values that have spaces")
        );
    }

    #[test]
    fn flagged_counts_word_each_side() {
        assert_eq!(
            refused("label delete", &[], false),
            flagged("cannot delete label: name argument required")
        );
        assert_eq!(
            refused("label delete", &["a", "b"], false),
            flagged("too many arguments")
        );
    }

    #[test]
    fn a_leaf_within_its_rule_or_without_one_passes() {
        assert_eq!(refused("pr view", &["1"], false), None);
        assert_eq!(refused("pr list", &[], true), None);
        assert_eq!(refused("search code", &["a", "b", "c"], false), None);
    }
}
