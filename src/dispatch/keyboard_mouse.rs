use agent_desktop_core::{
    AppError, MouseButton, MouseEvent, MouseEventKind, PlatformAdapter, Point,
    commands::{
        drag as drag_command, drop_files as drop_files_command, frame_pointer, helpers,
        hover as hover_command, key_down as key_down_command, key_up as key_up_command,
        mouse_click as mouse_click_command, mouse_down as mouse_down_command,
        mouse_move as mouse_move_command, mouse_up as mouse_up_command,
        mouse_wheel as mouse_wheel_command, press as press_command,
    },
    context::CommandContext,
};
use serde_json::Value;

use crate::cli_args::{
    actions::{HoverArgs, KeyComboArgs, MouseClickArgs, MouseMoveArgs, MousePointArgs, PressArgs},
    drag::DragCliArgs,
    file_drop::DropFilesArgs,
    mouse_wheel::MouseWheelArgs,
};
use crate::dispatch::parse::{parse_modifiers, parse_mouse_button, parse_xy, parse_xy_opt};

pub(super) fn press(
    args: PressArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    press_command::execute(
        press_command::PressArgs {
            combo: args.combo,
            app: args.app,
            window_id: args.window_id,
            force: args.force,
        },
        adapter,
        context,
    )
}

pub(super) fn key_down(
    args: KeyComboArgs,
    adapter: &dyn PlatformAdapter,
) -> Result<Value, AppError> {
    key_down_command::execute(
        key_down_command::KeyDownArgs {
            combo: args.combo,
            force: args.force,
        },
        adapter,
    )
}

pub(super) fn key_up(args: KeyComboArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    key_up_command::execute(
        key_up_command::KeyUpArgs {
            combo: args.combo,
            force: args.force,
        },
        adapter,
    )
}

pub(super) fn hover(
    args: HoverArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    hover_command::execute(
        hover_command::HoverArgs {
            ref_id: args.ref_id,
            xy: parse_xy_opt(args.xy.as_deref())?,
            duration_ms: args.duration,
            timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
        },
        adapter,
        context,
    )
}

pub(super) fn drag(
    args: DragCliArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let request = drag_command::DragArgs {
        from: drag_command::DragEndpoint {
            ref_id: args.target.from,
            xy: parse_xy_opt(args.target.from_xy.as_deref())?,
        },
        to: drag_command::DragEndpoint {
            ref_id: args.target.to,
            xy: parse_xy_opt(args.target.to_xy.as_deref())?,
        },
        duration_ms: args.duration,
        drop_delay_ms: args.drop_delay,
        timeout_ms: helpers::normalize_action_timeout_ms(args.timeout_ms),
        wait_for_scope: args
            .wait_for_scope
            .map(crate::cli_args::drag::WaitForScopeArg::to_core)
            .unwrap_or_default(),
    };
    match (args.from_frame, args.to_frame) {
        (None, None) => drag_command::execute(request, adapter, context),
        (Some(from), Some(to)) => {
            drag_command::frame::execute(request, &from, &to, adapter, context)
        }
        _ => Err(AppError::invalid_input(
            "Provide both --from-frame and --to-frame",
        )),
    }
}

pub(super) fn drop_files(
    args: DropFilesArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let xy = parse_xy_opt(args.xy.as_deref())?;
    let place = match (args.ref_id.as_deref(), args.frame.as_deref(), xy) {
        (Some(ref_id), None, None) => drop_files_command::DropPlace::Ref(ref_id),
        (None, Some(image), Some((x, y))) => drop_files_command::DropPlace::Frame { image, x, y },
        _ => {
            return Err(AppError::invalid_input(
                "Give either --ref, or --frame with --xy",
            ));
        }
    };
    drop_files_command::execute(
        drop_files_command::DropFilesArgs {
            files: args.files,
            place,
        },
        adapter,
        context,
    )
}

