import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches rendering errors in a single screen without taking the whole
 * application down. Reloading restores the last successfully stored state.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-xl py-12">
        <div className="card card-pad">
          <p className="text-sm font-semibold text-ink-900">This screen could not be displayed</p>
          <p className="mt-2 text-sm text-ink-500">
            The rest of the application is unaffected. Reload the page to recover; if it keeps happening, share the
            details below with your administrator.
          </p>
          <pre className="mt-3 max-h-32 overflow-auto rounded-md border border-ink-200 bg-ink-50 p-3 text-[11px] text-ink-600">
            {this.state.error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn-primary btn-sm" onClick={() => window.location.reload()}>
              Reload page
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
