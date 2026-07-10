# ─────────────────────────────────────────────────────────────────────────────
# spike-scanner.py — Fase 0 (de-riscar a física do BLE ANTES de construir a fusão).
# Escaneia anúncios BLE e loga RSSI de cada tag em CSV. Depois a gente correlaciona
# RSSI × distância (que a câmera dá) p/ decidir se dá pra separar 3-6 pessoas com 1
# estação sem IMU (o combo travado no 00-avaliacao-e-plano.md §9).
#
# Uso:
#   pip install bleak
#   python spike-scanner.py            # loga tudo em rssi-log.csv
#   python spike-scanner.py NomeDaTag  # filtra só o nome/parte do nome da sua tag
#
# Como medir (o que responde a pergunta):
#   1) Ligue a tag. Rode o scanner. Confirme que o nome/MAC dela aparece no terminal.
#   2) Ande com a tag em DISTÂNCIAS CONHECIDAS (1m, 2m, 3m, 5m) — pare ~15s em cada,
#      anote o horário. (Ou fique andando enquanto a câmera grava, p/ casar depois.)
#   3) Repita com 2-3 tags/pessoas ao MESMO tempo, andando diferente.
#   Me mande o rssi-log.csv — eu meço se o RSSI separa as pessoas (correlação com a
#   distância) e digo se o Tier 1 (1 estação) fecha p/ 3-6 ou se precisa IMU/estações.
# ─────────────────────────────────────────────────────────────────────────────
import asyncio
import csv
import sys
import time

try:
    from bleak import BleakScanner
except ImportError:
    print("Falta a lib: rode  pip install bleak")
    sys.exit(1)

OUT = "rssi-log.csv"
FILTER = (sys.argv[1].lower() if len(sys.argv) > 1 else "")  # substring do nome (opcional)


async def run():
    f = open(OUT, "w", newline="", encoding="utf-8")
    w = csv.writer(f)
    w.writerow(["ts_ms", "address", "name", "rssi"])

    def cb(device, adv):
        name = (adv.local_name or getattr(device, "name", "") or "")
        if FILTER and FILTER not in name.lower() and FILTER not in device.address.lower():
            return
        rssi = getattr(adv, "rssi", None)
        if rssi is None:
            rssi = getattr(device, "rssi", "")  # bleak antigo expunha no device
        ts = int(time.time() * 1000)
        w.writerow([ts, device.address, name, rssi])
        f.flush()
        print(f"{(name or device.address)[:32]:32s} rssi={rssi}")

    scanner = BleakScanner(detection_callback=cb)
    print(f"escaneando BLE… (Ctrl+C p/ parar) → {OUT}" + (f"  [filtro: {FILTER}]" if FILTER else ""))
    await scanner.start()
    try:
        while True:
            await asyncio.sleep(1)
    finally:
        await scanner.stop()
        f.close()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nparado. csv salvo em", OUT)
