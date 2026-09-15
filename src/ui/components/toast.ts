/**
 * Toast notifications.
 *
 * A toast carries an intent so success, failure and progress read differently
 * at a glance rather than all arriving as identical grey pills.
 */

import { getIconSvg } from '../../utils/icons';

export type ToastVariant = 'info' | 'success' | 'error' | 'progress';

const VARIANT_ICONS: Record<ToastVariant, string | null> = {
  info: 'info',
  success: 'check',
  error: 'alertTriangle',
  progress: null
};

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export function showToast(
  message: string,
  variant: ToastVariant = 'info',
  durationMs = 3000,
  action?: ToastAction
): void {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast is-${variant}`;
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  const iconName = VARIANT_ICONS[variant];
  // Progress toasts get an indeterminate spinner instead of a static glyph.
  icon.innerHTML = iconName ? getIconSvg(iconName, 15) : '<span class="toast-spinner"></span>';

  const label = document.createElement('span');
  label.className = 'toast-label';
  label.innerText = message;

  toast.append(icon, label);
  if (action) {
    const actionButton = document.createElement('button');
    actionButton.type = 'button';
    actionButton.className = 'toast-action';
    actionButton.textContent = action.label;
    actionButton.addEventListener('click', () => {
      try {
        action.onClick();
      } finally {
        dismiss();
      }
    });
    toast.append(actionButton);
  }
  container.appendChild(toast);

  const dismiss = () => {
    toast.classList.add('is-leaving');
    setTimeout(() => {
      if (toast.parentNode === container) {
        container.removeChild(toast);
      }
    }, 220);
  };
  setTimeout(dismiss, Math.max(500, durationMs));
}
