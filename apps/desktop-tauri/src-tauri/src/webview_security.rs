//! Native privilege and navigation limits for the shell's separate Host WebView.

use url::Url;

/// The Host is a desktop-owned HTTP listener on an explicit loopback port.
pub fn validate_host_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1") | Some("[::1]"))
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Desktop Host must use an explicit loopback HTTP origin".into());
    }
    Ok(())
}

/// Auth redirects and client routes stay on the exact Host origin, including port.
pub fn allows_host_navigation(host: &Url, target: &Url) -> bool {
    validate_host_url(host).is_ok()
        && target.origin() == host.origin()
        && target.username().is_empty()
        && target.password().is_none()
}

/// Destinations permitted for Host links requesting a separate browsing context.
#[derive(Debug, PartialEq, Eq)]
pub enum LinkDestination {
    /// The bundled Office notice keeps the Host cookie in an unprivileged document view.
    OfficeNotice,
    /// HTTP(S) references open through the operating system's default browser.
    ExternalBrowser,
    /// Local listeners, credentials and executable protocols never reach a launcher.
    Denied,
}

/// Classify a link without granting the content WebView a native command.
pub fn link_destination(host: &Url, target: &Url) -> LinkDestination {
    if validate_host_url(host).is_err()
        || !matches!(target.scheme(), "http" | "https")
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return LinkDestination::Denied;
    }
    if target.origin() == host.origin() {
        return if target.path() == "/clawmaster/office/runtime/NOTICE.html"
            && target.query().is_none()
        {
            LinkDestination::OfficeNotice
        } else {
            LinkDestination::Denied
        };
    }
    match target.host() {
        Some(url::Host::Ipv4(ip)) if ip.is_loopback() || ip.is_unspecified() => {
            LinkDestination::Denied
        }
        Some(url::Host::Ipv6(ip))
            if ip.is_loopback()
                || ip.is_unspecified()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|ip| ip.is_loopback() || ip.is_unspecified()) =>
        {
            LinkDestination::Denied
        }
        Some(url::Host::Domain(name))
            if name.trim_end_matches('.') == "localhost"
                || name.trim_end_matches('.').ends_with(".localhost") =>
        {
            LinkDestination::Denied
        }
        None => LinkDestination::Denied,
        _ => LinkDestination::ExternalBrowser,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_owned_host_routes_and_rejects_other_origins() {
        let host = Url::parse("http://127.0.0.1:17890/login?token=fixture").unwrap();
        for target in [
            "http://127.0.0.1:17890/",
            "http://127.0.0.1:17890/session/example",
        ] {
            assert!(allows_host_navigation(&host, &Url::parse(target).unwrap()));
        }
        for target in [
            "http://127.0.0.1:17891/",
            "http://localhost:17890/",
            "https://127.0.0.1:17890/",
            "http://user@127.0.0.1:17890/",
            "https://example.com/",
            "tauri://localhost/shell.html",
            "javascript:alert(1)",
            "data:text/html,example",
            "file:///tmp/example.html",
        ] {
            assert!(
                !allows_host_navigation(&host, &Url::parse(target).unwrap()),
                "{target}"
            );
        }
    }

    #[test]
    fn refuses_unowned_boot_origins() {
        for target in [
            "http://127.0.0.1/",
            "http://localhost:17890/",
            "https://example.com:17890/",
            "http://user:password@127.0.0.1:17890/",
        ] {
            assert!(
                validate_host_url(&Url::parse(target).unwrap()).is_err(),
                "{target}"
            );
        }
        assert!(validate_host_url(&Url::parse("http://[::1]:17890/").unwrap()).is_ok());
    }

    #[test]
    fn external_links_never_open_local_credentials_or_executable_protocols() {
        let host = Url::parse("http://127.0.0.1:17890/login?token=fixture").unwrap();
        for link in [
            "https://example.com/reference?q=hello#source",
            "http://intranet.example/help",
        ] {
            assert_eq!(
                link_destination(&host, &Url::parse(link).unwrap()),
                LinkDestination::ExternalBrowser
            );
        }
        for link in [
            "http://127.0.0.1:17890/login?token=fixture",
            "http://127.0.0.1:17891/",
            "http://127.1/",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://localhost./",
            "http://sub.localhost/",
            "https://user:secret@example.com/",
            "javascript:alert(1)",
            "data:text/html,example",
            "file:///tmp/example.html",
            "tauri://localhost/shell.html",
            "mailto:user@example.com",
            "http://127.0.0.1:17890/clawmaster/office/runtime/NOTICE.html?token=fixture",
        ] {
            assert_eq!(
                link_destination(&host, &Url::parse(link).unwrap()),
                LinkDestination::Denied,
                "{link}"
            );
        }
    }

    #[test]
    fn office_notice_stays_in_the_authenticated_document_view() {
        let host = Url::parse("http://127.0.0.1:17890/").unwrap();
        let notice = host
            .join("/clawmaster/office/runtime/NOTICE.html#licenses")
            .unwrap();
        assert_eq!(
            link_destination(&host, &notice),
            LinkDestination::OfficeNotice
        );
        assert_eq!(
            link_destination(&Url::parse("https://example.com/").unwrap(), &notice),
            LinkDestination::Denied
        );
    }
}
