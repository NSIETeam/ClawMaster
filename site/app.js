let windowsDownload = {
  label: '下载 Windows x64',
  href: 'https://github.com/NSIETeam/ClawMaster/releases/download/v0.0.2-beta.2/ClawMaster_0.0.2-2_x64-setup.exe',
};

let macDownload = {
  label: '下载 macOS ARM64',
  href: 'https://github.com/NSIETeam/ClawMaster/releases/download/v0.0.2-beta.2/ClawMaster_0.0.2-beta.2_aarch64.dmg',
};

const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);

function applyManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !manifest.assets?.windows || !manifest.assets?.mac) return;
  windowsDownload = { label: '下载 Windows x64', href: manifest.assets.windows.url };
  macDownload = { label: '下载 macOS ARM64', href: manifest.assets.mac.url };

  document.querySelectorAll('[data-release-version]').forEach((node) => { node.textContent = manifest.version; });
  document.querySelectorAll('[data-release-link="windows"]').forEach((link) => { link.href = manifest.assets.windows.url; });
  document.querySelectorAll('[data-release-link="mac"]').forEach((link) => { link.href = manifest.assets.mac.url; });
  document.querySelectorAll('[data-release-link="msi"]').forEach((link) => {
    link.href = manifest.assets.windowsMsi.url;
    link.textContent = `下载 MSI（${manifest.assets.windowsMsi.size}）`;
  });
  document.querySelectorAll('[data-release-link="checksums"]').forEach((link) => { link.href = manifest.checksumsUrl; });
  document.querySelectorAll('[data-release-link="notes"]').forEach((link) => { link.href = manifest.releaseUrl; });
  document.querySelector('[data-release-size="windows"]').textContent = manifest.assets.windows.size;
  document.querySelector('[data-release-size="mac"]').textContent = manifest.assets.mac.size;

  for (const platform of ['windows', 'mac']) {
    const checksum = manifest.assets[platform].sha256;
    document.querySelector(`[data-release-sha="${platform}"]`).textContent = checksum;
    document.querySelector(`[data-release-copy="${platform}"]`).dataset.copy = checksum;
  }
}

fetch('release-manifest.json', { cache: 'no-cache' })
  .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
  .then(applyManifest)
  .catch(() => {})
  .finally(() => {
    const primaryDownload = isMac ? macDownload : windowsDownload;
    document.querySelectorAll('.js-primary-download').forEach((link) => {
      link.href = primaryDownload.href;
      link.firstChild.textContent = `${primaryDownload.label} `;
    });
  });

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const originalLabel = button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = '已复制';
    } catch {
      button.textContent = '请手动复制';
    }
    window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1800);
  });
});

document.getElementById('year').textContent = String(new Date().getFullYear());

const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12 },
  );
  reveals.forEach((element) => observer.observe(element));
} else {
  reveals.forEach((element) => element.classList.add('is-visible'));
}
