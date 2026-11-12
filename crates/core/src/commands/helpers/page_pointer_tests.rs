use super::overlap;

#[test]
fn only_the_part_of_a_control_inside_the_page_view_counts() {
    let view = crate::Rect {
        x: 0.0,
        y: 100.0,
        width: 800.0,
        height: 600.0,
    };
    let half_above = crate::Rect {
        x: 10.0,
        y: 80.0,
        width: 40.0,
        height: 40.0,
    };
    let visible = overlap(&half_above, &view).unwrap();
    assert_eq!((visible.y, visible.height), (100.0, 20.0));
    let below = crate::Rect {
        x: 10.0,
        y: 900.0,
        width: 40.0,
        height: 40.0,
    };
    assert!(overlap(&below, &view).is_none());
}
