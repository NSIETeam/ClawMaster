const checksumNodes = new Map(
  Array.from(document.querySelectorAll('[data-release-sha]'), (node) => [node.dataset.releaseSha, node]),
);

document.querySelectorAll('[data-release-copy]').forEach((button) => {
  const originalLabel = button.textContent;
  button.setAttribute('aria-live', 'polite');

  button.addEventListener('click', async () => {
    const checksum = checksumNodes.get(button.dataset.releaseCopy)?.textContent.trim();
    button.disabled = true;

    try {
      if (!checksum) throw new Error('Missing displayed checksum');
      await navigator.clipboard.writeText(checksum);
      button.textContent = '已复制';
    } catch {
      button.textContent = '请手动复制';
    }

    window.setTimeout(() => {
      button.textContent = originalLabel;
      button.disabled = false;
    }, 1800);
  });
});

const year = document.getElementById('year');
if (year) year.textContent = String(new Date().getFullYear());

const reveals = document.querySelectorAll('.reveal');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if ('IntersectionObserver' in window && !reducedMotion) {
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
