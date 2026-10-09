import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface AppErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a route-level rendering error from turning the entire GRC app into a
 * blank page. Technical details stay in the console; users get a safe recovery
 * action without stack traces or internal identifiers.
 */
export default class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[grc] route render failed", error, info);
  }

  componentDidUpdate(previous: AppErrorBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="cv-route-error" aria-labelledby="grc-route-error-title">
        <div className="cv-card cv-route-error__card">
          <div className="cv-route-error__icon" aria-hidden="true">
            <AlertTriangle size={22} />
          </div>
          <div>
            <h1 id="grc-route-error-title" className="cv-h2">
              This page hit an unexpected error
            </h1>
            <p className="cv-body cv-route-error__body">
              Your data is still safe. Retry the page; if the problem continues, return to
              the dashboard and report what you were opening.
            </p>
          </div>
          <div className="cv-route-error__actions">
            <button
              type="button"
              className="cv-btn cv-btn--primary cv-btn--sm"
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Reload page
            </button>
            <a className="cv-btn cv-btn--secondary cv-btn--sm" href="./">
              Dashboard
            </a>
          </div>
        </div>
      </main>
    );
  }
}
