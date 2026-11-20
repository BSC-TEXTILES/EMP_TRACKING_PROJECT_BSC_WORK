import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './icons';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  isChunkError: boolean;
  reloading: boolean;
}

function isChunkLoadError(error: Error | null): boolean {
  if (!error) return false;
  const msg = String(error.message || '');
  return (
    error.name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk [\w\d]+ failed|mime type/i.test(
      msg
    )
  );
}

/**
 * Catches rendering and module-loading errors without taking the whole
 * application down. When a deployment updates hashed chunk filenames,
 * it automatically recovers by reloading to the latest version smoothly.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, isChunkError: false, reloading: false };
  private reloadTimer: any = null;

  static getDerivedStateFromError(error: Error): State {
    const isChunk = isChunkLoadError(error);
    return { error, isChunkError: isChunk, reloading: isChunk };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render error', error, info.componentStack);
    if (isChunkLoadError(error)) {
      const key = 'err_boundary_chunk_reload';
      const last = parseInt(sessionStorage.getItem(key) || '0', 10);
      const now = Date.now();
      if (now - last > 15000) {
        sessionStorage.setItem(key, String(now));
        // Give smooth visual feedback and auto-refresh the latest app bundle
        this.reloadTimer = setTimeout(() => {
          window.location.reload();
        }, 500);
      }
    }
  }

  componentWillUnmount(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    if (this.state.isChunkError) {
      return (
        <div className="mx-auto max-w-md py-16 text-center px-4">
          <div className="card p-8 border border-brand-200 bg-white shadow-sm">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600 animate-spin">
              <Icon name="refresh" size={24} />
            </div>
            <h3 className="text-base font-bold text-ink-900">Loading Latest Version…</h3>
            <p className="mt-2 text-xs text-ink-500 leading-relaxed">
              A new update was deployed to Workforce. Refreshing this module now.
            </p>
            <div className="mt-5">
              <button
                type="button"
                className="btn-primary btn-sm px-4 py-2"
                onClick={() => window.location.reload()}
              >
                Reload Now
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-xl py-12 px-4">
        <div className="card card-pad border border-ink-200 shadow-sm">
          <div className="flex items-center gap-3 mb-3 text-amber-600">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50">
              <Icon name="alert-triangle" size={20} />
            </div>
            <h3 className="text-base font-bold text-ink-900">Unable to load section</h3>
          </div>
          <p className="text-sm text-ink-500 leading-relaxed">
            The rest of the application is unaffected. You can reload this section or return to your dashboard.
          </p>
          <div className="mt-5 flex items-center gap-2.5">
            <button
              type="button"
              className="btn-primary btn-sm px-4 py-2"
              onClick={() => window.location.reload()}
            >
              Reload Page
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm px-4 py-2"
              onClick={() => {
                this.setState({ error: null, isChunkError: false, reloading: false });
                if (window.location.pathname !== '/') {
                  window.location.href = '/';
                }
              }}
            >
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
