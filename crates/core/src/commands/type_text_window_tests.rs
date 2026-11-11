use super::{WindowTypeArgs, execute};
use crate::actions::action_result::ActionResult;
use crate::adapter::{ActionOps, InputOps, ObservationOps, SystemOps};
use crate::context::CommandContext;
use crate::{AdapterError, DeliverySemantics};
use std::sync::Mutex;

#[derive(Default)]
struct DrawnWindowAdapter {
    typed: Mutex<Option<(u32, String)>>,
    focused: Mutex<Option<String>>,
    stays_behind: bool,
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
        *self.typed.lock().unwrap() = Some((process.pid.get(), text.to_owned()));
        Ok(ActionResult::delivered_unverified("type_text"))
    }
}

impl SystemOps for DrawnWindowAdapter {
    crate::adapter::guarded_interaction_lease!();

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
    execute(
        WindowTypeArgs {
            window_id: "w-7".into(),
            text: "发送 Build 1482".into(),
        },
        adapter,
        context,
    )
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
fn human_pacing_and_empty_text_are_refused_before_anything_moves() {
    let adapter = DrawnWindowAdapter::default();
    let human = Some(crate::HumanInput {
        pace: crate::HumanPace::Natural,
        seed: None,
    });
    let context = CommandContext::default()
        .with_headed(true)
        .with_human(human);
    assert_eq!(
        type_into(&adapter, &context).unwrap_err().code(),
        "INVALID_ARGS"
    );
    let empty = execute(
        WindowTypeArgs {
            window_id: "w-7".into(),
            text: String::new(),
        },
        &adapter,
        &CommandContext::default().with_headed(true),
    )
    .unwrap_err();
    assert_eq!(empty.code(), "INVALID_ARGS");
    assert!(adapter.focused.lock().unwrap().is_none());
}
