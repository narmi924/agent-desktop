use super::*;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetDesktopWindow, WindowFromPoint};

fn ole_loaded() {
    let name: Vec<u16> = "ole32.dll\0".encode_utf16().collect();
    let module = unsafe { windows_sys::Win32::System::LibraryLoader::LoadLibraryW(name.as_ptr()) };
    assert!(!module.is_null());
}

#[test]
fn the_redirect_finds_the_ole_entries_answers_only_the_drop_thread_and_restores_them() {
    ole_loaded();
    let base =
        unsafe { GetModuleHandleW("ole32.dll\0".encode_utf16().collect::<Vec<u16>>().as_ptr()) }
            as *const u8;
    let user32: Vec<u16> = "user32.dll\0".encode_utf16().collect();
    let real = unsafe { GetProcAddress(GetModuleHandleW(user32.as_ptr()), FUNCTION.as_ptr()) }
        .unwrap() as usize;
    let slots = unsafe { import_slots(base, real) };
    let before: Vec<usize> = slots
        .iter()
        .map(|slot| unsafe { slot.read_volatile() })
        .collect();

    let redirect = ImportRedirect::install().expect("OLE imports WindowFromPoint");
    let replacement = window_for_drop as WindowFromPointFn as usize;
    assert!(
        slots
            .iter()
            .all(|slot| unsafe { slot.read_volatile() } == replacement)
    );

    let marker = unsafe { GetDesktopWindow() };
    aim(marker, unsafe { GetCurrentThreadId() });
    let here = POINT { x: 1, y: 1 };
    assert_eq!(unsafe { window_for_drop(here) }, marker);
    assert!(times_asked() >= 1);
    let elsewhere = std::thread::spawn(move || unsafe { window_for_drop(here) } as isize)
        .join()
        .unwrap();
    assert_eq!(elsewhere, unsafe { WindowFromPoint(here) } as isize);

    drop(redirect);
    let after: Vec<usize> = slots
        .iter()
        .map(|slot| unsafe { slot.read_volatile() })
        .collect();
    assert_eq!(before, after);
    assert_eq!(RECEIVER.load(Ordering::Acquire), 0);
}
