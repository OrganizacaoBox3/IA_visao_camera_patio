import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, login } from "../api";
import type { LoginResponse } from "../types";
import { Button, ErrorState, Field, Input } from "../ui";

export function Login({ onLoggedIn }: { onLoggedIn: (r: LoginResponse) => void }) {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(email.trim(), senha);
      onLoggedIn(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "falha ao entrar");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cp-main" style={{ maxWidth: 380 }}>
      <div className="cp-panel">
        <h1 style={{ marginTop: 0, fontSize: "1.15rem" }}>Entrar no portal</h1>
        <form onSubmit={submit}>
          <Field label="E-mail">
            <Input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={busy}
            />
          </Field>
          <Field label="Senha">
            <Input
              type="password"
              autoComplete="current-password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
              disabled={busy}
            />
          </Field>
          {error && <ErrorState message={error} />}
          <Button type="submit" variant="primary" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Entrando…" : "Entrar"}
          </Button>
        </form>
      </div>
    </div>
  );
}
