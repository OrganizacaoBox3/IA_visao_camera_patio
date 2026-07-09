package com.grendene.btscan;

import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.os.Bundle;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * Estação BLE do TC22 — varre as tags (família Grendene) e REPORTA ao hub por HTTP. É a "antena real"
 * da identidade aumentada (analises/tags-bluetooth/). Responsabilidade única: varrer + reportar.
 * Loga em Logcat ("BTSCAN") p/ diagnóstico. Sem `+` (Android não tem StringConcatFactory) e sem lambda.
 *
 * Rede: por USB, rode `adb reverse tcp:4000 tcp:4000` → o 127.0.0.1:4000 do TC22 chega no hub do PC.
 * Em produção (WiFi), troque HUB_URL pelo endereço real do hub.
 */
public class MainActivity extends Activity {
    static final String TAG = "BTSCAN";
    static final String OUI = "48:87:2D"; // fabricante das tags do projeto
    static final String STATION_ID = "tc22";
    static final String HUB_URL = "http://127.0.0.1:4000/api/bt/reading";
    static final long POST_EVERY_MS = 2000;

    private BluetoothLeScanner scanner;
    private TextView tv;
    private volatile boolean running = true;
    private final Object lock = new Object();
    private final TreeMap<String, Integer> rssiByMac = new TreeMap<String, Integer>(); // MAC -> último RSSI
    private final Map<String, String> nameByMac = new HashMap<String, String>();       // MAC -> nome

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
                synchronized (lock) {
                    rssiByMac.put(mac, Integer.valueOf(rssi));
                    if (name.length() > 0) nameByMac.put(mac, name);
                }
                render();
            }
        }
    };

    private void render() {
        StringBuilder b = new StringBuilder();
        synchronized (lock) {
            b.append("TAGS: ").append(rssiByMac.size()).append("  → hub ").append(HUB_URL).append("\n\n");
            for (Map.Entry<String, Integer> e : rssiByMac.entrySet()) {
                b.append(e.getKey()).append("   RSSI ").append(e.getValue()).append("\n");
            }
        }
        final String text = b.toString();
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                tv.setText(text);
            }
        });
    }

    /** Monta o JSON das leituras atuais (sem lib: StringBuilder, MACs/nomes são seguros). */
    private String buildJson() {
        StringBuilder j = new StringBuilder("{\"stationId\":\"").append(STATION_ID).append("\",\"readings\":[");
        synchronized (lock) {
            boolean first = true;
            for (Map.Entry<String, Integer> e : rssiByMac.entrySet()) {
                if (!first) j.append(',');
                first = false;
                String nm = nameByMac.get(e.getKey());
                if (nm == null) nm = "";
                j.append("{\"mac\":\"").append(e.getKey()).append("\",\"name\":\"").append(nm)
                        .append("\",\"rssi\":").append(e.getValue()).append('}');
            }
        }
        return j.append("]}").toString();
    }

    private void postOnce() {
        HttpURLConnection c = null;
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
        } catch (Exception e) {
            Log.e(TAG, new StringBuilder("POST falhou: ").append(e.getMessage()).toString());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        ScrollView sv = new ScrollView(this);
        tv = new TextView(this);
        tv.setPadding(24, 24, 24, 24);
        tv.setTextSize(16);
        tv.setText("iniciando scan BLE...");
        sv.addView(tv);
        setContentView(sv);

        BluetoothManager bm = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bm != null ? bm.getAdapter() : null;
        if (adapter == null || !adapter.isEnabled()) {
            tv.setText("Bluetooth desligado/ausente — ligue o BT e reabra.");
            Log.e(TAG, "adapter null ou BT off");
            return;
        }
        scanner = adapter.getBluetoothLeScanner();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();
        try {
            scanner.startScan(null, settings, cb);
            Log.i(TAG, "scan iniciado");
        } catch (SecurityException e) {
            tv.setText("Falta permissão BLUETOOTH_SCAN. Conceda e reabra.");
            Log.e(TAG, new StringBuilder("sem permissao de scan: ").append(e.getMessage()).toString());
            return;
        }

        // Poster: a cada POST_EVERY_MS manda o snapshot das leituras ao hub (rede fora da main thread).
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
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        running = false;
        if (scanner != null) {
            try {
                scanner.stopScan(cb);
            } catch (SecurityException ignored) {
            }
        }
    }
}
