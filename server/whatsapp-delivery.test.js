import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DeliveryTracker,
  recipientCandidates,
  resolveRecipient,
} = require("./whatsapp-delivery");

describe("WhatsApp — resolução segura do destinatário", () => {
  it("consulta a forma brasileira com e sem nono dígito", () => {
    expect(recipientCandidates("+55 (88) 99238-1943")).toEqual([
      "5588992381943",
      "558892381943",
    ]);
  });

  it("prefere o LID verificado retornado pelo WhatsApp", async () => {
    const socket = {
      onWhatsApp: vi.fn().mockResolvedValue([
        {
          exists: true,
          jid: "5588992381943@s.whatsapp.net",
          lid: "123456789@lid",
        },
      ]),
    };

    await expect(resolveRecipient(socket, "+5588992381943")).resolves.toEqual({
      jid: "123456789@lid",
      addressing: "lid",
    });
    expect(socket.onWhatsApp).toHaveBeenCalledWith(
      "5588992381943",
      "558892381943",
    );
  });

  it("só usa a variante sem nono dígito quando ela foi verificada", async () => {
    const socket = {
      onWhatsApp: vi.fn().mockResolvedValue([
        {
          exists: true,
          jid: "558892381943@s.whatsapp.net",
        },
      ]),
    };

    await expect(resolveRecipient(socket, "+5588992381943")).resolves.toEqual({
      jid: "558892381943@s.whatsapp.net",
      addressing: "phone",
    });
  });

  it("recusa envio quando nenhuma forma foi confirmada pelo WhatsApp", async () => {
    const socket = { onWhatsApp: vi.fn().mockResolvedValue([]) };
    await expect(resolveRecipient(socket, "+5588992381943")).rejects.toThrow(
      "número não encontrado no WhatsApp",
    );
  });
});

describe("WhatsApp — recibo real de entrega", () => {
  it("só conclui após DELIVERY_ACK", async () => {
    const tracker = new DeliveryTracker();
    let settled = false;
    const delivery = tracker.waitFor("msg-1", 1, 1_000).then((value) => {
      settled = true;
      return value;
    });

    tracker.observe([{ key: { id: "msg-1" }, update: { status: 2 } }]);
    await Promise.resolve();
    expect(settled).toBe(false);

    tracker.observe([{ key: { id: "msg-1" }, update: { status: 3 } }]);
    await expect(delivery).resolves.toEqual({ delivery: "delivered", status: 3 });
  });

  it("propaga a recusa assíncrona e seu código", async () => {
    const tracker = new DeliveryTracker();
    const delivery = tracker.waitFor("msg-2", 1, 1_000);

    tracker.observe([
      {
        key: { id: "msg-2" },
        update: { status: 0, messageStubParameters: ["463"] },
      },
    ]);

    await expect(delivery).rejects.toThrow("código 463");
  });

  it("não transforma timeout em sucesso", async () => {
    vi.useFakeTimers();
    const tracker = new DeliveryTracker();
    const delivery = tracker.waitFor("msg-3", 2, 20_000);
    const assertion = expect(delivery).rejects.toMatchObject({
      code: "DELIVERY_TIMEOUT",
      httpStatus: 504,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    vi.useRealTimers();
  });
});
