use std::io;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GWL_EXSTYLE, GWL_STYLE, GetWindowLongW, STYLESTRUCT, SWP_FRAMECHANGED, SWP_NOACTIVATE,
            SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowLongW, SetWindowPos,
            WINDOW_LONG_PTR_INDEX, WM_NCACTIVATE, WM_NCDESTROY, WM_NCPAINT, WM_STYLECHANGING,
            WS_CAPTION, WS_EX_CLIENTEDGE, WS_EX_DLGMODALFRAME, WS_EX_STATICEDGE, WS_EX_WINDOWEDGE,
            WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
        },
    },
};

const SUBCLASS_ID: usize = 1;
const FRAME_STYLES: u32 =
    WS_CAPTION.0 | WS_SYSMENU.0 | WS_THICKFRAME.0 | WS_MINIMIZEBOX.0 | WS_MAXIMIZEBOX.0;
const FRAME_EXTENDED_STYLES: u32 =
    WS_EX_WINDOWEDGE.0 | WS_EX_CLIENTEDGE.0 | WS_EX_DLGMODALFRAME.0 | WS_EX_STATICEDGE.0;

pub(super) fn install(hwnd: HWND) -> tauri::Result<()> {
    // Tao keeps caption styles on borderless top-level windows. Windows can paint them
    // when the island's region changes, so remove them before the window is shown.
    unsafe {
        if !SetWindowSubclass(hwnd, Some(frame_proc), SUBCLASS_ID, 0).as_bool() {
            return Err(io::Error::other("Could not install the island frame handler").into());
        }
        for (index, mask) in [
            (GWL_STYLE, FRAME_STYLES),
            (GWL_EXSTYLE, FRAME_EXTENDED_STYLES),
        ] {
            let style = GetWindowLongW(hwnd, index) as u32;
            SetWindowLongW(hwnd, index, (style & !mask) as i32);
        }
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        )
        .map_err(io::Error::other)?;
    }
    Ok(())
}

unsafe extern "system" fn frame_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    let mut lparam = lparam;
    match message {
        super::outside_click::OUTSIDE_CLICK => {
            super::outside_click::notify(hwnd);
            return LRESULT(0);
        }
        WM_STYLECHANGING if lparam.0 != 0 => {
            let mask = match WINDOW_LONG_PTR_INDEX(wparam.0 as i32) {
                GWL_STYLE => FRAME_STYLES,
                GWL_EXSTYLE => FRAME_EXTENDED_STYLES,
                _ => 0,
            };
            // Windows supplies a writable STYLESTRUCT for this message.
            unsafe { (*(lparam.0 as *mut STYLESTRUCT)).styleNew &= !mask };
        }
        WM_NCPAINT => return LRESULT(0),
        // Forward activation so Tao still updates focus, with native repaint suppressed.
        WM_NCACTIVATE => lparam = LPARAM(-1),
        WM_NCDESTROY => unsafe {
            super::outside_click::stop(hwnd);
            let _ = RemoveWindowSubclass(hwnd, Some(frame_proc), id);
        },
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}
