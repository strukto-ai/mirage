pub(crate) const DAY: i128 = 86400;

pub(crate) fn days(mut year: i128, month: i128, day: i128) -> i128 {
    year += (month - 1).div_euclid(12);
    let month = (month - 1).rem_euclid(12) + 1;
    let shifted = year - i128::from(month <= 2);
    let march = if month <= 2 { month + 9 } else { month - 3 };
    365 * shifted + shifted.div_euclid(4) - shifted.div_euclid(100)
        + shifted.div_euclid(400)
        + (153 * march + 2) / 5
        + day
        - 1
        - 719468
}

pub(crate) fn fields(wall: i128) -> (i128, i128, i128, i128, i128, i128) {
    let days = wall.div_euclid(DAY);
    let mut year = 1970 + days.div_euclid(146097) * 400;
    let mut day = days.rem_euclid(146097);
    while day >= 365 + i128::from(leap(year)) {
        day -= 365 + i128::from(leap(year));
        year += 1;
    }
    let mut month = 1;
    for length in [
        31,
        28 + i128::from(leap(year)),
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ] {
        if day < length {
            break;
        }
        day -= length;
        month += 1;
    }
    let seconds = wall.rem_euclid(DAY);
    (
        year,
        month,
        day + 1,
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60,
    )
}

fn leap(year: i128) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_round_trips_across_centuries_and_normalizes_months() {
        for year in [-400, -1, 0, 1, 100, 400, 1900, 1970, 2000, 2026, 9999] {
            for month in 1..=12 {
                let value = days(year, month, 1) * DAY - 1;
                let (y, m, d, hour, minute, second) = fields(value);
                assert_eq!(
                    days(y, m, d) * DAY + hour * 3600 + minute * 60 + second,
                    value
                );
                assert_eq!(fields(value + 1), (year, month, 1, 0, 0, 0));
            }
        }
        assert_eq!(days(2026, 0, 1), days(2025, 12, 1));
        assert_eq!(days(2026, 14, 31), days(2027, 3, 3));
    }
}
