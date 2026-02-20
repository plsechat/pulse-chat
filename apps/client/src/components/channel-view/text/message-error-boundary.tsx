import { Component, type ReactNode } from 'react';

type TProps = {
  messageId: number;
  children: ReactNode;
};

type TState = {
  hasError: boolean;
};

class MessageErrorBoundary extends Component<TProps, TState> {
  state: TState = { hasError: false };

  static getDerivedStateFromError(): TState {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(
      `[MessageErrorBoundary] Failed to render message ${this.props.messageId}:`,
      error
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="text-xs text-muted-foreground/50 italic py-0.5">
          This message could not be displayed.
        </div>
      );
    }
    return this.props.children;
  }
}

export { MessageErrorBoundary };
