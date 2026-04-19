/**
 * Shared iframe preview renderer used by JSX/TSX preview-mode bindings.
 * This is NOT an IEditorBinding — it's an internal building block.
 */

export class PreviewRendererInstance {
  private _iframe: HTMLIFrameElement;
  private _ready = false;
  private _readyPromise: Promise<void>;
  private _pendingCode: string | null = null;
  private _messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(container: HTMLElement) {
    this._iframe = document.createElement('iframe');
    this._iframe.style.cssText = 'width:100%;min-height:300px;border:none;background:#fff;';
    container.appendChild(this._iframe);

    this._readyPromise = new Promise<void>((resolve) => {
      this._messageHandler = (event: MessageEvent) => {
        if (event.data?.type === 'preview-ready') {
          this._ready = true;
          resolve();
          if (this._pendingCode) {
            this._render(this._pendingCode);
            this._pendingCode = null;
          }
        }
      };
      window.addEventListener('message', this._messageHandler);
    });

    // Load preview.html from same origin
    this._iframe.src = '/preview.html';
  }

  /** Wait until the iframe has loaded React + Babel and is ready to render */
  async whenReady(): Promise<void> {
    return this._readyPromise;
  }

  render(code: string): void {
    if (!this._ready) {
      this._pendingCode = code;
      return;
    }
    this._render(code);
  }

  private _render(code: string): void {
    this._iframe.contentWindow?.postMessage({ type: 'render', code }, '*');
  }

  destroy(): void {
    if (this._messageHandler) {
      window.removeEventListener('message', this._messageHandler);
    }
    this._iframe.remove();
  }
}
