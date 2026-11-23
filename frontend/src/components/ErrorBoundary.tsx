import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './icons';
import { trackError } from '../lib/errorTracking';
import { isChunkOrModuleMismatch } from '../lib/lazyWithRetry';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  isChunkError: boolean;
  reloading: boolean;
  showDiagnostics: boolean;
  copied: boolean;
}

function isChunkLoadError(error: Error | null): boolean {
  if (!error) return false;
  return isChunkOrModuleMismatch(error);
}

/**
 * Catches rendering and module-loading errors without taking the whole
 * application down. When a deployment updates hashed chunk filenames,
 * it automatically recovers by reloading to the latest version smoothly.
 * All unexpected rendering exceptions are automatically tracked and reported.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
    componentStack: null,
    isChunkError: false,
    reloading: false,
    showDiagnostics: false,
    copied: false,
  };
  private reloadTimer: any = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    const isChunk = isChunkLoadError(error);
    return { error, isChunkError: isChunk, reloading: isChunk };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render error', error, info.componentStack);
    this.setState({ componentStack: info.componentStack || null });

    // Transmit crash telemetry to backend Error Tracking
    void trackError(error, {
      componentStack: info.componentStack || undefined,
      module: 'React ErrorBoundary',
      severity: 'high',
    });

    if (isChunkLoadError(error)) {
      const key = 'err_boundary_chunk_reload';
      const last = parseInt(sessionStorage.getItem(key) || '0', 10);
      const now = Date.now();
      if (now - last > 10000) {
        sessionStorage.setItem(key, String(now));
        // Give smooth visual feedback and auto-refresh the latest app bundle
        this.reloadTimer = setTimeout(() => {
          const url = new URL(window.location.href);
          url.searchParams.set('_v', String(now));
          window.location.replace(url.toString());
        }, 300);
      }
    }
  }

  componentWillUnmount(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  private handleCopyDiagnostics = () => {
    const { error, componentStack } = this.state;
    const text = [
      `Error: ${error?.name ?? 'Error'}: ${error?.message ?? 'Unknown'}`,
      `Path: ${window.location.href}`,
      `Time: ${new Date().toISOString()}`,
      `Stack:\n${error?.stack ?? 'No stack available'}`,
      componentStack ? `Component Stack:\n${componentStack}` : '',
    ].filter(Boolean).join('\n\n');

    navigator.clipboard?.writeText(text).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    }).catch(() => undefined);
  };

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
      <div className="mx-auto max-w-2xl py-12 px-4">
        <div className="card card-pad border border-amber-200 bg-white shadow-sm rounded-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 text-amber-600">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-50">
                <Icon name="alert-triangle" size={22} />
              </div>
              <div>
                <h3 className="text-base font-bold text-ink-900">Unable to load this section</h3>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md mt-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Auto-logged to Error Tracking
                </span>
              </div>
            </div>
          </div>

          <p className="mt-3 text-sm text-ink-600 leading-relaxed">
            The rest of the system continues to run smoothly. You can reload this view or return to your main dashboard.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              className="btn-primary btn-sm px-4 py-2 flex items-center gap-1.5"
              onClick={() => window.location.reload()}
            >
              <Icon name="refresh" size={14} />
              Reload Page
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm px-4 py-2 flex items-center gap-1.5"
              onClick={() => {
                this.setState({ error: null, isChunkError: false, reloading: false });
                if (window.location.pathname !== '/') {
                  window.location.href = '/';
                }
              }}
            >
              <Icon name="home" size={14} />
              Go to Dashboard
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm px-3 py-2 text-ink-600 text-xs flex items-center gap-1"
              onClick={() => this.setState((s) => ({ showDiagnostics: !s.showDiagnostics }))}
            >
              <Icon name={this.state.showDiagnostics ? 'chevron-up' : 'chevron-down'} size={14} />
              {this.state.showDiagnostics ? 'Hide Diagnostic Details' : 'View Diagnostic Details'}
            </button>
          </div>

          {this.state.showDiagnostics && (
            <div className="mt-4 border-t border-ink-100 pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-ink-700">Diagnostic Technical Log:</span>
                <button
                  type="button"
                  className="text-xs text-brand-600 hover:text-brand-700 font-medium flex items-center gap-1"
                  onClick={this.handleCopyDiagnostics}
                >
                  <Icon name={this.state.copied ? 'check' : 'copy'} size={13} />
                  {this.state.copied ? 'Copied' : 'Copy Log'}
                </button>
              </div>
              <pre className="max-h-56 overflow-auto rounded-lg bg-ink-950 p-3 text-left font-mono text-xs text-ink-100 leading-relaxed">
                <span className="text-rose-400 font-bold">{this.state.error.name}: {this.state.error.message}</span>
                {'\n\n'}
                <span className="text-ink-400">{this.state.error.stack || 'No stack trace available'}</span>
                {this.state.componentStack && (
                  <>
                    {'\n\n'}
                    <span className="text-amber-300">Component Stack:</span>
                    {'\n'}
                    <span className="text-ink-400">{this.state.componentStack}</span>
                  </>
                )}
              </pre>
            </div>
          )}
        </div>
      </div>
    );
  }
}
