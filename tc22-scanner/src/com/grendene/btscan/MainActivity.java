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

import java.util.TreeMap;

/**
 * Estação BLE do TC22 — varre anúncios e mostra/loga as tags (família Grendene). É a "antena real"
 * do projeto de identidade aumentada (analises/tags-bluetooth/). Passo 1: PROVAR que o coletor acha
 * todas as tags. Loga cada leitura em Logcat (tag "BTSCAN") p/ o PC ler via `adb logcat -s BTSCAN`.
 * (Reporte HTTP ao hub = próximo passo — este app fica com responsabilidade única: varrer + mostrar.)
 */
public class MainActivity extends Activity {
    static final String TAG = "BTSCAN";
    static final String OUI = "48:87:2D"; // fabricante das tags do projeto (visto no scan)

    private BluetoothLeScanner scanner;
    private TextView tv;
    private final TreeMap<String, Integer> seen = new TreeMap<>(); // MAC -> último RSSI

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
            // StringBuilder explícito (SEM operador +): o Android não tem java.lang.invoke.StringConcatFactory
            // que o javac moderno usaria via invokedynamic no `+` → NoClassDefFoundError em runtime.
            Log.i(TAG, new StringBuilder(isTag ? "TAG " : "dev ")
                    .append(mac).append(' ').append(name).append(' ').append(rssi).toString());
            if (isTag) {
                seen.put(mac, rssi);
                render();
            }
        }
    };

    private void render() {
        StringBuilder b = new StringBuilder();
        b.append("TAGS ENCONTRADAS: ").append(seen.size()).append("\n\n");
        for (java.util.Map.Entry<String, Integer> e : seen.entrySet()) {
            b.append(e.getKey()).append("   RSSI ").append(e.getValue()).append("\n");
        }
        final String text = b.toString();
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                tv.setText(text);
            }
        });
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
            scanner.startScan(null, settings, cb); // sem filtro: pega tudo, filtra no callback
            Log.i(TAG, "scan iniciado");
        } catch (SecurityException e) {
            tv.setText("Falta permissão BLUETOOTH_SCAN. Conceda e reabra.");
            Log.e(TAG, new StringBuilder("sem permissao de scan: ").append(e.getMessage()).toString());
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (scanner != null) {
            try {
                scanner.stopScan(cb);
            } catch (SecurityException ignored) {
            }
        }
    }
}
