/**
 * Password-Protected PDF Unlock Modal
 * Prompts the user to unlock encrypted PDF documents with retry support.
 */

import { getIconSvg } from '../../utils/icons';
import { tr } from '../i18n';

export type PasswordVerifyResult = boolean | { ok: boolean; errorMessage?: string };

export interface PromptPdfPasswordOptions {
  isRetry?: boolean;
  onVerify?: (password: string) => Promise<PasswordVerifyResult>;
}

export function promptPdfPassword(
  docName: string,
  optionsOrIsRetry: boolean | PromptPdfPasswordOptions = false
): Promise<string | null> {
  const opts: PromptPdfPasswordOptions =
    typeof optionsOrIsRetry === 'boolean' ? { isRetry: optionsOrIsRetry } : optionsOrIsRetry;
  const initialRetry = Boolean(opts.isRetry);

  return new Promise<string | null>((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);

    let settled = false;
    let verifying = false;
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      resolve(val);
    };

    const safeName = (docName || 'Document.pdf').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    host.innerHTML = `
      <div class="modal-overlay" id="pdf-pwd-overlay">
        <div class="modal-dialog form-dialog" role="dialog" aria-modal="true" aria-label="${tr('Password Protected PDF', 'فایل PDF رمزگذاری‌شده')}" style="max-width:410px; width:92vw;">
          <div class="panel-header">
            <span>${getIconSvg('lock', 15)} ${tr('Password Required', 'نیاز به رمز عبور')}</span>
            <button type="button" id="pdf-pwd-close" class="icon-btn" title="${tr('Cancel', 'انصراف')}" aria-label="${tr('Cancel', 'انصراف')}">${getIconSvg('close', 14)}</button>
          </div>
          <div class="form-dialog-body">
            <div style="font-size:13px; color:var(--text-secondary); line-height:1.5;">
              ${tr(
                `<strong>${safeName}</strong> is encrypted. Enter the document password to open it.`,
                `فایل <strong>${safeName}</strong> رمزگذاری شده است. برای باز کردن آن رمز عبور را وارد کنید.`
              )}
            </div>

            <div id="pdf-pwd-error" style="display:${initialRetry ? 'flex' : 'none'}; align-items:center; gap:8px; padding:8px 10px; border-radius:8px; background:var(--danger-subtle, rgba(239,68,68,0.12)); color:var(--danger, #ef4444); font-size:12px; font-weight:600;" role="alert">
              ${getIconSvg('alertTriangle', 15)}
              <span id="pdf-pwd-error-text">${tr('Incorrect password. Please try again.', 'رمز عبور نادرست است. لطفاً دوباره تلاش کنید.')}</span>
            </div>

            <label class="form-field">
              <span class="form-label">${tr('Document Password', 'رمز عبور سند')}</span>
              <div style="position:relative; display:flex; align-items:center;">
                <input id="pdf-pwd-input" class="field" type="password" placeholder="${tr('Enter password…', 'رمز عبور را وارد کنید…')}" style="width:100%; padding-inline-end:36px;" autocomplete="off" />
                <button type="button" id="pdf-pwd-toggle" class="icon-btn" style="position:absolute; inset-inline-end:4px; width:28px; height:28px;" title="${tr('Show / Hide Password', 'نمایش / مخفی کردن رمز')}" aria-label="${tr('Show / Hide Password', 'نمایش / مخفی کردن رمز')}">
                  ${getIconSvg('eye', 15)}
                </button>
              </div>
            </label>

            <div class="form-actions">
              <button type="button" id="pdf-pwd-cancel" class="header-btn">${tr('Cancel', 'انصراف')}</button>
              <button type="button" id="pdf-pwd-submit" class="header-btn primary">${getIconSvg('unlock', 14)}<span id="pdf-pwd-submit-label">${tr('Unlock PDF', 'باز کردن قفل')}</span></button>
            </div>
          </div>
        </div>
      </div>
    `;

    const input = host.querySelector<HTMLInputElement>('#pdf-pwd-input');
    const toggleBtn = host.querySelector<HTMLButtonElement>('#pdf-pwd-toggle');
    const submitBtn = host.querySelector<HTMLButtonElement>('#pdf-pwd-submit');
    const submitLabel = host.querySelector<HTMLElement>('#pdf-pwd-submit-label');
    const errorBox = host.querySelector<HTMLElement>('#pdf-pwd-error');
    const errorText = host.querySelector<HTMLElement>('#pdf-pwd-error-text');

    const setBusy = (busy: boolean) => {
      verifying = busy;
      if (input) input.disabled = busy;
      if (submitBtn) submitBtn.disabled = busy;
      if (submitLabel) {
        submitLabel.textContent = busy
          ? tr('Checking…', 'در حال بررسی…')
          : tr('Unlock PDF', 'باز کردن قفل');
      }
    };

    const showInlineError = (msg?: string) => {
      if (errorText) {
        errorText.textContent = msg || tr('Incorrect password. Please try again.', 'رمز عبور نادرست است. لطفاً دوباره تلاش کنید.');
      }
      if (errorBox) errorBox.style.display = 'flex';
    };

    const trySubmit = async () => {
      if (verifying || settled) return;
      const candidate = input?.value ?? '';
      if (!candidate) {
        input?.focus();
        return;
      }

      if (!opts.onVerify) {
        finish(candidate);
        return;
      }

      setBusy(true);
      if (errorBox) errorBox.style.display = 'none';
      try {
        const res = await opts.onVerify(candidate);
        const ok = typeof res === 'boolean' ? res : res.ok;
        if (ok) {
          finish(candidate);
          return;
        }
        setBusy(false);
        showInlineError(typeof res === 'object' ? res.errorMessage : undefined);
        if (input) {
          input.value = '';
          requestAnimationFrame(() => input.focus());
        }
      } catch (err: any) {
        setBusy(false);
        showInlineError(err?.message ? String(err.message) : undefined);
        if (input) {
          requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        }
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !verifying) {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void trySubmit();
      }
    };
    window.addEventListener('keydown', onKey, true);

    toggleBtn?.addEventListener('click', () => {
      if (!input) return;
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      toggleBtn.innerHTML = getIconSvg(isPwd ? 'eyeOff' : 'eye', 15);
      input.focus();
    });

    host.querySelector('#pdf-pwd-close')?.addEventListener('click', () => finish(null));
    host.querySelector('#pdf-pwd-cancel')?.addEventListener('click', () => finish(null));
    host.querySelector('#pdf-pwd-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'pdf-pwd-overlay' && !verifying) finish(null);
    });
    submitBtn?.addEventListener('click', () => {
      void trySubmit();
    });

    requestAnimationFrame(() => input?.focus());
  });
}

