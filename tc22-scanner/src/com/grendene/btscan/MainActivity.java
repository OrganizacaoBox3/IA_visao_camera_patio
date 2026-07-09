package com.grendene.btscan;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * Estação BLE do TC22 — varre as tags (família Grendene) e REPORTA ao hub por HTTP. É a "antena real"
 * da identidade aumentada (analises/tags-bluetooth/). Responsabilidade única: varrer + reportar + exibir vivo.
 * Loga em Logcat ("BTSCAN") p/ diagnóstico. Sem `+` em runtime (Android não tem StringConcatFactory) e sem lambda.
 *
 * Robustez (queixa do dono): recupera de BT off→on, de permissão negada, de scan que morre (watchdog),
 * e mostra falha de POST no hub — sem crashar e sem exigir reabrir o app. A tela atualiza SOZINHA por
 * um refresh periódico (Handler): tags novas aparecem, RSSI muda, tags paradas desbotam e caem.
 *
 * Rede: por USB, rode `adb reverse tcp:4000 tcp:4000` → o 127.0.0.1:4000 do TC22 chega no hub do PC.
 * Em produção (WiFi), troque HUB_URL pelo endereço real do hub.
 */
public class MainActivity extends Activity {
    static final String TAG = "BTSCAN";
    static final String OUI = "48:87:2D"; // fabricante das tags do projeto
    static final String STATION_ID = "tc22";
    static final String HUB_URL = "http://127.0.0.1:4000/api/bt/reading";
    static final long POST_EVERY_MS = 2000;      // envio ao hub
    static final long REFRESH_MS = 1000;         // refresh da tela (vida)
    static final long STALE_MS = 6000;           // sem ver a tag -> desbota
    static final long DROP_MS = 20000;           // sem ver a tag -> some da lista/contagem
    static final long SCAN_WATCHDOG_MS = 20000;  // sem NENHUMA leitura -> scan provavelmente morreu, reinicia
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

    /** Uma tag vista: nome, último RSSI e quando foi vista (relógio monotônico). */
    static final class Tag {
        String name;
        int rssi;
        long lastSeen;
    }

    // Bluetooth
    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private ScanSettings settings;

    // Estado do scan (tocado só na main thread, exceto os volatile abaixo)
    private boolean scanning = false;
    private boolean permissionDenied = false;
    private volatile boolean scanFailed = false;   // set pelo onScanFailed (fora da main)
    private volatile long lastResultMs = 0;        // última leitura de TAG (fora da main)
    private long lastScanStartMs = 0;

    // Estado do hub (escrito pelo poster, lido pela main)
    private volatile int hubState = 0;             // 0=aguardando 1=ok 2=falha
    private volatile String hubDetail = "aguardando primeiro envio ao hub";

    // Dados das tags (compartilhados: callback do scan escreve, main lê)
    private final Object lock = new Object();
    private final HashMap<String, Tag> tags = new HashMap<String, Tag>();

    // UI
    private LinearLayout listContainer;
    private TextView btChip, hubChip, tagChip, detailLine;
    private float density = 1f;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private volatile boolean running = true;

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

    // ---------- Scan (robusto) ----------

    private boolean hasScanPerm() {
        if (Build.VERSION.SDK_INT < 31) return true;
        return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
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
            scanner.startScan(null, settings, cb);
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

    /** Monta o JSON das leituras atuais (contrato: {stationId, readings:[{mac,name,rssi}]}). */
    private String buildJson() {
        StringBuilder j = new StringBuilder("{\"stationId\":\"").append(STATION_ID).append("\",\"readings\":[");
        synchronized (lock) {
            boolean first = true;
            for (Map.Entry<String, Tag> e : tags.entrySet()) {
                if (!first) j.append(',');
                first = false;
                String nm = e.getValue().name;
                if (nm == null) nm = "";
                j.append("{\"mac\":\"").append(e.getKey()).append("\",\"name\":\"").append(nm)
                        .append("\",\"rssi\":").append(e.getValue().rssi).append('}');
            }
        }
        return j.append("]}").toString();
    }

    private void postOnce() {
        HttpURLConnection c = null;
        int n;
        synchronized (lock) {
            n = tags.size();
        }
        try {
            c = (HttpURLConnection) new URL(HUB_URL).openConnection();
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/json");
            c.setConnectTimeout(3000);
            c.setReadTimeout(3000);
            c.setDoOutput(true);
            byte[] body = buildJson().getBytes("UTF-8");
            OutputStream os = c.getOutputStream();
            os.write(body);
            os.close();
            int code = c.getResponseCode();
            Log.i(TAG, new StringBuilder("POST hub -> ").append(code).toString());
            boolean ok = code >= 200 && code < 300;
            hubState = ok ? 1 : 2;
            hubDetail = new StringBuilder("POST ").append(code)
                    .append(" · ").append(n).append(" tags").toString();
        } catch (Exception e) {
            hubState = 2;
            hubDetail = new StringBuilder("POST falhou: ").append(e.getMessage()).toString();
            Log.e(TAG, hubDetail);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ---------- Ciclo de vida ----------

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        density = getResources().getDisplayMetrics().density;
        buildUi();

        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        adapter = bm != null ? bm.getAdapter() : null;
        settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

        if (Build.VERSION.SDK_INT >= 31 && !hasScanPerm()) {
            try {
                requestPermissions(new String[]{
                        Manifest.permission.BLUETOOTH_SCAN,
                        Manifest.permission.BLUETOOTH_CONNECT}, REQ_PERM);
            } catch (Exception ignored) {
            }
        }

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
                }
            }
        });
        poster.setDaemon(true);
        poster.start();

        ui.post(tick); // liga o refresh vivo (que também gerencia o scan)
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        running = false;
        ui.removeCallbacks(tick);
        stopScanSafe();
    }

    /** Coração vivo: 1x/s reavalia BT+scan, poda tags velhas e redesenha — sem reabrir o app. */
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            boolean btOn = adapter != null && adapter.isEnabled();
            ensureScan(btOn);
            pruneStale();
            refreshUi(btOn);
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

        TextView title = new TextView(this);
        title.setText("Estação BLE · TC22");
        title.setTextColor(C_TXT);
        title.setTextSize(19);
        title.setTypeface(Typeface.DEFAULT_BOLD);

        TextView sub = new TextView(this);
        sub.setText(new StringBuilder("fusão tag↔câmera · ").append(HUB_URL).toString());
        sub.setTextColor(C_MUTED);
        sub.setTextSize(11);
        sub.setPadding(0, dp(2), 0, 0);

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

        header.addView(title);
        header.addView(sub);
        header.addView(chips);
        header.addView(detailLine);

        // Lista rolável (peso 1)
        ScrollView sv = new ScrollView(this);
        sv.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        listContainer = new LinearLayout(this);
        listContainer.setOrientation(LinearLayout.VERTICAL);
        listContainer.setPadding(dp(12), dp(12), dp(12), dp(12));
        sv.addView(listContainer);

        root.addView(header, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(sv);
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
        detailLine.setText(hubDetail);

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
        String nm = t.name;
        nameTv.setText(nm != null && nm.length() > 0 ? nm : "(sem nome)");
        nameTv.setTextColor(C_TXT);
        nameTv.setTextSize(15);
        nameTv.setTypeface(Typeface.DEFAULT_BOLD);
        TextView macTv = new TextView(this);
        macTv.setText(mac);
        macTv.setTextColor(C_MUTED);
        macTv.setTextSize(12);
        left.addView(nameTv);
        left.addView(macTv);

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
        return row;
    }
}
