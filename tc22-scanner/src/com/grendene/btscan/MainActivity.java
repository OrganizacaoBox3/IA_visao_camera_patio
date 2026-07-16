package com.grendene.btscan;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import android.app.AlertDialog;
import android.content.DialogInterface;
import android.provider.Settings;
import android.text.InputType;
import android.widget.EditText;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Random;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Estação BLE do TC22 — varre as tags (família Grendene) e REPORTA ao hub por HTTP. É a "antena real"
 * da identidade aumentada (docs/analises/tags-bluetooth/). Responsabilidade única: varrer + reportar + exibir vivo.
 * Loga em Logcat ("BTSCAN") p/ diagnóstico. Sem `+` em runtime (Android não tem StringConcatFactory) e sem lambda.
 *
 * Robustez (queixa do dono): recupera de BT off→on, de permissão negada, de scan que morre (watchdog),
 * e mostra falha de POST no hub — sem crashar e sem exigir reabrir o app. A tela atualiza SOZINHA por
 * um refresh periódico (Handler): tags novas aparecem, RSSI muda, tags paradas desbotam e caem.
 *
 * Rede: acha o hub SOZINHO na LAN por descoberta UDP (broadcast → o hub responde o endereço; caminho
 * feliz de "se o hub está no ar, conecta"). Por USB, `adb reverse tcp:4000 tcp:4000` mantém 127.0.0.1
 * funcionando. O endereço também é editável à mão (toque no subtítulo) e persistido — fallback se o
 * broadcast for bloqueado na rede.
 *
 * Multi-antena (spec-multi-antena-ble §F1): o id da estação é PREF persistida (toque no TÍTULO p/
 * editar), com default anti-colisão derivado do ANDROID_ID ("tc22-xxxx") — dois celulares recém-
 * instalados nunca postam o mesmo id. Token opcional do hub (x-station-token) vive no dialog do hub;
 * vazio = LAN aberta (dev). Id vai em todo payload; token em todo request quando presente.
 */
public class MainActivity extends Activity {
    static final String TAG = "BTSCAN";
    static final String OUI = "48:87:2D"; // fabricante das tags do projeto
    static final String DEFAULT_HUB_URL = "http://127.0.0.1:4000/api/bt/reading";
    static final String PREFS = "btscan";        // SharedPreferences do app
    static final String KEY_HUB = "hub_url";      // chave do endereço do hub (editável em runtime)
    static final String KEY_STATION = "station_id";   // id DESTA estação (multi-antena; default anti-colisão derivado do device)
    static final String KEY_TOKEN = "station_token";  // token de auth do hub (vazio = LAN aberta, sem header)
    static final String KEY_NAMES = "tag_names";  // blob de nomes customizados (linhas "mac=nome")
    static final String KEY_LOCS = "tag_locs";    // blob da última localização por tag (linhas "mac=lat,lon,ts")
    static final String SUFFIX_READING = "/api/bt/reading";  // sufixo do ingest — trocado p/ tag-name
    static final String SUFFIX_TAGNAME = "/api/bt/tag-name"; // endpoint de nomeação (contrato com o hub)
    static final String SUFFIX_TAGS = "/api/bt/tags";        // endpoint de listagem de nomes (pull do hub)
    static final String HDR_TOKEN = "x-station-token";       // header de auth do ingest (contrato com o hub)
    static final int DISCOVERY_PORT = 41234;      // porta UDP do beacon de descoberta do hub
    static final String DISCOVERY_PROBE = "VISAO_HUB_DISCOVER"; // payload do broadcast (contrato com o hub)
    // 2000→500ms (2026-07-11) — e o que a MEDIÇÃO disse depois (2026-07-13, gravação real de campo,
    // n=30.267 intervalos). O comentário antigo prometia "500ms ≈ 4× leituras distintas". É FALSO:
    // quadruplicar o POST NÃO moveu o Δt entre leituras DISTINTAS (2101 ms → 2303 ms; ganho de 1,4×
    // em contagem, não 4×). O gargalo é o ADVERTISING DA TAG (~2,2 s), não a estação — o scanner já
    // roda LOW_LATENCY e vê tudo que existe para ver. O que o POST rápido de fato produziu foi
    // CÓPIA: 83,3% do que o hub recebia era o valor anterior repetido [Wilson 95%: 83,1–83,4%].
    // POST_EVERY_MS segue em 500 ms porque agora ele só carrega o que MUDOU (ver buildJson): a
    // latência de entrega da medição fresca cai para ≤500 ms sem inventar evidência. Aumentar este
    // número só ATRASA a leitura; diminuí-lo não compra leitura nenhuma — o teto é da tag.
    static final long POST_EVERY_MS = 500;       // envio ao hub (só o que mudou desde o último 2xx)
    static final long SYNC_NAMES_MS = 15000;     // pull periódico dos nomes do hub (servidor = fonte)
    static final long SAVE_LOCS_EVERY_TICKS = 15; // persiste a réplica de localização a cada N ticks (se mudou)
    static final long REFRESH_MS = 1000;         // refresh da tela (vida)
    static final long STALE_MS = 6000;           // sem ver a tag -> desbota
    static final long DROP_MS = 20000;           // sem ver a tag -> some da lista/contagem
    static final long SCAN_WATCHDOG_MS = 20000;  // sem NENHUMA leitura -> scan provavelmente morreu, reinicia
    // Janela de "scan vivo" reportada ao hub no campo `scanning` do POST (saúde honesta — o hub
    // distingue "estação viva mas CEGA" de "sem tags por perto"). 15 s < SCAN_WATCHDOG_MS de
    // propósito: o hub vê o problema ANTES de o watchdog tentar religar.
    static final long SCAN_ALIVE_MS = 15000;
    static final int REQ_PERM = 1001;

    // Paleta (going-gray: base neutra, cor só p/ significado). parseColor em constantes = sem concat.
    static final int C_BG = Color.parseColor("#0F1115");
    static final int C_HEADER = Color.parseColor("#171B22");
    static final int C_ROW = Color.parseColor("#161A20");
    static final int C_TRACK = Color.parseColor("#2A2F3A");
    static final int C_TXT = Color.parseColor("#E6E9EF");
    static final int C_MUTED = Color.parseColor("#8A93A2");
    static final int C_GREEN = Color.parseColor("#35C46A");
    static final int C_AMBER = Color.parseColor("#E0A93B");
    static final int C_RED = Color.parseColor("#E5484D");
    static final int C_GREEN_BG = Color.parseColor("#12351F");
    static final int C_RED_BG = Color.parseColor("#3A1417");
    static final int C_MUTED_BG = Color.parseColor("#232833");

    // Página do mapa "você está aqui": Leaflet + tiles de satélite Esri. Montada por append de LITERAIS
    // (sem concat de variáveis em runtime). Carregada UMA vez; o app injeta o GPS via window.setHere(...).
    static final String MAP_HTML = buildMapHtml();

