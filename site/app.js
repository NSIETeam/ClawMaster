const windowsDownload = {
  label: '下载 Windows x64',
  href: 'https://github.com/NSIETeam/ClawMaster/releases/download/v0.0.2-beta.2/ClawMaster_0.0.2-2_x64-setup.exe',
};

const macDownload = {
  label: '下载 macOS ARM64',
  href: 'https://github.com/NSIETeam/ClawMaster/releases/download/v0.0.2-beta.2/ClawMaster_0.0.2-beta.2_aarch64.dmg',
};

const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
const primaryDownload = isMac ? macDownload : windowsDownload;

document.querySelectorAll('.js-primary-download').forEach((link) => {
  link.href = primaryDownload.href;
  link.firstChild.textContent = `${primaryDownload.label} `;
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
