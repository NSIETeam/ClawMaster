//! Attribute-by-attribute AX access; obtaining children never reads their text.
use super::{
    read_selected, ChatNode, ReadRequest, ReadResult, CHANGED, MAX_SCAN_NODES, UNSUPPORTED,
};
use accessibility::{AXAttribute, AXUIElement, AXUIElementAttributes};
use accessibility_sys::{
    kAXValueTypeCGPoint, kAXValueTypeCGSize, AXIsProcessTrusted, AXValueGetType, AXValueGetTypeID,
    AXValueGetValue, AXValueRef,
};
use core_foundation::{
    base::{CFType, TCFType},
    boolean::CFBoolean,
    string::CFString,
};
use core_graphics_types::geometry::{CGPoint, CGSize};
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::NSString;
use xa11y::{Rect, Role};

const BUNDLE_ID: &str = "com.tencent.xinWeChat";

#[derive(Clone)]
struct Node(AXUIElement);

impl Node {
    fn attribute(&self, name: &str) -> Option<CFType> {
        self.0
            .attribute(&AXAttribute::new(&CFString::new(name)))
            .ok()
    }
}

impl ChatNode for Node {
    fn role(&self) -> Result<Role, String> {
        let role = self
            .0
            .role()
            .map_err(|_| UNSUPPORTED.to_owned())?
            .to_string();
        Ok(match role.as_str() {
            "AXWindow" => Role::Window,
            "AXGroup" | "AXScrollArea" => Role::Group,
            "AXSplitGroup" => Role::SplitGroup,
            "AXList" => Role::List,
            "AXStaticText" => Role::StaticText,
            "AXListItem" => Role::ListItem,
            _ => Role::Unknown,
        })
    }
    fn identifier(&self) -> Option<String> {
        self.0.identifier().ok().map(|s| s.to_string())
    }
    fn title(&self) -> Option<String> {
        self.0.title().ok().map(|s| s.to_string())
    }
    fn text(&self) -> Result<String, String> {
        let value = self
            .0
            .value()
            .ok()
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string());
        value
            .filter(|text| !text.is_empty())
            .or_else(|| self.title())
            .ok_or_else(|| UNSUPPORTED.to_owned())
    }
    fn bounds(&self) -> Option<Rect> {
        let position = self.attribute("AXPosition")?;
        let size = self.attribute("AXSize")?;
        let mut point = CGPoint::new(0.0, 0.0);
        let mut extent = CGSize::new(0.0, 0.0);
        // CF ownership remains with position/size. The type and AX payload kind
        // are checked before the system copies bytes into the matching C structs.
        unsafe {
            if position.type_of() != AXValueGetTypeID()
                || size.type_of() != AXValueGetTypeID()
                || AXValueGetType(position.as_CFTypeRef() as AXValueRef) != kAXValueTypeCGPoint
                || AXValueGetType(size.as_CFTypeRef() as AXValueRef) != kAXValueTypeCGSize
                || !AXValueGetValue(
                    position.as_CFTypeRef() as AXValueRef,
                    kAXValueTypeCGPoint,
                    (&mut point as *mut CGPoint).cast(),
                )
                || !AXValueGetValue(
                    size.as_CFTypeRef() as AXValueRef,
                    kAXValueTypeCGSize,
                    (&mut extent as *mut CGSize).cast(),
                )
            {
                return None;
            }
        }
        if ![point.x, point.y, extent.width, extent.height]
            .into_iter()
            .all(f64::is_finite)
            || point.x < i32::MIN as f64
            || point.x > i32::MAX as f64
            || point.y < i32::MIN as f64
            || point.y > i32::MAX as f64
            || extent.width <= 0.0
            || extent.width > u32::MAX as f64
            || extent.height <= 0.0
            || extent.height > u32::MAX as f64
        {
            return None;
        }
        Some(Rect {
            x: point.x as i32,
            y: point.y as i32,
            width: extent.width as u32,
            height: extent.height as u32,
        })
    }
    fn visible(&self) -> bool {
        !self
            .attribute("AXHidden")
            .and_then(|v| v.downcast::<CFBoolean>())
            .is_some_and(bool::from)
    }
    fn editable(&self) -> bool {
        self.0.is_settable(&AXAttribute::value()).unwrap_or(true)
    }
    fn children(&self) -> Result<Vec<Self>, String> {
        let refs = self.0.children().map_err(|_| UNSUPPORTED.to_owned())?;
        if refs.len() > MAX_SCAN_NODES as isize {
            return Err(UNSUPPORTED.into());
        }
        Ok(refs
            .iter()
            .map(|element| Node((*element).clone()))
            .collect())
    }
}

fn main_window(app: &AXUIElement) -> Result<Node, String> {
    let window = app.main_window().map_err(|_| UNSUPPORTED.to_owned())?;
    if bool::from(window.minimized().map_err(|_| UNSUPPORTED.to_owned())?) {
        return Err(UNSUPPORTED.into());
    }
    let node = Node(window);
    if node.role()? != Role::Window || !node.visible() {
        return Err(UNSUPPORTED.into());
    }
    Ok(node)
}

pub(super) fn read(request: &ReadRequest) -> Result<ReadResult, String> {
    // This read-only predicate never opens the system consent dialog.
    if !unsafe { AXIsProcessTrusted() } {
        return Err("ClawMaster 尚未获得 macOS 辅助功能授权；未探测微信。请在系统设置 → 隐私与安全性 → 辅助功能中授权后重试。".into());
    }
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(
        BUNDLE_ID,
    ));
    if apps.len() != 1 {
        return Err("请打开并登录唯一一个微信应用，在主窗口手动选定本次授权的聊天。".into());
    }
    let process = apps.objectAtIndex(0);
    if process.isTerminated()
        || process
            .bundleIdentifier()
            .as_deref()
            .map(NSString::to_string)
            .as_deref()
            != Some(BUNDLE_ID)
    {
        return Err("无法核验微信应用身份；未读取聊天。".into());
    }
    let pid = process.processIdentifier();
    if pid <= 0 {
        return Err("无法核验微信应用进程；未读取聊天。".into());
    }
    let app = AXUIElement::application(pid);
    app.set_messaging_timeout(2.0).map_err(|_| {
        "微信辅助功能接口不可用，请检查 ClawMaster 的 macOS 辅助功能授权。".to_owned()
    })?;
    read_selected(request, main_window(&app)?, || {
        if process.isTerminated()
            || process.processIdentifier() != pid
            || process
                .bundleIdentifier()
                .as_deref()
                .map(NSString::to_string)
                .as_deref()
                != Some(BUNDLE_ID)
        {
            return Err(CHANGED.into());
        }
        main_window(&app)
    })
}
