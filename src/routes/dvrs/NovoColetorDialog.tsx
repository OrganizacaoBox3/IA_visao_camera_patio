import { useState } from "react";
import QRCode from "qrcode";
import { Button, Dialog, Field, Input, useToast } from "../../ui";
import { criarDvrColetor } from "../../api";

// "Novo coletor" (enrollment, contratos §3/§8): o suporte (superadmin) cria um coletor ligando a empresa
// Box3 ↔ o cliente do visão; o hub EMITE um enrollmentToken de uso único + curta validade. Renderizamos
// aqui, no navegador, o QR que o leigo escaneia no app — `{ v, cliente, token }` (o formato que o
// `leitorQr.parsePayloadQr` do app entende). `visao` é omitido de propósito: o app cai no HUB padrão
// (cam.box3.software); `dvr` omitido ⇒ o app descobre o DVR na LAN.
//
// SIGILO (invariante 6): o `enrollmentToken` é SENSÍVEL — só existe nesta resposta (uso único), some ao
// fechar o diálogo e NUNCA é logado. O QR é a única forma de ele sair.

type Props = {
  // Recarrega a lista de DVRs/coletores do pai após criar (o novo coletor passa a existir no hub).
  onCriado: () => void | Promise<void>;
};

export function NovoColetorDialog({ onCriado }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [cliente, setCliente] = useState("");
  const [empresa, setEmpresa] = useState("");
  const [nome, setNome] = useState("");
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<{ dataUrl: string; expira: number } | null>(null);

  function reset() {
    setCliente("");
    setEmpresa("");
    setNome("");
    setQr(null);
    setBusy(false);
  }

  async function gerar() {
    if (busy) return;
    if (!cliente.trim() || !empresa.trim()) {
      toast("Informe o cliente e a empresa Box3.", "alert");
      return;
    }
    setBusy(true);
    try {
      const c = await criarDvrColetor({
        cliente_id: cliente.trim(),
        empresa_id_box3: empresa.trim(),
        nome: nome.trim() || undefined,
      });
      // Payload que o app entende (NÃO logar — carrega o token de uso único).
      const payload = JSON.stringify({ v: 1, cliente: c.cliente_id, token: c.enrollmentToken });
      const dataUrl = await QRCode.toDataURL(payload, { width: 260, margin: 2, errorCorrectionLevel: "M" });
      setQr({ dataUrl, expira: c.expira });
      await onCriado();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao criar o coletor.", "alert");
    }
    setBusy(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset(); // ao fechar, apaga o token da tela (uso único)
      }}
      title="Novo coletor — QR de ativação"
      description="O leigo escaneia este QR no app 1×: liga o aparelho ao cliente e libera o registro do DVR. Uso único — expira."
      trigger={
        <Button size="sm" variant="primary">
          Novo coletor
        </Button>
      }
      footer={
        qr ? (
          <Button size="sm" variant="ghost" onClick={reset}>
            Gerar outro
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={gerar} disabled={busy}>
            {busy ? "Gerando…" : "Gerar QR"}
          </Button>
        )
      }
    >
      {qr ? (
        <div className="flex flex-col items-center gap-[var(--sp-3)]">
          <img
            src={qr.dataUrl}
            alt="QR de ativação do coletor"
            width={260}
            height={260}
            className="rounded-sm bg-white p-[var(--sp-2)]"
          />
          <p className="text-[12px] text-text-muted text-center">
            Aponte a câmera do app para este QR. Uso único — expira em{" "}
            {new Date(qr.expira).toLocaleString("pt-BR")}.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-[var(--sp-3)]">
          <Field label="Cliente (id do cliente no visão)" htmlFor="nc-cliente">
            <Input
              id="nc-cliente"
              value={cliente}
              onChange={(e) => setCliente(e.target.value)}
              placeholder="ex.: cliente-acme"
            />
          </Field>
          <Field label="Empresa Box3 (id da integradora)" htmlFor="nc-empresa">
            <Input
              id="nc-empresa"
              value={empresa}
              onChange={(e) => setEmpresa(e.target.value)}
              placeholder="ex.: 8"
            />
          </Field>
          <Field label="Nome do coletor (opcional)" htmlFor="nc-nome">
            <Input
              id="nc-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="ex.: Portaria"
            />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
