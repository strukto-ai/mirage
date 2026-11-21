/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

#[cfg(feature = "full_encoding")]
use encoding_rs::*;

#[cfg(feature = "full_encoding")]
fn multi_byte_decoder(mut decoder: Decoder, bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 4);

    if let (CoderResult::OutputFull, _, _) = decoder.decode_to_string(bytes, &mut result, true) {
        debug_assert!(false, "String full while decoding.")
    }

    result.shrink_to_fit();
    result
}

#[inline(always)]
pub(crate) fn decoder_shift_jis(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(SHIFT_JIS.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_big5(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(BIG5.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_euc_jp(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(EUC_JP.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_euc_kr(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(EUC_KR.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_gb18030(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(GB18030.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_gbk(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(GBK.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_iso2022_jp(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(ISO_2022_JP.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_windows874(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(WINDOWS_874.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_ibm866(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(IBM866.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_x_mac_cyrillic(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(X_MAC_CYRILLIC.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_x_user_defined(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(X_USER_DEFINED.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[inline(always)]
pub(crate) fn decoder_replacement(bytes: &[u8]) -> String {
    #[cfg(feature = "full_encoding")]
    {
        multi_byte_decoder(REPLACEMENT.new_decoder(), bytes)
    }

    #[cfg(not(feature = "full_encoding"))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}
