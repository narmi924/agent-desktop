//! The files of a drop as the shell's own data object, the same object File
//! Explorer hands to a window when a person drags files out of a folder.

use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};
use std::path::{Path, PathBuf};
use windows::Win32::System::Com::IDataObject;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    BHID_DataObject, ILFree, SHCreateShellItemArrayFromIDLists, SHParseDisplayName,
};
use windows::core::HSTRING;

/// The folder every file of one drop sits in. The shell builds one data
/// object per folder, as Explorer does, so files from several folders are
/// refused before anything is dragged.
pub(crate) fn shared_folder(files: &[PathBuf]) -> Result<&Path, AdapterError> {
    let first = files
        .first()
        .and_then(|file| file.parent())
        .ok_or_else(|| refused("Name at least one file to drop"))?;
    if files.iter().any(|file| file.parent() != Some(first)) {
        return Err(refused(
            "All files of one drop must be in the same folder, as when dragging them out of one Explorer window",
        ));
    }
    Ok(first)
}

fn refused(message: &str) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
        .with_disposition(DeliverySemantics::not_delivered())
}

/// Owns the item id lists the data object was built from.
struct ItemList(Vec<*mut ITEMIDLIST>);

impl Drop for ItemList {
    fn drop(&mut self) {
        for item in &self.0 {
            unsafe { ILFree(Some(*item as *const ITEMIDLIST)) };
        }
    }
}

/// Builds the shell data object for `files`. Runs on the drop thread after
/// OLE was initialized there.
pub(crate) fn shell_data_object(files: &[PathBuf]) -> Result<IDataObject, AdapterError> {
    shared_folder(files)?;
    let mut items = ItemList(Vec::with_capacity(files.len()));
    for file in files {
        let mut item: *mut ITEMIDLIST = std::ptr::null_mut();
        unsafe { SHParseDisplayName(&HSTRING::from(file.as_os_str()), None, &mut item, 0, None) }
            .map_err(|error| shell_failure("A file could not be handed to the shell", &error))?;
        items.0.push(item);
    }
    let pointers: Vec<*const ITEMIDLIST> = items.0.iter().map(|item| *item as _).collect();
    let array = unsafe { SHCreateShellItemArrayFromIDLists(&pointers) }
        .map_err(|error| shell_failure("The shell could not group the files", &error))?;
    unsafe { array.BindToHandler::<_, IDataObject>(None, &BHID_DataObject) }
        .map_err(|error| shell_failure("The shell could not offer the files for a drop", &error))
}

fn shell_failure(message: &str, error: &windows::core::Error) -> AdapterError {
    AdapterError::new(ErrorCode::ActionFailed, message)
        .with_platform_detail(format!("HRESULT 0x{:08X}", error.code().0))
        .with_disposition(DeliverySemantics::not_delivered())
}
