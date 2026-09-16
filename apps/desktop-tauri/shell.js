    window.DSH_I18N.apply()

    const closePrompt = document.getElementById('close-prompt')
    function setClosePrompt(open) {
      closePrompt.hidden = !open
    }
    function dismissClosePrompt() {
      setClosePrompt(false)
      window.__TAURI__?.core?.invoke('dismiss_close_prompt')
    }
    async function chooseClose(action) {
      setClosePrompt(false)
      const invoke = window.__TAURI__?.core?.invoke
      if (invoke) await invoke('set_close_action', { action })
    }
    closePrompt.querySelectorAll('[data-dismiss]').forEach((el) => {
      el.addEventListener('click', dismissClosePrompt)
    })
    document.getElementById('close-minimize').onclick = () => chooseClose('minimize')
    document.getElementById('close-exit').onclick = () => chooseClose('exit')
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !closePrompt.hidden) dismissClosePrompt()
    })
    window.__DSH_CLOSE_PROMPT__ = {
      show() { setClosePrompt(true) },
      hide() { setClosePrompt(false) },
    }
