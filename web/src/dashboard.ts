import dashboardTemplate from '../../dashboard.template.html?raw';
import type { AfaScanRecord } from './model.js';

const safeJson = (records: AfaScanRecord[]): string => JSON.stringify(records).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');

export function renderDashboard(container: HTMLElement, records: AfaScanRecord[]): void {
  const iframe = document.createElement('iframe');
  iframe.className = 'dashboard-frame';
  iframe.title = 'AfaScan dashboard';
  iframe.srcdoc = dashboardTemplate.replace('__MEASUREMENTS_JSON__', safeJson(records));
  iframe.addEventListener('load', () => {
    const resize = () => {
      const height = iframe.contentDocument?.documentElement.scrollHeight;
      if (height) iframe.style.height = `${Math.max(700, height + 16)}px`;
    };
    resize();
    const body = iframe.contentDocument?.body;
    if (body && 'ResizeObserver' in window) new ResizeObserver(resize).observe(body);
  });
  container.replaceChildren(iframe);
}
