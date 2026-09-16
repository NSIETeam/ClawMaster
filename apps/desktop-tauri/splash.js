    window.DSH_I18N.apply()
    const statusEl = document.getElementById('status')
    const barEl = document.getElementById('bar')
    const progressEl = document.querySelector('.track')
    const errorEl = document.getElementById('error')
    window.__DSH_SPLASH__ = {
      setStatus(text) { statusEl.textContent = text },
      setProgress(pct) {
        const value = Math.min(100, Math.max(0, pct))
        barEl.style.width = value + '%'
        progressEl.setAttribute('aria-valuenow', String(value))
      },
      setError(text) {
        document.body.classList.add('failed')
        errorEl.style.display = 'block'
        errorEl.textContent = text
        statusEl.textContent = window.DSH_I18N.t('splash.failed')
      },
    }
