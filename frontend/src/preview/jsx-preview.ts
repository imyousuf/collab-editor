/**
 * JSX/TSX/Next.js Preview renderer.
 * Loads preview.html (served from same origin) which includes React + Babel.
 * Sends JSX/TSX source via postMessage for compilation and rendering.
 */
export class JsxPreview {
  private iframe: HTMLIFrameElement;
  private ready = false;
  private pendingCode: string | null = null;

  constructor(container: HTMLElement) {
    this.iframe = document.createElement('iframe');
    this.iframe.style.cssText = 'width:100%;min-height:300px;border:none;background:#fff;';
    container.appendChild(this.iframe);

    window.addEventListener('message', (event) => {
      if (event.data?.type === 'preview-ready') {
        this.ready = true;
        if (this.pendingCode) {
          this.render(this.pendingCode);
          this.pendingCode = null;
        }
      }
    });

    // Load preview.html from the same origin (served by nginx/vite)
    this.iframe.src = '/preview.html';
  }

  render(code: string): void {
    if (!this.ready) {
      this.pendingCode = code;
      return;
    }
    this.iframe.contentWindow?.postMessage({ type: 'render', code }, '*');
  }

  destroy(): void {
    this.iframe.remove();
  }
}
