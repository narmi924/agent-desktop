use crate::tree::state::{SECURE, has_state};
use crate::{
    AdapterError, AppError, CommandContext, DeliverySemantics, ErrorCode, PlatformAdapter,
    RefEntry, TypingStep, plan_typing,
};
use std::time::{Duration, Instant};

const QUIET_MS: u64 = 600;
const OWN_KEY_MARGIN_MS: u64 = 30;
const PERSON_WAIT_LIMIT: Duration = Duration::from_secs(60);
const PERSON_POLL: Duration = Duration::from_millis(50);

const EXACT_ENTRY_WORDS: &[&str] = &[
    "password",
    "passcode",
    "passphrase",
    "one-time",
    "one time",
    "verification code",
    "security code",
    "captcha",
    "otp",
    "cvv",
    "cvc",
    "card number",
    "credit card",
    "payment",
    "密码",
    "口令",
    "验证码",
    "校验码",
    "动态码",
    "安全码",
    "卡号",
    "支付",
];

/// Whether a deliberate wrong key may be typed here. Secrets, codes and payment
/// details stay exact: a corrected mistake can still trip a retry limit or a
/// keystroke-sensitive form.
fn allows_typos(entry: &RefEntry) -> bool {
    if has_state(&entry.capabilities.states, SECURE) {
        return false;
    }
    let label = [&entry.identity.name, &entry.identity.description]
        .into_iter()
        .flatten()
        .map(|text| text.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    !EXACT_ENTRY_WORDS.iter().any(|word| label.contains(word))
}

/// Gives way to a person during human-paced typing. Input that arrived after
/// this burst's own last key is someone else's, so the burst waits until they
/// have left the keyboard and mouse alone. Escape stops it.
pub(super) struct PersonGuard<'a> {
    adapter: Option<&'a dyn PlatformAdapter>,
    last_key: Option<Instant>,
}

impl<'a> PersonGuard<'a> {
    pub(super) fn new(adapter: &'a dyn PlatformAdapter, context: &CommandContext) -> Self {
        let adapter = context.human().map(|_| adapter);
        if let Some(adapter) = adapter {
            adapter.stop_requested();
        }
        Self {
            adapter,
            last_key: None,
        }
    }

    pub(super) fn before_key(&self) -> Result<(), AdapterError> {
        let (Some(adapter), Some(last_key)) = (self.adapter, self.last_key) else {
            return Ok(());
        };
        give_way(adapter, last_key, PERSON_WAIT_LIMIT)
    }

    pub(super) fn key_sent(&mut self) {
        if self.adapter.is_some() {
            self.last_key = Some(Instant::now());
        }
    }
}

fn someone_else_typed(idle_ms: u64, since_own_key_ms: u64) -> bool {
    idle_ms + OWN_KEY_MARGIN_MS < since_own_key_ms
}

fn stopped() -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, "Typing stopped by Escape")
        .with_disposition(DeliverySemantics::not_delivered())
}

fn give_way(
    adapter: &dyn PlatformAdapter,
    last_key: Instant,
    limit: Duration,
) -> Result<(), AdapterError> {
    if adapter.stop_requested() {
        return Err(stopped());
    }
    let since_own_key_ms = u64::try_from(last_key.elapsed().as_millis()).unwrap_or(u64::MAX);
    match adapter.user_idle_ms() {
        Ok(idle) if someone_else_typed(idle, since_own_key_ms) => {}
        _ => return Ok(()),
    }
    let until = Instant::now() + limit;
    loop {
        std::thread::sleep(PERSON_POLL);
        if adapter.stop_requested() {
            return Err(stopped());
        }
        if adapter.user_idle_ms().is_ok_and(|idle| idle >= QUIET_MS) {
            return Ok(());
        }
        if Instant::now() >= until {
            return Err(AdapterError::new(
                ErrorCode::Timeout,
                "The computer stayed in use, so typing stopped",
            )
            .with_disposition(DeliverySemantics::not_delivered()));
        }
    }
}

/// One key action of a burst. `delay` replaces the fixed interval before it.
pub(super) struct KeyStep {
    pub(super) unit: String,
    pub(super) backspace: bool,
    pub(super) delay: Option<Duration>,
}

/// The keys a burst sends: one per unit, or a human-like plan when requested.
/// A field that needs exact entry never receives a deliberate wrong key.
pub(super) fn key_steps(
    units: &[String],
    ref_id: &str,
    context: &CommandContext,
) -> Result<Vec<KeyStep>, AppError> {
    let Some(human) = context.human() else {
        return Ok(units
            .iter()
            .map(|unit| KeyStep {
                unit: unit.clone(),
                backspace: false,
                delay: None,
            })
            .collect());
    };
    let entry = crate::commands::helpers::load_ref_entry(ref_id, context)?;
    let plan = plan_typing(units, human.pace, &mut human.rng(), allows_typos(&entry));
    Ok(plan
        .into_iter()
        .map(|step| match step {
            TypingStep::Text { text, after_ms } => KeyStep {
                unit: text,
                backspace: false,
                delay: Some(Duration::from_millis(after_ms)),
            },
            TypingStep::Backspace { after_ms } => KeyStep {
                unit: String::new(),
                backspace: true,
                delay: Some(Duration::from_millis(after_ms)),
            },
        })
        .collect())
}

#[cfg(test)]
#[path = "human_tests.rs"]
mod tests;
