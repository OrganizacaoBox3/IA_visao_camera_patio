import { Component, type ErrorInfo, type ReactNode } from "react";

// ErrorBoundary global: captura erros de render/lifecycle e mostra uma tela amigável (com a
// identidade do produto) em vez de tela branca. O detalhe técnico fica só no console.
type Props = { children: ReactNode };
type State = { hasError: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] erro de render capturado", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="error-screen" role="alert">
        <div className="error-card">
          <div className="login-brand">▣ Visão de Pátio</div>
          <h1 className="error-title">Algo deu errado</h1>
          <p className="error-sub">Encontramos um problema inesperado ao exibir esta tela. Recarregar costuma resolver.</p>
          <button className="ui-btn ui-btn--primary" onClick={() => window.location.reload()}>Recarregar</button>
        </div>
      </div>
    );
  }
}
