// Estado vazio do Relatório (sem histórico para o modo atual): dá o CAMINHO exato de ativação
// (Central, desenhar zona com a ferramenta Zona, "Configurar zona", escolher o Modo) e, com a
// persistência confirmada pelo hub, afirma que é falta de dados no período (não banco ausente)
// — vazio honesto. Prosa em linguagem de produto, sem glifo de ícone (acabamento da simplificação).
import { EmptyState } from "../../ui";
import type { DataPersistence } from "../../api";
import type { Mode } from "./labels";

export function EmptyHistory({
  mode,
  dataSource,
}: {
  mode: Mode;
  dataSource: DataPersistence | null; // null = hub antigo sem /api/data/status → texto genérico
}) {
  return (
    <EmptyState>
      <p>
        <b>
          Sem histórico de{" "}
          {mode === "leitura"
            ? "leitura"
            : mode === "objetos"
              ? "objetos"
              : mode === "fadiga"
                ? "operador"
                : "atividade"}{" "}
          ainda.
        </b>
      </p>
      <p>
        {mode === "leitura" ? (
          <>
            Na Central, abra a câmera, desenhe uma zona sobre a etiqueta/esteira com a ferramenta{" "}
            <b>Zona</b> e, em <b>Configurar zona</b>, escolha o <b>Modo: Leitura</b>.
          </>
        ) : mode === "objetos" ? (
          <>
            Na Central, abra a câmera, desenhe uma zona sobre a área com a ferramenta <b>Zona</b>{" "}
            e, em <b>Configurar zona</b>, escolha o <b>Modo: Objetos</b> e as classes.
          </>
        ) : mode === "fadiga" ? (
          <>
            Em <b>Câmeras → Ajustes desta câmera</b>, selecione <b>Operador (fadiga)</b> na câmera
            do posto — ou desenhe uma zona com <b>Modo: Fadiga</b> numa câmera de área.
          </>
        ) : (
          <>
            Na Central, abra a câmera e desenhe uma zona sobre a área de trabalho com a ferramenta{" "}
            <b>Zona</b> — o modo <b>Atividade</b> é o padrão. Deixe a Central rodando para acumular
            indicadores.
          </>
        )}
      </p>
      <p className="muted">
        {dataSource
          ? `Sem dados no período — deixe a Central aberta com câmeras ativas. Histórico gravado em ${
              dataSource === "pg" ? "banco" : "arquivo local no servidor"
            }.`
          : "Os dados aparecem automaticamente conforme as câmeras operam."}
      </p>
    </EmptyState>
  );
}
