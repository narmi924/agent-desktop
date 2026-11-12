use super::{WindowTypeArgs, execute};
use crate::actions::action_result::ActionResult;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::context::CommandContext;
use crate::{AdapterError, DeliverySemantics};
use std::sync::Mutex;

#[derive(Default)]
struct DrawnWindowAdapter {
    typed: Mutex<Option<(u32, String)>>,
    keys: Mutex<Vec<String>>,
    focused: Mutex<Option<String>>,
    stays_behind: bool,
    fails_after: Option<usize>,
}

fn app() -> crate::AppInfo {
    crate::AppInfo {
        name: "Drawn".into(),
        pid: crate::ProcessId::new(7),
        bundle_id: None,
        process_instance: Some("generation-7".into()),
        presentation: None,
    }
}

fn window(id: &str) -> crate::WindowInfo {
    crate::WindowInfo {
        id: id.into(),
        title: id.into(),
        app: "Drawn".into(),
        pid: crate::ProcessId::new(7),
        process_instance: Some("generation-7".into()),
        bounds: None,
        state: crate::WindowState {
            visible: Some(true),
            ..Default::default()
        },
    }
}

impl ObservationOps for DrawnWindowAdapter {
    fn list_apps(&self, _deadline: crate::Deadline) -> Result<Vec<crate::AppInfo>, AdapterError> {
        Ok(vec![app()])
    }

    fn list_windows(
        &self,
        _filter: &crate::WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<crate::WindowInfo>, AdapterError> {
        Ok(vec![window("w-7"), window("w-7-tools")])
    }
}

impl ActionOps for DrawnWindowAdapter {}

impl InputOps for DrawnWindowAdapter {
    fn type_text_for_app(
        &self,
        process: crate::ProcessIdentity,
        text: &str,
        _policy: crate::InteractionPolicy,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let mut keys = self.keys.lock().unwrap();
        if self.fails_after == Some(keys.len()) {
            return Err(AdapterError::stale_ref_because(
                "The window lost the keyboard",
            ));
        }
        keys.push(text.to_owned());
        *self.typed.lock().unwrap() = Some((process.pid.get(), text.to_owned()));
        Ok(ActionResult::delivered_unverified("type_text"))
    }
}

impl SystemOps for DrawnWindowAdapter {
    crate::adapter::guarded_interaction_lease!();

    fn press_key_for_app(
        &self,
        _process: crate::ProcessIdentity,
        combo: &crate::KeyCombo,
        _policy: crate::InteractionPolicy,
        _lease: &crate::InteractionLease,
    ) -> Result<ActionResult, AdapterError> {
        let held = if combo.modifiers.is_empty() {
            ""
        } else {
            "ctrl+"
        };
        self.keys
            .lock()
            .unwrap()
            .push(format!("<{held}{}>", combo.key));
        Ok(ActionResult::delivered_unverified("press"))
    }

    fn resolve_window_strict(
        &self,
        window: &crate::WindowInfo,
        _deadline: crate::Deadline,
    ) -> Result<crate::WindowInfo, AdapterError> {
        Ok(window.clone())
    }

    fn focus_window(
        &self,
        window: &crate::WindowInfo,
        _lease: &crate::InteractionLease,
    ) -> Result<(), AdapterError> {
        *self.focused.lock().unwrap() = Some(window.id.clone());
        Ok(())
    }