    private static String buildMapHtml() {
        StringBuilder h = new StringBuilder();
        h.append("<!DOCTYPE html><html><head><meta charset=\"utf-8\">");
        h.append("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no\">");
        h.append("<link rel=\"stylesheet\" href=\"https://unpkg.com/leaflet@1.9.4/dist/leaflet.css\">");
        h.append("<script src=\"https://unpkg.com/leaflet@1.9.4/dist/leaflet.js\"></script>");
        h.append("<style>html,body,#m{height:100%;margin:0;background:#0F1115}</style>");
        h.append("</head><body><div id=\"m\"></div>");
        // Botão recentrar (◎): volta pra "você está aqui" e reativa o modo seguir.
        h.append("<button id=\"rc\" style=\"position:absolute;right:12px;bottom:16px;z-index:1000;width:46px;height:46px;");
        h.append("border-radius:9999px;border:none;background:#35C46A;color:#0F1115;font-size:22px;font-weight:bold;");
        h.append("box-shadow:0 2px 6px rgba(0,0,0,.5)\">&#9678;</button>");
        h.append("<script>");
        h.append("var map=L.map('m',{zoomControl:true,attributionControl:false}).setView([-3.688,-40.348],17);");
        // Esri só tem imagem até ~z17 nesta região (interior/CE) — z18+ retorna o placeholder "Map data
        // not yet available" (~2,5KB, confirmado por diagnóstico). maxNativeZoom:17 → o Leaflet AMPLIA o
        // tile z17 no zoom alto, sem pedir os tiles inexistentes de z18+.
        h.append("L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,maxNativeZoom:17}).addTo(map);");
        h.append("var here=null,acc=null,centered=false,follow=true;");
        h.append("map.on('dragstart',function(){follow=false;});"); // arrastou → para de seguir
        h.append("window.setHere=function(lat,lon,a){");
        h.append("if(here==null){");
        h.append("here=L.circleMarker([lat,lon],{radius:8,color:'#ffffff',weight:2,fillColor:'#35C46A',fillOpacity:1}).addTo(map);");
        h.append("here.bindTooltip('Voc\\u00ea est\\u00e1 aqui',{direction:'top'});");
        h.append("acc=L.circle([lat,lon],{radius:a,color:'#35C46A',weight:1,fillColor:'#35C46A',fillOpacity:0.12}).addTo(map);");
        h.append("}else{here.setLatLng([lat,lon]);acc.setLatLng([lat,lon]);acc.setRadius(a);}");
        h.append("if(!centered){centered=true;map.setView([lat,lon],17);}else if(follow){map.panTo([lat,lon]);}");
        h.append("};");
        h.append("var rb=document.getElementById('rc');");
        h.append("if(rb){rb.onclick=function(){if(here){follow=true;map.setView(here.getLatLng(),Math.max(map.getZoom(),17));}};}");
        // Marcadores das TAGS (réplica local): âmbar, distinto do verde "você está aqui". Recebe o array já
        // montado pelo app (setTags([{mac,name,lat,lon}])); cria/move os pontos e remove os que sumiram.
        h.append("var tagMarks={};");
        h.append("window.setTags=function(arr){try{");
        h.append("var seen={};");
        h.append("for(var i=0;i<arr.length;i++){var it=arr[i];var mc=it.mac;seen[mc]=true;");
        h.append("var m=tagMarks[mc];");
        h.append("if(m==null){m=L.circleMarker([it.lat,it.lon],{radius:6,color:'#0F1115',weight:2,fillColor:'#E0A93B',fillOpacity:1}).addTo(map);tagMarks[mc]=m;}");
        h.append("else{m.setLatLng([it.lat,it.lon]);}");
        h.append("m.bindTooltip(it.name,{direction:'top'});}");
        h.append("for(var k in tagMarks){if(!seen[k]){map.removeLayer(tagMarks[k]);delete tagMarks[k];}}");
        h.append("}catch(e){}};");
        h.append("</script></body></html>");
        return h.toString();
    }

    /** Uma tag vista: nome, último RSSI e quando foi vista (relógio monotônico).
     *  `sentSeen` = o `lastSeen` da última medição que o hub JÁ RECEBEU (confirmada com 2xx).
     *  lastSeen > sentSeen ⇔ há medição FRESCA para postar. É o que separa medição de cópia. */
    static final class Tag {
        String name;
        int rssi;
        long lastSeen;
        long sentSeen;
    }

    // Bluetooth
    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private ScanSettings settings;
    private List<ScanFilter> scanFilters; // montado no onCreate (buildScanFilters) — NUNCA scan sem filtro

    // Estado do scan (tocado só na main thread, exceto os volatile abaixo)
    private final HashMap<String, Long> rawLogMs = new HashMap<String, Long>(); // throttle do log RAW (cb thread)
    private boolean scanning = false;
    private boolean permissionDenied = false;
    private volatile boolean scanFailed = false;   // set pelo onScanFailed (fora da main)
    private volatile long lastResultMs = 0;        // última leitura de TAG (fora da main)
    private long lastScanStartMs = 0;

    // Localização do aparelho (modelo AirTag): o LocationListener cacheia aqui; o poster lê no buildJson.
    private LocationManager locationManager;
    private boolean locActive = false;             // updates já registrados (tocado só na main thread)
    private volatile double lastLat, lastLon;
    private volatile float lastAcc;
    private volatile boolean hasFix = false;

    // Estado do hub (escrito pelo poster, lido pela main)
    private volatile String hubUrl = DEFAULT_HUB_URL; // endereço do ingest — descoberto na LAN ou editado à mão; persistido
    private volatile int hubState = 0;             // 0=aguardando 1=ok 2=falha
    private volatile String hubDetail = "aguardando primeiro envio ao hub";

    // Identidade desta estação (multi-antena): id vai no payload de TODO POST; token (opcional) vai
    // em x-station-token. Volatile: editados na main (dialogs), lidos nas threads de rede.
    private volatile String stationId = "tc22";    // sobrescrito no onCreate (pref ou default derivado)
    private volatile String stationToken = "";     // vazio = sem header (dev/LAN aberta)

    // Dados das tags (compartilhados: callback do scan escreve, main lê)
    private final Object lock = new Object();
    private final HashMap<String, Tag> tags = new HashMap<String, Tag>();

    // Nomes customizados do operador (mac -> nome). Lock próprio: tocado na main (dialog/redraw) e lido no makeRow.
    private final Object nameLock = new Object();
    private final HashMap<String, String> tagNames = new HashMap<String, String>();

    // Réplica local da ÚLTIMA localização vista de cada tag (mac -> [lat,lon,ts]). Persistida em prefs (KEY_LOCS).
    // Escrita quando a tag é vista COM fix (fora da main, no callback do scan); lida na main (makeRow/pushTags).
    private final Object locLock = new Object();
    private final HashMap<String, double[]> tagLocs = new HashMap<String, double[]>();
    private volatile boolean locsDirty = false;   // há localização nova ainda não persistida
    private long tickCount = 0;                    // conta ticks p/ persistir a réplica periodicamente (só main)

    // UI
    private LinearLayout listContainer;
    private TextView btChip, hubChip, tagChip, detailLine, subLine, titleLine;
    private WebView map;                             // mapa "você está aqui" (satélite Esri via Leaflet)
    private volatile boolean mapReady = false;       // HTML do mapa carregado (onPageFinished)
    private float density = 1f;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean running = true;
    private final Runnable subtitleRefresh = new Runnable() {
        @Override
        public void run() {
            updateSubtitle();
        }
    };

