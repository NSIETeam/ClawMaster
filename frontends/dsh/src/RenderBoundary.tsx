/** Keep a thrown render inside one panel: the shell shows what failed instead of an empty region. */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { productCopy, type ProductLocale } from './locales/frontend.ts';

/** One panel's boundary: which surface it wraps, and the locale its fallback speaks. */
export interface RenderBoundaryProps {
  /** Locale of the fallback copy, read from the live locale service by the caller. */
  locale: ProductLocale;
  /** Panel name used in the visible message and in the console report. */
  scope: string;
  children: ReactNode;
}

interface RenderBoundaryState {
  /** The message of the error that replaced the children, or null while they render. */
  failure: string | null;
}

/**
 * Replace a failed subtree with a readable alert rather than letting React unmount past it.
 *
 * A panel that throws during render leaves a blank region, and a throw in the shell's own tree can
 * leave the whole window blank. This boundary keeps the failure local, names it, and offers a retry
 * that re-renders the children once the cause is gone.
 */
export class RenderBoundary extends Component<RenderBoundaryProps, RenderBoundaryState> {
  state: RenderBoundaryState = { failure: null };

  /** React reports the throw here first, so the fallback state is set before the next render. */
  static getDerivedStateFromError(error: unknown): RenderBoundaryState {
    return { failure: error instanceof Error ? error.message : String(error) };
  }

  /** Record the component stack once, where the browser console can be read for diagnosis. */
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`clawmaster: panel '${this.props.scope}' failed to render`, error, info.componentStack);
  }

  /** Drop the recorded failure so the children render again. */
  retry = (): void => { this.setState({ failure: null }); };

  /** Render the children, or the fallback that names the failure and offers retry. */
  render(): ReactNode {
    if (this.state.failure === null) return this.props.children;
    const copy = productCopy(this.props.locale);
    return <section className="cm-render-failure" role="alert" data-scope={this.props.scope} data-failure="render">
      <h2>{copy.renderFailedTitle}</h2>
      <p>{copy.renderFailedBody.replace('{error}', this.state.failure)}</p>
      <button type="button" onClick={this.retry}>{copy.renderRetry}</button>
    </section>;
  }
}
