use super::*;

struct LiveValue(Option<String>);

impl ObservationOps for LiveValue {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_value(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<String>, AdapterError> {
        Ok(self.0.clone())
    }
    crate::adapter::saved_ref_scope!(nodes: &[
        ("checkbox", Some("Target"), None),
        ("textfield", Some("Target"), None),
    ]);
}

impl ActionOps for LiveValue {}
impl InputOps for LiveValue {}
impl SystemOps for LiveValue {}

#[test]
fn get_value_does_not_resurrect_snapshot_text_when_live_value_is_absent() {
    let _guard = HomeGuard::new();
    let snapshot = save_entry(entry(vec![], Some("old text"), vec![]));
    let mut field = entry(vec![], Some("old text"), vec![]);
    field.identity.role = "textfield".into();
    let field_snapshot = save_entry(field);
    for (live, field_text) in [
        (None, "Target"),
        (Some(String::new()), "Target"),
        (Some("new text".to_string()), "new text"),
    ] {
        let adapter = LiveValue(live.clone());
        assert_eq!(
            get_property(&snapshot, &adapter, GetProperty::Value).unwrap()["value"],
            json!(live)
        );
        assert_eq!(
            get_property(&snapshot, &adapter, GetProperty::Text).unwrap()["value"],
            "Target"
        );
        assert_eq!(
            get_property(&field_snapshot, &adapter, GetProperty::Text).unwrap()["value"],
            field_text
        );
    }
    assert_eq!(
        get_property(
            &snapshot,
            &LiveStateAdapter::without_live_support(),
            GetProperty::Value
        )
        .unwrap()["value"],
        "old text"
    );
}

struct Selection {
    direct: Option<Result<Option<String>, ()>>,
    range: Option<std::ops::Range<usize>>,
    value: Option<String>,
}

impl ObservationOps for Selection {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_selected_text(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<String>, AdapterError> {
        match &self.direct {
            Some(Ok(text)) => Ok(text.clone()),
            Some(Err(())) => Err(AdapterError::new(crate::ErrorCode::StaleRef, "gone")),
            None => Err(AdapterError::not_supported("get_selected_text")),
        }
    }

    fn get_text_selection(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<std::ops::Range<usize>>, AdapterError> {
        Ok(self.range.clone())
    }

    fn get_live_value(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<String>, AdapterError> {
        Ok(self.value.clone())
    }
    crate::adapter::saved_ref_scope!(nodes: &[("textfield", Some("Target"), None)]);
}

impl ActionOps for Selection {}
impl InputOps for Selection {}
impl SystemOps for Selection {}

fn selection_of(adapter: &Selection) -> Result<Value, AppError> {
    let mut field = entry(vec![], None, vec![]);
    field.identity.role = "textfield".into();
    let snapshot = save_entry(field);
    get_property(&snapshot, adapter, GetProperty::Selection)
}

#[test]
fn selection_prefers_the_platform_read_and_reports_none_for_an_empty_one() {
    let _guard = HomeGuard::new();
    let direct = |text: &str| Selection {
        direct: Some(Ok(Some(text.into()))),
        range: Some(0..2),
        value: Some("不该用到".into()),
    };
    assert_eq!(
        selection_of(&direct("选中的字")).unwrap()["value"],
        "选中的字"
    );
    assert_eq!(selection_of(&direct("")).unwrap()["value"], Value::Null);
}

#[test]
fn selection_is_cut_from_the_value_by_utf16_offsets_where_the_platform_has_no_direct_read() {
    let _guard = HomeGuard::new();
    let adapter = Selection {
        direct: None,
        range: Some(3..7),
        value: Some("😀今天中午吃拉面".into()),
    };
    assert_eq!(selection_of(&adapter).unwrap()["value"], "天中午吃");
    let collapsed = Selection {
        direct: None,
        range: Some(2..2),
        value: Some("abc".into()),
    };
    assert_eq!(selection_of(&collapsed).unwrap()["value"], Value::Null);
}

#[test]
fn selection_failures_other_than_unsupported_reach_the_caller() {
    let _guard = HomeGuard::new();
    let adapter = Selection {
        direct: Some(Err(())),
        range: None,
        value: None,
    };
    assert_eq!(selection_of(&adapter).unwrap_err().code(), "STALE_REF");
}
