package com.dilamdi.vitriao;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.AppOpsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;
import org.osmdroid.config.Configuration;
import org.osmdroid.events.MapEventsReceiver;
import org.osmdroid.tileprovider.tilesource.TileSourceFactory;
import org.osmdroid.util.GeoPoint;
import org.osmdroid.views.MapView;
import org.osmdroid.views.overlay.MapEventsOverlay;
import org.osmdroid.views.overlay.Marker;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final int REQ_PERM = 11;
    private static final Pattern COORD = Pattern.compile("^\\s*(-?\\d{1,2}(?:\\.\\d+)?)\\s*[,; ]\\s*(-?\\d{1,3}(?:\\.\\d+)?)\\s*$");

    private MapView map;
    private Marker marker;
    private TextView status, coords;
    private Button btnToggle;
    private CheckBox jitter;
    private EditText search;
    private SharedPreferences prefs;
    private GeoPoint chosen;
    private String chosenName = "";
    private final Handler ui = new Handler(Looper.getMainLooper());

    private final BroadcastReceiver stateRx = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            String err = i.getStringExtra(MockService.EXTRA_ERROR);
            if (err != null) showMockSetupDialog(err);
            refreshUi();
        }
    };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = getSharedPreferences("vitriao", MODE_PRIVATE);
        Configuration.getInstance().setUserAgentValue(getPackageName() + "/1.0");
        Configuration.getInstance().setOsmdroidBasePath(getFilesDir());
        Configuration.getInstance().setOsmdroidTileCache(new java.io.File(getCacheDir(), "tiles"));
        setContentView(R.layout.activity_main);

        map = findViewById(R.id.map);
        status = findViewById(R.id.status);
        coords = findViewById(R.id.coords);
        btnToggle = findViewById(R.id.btnToggle);
        jitter = findViewById(R.id.jitter);
        search = findViewById(R.id.search);

        map.setTileSource(TileSourceFactory.MAPNIK);
        map.setMultiTouchControls(true);
        map.setTilesScaledToDpi(true);
        map.getZoomController().setVisibility(org.osmdroid.views.CustomZoomButtonsController.Visibility.NEVER);

        marker = new Marker(map);
        marker.setAnchor(Marker.ANCHOR_CENTER, Marker.ANCHOR_BOTTOM);
        marker.setDraggable(true);
        marker.setOnMarkerDragListener(new Marker.OnMarkerDragListener() {
            @Override public void onMarkerDrag(Marker m) {}
            @Override public void onMarkerDragStart(Marker m) {}
            @Override public void onMarkerDragEnd(Marker m) { choose(m.getPosition(), "", false); }
        });

        map.getOverlays().add(new MapEventsOverlay(new MapEventsReceiver() {
            @Override public boolean singleTapConfirmedHelper(GeoPoint p) { choose(p, "", false); return true; }
            @Override public boolean longPressHelper(GeoPoint p) { choose(p, "", false); return true; }
        }));

        jitter.setChecked(prefs.getBoolean("jitter", true));
        jitter.setOnCheckedChangeListener((v, on) -> prefs.edit().putBoolean("jitter", on).apply());

        // Khôi phục điểm đã chọn lần trước (mặc định: Hồ Gươm, Hà Nội)
        double la = Double.longBitsToDouble(prefs.getLong("lat", Double.doubleToLongBits(21.0287)));
        double lo = Double.longBitsToDouble(prefs.getLong("lon", Double.doubleToLongBits(105.8524)));
        if (MockService.running) { la = MockService.curLat; lo = MockService.curLon; }
        map.getController().setZoom(16.0);
        choose(new GeoPoint(la, lo), prefs.getString("name", ""), true);

        btnToggle.setOnClickListener(v -> toggle());
        findViewById(R.id.btnSearch).setOnClickListener(v -> doSearch());
        search.setOnEditorActionListener((v, id, ev) -> {
            if (id == EditorInfo.IME_ACTION_SEARCH || (ev != null && ev.getKeyCode() == KeyEvent.KEYCODE_ENTER)) { doSearch(); return true; }
            return false;
        });
        findViewById(R.id.btnSave).setOnClickListener(v -> saveFav());
        findViewById(R.id.btnFavs).setOnClickListener(v -> showFavs());
        findViewById(R.id.btnHelp).setOnClickListener(v -> showMockSetupDialog(null));

        askPermissions();
        if (!prefs.getBoolean("seenHelp", false)) {
            prefs.edit().putBoolean("seenHelp", true).apply();
            showMockSetupDialog(null);
        }
    }

    /* ---------- Chọn vị trí ---------- */
    private void choose(GeoPoint p, String name, boolean center) {
        chosen = p;
        chosenName = name == null ? "" : name;
        marker.setPosition(p);
        marker.setTitle(chosenName.isEmpty() ? fmt(p) : chosenName);
        if (!map.getOverlays().contains(marker)) map.getOverlays().add(marker);
        if (center) map.getController().animateTo(p);
        map.invalidate();
        prefs.edit()
                .putLong("lat", Double.doubleToLongBits(p.getLatitude()))
                .putLong("lon", Double.doubleToLongBits(p.getLongitude()))
                .putString("name", chosenName).apply();
        // Đang giả lập thì chuyển ngay sang điểm mới
        if (MockService.running) startMock();
        refreshUi();
    }

    private static String fmt(GeoPoint p) {
        return String.format(Locale.US, "%.6f, %.6f", p.getLatitude(), p.getLongitude());
    }

    private void refreshUi() {
        boolean on = MockService.running;
        status.setText(on ? "● Đang giả lập vị trí" : (chosenName.isEmpty() ? "Vị trí đã chọn" : chosenName));
        status.setTextColor(on ? 0xFF1F8A4C : 0xFF0E1A26);
        coords.setText((on && !chosenName.isEmpty() ? chosenName + " · " : "") + fmt(chosen));
        btnToggle.setText(on ? "■  Dừng giả lập" : "▶  Bắt đầu giả lập");
        btnToggle.setBackgroundResource(on ? R.drawable.btn_danger : R.drawable.btn_primary);
    }

    /* ---------- Bật / tắt ---------- */
    private void toggle() {
        if (MockService.running) {
            startService(new Intent(this, MockService.class).setAction(MockService.ACTION_STOP));
            ui.postDelayed(this::refreshUi, 300);
            return;
        }
        if (!hasLocationPermission()) { askPermissions(); toast("Cần cấp quyền vị trí trước."); return; }
        if (!isMockAppSelected()) { showMockSetupDialog("Bạn chưa chọn \"Vị Trí Ảo\" làm ứng dụng vị trí mô phỏng."); return; }
        startMock();
        ui.postDelayed(this::refreshUi, 400);
    }

    private void startMock() {
        Intent i = new Intent(this, MockService.class).setAction(MockService.ACTION_START)
                .putExtra(MockService.EXTRA_LAT, chosen.getLatitude())
                .putExtra(MockService.EXTRA_LON, chosen.getLongitude())
                .putExtra(MockService.EXTRA_JITTER, jitter.isChecked());
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
    }

    private boolean isMockAppSelected() {
        try {
            AppOpsManager ops = (AppOpsManager) getSystemService(APP_OPS_SERVICE);
            return ops.checkOpNoThrow(AppOpsManager.OPSTR_MOCK_LOCATION, Process.myUid(), getPackageName()) == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) { return true; } // không kiểm tra được thì cứ thử
    }

    private void showMockSetupDialog(String reason) {
        String msg = (reason != null ? reason + "\n\n" : "") +
                "Cách bật (chỉ làm 1 lần):\n\n" +
                "1. Mở Cài đặt → Thông tin điện thoại → chạm 7 lần vào \"Số hiệu bản tạo\" (Build number) để bật Tùy chọn nhà phát triển.\n" +
                "   (Xiaomi: chạm \"Phiên bản MIUI/HyperOS\"; Samsung: Thông tin phần mềm → Số hiệu bản tạo.)\n\n" +
                "2. Vào Tùy chọn nhà phát triển → \"Chọn ứng dụng vị trí mô phỏng\" (Select mock location app) → chọn \"Vị Trí Ảo\".\n\n" +
                "3. Quay lại app, chạm bản đồ để chọn điểm rồi bấm \"Bắt đầu giả lập\".\n\n" +
                "Mẹo: bật Vị trí của máy ở chế độ \"Độ chính xác cao\". Một số app (ngân hàng, chấm công, game) phát hiện được vị trí mô phỏng.";
        new AlertDialog.Builder(this)
                .setTitle("Thiết lập vị trí mô phỏng")
                .setMessage(msg)
                .setPositiveButton("Mở Tùy chọn nhà phát triển", (d, w) -> openDevSettings())
                .setNegativeButton("Đóng", null)
                .show();
    }

    private void openDevSettings() {
        try { startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)); }
        catch (Exception e) {
            toast("Chưa bật Tùy chọn nhà phát triển — mở Thông tin điện thoại.");
            try { startActivity(new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)); } catch (Exception ignored) {}
        }
    }

    /* ---------- Quyền ---------- */
    private boolean hasLocationPermission() {
        return Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void askPermissions() {
        if (Build.VERSION.SDK_INT < 23) return;
        List<String> need = new ArrayList<>();
        if (!hasLocationPermission()) {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ_PERM);
    }

    /* ---------- Tìm kiếm ---------- */
    private void doSearch() {
        String q = search.getText().toString().trim();
        if (q.isEmpty()) return;
        hideKeyboard();
        Matcher m = COORD.matcher(q);
        if (m.matches()) {
            double la = Double.parseDouble(m.group(1)), lo = Double.parseDouble(m.group(2));
            if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) { choose(new GeoPoint(la, lo), "", true); return; }
        }
        toast("Đang tìm…");
        new Thread(() -> {
            try {
                URL url = new URL("https://nominatim.openstreetmap.org/search?format=json&limit=8&accept-language=vi&q=" + URLEncoder.encode(q, "UTF-8"));
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                c.setRequestProperty("User-Agent", getPackageName() + "/1.0 (Android)");
                c.setConnectTimeout(10000); c.setReadTimeout(10000);
                StringBuilder sb = new StringBuilder();
                try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                    String line; while ((line = r.readLine()) != null) sb.append(line);
                }
                JSONArray arr = new JSONArray(sb.toString());
                ui.post(() -> showResults(arr));
            } catch (Exception e) {
                ui.post(() -> toast("Không tìm được (kiểm tra mạng)."));
            }
        }).start();
    }

    private void showResults(JSONArray arr) {
        if (arr.length() == 0) { toast("Không thấy địa điểm nào."); return; }
        String[] names = new String[arr.length()];
        for (int i = 0; i < arr.length(); i++) names[i] = arr.optJSONObject(i).optString("display_name");
        new AlertDialog.Builder(this).setTitle("Kết quả").setItems(names, (d, i) -> {
            JSONObject o = arr.optJSONObject(i);
            String full = o.optString("display_name");
            String shortName = full.contains(",") ? full.substring(0, full.indexOf(',')) : full;
            choose(new GeoPoint(o.optDouble("lat"), o.optDouble("lon")), shortName, true);
            map.getController().setZoom(16.0);
        }).show();
    }

    /* ---------- Yêu thích ---------- */
    private JSONArray favs() {
        try { return new JSONArray(prefs.getString("favs", "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    private void saveFav() {
        EditText in = new EditText(this);
        in.setText(chosenName.isEmpty() ? "" : chosenName);
        in.setHint("Tên gợi nhớ (VD: Nhà, Công ty)");
        in.setSingleLine(true);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        in.setPadding(pad, pad / 2, pad, pad / 2);
        new AlertDialog.Builder(this).setTitle("Lưu vị trí").setMessage(fmt(chosen)).setView(in)
                .setPositiveButton("Lưu", (d, w) -> {
                    try {
                        String n = in.getText().toString().trim();
                        JSONObject o = new JSONObject();
                        o.put("name", n.isEmpty() ? fmt(chosen) : n);
                        o.put("lat", chosen.getLatitude());
                        o.put("lon", chosen.getLongitude());
                        JSONArray a = favs(); a.put(o);
                        prefs.edit().putString("favs", a.toString()).apply();
                        chosenName = o.getString("name");
                        refreshUi();
                        toast("Đã lưu.");
                    } catch (Exception ignored) {}
                }).setNegativeButton("Hủy", null).show();
    }

    private void showFavs() {
        JSONArray a = favs();
        if (a.length() == 0) { toast("Chưa có vị trí nào được lưu."); return; }
        String[] names = new String[a.length()];
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            names[i] = o.optString("name") + "\n" + String.format(Locale.US, "%.5f, %.5f", o.optDouble("lat"), o.optDouble("lon"));
        }
        AlertDialog dlg = new AlertDialog.Builder(this).setTitle("Vị trí đã lưu  (giữ lâu để xóa)")
                .setItems(names, (d, i) -> {
                    JSONObject o = a.optJSONObject(i);
                    choose(new GeoPoint(o.optDouble("lat"), o.optDouble("lon")), o.optString("name"), true);
                })
                .setNegativeButton("Đóng", null).create();
        dlg.setOnShowListener(x -> dlg.getListView().setOnItemLongClickListener((p, v, i, id) -> {
            new AlertDialog.Builder(this).setMessage("Xóa \"" + a.optJSONObject(i).optString("name") + "\"?")
                    .setPositiveButton("Xóa", (d2, w) -> {
                        JSONArray n = new JSONArray();
                        for (int k = 0; k < a.length(); k++) if (k != i) n.put(a.optJSONObject(k));
                        prefs.edit().putString("favs", n.toString()).apply();
                        dlg.dismiss();
                        toast("Đã xóa.");
                    }).setNegativeButton("Hủy", null).show();
            return true;
        }));
        dlg.show();
    }

    /* ---------- Vòng đời ---------- */
    @Override protected void onResume() {
        super.onResume();
        map.onResume();
        IntentFilter f = new IntentFilter(MockService.ACTION_STATE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(stateRx, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(stateRx, f);
        refreshUi();
    }

    @Override protected void onPause() {
        super.onPause();
        map.onPause();
        try { unregisterReceiver(stateRx); } catch (Exception ignored) {}
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(search.getWindowToken(), 0);
        search.clearFocus();
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_SHORT).show(); }
}
