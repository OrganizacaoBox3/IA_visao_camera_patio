// EXCLUSIVIDADE de câmera por cliente (2026-09-24): uma câmera pertence a NO MÁXIMO UM cliente
// por vez. Decisão de produto: alocação compartilhada vazaria o pátio de um cliente para a
// tela de outro sem ninguém ter pedido — ver o racional em users.js (findCameraConflict).
//
// writeFileSync mockado como NO-OP (mesmo padrão de users.persist.test.js): nunca toca o
// users.json real do dev; o teste prova a REGRA DE NEGÓCIO, não a persistência.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const users = require("./users");

beforeEach(() => {
  vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// updateUser exige ≥1 superadmin ATIVO no sistema (invariante alheia a este arquivo — protege
// contra ficar sem admin). Este módulo é um singleton em memória sem bootstrap: sem isto, TODO
// updateUser destes testes falharia com "precisa de ao menos 1 superadmin ativo", mascarando a
// regra de exclusividade que é o que este arquivo prova.
beforeAll(async () => {
  vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
  await users.createUser({ usuario: "boss-exclusividade", senha: "x", papel: "superadmin" });
  vi.restoreAllMocks();
});

// Nomes únicos por teste (evita colisão "usuário já existe" — o módulo é um singleton em
// memória que acumula entre os `it` deste arquivo, mesmo padrão de users.persist.test.js).
let n = 0;
const nome = (base) => `${base}-${Date.now()}-${n++}`;

describe("cameraOwner — quem tem uma câmera agora", () => {
  it("null quando ninguém tem", async () => {
    const cam = `cam-${nome("livre")}`;
    expect(users.cameraOwner(cam)).toBeNull();
  });

  it("acha o dono entre os clientes ATIVOS", async () => {
    const cam = `cam-${nome("vinc")}`;
    const r = await users.createUser({
      usuario: nome("cliA"),
      senha: "x",
      papel: "cliente",
      cameraIds: [cam],
    });
    expect(users.cameraOwner(cam)).toMatchObject({ id: r.user.id, usuario: r.user.usuario });
  });

  it("excludeUserId deixa o PRÓPRIO dono passar (não se autobloqueia)", async () => {
    const cam = `cam-${nome("self")}`;
    const r = await users.createUser({
      usuario: nome("cliB"),
      senha: "x",
      papel: "cliente",
      cameraIds: [cam],
    });
    expect(users.cameraOwner(cam, r.user.id)).toBeNull();
  });

  it("cliente INATIVO não conta como dono (câmera libera ao desativar)", async () => {
    const cam = `cam-${nome("inativo")}`;
    const r = await users.createUser({
      usuario: nome("cliC"),
      senha: "x",
      papel: "cliente",
      cameraIds: [cam],
    });
    await users.updateUser(r.user.id, { ativo: false });
    expect(users.cameraOwner(cam)).toBeNull();
  });

  it("papel que NÃO é 'cliente' nunca é dono, mesmo com cameraIds no registro", async () => {
    const cam = `cam-${nome("equipe")}`;
    // cameraIds sem efeito em papéis de equipe (canSeeCamera ignora) — cameraOwner tem que
    // ser CONSISTENTE com essa regra, senão bloquearia alocação por um id órfão sem sentido.
    await users.createUser({ usuario: nome("op"), senha: "x", papel: "usuario", cameraIds: [cam] });
    expect(users.cameraOwner(cam)).toBeNull();
  });
});

describe("createUser — recusa câmera já vinculada a OUTRO cliente", () => {
  it("400 nomeando a câmera e o dono; usuário NÃO é criado", async () => {
    const cam = `cam-${nome("disputa")}`;
    await users.createUser({ usuario: nome("dono"), senha: "x", papel: "cliente", cameraIds: [cam] });
    const antes = users.all().length;
    const r = await users.createUser({
      usuario: nome("intruso"),
      senha: "x",
      papel: "cliente",
      cameraIds: [cam],
    });
    expect(r.error).toMatch(new RegExp(`${cam}.*vinculada ao cliente`));
    expect(users.all().length).toBe(antes); // nada foi criado
  });

  it("papel NÃO-cliente pode receber o MESMO cameraId sem conflito (a lista não tem efeito ali)", async () => {
    const cam = `cam-${nome("equipe2")}`;
    await users.createUser({ usuario: nome("donoX"), senha: "x", papel: "cliente", cameraIds: [cam] });
    const r = await users.createUser({
      usuario: nome("engY"),
      senha: "x",
      papel: "engenheiro",
      cameraIds: [cam],
    });
    expect(r.error).toBeUndefined();
  });

  it("duas câmeras DIFERENTES para dois clientes DIFERENTES: sem conflito", async () => {
    const camA = `cam-${nome("a")}`;
    const camB = `cam-${nome("b")}`;
    const rA = await users.createUser({ usuario: nome("cliD"), senha: "x", papel: "cliente", cameraIds: [camA] });
    const rB = await users.createUser({ usuario: nome("cliE"), senha: "x", papel: "cliente", cameraIds: [camB] });
    expect(rA.error).toBeUndefined();
    expect(rB.error).toBeUndefined();
  });
});

describe("updateUser — mesma regra na edição", () => {
  it("recusa mover câmera de um cliente para outro sem desvincular antes", async () => {
    const cam = `cam-${nome("mover")}`;
    const dono = await users.createUser({ usuario: nome("donoF"), senha: "x", papel: "cliente", cameraIds: [cam] });
    const pretendente = await users.createUser({ usuario: nome("pretF"), senha: "x", papel: "cliente", cameraIds: [] });
    const r = await users.updateUser(pretendente.user.id, { cameraIds: [cam] });
    expect(r.error).toMatch(new RegExp(`${cam}.*${dono.user.usuario}`));
    expect(users.getById(pretendente.user.id).cameraIds).toEqual([]); // nada mudou
  });

  it("o PRÓPRIO dono pode salvar de novo a mesma câmera (idempotente)", async () => {
    const cam = `cam-${nome("idem")}`;
    const dono = await users.createUser({ usuario: nome("donoG"), senha: "x", papel: "cliente", cameraIds: [cam] });
    const r = await users.updateUser(dono.user.id, { cameraIds: [cam] });
    expect(r.error).toBeUndefined();
  });

  it("promover um usuário comum a 'cliente' TAMBÉM valida exclusividade", async () => {
    const cam = `cam-${nome("promo")}`;
    await users.createUser({ usuario: nome("donoH"), senha: "x", papel: "cliente", cameraIds: [cam] });
    const comum = await users.createUser({ usuario: nome("comumH"), senha: "x", papel: "usuario" });
    const r = await users.updateUser(comum.user.id, { papel: "cliente", cameraIds: [cam] });
    expect(r.error).toMatch(/vinculada ao cliente/);
  });

  it("desvincular (esvaziar cameraIds) NUNCA conflita — libera a câmera pra outro", async () => {
    const cam = `cam-${nome("libera")}`;
    const dono = await users.createUser({ usuario: nome("donoI"), senha: "x", papel: "cliente", cameraIds: [cam] });
    const r = await users.updateUser(dono.user.id, { cameraIds: [] });
    expect(r.error).toBeUndefined();
    expect(users.cameraOwner(cam)).toBeNull();
  });
});