    private final ScanCallback cb = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult r) {
            String mac = r.getDevice().getAddress();
            String name = "";
            if (r.getScanRecord() != null && r.getScanRecord().getDeviceName() != null) {
                name = r.getScanRecord().getDeviceName();
            }
            int rssi = r.getRssi();
            boolean isTag = mac.toUpperCase().startsWith(OUI) || name.toUpperCase().startsWith("CP");
            Log.i(TAG, new StringBuilder(isTag ? "TAG " : "dev ")
                    .append(mac).append(' ').append(name).append(' ').append(rssi).toString());
            // DIAGNÓSTICO do filtro (barato, throttled): despeja o advertisement CRU das tags em hex
            // para auditar o formato real dos frames (company ID/estrutura) quando o ScanFilter não
            // casar — foi assim que o filtro certo foi derivado. 1 log por tag a cada ~10 s.
            if (isTag && r.getScanRecord() != null) {
                long nowRaw = SystemClock.elapsedRealtime();
                Long lastRaw = rawLogMs.get(mac);
                if (lastRaw == null || nowRaw - lastRaw > 10000) {
                    rawLogMs.put(mac, nowRaw);
                    byte[] raw = r.getScanRecord().getBytes();
                    StringBuilder hex = new StringBuilder("RAW ").append(mac).append(' ');
                    for (int i = 0; i < raw.length; i++) {
                        hex.append(String.format("%02X", raw[i]));
                    }
                    Log.i(TAG, hex.toString());
                }
            }
            if (isTag) {
                long now = SystemClock.elapsedRealtime();
                lastResultMs = now;
                synchronized (lock) {
                    Tag t = tags.get(mac);
                    if (t == null) {
                        t = new Tag();
                        tags.put(mac, t);
                    }
                    t.rssi = rssi;
                    t.lastSeen = now;
                    if (name.length() > 0) t.name = name;
                }
                // Réplica local: com fix, guarda a última posição em que ESTA tag foi vista (é a referência do app).
                if (hasFix) {
                    double la = lastLat, lo = lastLon;
                    double ts = System.currentTimeMillis();
                    synchronized (locLock) {
                        tagLocs.put(mac, new double[]{la, lo, ts});
                    }
                    locsDirty = true;
                }
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            Log.e(TAG, new StringBuilder("scan falhou: ").append(errorCode).toString());
            // ALREADY_STARTED(1) não é problema; qualquer outro erro -> deixa o tick reiniciar.
            if (errorCode != ScanCallback.SCAN_FAILED_ALREADY_STARTED) {
                scanFailed = true;
            }
        }
    };

    // Só cacheia a última posição (nada de rede aqui — o poster leva carona no POST de 2s).
    private final LocationListener locListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location loc) {
            if (loc == null) return;
            lastLat = loc.getLatitude();
            lastLon = loc.getLongitude();
            lastAcc = loc.hasAccuracy() ? loc.getAccuracy() : 0f;
            hasFix = true;
        }

        // Overrides vazios p/ compatibilidade com APIs antigas (evita AbstractMethodError em alguns ROMs).
        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {
        }

        @Override
        public void onProviderEnabled(String provider) {
        }

        @Override
        public void onProviderDisabled(String provider) {
        }
    };

    // ---------- Scan (robusto) ----------

    private boolean hasScanPerm() {
        if (Build.VERSION.SDK_INT < 31) return true;
        return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasLocationPerm() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * Liga os updates de localização UMA vez (GPS + rede), quando houver permissão. Baixa frequência
     * (~4s / ~10m) — a posição leva carona no POST de 2s. Semeia com a última conhecida. Nunca crasha:
     * SecurityException ou provider ausente são engolidos. Idempotente via locActive (self-heal no tick).
     */
    private void ensureLocation() {
        if (locActive || locationManager == null || !hasLocationPerm()) return;
        boolean any = false;
        try {
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 4000L, 10f, locListener);
            any = true;
        } catch (SecurityException se) {
            return; // permissão sumiu no meio — tenta de novo no próximo tick
        } catch (Exception ignored) {
            // provider inexistente neste device — segue p/ o de rede
        }
        try {
            locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 4000L, 10f, locListener);
            any = true;
        } catch (Exception ignored) {
        }
        // Semeia sem esperar o 1º update (útil logo após abrir o app).
        try {
            Location seed = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (seed == null) seed = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (seed != null) {
                lastLat = seed.getLatitude();
                lastLon = seed.getLongitude();
                lastAcc = seed.hasAccuracy() ? seed.getAccuracy() : 0f;
                hasFix = true;
            }
        } catch (Exception ignored) {
        }
        if (any) locActive = true;
    }

    /**
     * Filtros de hardware do scan (bug C1 do laudo `docs/analises/planta-ble-localizacao-continua/
     * estabilidade.md`): desde o Android 8.1 o framework SUPRIME os resultados de scan NÃO-FILTRADO
     * com a tela apagada — a estação ficava CEGA postando readings vazios, e o watchdog religava um
     * scan igualmente mudo (religar sem filtro não cura). Scan FILTRADO continua entregando
     * resultados de tela desligada — mata a C1 na raiz. FLAG_KEEP_SCREEN_ON e o watchdog seguem como
     * defesa em profundidade (política de OEM pode apagar a tela mesmo assim; scan pode morrer por
     * outros motivos).
     *
     * O formato REAL das DX-CP27 foi AUDITADO NO AR em 2026-07-15 (log "RAW" abaixo, 10 tags):
     *  - Frame PRINCIPAL (proprietário DX): lista de service UUIDs anuncia 0xFDA5, com service data
     *    em 0xFEAB (bateria + MAC) e 0xFEAC (MAC), + nome "CP27-xxxx".
     *      RAW: 0201060303A5FD0A16ABFE64<MAC>00000B16ACFE<MAC>00000A09 43503237...
     *  - Frame iBeacon: manufacturer data com company ID 0x4458 ("DX" em ASCII — NÃO é a Apple!),
     *    payload 0x02 0x15 + UUID E2C56DB5... + major/minor.
     *      RAW: 0201061AFF5844 0215 E2C56DB5DFFB48D2B060D0F5A71096E0 0005 0006 C7
     * OR entre os filtros (basta UM casar). A máscara do iBeacon cobre só 0x02 0x15 de propósito:
     * pega o frame de QUALQUER UUID/major/minor — quem filtra por cadastro é o pipeline (isTag +
     * cadastro no hub), não o rádio. 0x004C (Apple) e 0xFEAA (Eddystone) ficam como futuro-proof
     * (custo zero) caso as tags sejam reconfiguradas para modos genéricos.
     * Se as tags forem reconfiguradas p/ um formato FORA desses, o filtro cega a estação até com
     * tela ligada — reconfigurar advertising exige re-auditar com o log RAW (ver onScanResult).
     */
    private List<ScanFilter> buildScanFilters() {
        ArrayList<ScanFilter> filters = new ArrayList<ScanFilter>();
        // Frame proprietário DX (o dominante nas 10 tags): service UUID 0xFDA5 na lista.
        filters.add(new ScanFilter.Builder()
                .setServiceUuid(ParcelUuid.fromString("0000FDA5-0000-1000-8000-00805F9B34FB"))
                .build());
        // Frame iBeacon DX: company ID 0x4458 ("DX"), payload iBeacon clássico 0x02 0x15.
        filters.add(new ScanFilter.Builder()
                .setManufacturerData(0x4458,
                        new byte[]{(byte) 0x02, (byte) 0x15},
                        new byte[]{(byte) 0xFF, (byte) 0xFF})
                .build());
        // Futuro-proof (custo zero): iBeacon Apple e Eddystone genéricos.
        filters.add(new ScanFilter.Builder()
                .setManufacturerData(0x004C,
                        new byte[]{(byte) 0x02, (byte) 0x15},
                        new byte[]{(byte) 0xFF, (byte) 0xFF})
                .build());
        filters.add(new ScanFilter.Builder()
                .setServiceUuid(ParcelUuid.fromString("0000FEAA-0000-1000-8000-00805F9B34FB"))
                .build());
        return filters;
    }

    /** Decide, a cada tick, se o scan deve estar ligado; liga, religa (watchdog) ou desliga. Nunca crasha. */
    private void ensureScan(boolean btOn) {
        if (adapter == null || !btOn) {
            if (scanning) stopScanSafe();
            scanning = false;
            return;
        }
        if (!hasScanPerm()) {
            permissionDenied = true;
            if (scanning) {
                stopScanSafe();
                scanning = false;
            }
            return;
        }
        permissionDenied = false;
        long now = SystemClock.elapsedRealtime();
        if (scanFailed) {
            scanFailed = false;
            if (scanning) stopScanSafe();
            scanning = false;
        }
        if (!scanning) {
            startScanSafe(now);
            return;
        }
        // Watchdog: scan vivo não deveria ficar mudo (o CD tem tags sempre presentes). Religa.
        if (now - lastResultMs > SCAN_WATCHDOG_MS) {
            Log.w(TAG, "watchdog: sem leituras — reiniciando scan");
            stopScanSafe();
            scanning = false;
            startScanSafe(now);
        }
    }

    private void startScanSafe(long now) {
        try {
            scanner = adapter.getBluetoothLeScanner(); // pode mudar após religar o BT
            if (scanner == null) return;
            // SEMPRE com filtros: startScan(null, ...) é suprimido de tela apagada desde o 8.1 (C1).
            if (scanFilters == null) scanFilters = buildScanFilters(); // defensivo — onCreate já montou
            scanner.startScan(scanFilters, settings, cb);
            scanning = true;
            lastScanStartMs = now;
            lastResultMs = now; // dá folga ao watchdog logo após ligar
            Log.i(TAG, "scan iniciado");
        } catch (SecurityException e) {
            permissionDenied = true;
            scanning = false;
            Log.e(TAG, new StringBuilder("sem permissao de scan: ").append(e.getMessage()).toString());
        } catch (Exception e) {
            scanning = false;
            Log.e(TAG, new StringBuilder("startScan erro: ").append(e.getMessage()).toString());
        }
    }

    private void stopScanSafe() {
        if (scanner == null) return;
        try {
            scanner.stopScan(cb);
        } catch (Exception ignored) {
        }
    }

    // ---------- Hub ----------

    /**
     * Monta o JSON das leituras NOVAS desde o último POST bem-sucedido
     * (contrato: {stationId, readings:[{mac,name,rssi,ageMs}]}).
     *
     * SÓ O QUE MUDOU (2026-07-13 — bug B1 do laudo `laudo-2026-07-13-por-que-nao-associa.md`): antes
     * este método serializava o mapa INTEIRO de tags a cada 500 ms e o mapa só era limpo por
     * `pruneStale` (DROP_MS = 20 s). Duas consequências MEDIDAS na gravação real de campo:
     *  1. **83,3% do que o hub recebia era CÓPIA** do valor anterior (n = 266.174; Wilson 95%:
     *     83,1–83,4%) — a tag anuncia a cada ~2,2 s, o POST saía a cada 0,5 s. Cópia não é medição:
     *     ela infla a contagem de evidência do associador (Regra 8) e, pior, ENTRA na correlação
     *     como "RSSI parado enquanto a pessoa anda" — empurrando |r| PARA BAIXO justamente no par
     *     verdadeiro em movimento. Parte do silêncio era FABRICADA aqui.
     *  2. **FANTASMA**: tag que SAIU DE CENA seguia sendo postada com o último RSSI por até 20 s
     *     (app) + 15 s (pool do hub) = ~35 s oferecida ao associador como candidata PRESENTE.
     * Agora a tag só entra no payload quando o scanner a viu DE NOVO (`lastSeen > sentSeen`) — e o
     * fantasma morre no pool do hub (≤15 s) porque nada o realimenta.
     *
     * `ageMs` (ADITIVO, retrocompatível — hub antigo ignora o campo): idade da medição em ms, do
     * relógio MONOTÔNICO do aparelho. NÃO mandamos epoch de propósito: o relógio de parede do
     * celular pode estar torto em minutos e o hub reconstrói o instante com o RELÓGIO DELE
     * (`measuredAt = now − ageMs`, ver server/bt/bt-readings.js) — imune a skew. É o que permite ao
     * motor distinguir medição fresca de cópia ressuscitada pelo pool (src/fusion/associate.ts).
     *
     * `scanning` (ADITIVO, retrocompatível — hub antigo ignora o campo): true se o scanner entregou
     * ALGUMA leitura nos últimos SCAN_ALIVE_MS (15 s), false caso contrário. É a saúde HONESTA da
     * antena: sem ele, "estação cega" (bug C1 — scan suprimido de tela apagada, ver estabilidade.md)
     * e "sem tags por perto" chegam ao hub como o MESMO readings vazio. Com ele, o hub distingue e
     * pode alarmar a causa certa.
     *
     * POST VAZIO é MANTIDO (nada novo → `readings: []`): é o batimento cardíaco da estação — o hub
     * usa a chegada do POST para saber que a antena está viva (e é assim que "estação cega" pode
     * virar alarme). Silenciar o POST inteiro faria a estação parecer morta.
     *
     * `sent` (saída): mac → lastSeen de cada leitura incluída — só é COMMITADO em `sentSeen` se o
     * POST voltar 2xx (ver postOnce). POST que falhou não consome a medição.
     * stationId é validado a [a-zA-Z0-9_-] na entrada (isValidStationId) — vai cru, sem escapar.
     */
    private String buildJson(HashMap<String, Long> sent) {
        long now = SystemClock.elapsedRealtime();
        StringBuilder j = new StringBuilder("{\"stationId\":\"").append(stationId).append('"');
        // Saúde honesta da antena (ADITIVO): callbacks chegando há < SCAN_ALIVE_MS ⇒ scanning=true.
        // lastResultMs também é semeado no startScanSafe — logo após (re)ligar o scan há folga, igual
        // ao watchdog. StringBuilder.append(boolean) serializa "true"/"false" — JSON válido.
        j.append(",\"scanning\":").append(now - lastResultMs < SCAN_ALIVE_MS);
        // Modelo AirTag: com fix, a posição do aparelho vai no objeto raiz (Double/Float.toString = ponto decimal, sem locale).
        if (hasFix) {
            j.append(",\"lat\":").append(Double.toString(lastLat))
                    .append(",\"lon\":").append(Double.toString(lastLon))
                    .append(",\"acc\":").append(Float.toString(lastAcc));
        }
        j.append(",\"readings\":[");
        synchronized (lock) {
            boolean first = true;
            for (Map.Entry<String, Tag> e : tags.entrySet()) {
                Tag t = e.getValue();
                if (t.lastSeen <= t.sentSeen) continue; // já postada — cópia não é medição nova
                if (!first) j.append(',');
                first = false;
                String nm = t.name;
                if (nm == null) nm = "";
                long age = now - t.lastSeen;
                if (age < 0) age = 0; // defensivo (o monotônico não anda pra trás, mas custa 1 linha)
                j.append("{\"mac\":\"").append(e.getKey()).append("\",\"name\":\"").append(nm)
                        .append("\",\"rssi\":").append(t.rssi)
                        .append(",\"ageMs\":").append(age).append('}');
                sent.put(e.getKey(), Long.valueOf(t.lastSeen));
            }
        }
        return j.append("]}").toString();
    }

    /** Marca como entregues SÓ as medições que o hub confirmou (2xx). POST que falhou NÃO consome a
     *  leitura — ela vai no próximo envio (senão um 500 do hub apagaria a medição para sempre).
     *  Compara antes de gravar: uma leitura mais nova chegada DURANTE o POST não pode ser engolida. */
    private void commitSent(HashMap<String, Long> sent) {
        synchronized (lock) {
            for (Map.Entry<String, Long> e : sent.entrySet()) {
                Tag t = tags.get(e.getKey());
                if (t == null) continue; // podada no meio do POST (saiu de cena) — nada a marcar
                long v = e.getValue().longValue();
                if (t.sentSeen < v) t.sentSeen = v;
            }
        }
    }

    /** Aplica o token da estação (se houver) na conexão — header x-station-token do hub. Vazio = nada. */
    private void applyStationToken(HttpURLConnection c) {
        String tok = stationToken;
        if (tok != null && tok.length() > 0) c.setRequestProperty(HDR_TOKEN, tok);
    }

    private void postOnce() {
        HttpURLConnection c = null;
        int n;
        synchronized (lock) {
            n = tags.size();
        }
        // Payload montado ANTES de abrir a conexão: `sent` guarda o que foi incluído (só vira
        // "entregue" com 2xx — ver commitSent). Vazio = nada novo desde o último POST (heartbeat).
        final HashMap<String, Long> sent = new HashMap<String, Long>();
        final String payload = buildJson(sent);
        try {
            c = (HttpURLConnection) new URL(hubUrl).openConnection();
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/json");
            applyStationToken(c);
            c.setConnectTimeout(3000);
            c.setReadTimeout(3000);
            c.setDoOutput(true);
            byte[] body = payload.getBytes("UTF-8");
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.close();
            int code = c.getResponseCode();
            Log.i(TAG, new StringBuilder("POST hub -> ").append(code).toString());
            boolean ok = code >= 200 && code < 300;
            if (ok) commitSent(sent); // só agora a medição vira "entregue"
            hubState = ok ? 1 : 2;
            hubDetail = new StringBuilder("POST ").append(code)
                    .append(" · ").append(sent.size()).append(" nova(s) de ")
                    .append(n).append(" tags").toString();
        } catch (Exception e) {
            hubState = 2;
            hubDetail = new StringBuilder("POST falhou: ").append(e.getMessage()).toString();
            Log.e(TAG, hubDetail);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Broadcast UDP p/ achar o hub na LAN (contrato com server/discovery.js). URL de ingest ou null. Fora da main. */
    private String discoverHub() {
        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket();
            sock.setBroadcast(true);
            sock.setSoTimeout(1500);
            byte[] probe = DISCOVERY_PROBE.getBytes("UTF-8");
            sock.send(new DatagramPacket(probe, probe.length,
                    InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT));
            byte[] buf = new byte[512];
            DatagramPacket resp = new DatagramPacket(buf, buf.length);
            sock.receive(resp); // bloqueia até a resposta ou o timeout
            String msg = new String(resp.getData(), 0, resp.getLength(), "UTF-8");
            int i = msg.indexOf("\"ingest\":\"");
            if (i < 0) return null;
            i += 10; // len de "ingest":"
            int j = msg.indexOf('"', i);
            if (j < 0) return null;
            return msg.substring(i, j);
        } catch (Exception e) {
            return null; // sem hub na LAN, ou broadcast bloqueado — silencioso (o manual é o fallback)
        } finally {
            if (sock != null) sock.close();
        }
    }

    /** Título = id desta estação (tocável p/ editar); subtítulo = id + endereço do hub (tocável p/ editar). */
    private void updateSubtitle() {
        if (titleLine != null) {
            titleLine.setText(new StringBuilder("Estação BLE · ").append(stationId).toString());
        }
        if (subLine == null) return;
        subLine.setText(new StringBuilder("estação ").append(stationId)
                .append("  ·  hub ").append(hubUrl).append("  ·  toque p/ editar").toString());
    }

    /** Valida o id da estação: 1–32 chars em [a-zA-Z0-9_-] (vai cru no JSON/logs — nada de escapar). */
    private static boolean isValidStationId(String v) {
        if (v == null || v.length() == 0 || v.length() > 32) return false;
        for (int i = 0; i < v.length(); i++) {
            char ch = v.charAt(i);
            boolean ok = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')
                    || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-';
            if (!ok) return false;
        }
        return true;
    }

    /**
     * Id default anti-colisão: "tc22-" + 4 últimos chars do ANDROID_ID (hex; estável por
     * device+assinatura+usuário desde a API 26 — o minSdk do app). Build.SERIAL foi descartado:
     * na API 26+ exige READ_PHONE_STATE (Build.getSerial idem) — permissão que o app não pede.
     * Sem ANDROID_ID (raro: ROM capada), sorteia 4 chars — a persistência em prefs (onCreate)
     * é quem garante a estabilidade entre restarts nesse caso.
     */
    private String defaultStationId() {
        String suffix = null;
        try {
            String aid = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
            if (aid != null && aid.length() >= 4) suffix = aid.substring(aid.length() - 4);
        } catch (Exception ignored) {
            // provider indisponível — cai no sorteio abaixo
        }
        if (suffix == null || !isValidStationId(suffix)) {
            String alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
            Random rnd = new Random();
            StringBuilder r = new StringBuilder();
            for (int i = 0; i < 4; i++) r.append(alpha.charAt(rnd.nextInt(alpha.length())));
            suffix = r.toString();
        }
        return new StringBuilder("tc22-").append(suffix).toString();
    }

    /** Dialog p/ editar o id DESTA estação (persistido) — molde do promptHubUrl. Multi-antena: cada celular = um id. */
    private void promptStationId() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        input.setSingleLine(true);
        input.setSelectAllOnFocus(true);
        input.setText(stationId);
        input.setPadding(dp(16), dp(12), dp(16), dp(12));
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle("Id da estação");
        b.setMessage("Identifica ESTA antena no hub. 1–32 chars: letras, números, _ ou -. Dois celulares nunca podem usar o mesmo id.");
        b.setView(input);
        b.setPositiveButton("Salvar", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int w) {
                String v = input.getText().toString().trim();
                if (!isValidStationId(v)) {
                    Toast.makeText(MainActivity.this,
                            "Id inválido — 1–32 chars: letras, números, _ ou -", Toast.LENGTH_LONG).show();
                    return;
                }
                stationId = v;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_STATION, v).apply();
                updateSubtitle();
            }
        });
        b.setNeutralButton("Padrão", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int w) {
                String v = defaultStationId();
                stationId = v;
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_STATION, v).apply();
                updateSubtitle();
            }
        });
        b.setNegativeButton("Cancelar", null);
        b.show();
    }

    /** Persiste hub URL + token de uma vez (os dois campos do dialog aplicam juntos) e força reenvio. */
    private void saveHubAndToken(String url, String token) {
        hubUrl = url;
        stationToken = token;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(KEY_HUB, url).putString(KEY_TOKEN, token).apply();
        hubState = 0;
        hubDetail = "endereço atualizado — reenviando…";
        updateSubtitle();
    }

    /**
     * Dialog p/ fixar o endereço do hub à mão (persistido) — fallback quando o broadcast não passa.
     * Traz também o token da estação (opcional, mesmo dialog): vazio = LAN aberta (dev); preenchido
     * vai em x-station-token em TODO request ao hub (produção pós-faxina). Texto visível de propósito
     * — o engenheiro precisa conferir o que digitou no chão de fábrica.
     */
    private void promptHubUrl() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setSelectAllOnFocus(true);
        input.setText(hubUrl);
        input.setPadding(dp(16), dp(12), dp(16), dp(12));
        final EditText tokenInput = new EditText(this);
        tokenInput.setInputType(InputType.TYPE_CLASS_TEXT);
        tokenInput.setSingleLine(true);
        tokenInput.setHint("token da estação (opcional — vazio = sem auth)");
        tokenInput.setText(stationToken);
        tokenInput.setPadding(dp(16), dp(12), dp(16), dp(12));
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.addView(input);
        box.addView(tokenInput);
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle("Endereço do hub");
        b.setMessage("URL do ingest — mesmo caminho/porta do hub. Ex.: http://192.168.0.10:4000/api/bt/reading");
        b.setView(box);
        b.setPositiveButton("Salvar", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int w) {
                String v = input.getText().toString().trim();
                if (v.length() == 0) return;
                saveHubAndToken(v, tokenInput.getText().toString().trim());
            }
        });
        b.setNeutralButton("Padrão", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int w) {
                saveHubAndToken(DEFAULT_HUB_URL, tokenInput.getText().toString().trim());
            }
        });
        b.setNegativeButton("Cancelar", null);
        b.show();
    }

    // ---------- Nomes customizados das tags ----------

    /** Carrega o blob de nomes do prefs (linhas "mac=nome") para o cache. Tolerante a linha malformada. */
    private void loadTagNames() {
        String blob = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_NAMES, "");
        if (blob == null || blob.length() == 0) return;
        String[] lines = blob.split("\n");
        synchronized (nameLock) {
            for (int i = 0; i < lines.length; i++) {
                String ln = lines[i];
                int eq = ln.indexOf('=');
                if (eq <= 0) continue; // sem '=' ou mac vazio
                String mac = ln.substring(0, eq);
                String nm = ln.substring(eq + 1);
                if (nm.length() > 0) tagNames.put(mac, nm);
            }
        }
    }

    /** Persiste o cache de nomes como blob simples (StringBuilder, sem lib). Chamado após cada edição. */
    private void saveTagNames() {
        StringBuilder sb = new StringBuilder();
        synchronized (nameLock) {
            boolean first = true;
            for (Map.Entry<String, String> e : tagNames.entrySet()) {
                if (!first) sb.append('\n');
                first = false;
                sb.append(e.getKey()).append('=').append(e.getValue());
            }
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_NAMES, sb.toString()).apply();
    }

    /** Carrega a réplica de localização do prefs (linhas "mac=lat,lon,ts"). Tolerante a linha malformada. */
    private void loadTagLocs() {
        String blob = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_LOCS, "");
        if (blob == null || blob.length() == 0) return;
        String[] lines = blob.split("\n");
        synchronized (locLock) {
            for (int i = 0; i < lines.length; i++) {
                String ln = lines[i];
                int eq = ln.indexOf('=');
                if (eq <= 0) continue; // sem '=' ou mac vazio
                String mac = ln.substring(0, eq);
                String[] parts = ln.substring(eq + 1).split(",");
                if (parts.length < 2) continue;
                try {
                    double la = Double.parseDouble(parts[0]);
                    double lo = Double.parseDouble(parts[1]);
                    double ts = parts.length >= 3 ? Double.parseDouble(parts[2]) : 0d;
                    tagLocs.put(mac, new double[]{la, lo, ts});
                } catch (Exception ignored) {
                    // linha corrompida — ignora e segue
                }
            }
        }
    }

    /** Persiste a réplica de localização como blob simples (StringBuilder, sem lib; ponto decimal via Double.toString). */
    private void saveTagLocs() {
        StringBuilder sb = new StringBuilder();
        synchronized (locLock) {
            boolean first = true;
            for (Map.Entry<String, double[]> e : tagLocs.entrySet()) {
                double[] v = e.getValue();
                if (!first) sb.append('\n');
                first = false;
                sb.append(e.getKey()).append('=')
                        .append(Double.toString(v[0])).append(',')
                        .append(Double.toString(v[1])).append(',')
                        .append(Double.toString(v[2]));
            }
        }
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_LOCS, sb.toString()).apply();
    }

    /** Formata um grau com 4 casas decimais SEM locale (sempre ponto) e sem `+` — p/ exibir a última posição. */
    private String fmt4(double v) {
        long scaled = Math.round(v * 10000d);
        boolean neg = scaled < 0;
        if (neg) scaled = -scaled;
        long ip = scaled / 10000;
        long fp = scaled % 10000;
        StringBuilder sb = new StringBuilder();
        if (neg) sb.append('-');
        sb.append(Long.toString(ip)).append('.');
        if (fp < 1000) sb.append('0');
        if (fp < 100) sb.append('0');
        if (fp < 10) sb.append('0');
        sb.append(Long.toString(fp));
        return sb.toString();
    }

    /** Deriva a URL de nomeação do hubUrl atual: troca o sufixo /reading por /tag-name (ou concatena seguro). */
    private String tagNameUrl() {
        String base = hubUrl;
        if (base.endsWith(SUFFIX_READING)) {
            StringBuilder sb = new StringBuilder(base.substring(0, base.length() - SUFFIX_READING.length()));
            return sb.append(SUFFIX_TAGNAME).toString();
        }
        StringBuilder sb = new StringBuilder(base);
        if (base.length() > 0 && base.charAt(base.length() - 1) == '/') sb.setLength(sb.length() - 1);
        return sb.append(SUFFIX_TAGNAME).toString();
    }

    /** Deriva a URL de listagem de nomes do hubUrl atual: troca o sufixo /reading por /tags (ou concatena seguro). */
    private String tagsUrl() {
        String base = hubUrl;
        if (base.endsWith(SUFFIX_READING)) {
            StringBuilder sb = new StringBuilder(base.substring(0, base.length() - SUFFIX_READING.length()));
            return sb.append(SUFFIX_TAGS).toString();
        }
        StringBuilder sb = new StringBuilder(base);
        if (base.length() > 0 && base.charAt(base.length() - 1) == '/') sb.setLength(sb.length() - 1);
        return sb.append(SUFFIX_TAGS).toString();
    }

    /**
     * Puxa os nomes do hub (GET /api/bt/tags → [{mac,rotulo}]) e ADOTA (servidor = fonte). Fora da main.
     * Só regrava/redesenha se algo mudou. Falha é silenciosa (o naming local continua empurrando via postTagName).
     */
    private void syncTagNamesOnce() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(tagsUrl()).openConnection();
            c.setRequestMethod("GET");
            applyStationToken(c);
            c.setConnectTimeout(3000);
            c.setReadTimeout(3000);
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) return;
            InputStream is = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            int r;
            while ((r = is.read(buf)) != -1) bos.write(buf, 0, r);
            is.close();
            String body = new String(bos.toByteArray(), "UTF-8");
            JSONArray arr = new JSONArray(body);
            boolean changed = false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String mac = o.optString("mac", "");
                String rotulo = o.optString("rotulo", "");
                if (mac.length() == 0 || rotulo.length() == 0) continue;
                synchronized (nameLock) {
                    String prev = tagNames.get(mac);
                    if (prev == null || !prev.equals(rotulo)) {
                        tagNames.put(mac, rotulo);
                        changed = true;
                    }
                }
            }
            if (changed) {
                saveTagNames();
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        refreshUi(adapter != null && adapter.isEnabled());
                    }
                });
                Log.i(TAG, "nomes sincronizados do hub");
            }
        } catch (Exception e) {
            Log.e(TAG, new StringBuilder("sync tags falhou: ").append(e.getMessage()).toString());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Escapa o mínimo p/ JSON válido (nome é digitado pelo operador): barra invertida e aspas. */
    private String jsonEscape(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '\\' || ch == '"') sb.append('\\');
            sb.append(ch);
        }
        return sb.toString();
    }

    /** POST {mac,name} ao hub numa thread daemon (rede fora da main). Falha só loga — o nome local já foi salvo. */
    private void postTagName(final String mac, final String name) {
        final String url = tagNameUrl();
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection c = null;
                try {
                    StringBuilder j = new StringBuilder("{\"mac\":\"").append(jsonEscape(mac))
                            .append("\",\"name\":\"").append(jsonEscape(name)).append("\"}");
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod("POST");
                    c.setRequestProperty("Content-Type", "application/json");
                    applyStationToken(c);
                    c.setConnectTimeout(3000);
                    c.setReadTimeout(3000);
                    c.setDoOutput(true);
                    byte[] body = j.toString().getBytes("UTF-8");
                    OutputStream os = c.getOutputStream();
                    os.write(body);
                    os.close();
                    int code = c.getResponseCode();
                    Log.i(TAG, new StringBuilder("POST tag-name -> ").append(code).toString());
                } catch (Exception e) {
                    Log.e(TAG, new StringBuilder("POST tag-name falhou: ").append(e.getMessage()).toString());
                } finally {
                    if (c != null) c.disconnect();
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    /** Dialog p/ nomear uma tag: prefill com o nome atual, Salvar grava local + prefs + redesenha + POST ao hub. */
    private void promptTagName(final String mac) {
        String current;
        synchronized (nameLock) {
            current = tagNames.get(mac);
        }
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS);
        input.setSingleLine(true);
        input.setSelectAllOnFocus(true);
        if (current != null) input.setText(current);
        input.setPadding(dp(16), dp(12), dp(16), dp(12));
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        b.setTitle("Nomear tag");
        b.setMessage(new StringBuilder("MAC ").append(mac).toString());
        b.setView(input);
        b.setPositiveButton("Salvar", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface d, int w) {
                String v = input.getText().toString().trim();
                if (v.length() == 0) return;
                synchronized (nameLock) {
                    tagNames.put(mac, v);
                }
                saveTagNames();
                refreshUi(adapter != null && adapter.isEnabled()); // redraw imediato com o nome novo
                postTagName(mac, v);
            }
        });
        b.setNegativeButton("Cancelar", null);
        b.show();
    }

    // ---------- Ciclo de vida ----------

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        // Modo estação: TELA SEMPRE ACESA. Com a tela apagada o Android estrangula o scan BLE de app
        // em segundo plano e a estação fica CEGA (caso real de campo: 11 min postando readings vazios).
        // O app é dedicado — o TC22 é a antena da estação — então manter a tela ligada é a semântica
        // certa, não desperdício. FLAG_KEEP_SCREEN_ON só vale com o app em foreground: não impede o
        // usuário de sair do app nem segura wakelock global.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        density = getResources().getDisplayMetrics().density;
        hubUrl = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_HUB, DEFAULT_HUB_URL);
        // Identidade da estação: pref válida vale; senão (1º boot ou pref corrompida) deriva o default
        // anti-colisão do device e PERSISTE já — o id nunca muda sozinho entre restarts (CA-4).
        String sid = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_STATION, "");
        if (!isValidStationId(sid)) {
            sid = defaultStationId();
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_STATION, sid).apply();
        }
        stationId = sid;
        String tok = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_TOKEN, "");
        stationToken = tok != null ? tok : "";
        loadTagNames();
        loadTagLocs();
        buildUi();

        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        adapter = bm != null ? bm.getAdapter() : null;
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();
        scanFilters = buildScanFilters(); // scan SEMPRE filtrado (C1 — ver buildScanFilters)

        // Permissões de runtime: BLE scan (Android 12+) + localização do aparelho (modelo AirTag). Pede tudo de uma vez.
        ArrayList<String> want = new ArrayList<String>();
        if (Build.VERSION.SDK_INT >= 31 && !hasScanPerm()) {
            want.add(Manifest.permission.BLUETOOTH_SCAN);
            want.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (!hasLocationPerm()) {
            want.add(Manifest.permission.ACCESS_FINE_LOCATION);
            want.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (!want.isEmpty()) {
            try {
                requestPermissions(want.toArray(new String[0]), REQ_PERM);
            } catch (Exception ignored) {
            }
        }
        ensureLocation(); // liga já se a permissão existir; senão o tick religa após o grant (sem reabrir o app)

        // Poster: a cada POST_EVERY_MS envia o snapshot ao hub (rede SEMPRE fora da main thread).
        Thread poster = new Thread(new Runnable() {
            @Override
            public void run() {
                while (running) {
                    try {
                        Thread.sleep(POST_EVERY_MS);
                    } catch (InterruptedException ie) {
                        return;
                    }
                    postOnce();
                    // "Se o hub está no ar, conecta": quando o envio falha, procura o hub na LAN por
                    // broadcast e adota o endereço SE alguém responder (nunca quebra um endereço que funciona).
                    if (hubState == 2) {
                        String found = discoverHub();
                        if (found != null && !found.equals(hubUrl)) {
                            hubUrl = found;
                            hubDetail = new StringBuilder("hub encontrado na rede: ").append(found).toString();
                            ui.post(subtitleRefresh);
                        }
                    }
                }
            }
        });
        poster.setDaemon(true);
        poster.start();

        // Sync de nomes (PULL): a cada SYNC_NAMES_MS puxa os rótulos do hub e adota (servidor = fonte). Fora da main.
        Thread syncer = new Thread(new Runnable() {
            @Override
            public void run() {
                while (running) {
                    syncTagNamesOnce();
                    try {
                        Thread.sleep(SYNC_NAMES_MS);
                    } catch (InterruptedException ie) {
                        return;
                    }
                }
            }
        });
        syncer.setDaemon(true);
        syncer.start();

        ui.post(tick); // liga o refresh vivo (que também gerencia o scan)
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        running = false;
        ui.removeCallbacks(tick);
        if (locsDirty) saveTagLocs(); // não perde a última posição vista ao fechar
        locsDirty = false;
        if (map != null) {
            try {
                map.destroy();
            } catch (Exception ignored) {
            }
        }
        stopScanSafe();
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(locListener);
            } catch (Exception ignored) {
            }
        }
    }

    /** Coração vivo: 1x/s reavalia BT+scan, poda tags velhas e redesenha — sem reabrir o app. */
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            boolean btOn = adapter != null && adapter.isEnabled();
            ensureScan(btOn);
            ensureLocation(); // religa a localização assim que a permissão for concedida (sem reabrir)
            pruneStale();
            refreshUi(btOn);
            pushLocation(); // atualiza o "você está aqui" no mapa (só age quando há fix)
            pushTags();     // atualiza os marcadores das tags (réplica local de localização)
            // Persiste a réplica periodicamente, só quando algo mudou (evita escrever prefs todo tick).
            tickCount++;
            if (locsDirty && (tickCount % SAVE_LOCS_EVERY_TICKS == 0)) {
                locsDirty = false;
                saveTagLocs();
            }
            ui.postDelayed(this, REFRESH_MS);
        }
    };

    private void pruneStale() {
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            Iterator<Map.Entry<String, Tag>> it = tags.entrySet().iterator();
            while (it.hasNext()) {
                if (now - it.next().getValue().lastSeen > DROP_MS) it.remove();
            }
        }
    }

    /** Injeta o último fix no mapa via JS (main thread). Barato: só move o marcador quando há posição. */
    private void pushLocation() {
        if (!mapReady || !hasFix || map == null) return;
        try {
            StringBuilder js = new StringBuilder("setHere(");
            js.append(Double.toString(lastLat)).append(',')
                    .append(Double.toString(lastLon)).append(',')
                    .append(Float.toString(lastAcc)).append(')');
            map.evaluateJavascript(js.toString(), null);
        } catch (Exception ignored) {
            // WebView pode estar em transição — ignora; o próximo tick tenta de novo
        }
    }

    /**
     * Injeta os marcadores das tags (réplica local) no mapa via JS (main thread). Monta o array com o
     * NOME atual (rótulo do operador/hub se houver) — StringBuilder, sem `+`. Passa o array literal direto
     * ao setTags (o WebView avalia como JS; sem JSON.parse). Barato: só um evaluateJavascript por tick.
     */
    private void pushTags() {
        if (!mapReady || map == null) return;
        StringBuilder arr = new StringBuilder("[");
        synchronized (locLock) {
            boolean first = true;
            for (Map.Entry<String, double[]> e : tagLocs.entrySet()) {
                double[] v = e.getValue();
                String mac = e.getKey();
                String nm;
                synchronized (nameLock) {
                    nm = tagNames.get(mac);
                }
                if (nm == null || nm.length() == 0) nm = mac;
                if (!first) arr.append(',');
                first = false;
                arr.append("{\"mac\":\"").append(jsonEscape(mac))
                        .append("\",\"name\":\"").append(jsonEscape(nm))
                        .append("\",\"lat\":").append(Double.toString(v[0]))
                        .append(",\"lon\":").append(Double.toString(v[1])).append('}');
            }
        }
        arr.append(']');
        try {
            StringBuilder js = new StringBuilder("setTags(").append(arr).append(')');
            map.evaluateJavascript(js.toString(), null);
        } catch (Exception ignored) {
            // WebView pode estar em transição — ignora; o próximo tick tenta de novo
        }
    }

    // ---------- UI (programática — sem res/layout XML, mantém o build offline) ----------

    private int dp(int v) {
        return Math.round(v * density);
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(C_BG);

        // Header
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setBackgroundColor(C_HEADER);
        header.setPadding(dp(16), dp(16), dp(16), dp(14));

        // Título = identidade da estação (o operador precisa VER qual id este device usa). Toque edita.
        titleLine = new TextView(this);
        titleLine.setTextColor(C_TXT);
        titleLine.setTextSize(19);
        titleLine.setTypeface(Typeface.DEFAULT_BOLD);
        titleLine.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                promptStationId();
            }
        });

        subLine = new TextView(this);
        subLine.setTextColor(C_MUTED);
        subLine.setTextSize(11);
        subLine.setPadding(0, dp(2), 0, 0);
        subLine.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                promptHubUrl();
            }
        });
        updateSubtitle();

        LinearLayout chips = new LinearLayout(this);
        chips.setOrientation(LinearLayout.HORIZONTAL);
        chips.setPadding(0, dp(12), 0, 0);
        btChip = newChip();
        hubChip = newChip();
        tagChip = newChip();
        chips.addView(btChip, chipLp());
        chips.addView(hubChip, chipLp());
        chips.addView(tagChip, chipLp());

        detailLine = new TextView(this);
        detailLine.setTextColor(C_MUTED);
        detailLine.setTextSize(11);
        detailLine.setPadding(0, dp(10), 0, 0);

        header.addView(titleLine);
        header.addView(subLine);
        header.addView(chips);
        header.addView(detailLine);

        // Mapa "você está aqui" — área PRINCIPAL da tela (peso maior). WebView Leaflet, GPS injetado por JS.
        map = new WebView(this);
        WebSettings s = map.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        map.setBackgroundColor(C_BG);
        map.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                mapReady = true;
                pushLocation(); // empurra o último fix assim que o HTML termina de carregar
            }
        });
        map.loadDataWithBaseURL("https://appmap.local/", MAP_HTML, "text/html", "utf-8", null);

        // Lista rolável (peso menor, abaixo do mapa)
        ScrollView sv = new ScrollView(this);
        listContainer = new LinearLayout(this);
        listContainer.setOrientation(LinearLayout.VERTICAL);
        listContainer.setPadding(dp(12), dp(12), dp(12), dp(12));
        sv.addView(listContainer);

        root.addView(header, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(map, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 2.2f));
        root.addView(sv, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1.3f));
        setContentView(root);
    }

    private TextView newChip() {
        TextView t = new TextView(this);
        t.setTextSize(13);
        return t;
    }

    private LinearLayout.LayoutParams chipLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(8);
        return lp;
    }

    private void styleChip(TextView chip, String text, int fg, int bg) {
        chip.setText(text);
        chip.setTextColor(fg);
        GradientDrawable d = new GradientDrawable();
        d.setColor(bg);
        d.setCornerRadius(dp(14));
        chip.setBackground(d);
        chip.setPadding(dp(12), dp(6), dp(12), dp(6));
    }

    private void refreshUi(boolean btOn) {
        long now = SystemClock.elapsedRealtime();

        if (btOn) styleChip(btChip, "Bluetooth on", C_GREEN, C_GREEN_BG);
        else styleChip(btChip, "Bluetooth OFF", C_RED, C_RED_BG);

        int hs = hubState;
        if (hs == 1) styleChip(hubChip, "Hub ✓", C_GREEN, C_GREEN_BG);
        else if (hs == 2) styleChip(hubChip, "Hub ✗", C_RED, C_RED_BG);
        else styleChip(hubChip, "Hub …", C_MUTED, C_MUTED_BG);

        // Snapshot ordenado (cópia sob lock; UI construída fora do lock)
        final ArrayList<Object[]> snap = new ArrayList<Object[]>();
        int count;
        synchronized (lock) {
            count = tags.size();
            for (Map.Entry<String, Tag> e : tags.entrySet()) {
                Tag src = e.getValue();
                Tag c = new Tag();
                c.name = src.name;
                c.rssi = src.rssi;
                c.lastSeen = src.lastSeen;
                snap.add(new Object[]{e.getKey(), c});
            }
        }
        Collections.sort(snap, new Comparator<Object[]>() {
            @Override
            public int compare(Object[] a, Object[] b) {
                return ((Tag) b[1]).rssi - ((Tag) a[1]).rssi; // mais forte primeiro
            }
        });

        StringBuilder tb = new StringBuilder().append(count).append(count == 1 ? " tag" : " tags");
        styleChip(tagChip, tb.toString(), count > 0 ? C_GREEN : C_MUTED, count > 0 ? C_GREEN_BG : C_MUTED_BG);
        detailLine.setTextColor(hs == 2 ? C_RED : C_MUTED);
        detailLine.setText(new StringBuilder(hubDetail).append(hasFix ? "  ·  GPS ✓" : "  ·  GPS …").toString());

        listContainer.removeAllViews();
        if (!btOn) {
            listContainer.addView(stateView("Bluetooth desligado. Ligue para retomar a varredura automaticamente."));
            return;
        }
        if (permissionDenied) {
            listContainer.addView(stateView("Permissão de scan negada. Conceda BLUETOOTH_SCAN e reabra o app."));
            return;
        }
        if (snap.isEmpty()) {
            listContainer.addView(stateView("Procurando tags…"));
            return;
        }
        for (Object[] o : snap) {
            listContainer.addView(makeRow((String) o[0], (Tag) o[1], now));
        }
    }

    private TextView stateView(String msg) {
        TextView t = new TextView(this);
        t.setText(msg);
        t.setTextColor(C_MUTED);
        t.setTextSize(14);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(16), dp(40), dp(16), dp(16));
        return t;
    }

    private LinearLayout makeRow(String mac, Tag t, long now) {
        boolean stale = now - t.lastSeen > STALE_MS;

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(C_ROW);
        bg.setCornerRadius(dp(10));
        row.setBackground(bg);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rlp.bottomMargin = dp(8);
        row.setLayoutParams(rlp);

        // Nome + MAC (esquerda, peso 1)
        LinearLayout left = new LinearLayout(this);
        left.setOrientation(LinearLayout.VERTICAL);
        left.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        TextView nameTv = new TextView(this);
        String custom;
        synchronized (nameLock) {
            custom = tagNames.get(mac);
        }
        String nm = t.name;
        String shown;
        if (custom != null && custom.length() > 0) shown = custom;       // nome do operador tem prioridade
        else if (nm != null && nm.length() > 0) shown = nm;              // senão o nome BT
        else shown = "(sem nome)";
        nameTv.setText(shown);
        nameTv.setTextColor(C_TXT);
        nameTv.setTextSize(15);
        nameTv.setTypeface(Typeface.DEFAULT_BOLD);
        TextView macTv = new TextView(this);
        macTv.setText(mac);
        macTv.setTextColor(C_MUTED);
        macTv.setTextSize(12);
        left.addView(nameTv);
        left.addView(macTv);
        // Réplica local: se já vimos esta tag com fix, mostra a última posição conhecida (referência do app).
        double[] loc;
        synchronized (locLock) {
            loc = tagLocs.get(mac);
        }
        if (loc != null) {
            TextView locTv = new TextView(this);
            locTv.setText(new StringBuilder("última: ").append(fmt4(loc[0])).append(',').append(fmt4(loc[1])).toString());
            locTv.setTextColor(C_MUTED);
            locTv.setTextSize(11);
            left.addView(locTv);
        }

        // Barra de sinal
        int barW = dp(84), barH = dp(8);
        FrameLayout bar = new FrameLayout(this);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(barW, barH);
        blp.leftMargin = dp(8);
        blp.rightMargin = dp(12);
        bar.setLayoutParams(blp);
        GradientDrawable track = new GradientDrawable();
        track.setColor(C_TRACK);
        track.setCornerRadius(barH / 2f);
        bar.setBackground(track);
        float f = (t.rssi + 100) / 70f; // ~-100 fraco .. -30 forte
        if (f < 0.05f) f = 0.05f;
        if (f > 1f) f = 1f;
        int fillColor = stale ? C_MUTED : (t.rssi >= -60 ? C_GREEN : (t.rssi >= -75 ? C_AMBER : C_MUTED));
        View fill = new View(this);
        fill.setLayoutParams(new FrameLayout.LayoutParams((int) (barW * f), barH));
        GradientDrawable fd = new GradientDrawable();
        fd.setColor(fillColor);
        fd.setCornerRadius(barH / 2f);
        fill.setBackground(fd);
        bar.addView(fill);

        // RSSI (direita)
        TextView rssiTv = new TextView(this);
        rssiTv.setText(new StringBuilder().append(t.rssi).append(" dBm").toString());
        rssiTv.setTextColor(stale ? C_MUTED : C_TXT);
        rssiTv.setTextSize(13);
        rssiTv.setGravity(Gravity.END);
        rssiTv.setLayoutParams(new LinearLayout.LayoutParams(dp(64), ViewGroup.LayoutParams.WRAP_CONTENT));

        row.addView(left);
        row.addView(bar);
        row.addView(rssiTv);
        if (stale) row.setAlpha(0.45f);

        // Toque na linha -> nomear a tag (classe anônima; mac precisa ser final p/ o build manual).
        final String rowMac = mac;
        row.setClickable(true);
        row.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                promptTagName(rowMac);
            }
        });
        return row;
    }
}
