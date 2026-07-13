// Protocolo socket do nó-CÂMERA (role=camera): registro, relé de frames e desconexão.
// Espelha o padrão de server/routes/: o corpo do handler mora aqui; index.js só compõe.
// Contrato ADITIVO (CLAUDE.md §3): eventos "frame", "cameras" e "camera-status" byte-a-byte.
// LGPD/ADR-002: frames são efêmeros em memória — este módulo só repassa referências.

/**
 * Anexa os handlers de nó-câmera a um socket recém-conectado.
 * @param socket socket.io com handshake.query { role:"camera", id?, label? }
 * @param ctx { io, cameras, cameraList, socketById, shed }
 *        io = TEE de análise (index.js) — o motor observa os emits de "frame".
 */
function attach(socket, { io, cameras, cameraList, socketById, shed }) {
  const id = String(socket.handshake.query.id || socket.id);
  const label = String(socket.handshake.query.label || `Câmera ${id.slice(0, 4)}`);

  // S4/§4 spec-multitenancy — anti-sequestro de id. O nó DECLARA o próprio id no handshake e o
  // CAMERA_TOKEN é GLOBAL: sem isto, qualquer nó autenticado sobrescreve o registro de OUTRA
  // câmera (`cameras.set(id,...)`). Se um OUTRO socket AINDA VIVO já ocupa este id, recusa o
  // intruso — o incumbente permanece. Reconexão legítima passa: quando o socket anterior CAIU,
  // seu `disconnect` já removeu o registro (socketById.delete), OU ele está `connected:false`
  // (corrida antes do disconnect chegar) — só bloqueamos enquanto o incumbente segue conectado.
  // S4/§4 spec-multitenancy — anti-sequestro de id. O nó DECLARA o próprio id no handshake e o
  // CAMERA_TOKEN é GLOBAL: sem isto, qualquer nó autenticado sobrescreve o registro de OUTRA
  // câmera (`cameras.set(id,...)`). Se um OUTRO socket AINDA VIVO já ocupa este id, recusa o
  // intruso — o incumbente permanece. Reconexão legítima passa: quando o socket anterior CAIU,
  // seu `disconnect` já removeu o registro (socketById.delete), OU ele está `connected:false`
  // (corrida antes do disconnect chegar) — só bloqueamos enquanto o incumbente segue conectado.
  const incumbent = socketById.get(id);
  if (incumbent && incumbent !== socket && incumbent.connected) {
    console.warn(
      `[camera!] id "${id}" já conectado por ${incumbent.id} — recusando intruso ${socket.id}`,
    );
    socket.disconnect(true);
    return; // NÃO registra frame/disconnect: o disconnect do intruso NÃO pode apagar o incumbente
  }

  cameras.set(id, { id, label });
  socketById.set(id, socket);
  socket.data.cameraId = id;
  shed.onCameraConnected(id); // nó (re)conectou no perfil default — estado de shed anterior não vale mais
  io.to("dashboards").emit("cameras", cameraList());
  io.to("dashboards").emit("camera-status", { id, state: "online", label, kind: "browser" });
  console.log(`[camera+] ${label} (${id}) · total=${cameras.size}`);

  // Relé de frames (payload: { buf, w, h, ts }). VOLATILE: se um dashboard está lento, o frame
  // é DESCARTADO em vez de enfileirar — vídeo prefere o frame mais novo a acumular latência.
  // Rooms: dashboards novos assistem por câmera (`cam:<id>`, via `watch`); antigos recebem
  // tudo pela `dash-legacy`. União de rooms — socket.io deduplica destinos.
  socket.on("frame", (payload) => {
    // UM caminho só p/ o motor: este emit passa pelo TEE de análise (io = ioAnalysis no
    // index.js) — o mesmo dos frames RTSP. O engine amostra @1fps (último-vence); o custo
    // aqui é ~zero (passa referência). LGPD: nada persiste (ADR-002).
    io.to(`cam:${id}`).to("dash-legacy").volatile.emit("frame", { id, ...payload });
  });

  socket.on("disconnect", () => {
    cameras.delete(id);
    socketById.delete(id);
    io.to("dashboards").emit("cameras", cameraList());
    io.to("dashboards").emit("camera-status", { id, state: "stopped", label, kind: "browser" });
    console.log(`[camera-] ${label} (${id}) · total=${cameras.size}`);
  });
}

module.exports = { attach };
