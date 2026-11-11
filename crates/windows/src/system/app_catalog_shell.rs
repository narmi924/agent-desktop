//! Reads the Apps folder through the shell's item interfaces, on the calling
//! thread, which must not have chosen a COM apartment yet.

use agent_desktop_core::{AdapterError, ErrorCode};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize,
};
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, IShellItem2, KF_FLAG_DEFAULT,
    SHGetKnownFolderItem, SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};
use windows::core::{GUID, Interface, PWSTR};

use super::RawItem;

const LINK_TARGET_PARSING_PATH: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xb9b4b3fc_2b51_4a42_b5d8_324146afcf25),
    pid: 2,
};
const LINK_ARGUMENTS: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x436f2667_14e2_4feb_b30a_146c53b5b674),
    pid: 100,
};
const BATCH: usize = 64;

struct Apartment;

impl Apartment {
    fn enter() -> Result<Self, AdapterError> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|error| shell_error("join a single-threaded COM apartment", &error))?;
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub(super) fn read_apps_folder() -> Result<Vec<RawItem>, AdapterError> {
    let _apartment = Apartment::enter()?;
    let folder: IShellItem =
        unsafe { SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None) }
            .map_err(|error| shell_error("open the Apps folder", &error))?;
    let items: IEnumShellItems = unsafe { folder.BindToHandler(None, &BHID_EnumItems) }
        .map_err(|error| shell_error("list the Apps folder", &error))?;
    let mut raw = Vec::new();
    loop {
        let mut batch: [Option<IShellItem>; BATCH] = std::array::from_fn(|_| None);
        let mut fetched = 0_u32;
        let more = unsafe { items.Next(&mut batch, Some(&mut fetched)) };
        let count = (fetched as usize).min(BATCH);
        raw.extend(batch.iter().take(count).flatten().map(read_item));
        if more.is_err() || count < BATCH {
            break;
        }
    }
    Ok(raw)
}

fn read_item(item: &IShellItem) -> RawItem {
    let properties = item.cast::<IShellItem2>().ok();
    let property = |key: &PROPERTYKEY| {
        properties
            .as_ref()
            .and_then(|store| unsafe { store.GetString(key) }.ok())
            .and_then(take_string)
    };
    RawItem {
        name: display_name(item, SIGDN_NORMALDISPLAY),
        parsing_name: display_name(item, SIGDN_PARENTRELATIVEPARSING),
        link_target: property(&LINK_TARGET_PARSING_PATH),
        link_arguments: property(&LINK_ARGUMENTS),
    }
}

fn display_name(item: &IShellItem, form: SIGDN) -> String {
    unsafe { item.GetDisplayName(form) }
        .ok()
        .and_then(take_string)
        .unwrap_or_default()
}

/// Copies a shell-allocated string and frees it, so no caller can forget to.
fn take_string(text: PWSTR) -> Option<String> {
    if text.is_null() {
        return None;
    }
    let owned = unsafe { text.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(text.0.cast_const().cast())) };
    owned
}

fn shell_error(action: &str, error: &windows::core::Error) -> AdapterError {
    AdapterError::new(ErrorCode::Internal, format!("Cannot {action}")).with_platform_detail(
        format!("HRESULT 0x{:08X}: {}", error.code().0, error.message()),
    )
}
