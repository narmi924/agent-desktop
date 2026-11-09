use super::{candidate_points, receives_events_check};
use crate::actions::action::Action;
use crate::actions::action_request::ActionRequest;
use crate::adapter::hit_test::HitTestResult;
use crate::adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps};
use crate::{AdapterError, Deadline, Point, Rect};

const BOX: Rect = Rect {
    x: 100.0,
    y: 50.0,
    width: 300.0,
    height: 44.0,
};

struct VisibleFrom(f64);

impl ObservationOps for VisibleFrom {
    fn hit_test(
        &self,
        _handle: &NativeHandle,
        point: Point,
        _deadline: Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        Ok(if point.x >= self.0 {
            HitTestResult::ReachesTarget
        } else {
            HitTestResult::InterceptedBy {
                role: Some("group".into()),
                name: None,
                bounds: None,
            }
        })
    }
}

impl ActionOps for VisibleFrom {}
impl InputOps for VisibleFrom {}
impl SystemOps for VisibleFrom {}

fn check(visible_from: f64) -> Option<Point> {
    let (_, point) = receives_events_check(
        Some(BOX),
        &NativeHandle::null(),
        &VisibleFrom(visible_from),
        &ActionRequest::headed(Action::Click),
        Deadline::after(2_000).unwrap(),
    )
    .unwrap();
    point
}

#[test]
fn probing_starts_at_the_centre() {
    let first = &candidate_points(BOX)[0];
    assert_eq!((first.x, first.y), (250.0, 72.0));
}

#[test]
fn a_target_visible_only_at_its_far_edge_is_still_reached() {
    let point = check(380.0).expect("the visible sliver is reachable");
    assert!(point.x >= 380.0);
}

#[test]
fn a_blocked_centre_falls_back_to_a_reachable_quarter_point() {
    let point = check(260.0).expect("reachable");
    assert_eq!(point.x, 325.0);
}

#[test]
fn a_blocked_probe_that_is_unknown_stops_the_grid() {
    struct Unknown;
    impl ObservationOps for Unknown {
        fn hit_test(
            &self,
            _handle: &NativeHandle,
            _point: Point,
            _deadline: Deadline,
        ) -> Result<HitTestResult, AdapterError> {
            Ok(HitTestResult::Unknown)
        }
    }
    impl ActionOps for Unknown {}
    impl InputOps for Unknown {}
    impl SystemOps for Unknown {}
    let (check, point) = receives_events_check(
        Some(BOX),
        &NativeHandle::null(),
        &Unknown,
        &ActionRequest::headed(Action::Click),
        Deadline::after(2_000).unwrap(),
    )
    .unwrap();
    assert!(point.is_none());
    assert_eq!(check.hit_test.unwrap().attempted, 5);
}

#[test]
fn a_fully_covered_target_is_not_reachable() {
    assert!(check(1_000.0).is_none());
}
