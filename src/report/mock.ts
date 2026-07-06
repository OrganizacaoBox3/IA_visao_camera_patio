// ALIAS de compatibilidade — o barrel real dos cálculos do Relatório é ./calc (o nome
// "mock" era herança da etapa de dados fictícios e mentia sobre o conteúdo). Permanece
// só para os importadores fora desta frente (CameraWorkspace, camera/ConfigZonaDialog);
// código novo importa de "report/calc".
export * from "./calc";