    fn focused_window(
        &self,
        _deadline: crate::Deadline,
    ) -> Result<Option<crate::WindowInfo>, AdapterError> {
        if self.stays_behind {
            return Ok(Some(window("w-7-tools")));
        }
        Ok(self.focused.lock().unwrap().as_deref().map(window))
    }
}

fn type_into(
    adapter: &DrawnWindowAdapter,
    context: &CommandContext,
) -> Result<serde_json::Value, crate::AppError> {
    type_text(adapter, context, "发送 Build 1482", None)
}

fn type_text(
    adapter: &DrawnWindowAdapter,
    context: &CommandContext,
    text: &str,
    interval_ms: Option<u64>,
) -> Result<serde_json::Value, crate::AppError> {
    execute(
        WindowTypeArgs {
            window_id: "w-7".into(),
            text: text.into(),
            interval_ms,
            multiline: false,
            caret: None,
        },
        adapter,
        context,
    )
}

fn type_lines(
    adapter: &DrawnWindowAdapter,
    text: &str,
    interval_ms: Option<u64>,
    caret: Option<crate::CaretPlace>,
) -> Result<serde_json::Value, crate::AppError> {
    execute(
        WindowTypeArgs {
            window_id: "w-7".into(),
            text: text.into(),
            interval_ms,
            multiline: true,
            caret,
        },
        adapter,
        &CommandContext::default().with_headed(true),
    )
}

fn human_context() -> CommandContext {
    CommandContext::default()
        .with_headed(true)
        .with_human(Some(crate::HumanInput {
            pace: crate::HumanPace::Natural,
            seed: Some(4),
            typos: false,
        }))
}

#[test]
fn a_named_window_is_brought_forward_and_typed_into_unverified() {
    let adapter = DrawnWindowAdapter::default();
    let value = type_into(&adapter, &CommandContext::default().with_headed(true)).unwrap();
    assert_eq!(adapter.focused.lock().unwrap().as_deref(), Some("w-7"));
    assert_eq!(
        adapter.typed.lock().unwrap().clone(),
        Some((7, "发送 Build 1482".to_string()))
    );
    assert_eq!(value["window_id"], "w-7");
    assert_eq!(
        serde_json::to_value(DeliverySemantics::delivered_unverified()).unwrap(),
        value["disposition"]
    );
}

#[test]
fn without_headed_nothing_is_typed() {
    let adapter = DrawnWindowAdapter::default();
    let error = type_into(&adapter, &CommandContext::default()).unwrap_err();
    assert_eq!(error.code(), "INVALID_ARGS");
    assert!(adapter.typed.lock().unwrap().is_none());
}

#[test]
fn a_window_that_does_not_become_active_is_not_typed_into() {
    let adapter = DrawnWindowAdapter {
        stays_behind: true,
        ..Default::default()
    };
    let error = type_into(&adapter, &CommandContext::default().with_headed(true)).unwrap_err();
    assert_eq!(error.code(), "STALE_REF");
    assert!(adapter.typed.lock().unwrap().is_none());
}

#[test]
fn an_interval_sends_one_keystroke_at_a_time_in_order() {
    let adapter = DrawnWindowAdapter::default();
    let value = type_lines(&adapter, "a中\r\nb", Some(1), None).unwrap();
    assert_eq!(
        adapter.keys.lock().unwrap().clone(),
        vec!["a", "中", "<return>", "b"]
    );
    assert_eq!(value["keystrokes"], 4);
    assert_eq!(value["interval_ms"], 1);
    assert!(value.get("human").is_none());
}

#[test]
fn a_human_pace_types_exactly_the_text_and_reports_the_pace_it_used() {
    let adapter = DrawnWindowAdapter::default();
    let value = type_text(&adapter, &human_context(), "ok 好", None).unwrap();
    assert_eq!(adapter.keys.lock().unwrap().concat(), "ok 好");
    assert_eq!(adapter.keys.lock().unwrap().len(), 4);
    assert_eq!(value["human"]["pace"], "natural");
    assert!(value["human"]["typed_in_ms"].as_u64().unwrap() > 0);
    assert!(value.get("interval_ms").is_none());
}

#[test]
fn a_paced_run_that_fails_part_way_says_how_many_keys_were_typed() {
    let adapter = DrawnWindowAdapter {
        fails_after: Some(2),
        ..Default::default()
    };
    let headed = CommandContext::default().with_headed(true);
    let error = type_text(&adapter, &headed, "abcd", Some(1)).unwrap_err();
    let crate::AppError::Adapter(error) = error else {
        panic!("expected the adapter's refusal");
    };
    assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    let details = error.details.unwrap();
    assert_eq!(details["typed_keystrokes"], 2);
    assert_eq!(details["keystrokes"], 4);
}

#[test]
fn a_paced_run_that_fails_on_its_first_key_typed_nothing() {
    let adapter = DrawnWindowAdapter {
        fails_after: Some(0),
        ..Default::default()
    };
    let headed = CommandContext::default().with_headed(true);
    let error = type_text(&adapter, &headed, "abcd", Some(1)).unwrap_err();
    let crate::AppError::Adapter(error) = error else {
        panic!("expected the adapter's refusal");
    };
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
}

#[test]
fn empty_text_is_refused_before_anything_moves() {
    let adapter = DrawnWindowAdapter::default();
    let headed = CommandContext::default().with_headed(true);
    let empty = type_text(&adapter, &headed, "", None).unwrap_err();
    assert_eq!(empty.code(), "INVALID_ARGS");
    assert!(adapter.focused.lock().unwrap().is_none());
}

#[test]
fn a_line_break_is_refused_until_the_caller_says_enter_starts_a_new_line() {
    let adapter = DrawnWindowAdapter::default();
    let headed = CommandContext::default().with_headed(true);
    let error = type_text(&adapter, &headed, "第一行\n第二行", None).unwrap_err();
    assert_eq!(error.code(), "INVALID_ARGS");
    assert!(adapter.focused.lock().unwrap().is_none());
    assert!(adapter.keys.lock().unwrap().is_empty());
}

#[test]
fn multiline_text_goes_out_a_line_at_a_time_with_enter_between() {
    let adapter = DrawnWindowAdapter::default();
    let value = type_lines(&adapter, "第一行\n第二行\r\n\n末行", None, None).unwrap();
    assert_eq!(
        adapter.keys.lock().unwrap().clone(),
        vec![
            "第一行",
            "<return>",
            "第二行",
            "<return>",
            "<return>",
            "末行"
        ]
    );
    assert!(value.get("keystrokes").is_none());
}

#[test]
fn a_caret_place_is_reached_with_its_key_before_the_first_character() {
    let adapter = DrawnWindowAdapter::default();
    type_lines(&adapter, "追加", None, Some(crate::CaretPlace::End)).unwrap();
    assert_eq!(
        adapter.keys.lock().unwrap().clone(),
        vec!["<ctrl+end>", "追加"]
    );
}