pub(super) fn mouse_move(
    args: MouseMoveArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let (x, y) = parse_xy(&args.xy)?;
    if let Some(image) = &args.frame {
        return frame_pointer::execute(
            frame_pointer::FramePointer { image, x, y },
            MouseEvent {
                point: Point { x, y },
                kind: MouseEventKind::Move,
                button: MouseButton::Left,
                modifiers: Vec::new(),
            },
            adapter,
            context,
        );
    }
    if let Some(page) = crate::cli_args::mouse_wheel::binding(&args.page_refs)? {
        return helpers::page_pointer::execute(
            page,
            MouseEvent {
                point: Point { x, y },
                kind: MouseEventKind::Move,
                button: MouseButton::Left,
                modifiers: Vec::new(),
            },
            adapter,
            context,
        );
    }
    mouse_move_command::execute(mouse_move_command::MouseMoveArgs { x, y }, adapter, context)
}

pub(super) fn mouse_click(
    args: MouseClickArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let (x, y) = parse_xy(&args.xy)?;
    if let Some(image) = &args.frame {
        let target = frame_pointer::FramePointer { image, x, y };
        let event = MouseEvent {
            point: Point { x, y },
            kind: MouseEventKind::Click { count: args.count },
            button: parse_mouse_button(&args.button)?,
            modifiers: parse_modifiers(&args.modifiers)?,
        };
        if args.post {
            return frame_pointer::post_click(target, event, adapter);
        }
        return frame_pointer::execute(target, event, adapter, context);
    }
    if let Some(page) = crate::cli_args::mouse_wheel::binding(&args.page_refs)? {
        return helpers::page_pointer::execute(
            page,
            MouseEvent {
                point: Point { x, y },
                kind: MouseEventKind::Click { count: args.count },
                button: parse_mouse_button(&args.button)?,
                modifiers: parse_modifiers(&args.modifiers)?,
            },
            adapter,
            context,
        );
    }
    mouse_click_command::execute(
        mouse_click_command::MouseClickArgs {
            x,
            y,
            button: parse_mouse_button(&args.button)?,
            count: args.count,
            modifiers: parse_modifiers(&args.modifiers)?,
            hold_ms: args.hold_ms,
        },
        adapter,
        context,
    )
}

pub(super) fn mouse_down(
    args: MousePointArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let (x, y) = parse_xy(&args.xy)?;
    mouse_down_command::execute(
        mouse_down_command::MouseDownArgs {
            x,
            y,
            button: parse_mouse_button(&args.button)?,
            modifiers: parse_modifiers(&args.modifiers)?,
        },
        adapter,
        context,
    )
}

pub(super) fn mouse_up(
    args: MousePointArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    let (x, y) = parse_xy(&args.xy)?;
    mouse_up_command::execute(
        mouse_up_command::MouseUpArgs {
            x,
            y,
            button: parse_mouse_button(&args.button)?,
            modifiers: parse_modifiers(&args.modifiers)?,
        },
        adapter,
        context,
    )
}

pub(super) fn mouse_wheel(
    args: MouseWheelArgs,
    adapter: &dyn PlatformAdapter,
    context: &CommandContext,
) -> Result<Value, AppError> {
    if let Some(page) = crate::cli_args::mouse_wheel::binding(&args.page_refs)? {
        return helpers::page_pointer::execute(
            page,
            MouseEvent {
                point: Point {
                    x: args.x,
                    y: args.y,
                },
                kind: MouseEventKind::Wheel {
                    delta_x: args.dx,
                    delta_y: args.vertical_lines(),
                },
                button: MouseButton::Left,
                modifiers: parse_modifiers(&args.modifiers)?,
            },
            adapter,
            context,
        );
    }
    mouse_wheel_command::execute(
        mouse_wheel_command::MouseWheelArgs {
            x: args.x,
            y: args.y,
            dy: args.vertical_lines(),
            dx: args.dx,
            modifiers: parse_modifiers(&args.modifiers)?,
        },
        adapter,
        context,
    )
}

#[cfg(test)]
#[path = "keyboard_mouse_tests.rs"]
mod tests;
