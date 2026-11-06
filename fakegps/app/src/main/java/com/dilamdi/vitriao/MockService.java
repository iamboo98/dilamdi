package com.dilamdi.vitriao;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationServices;

import java.util.Locale;
import java.util.Random;

/** Dịch vụ chạy nền: liên tục đẩy vị trí giả vào GPS, mạng và Fused Location. */
public class MockService extends Service {
    public static final String ACTION_START = "com.dilamdi.vitriao.START";
    public static final String ACTION_STOP = "com.dilamdi.vitriao.STOP";
    public static final String ACTION_STATE = "com.dilamdi.vitriao.STATE";
    public static final String EXTRA_LAT = "lat";
    public static final String EXTRA_LON = "lon";
    public static final String EXTRA_JITTER = "jitter";
    public static final String EXTRA_ERROR = "error";

    private static final String TAG = "ViTriAo";
    private static final String CHANNEL = "mock";
    private static final int NOTI_ID = 7;
    private static final String[] PROVIDERS = {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER};

    public static volatile boolean running = false;
    public static volatile double curLat, curLon;

    private LocationManager lm;
    private FusedLocationProviderClient fused;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Random rnd = new Random();
    private boolean jitter;
    private double lat, lon;

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!running) return;
            try {
                pushLocation();
                handler.postDelayed(this, 1000);
            } catch (SecurityException e) {
                fail("Chưa chọn \"Vị Trí Ảo\" làm ứng dụng vị trí mô phỏng trong Tùy chọn nhà phát triển.");
            }
        }
    };

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) { stopMock(); return START_NOT_STICKY; }
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }

        lat = intent.getDoubleExtra(EXTRA_LAT, 0);
        lon = intent.getDoubleExtra(EXTRA_LON, 0);
        jitter = intent.getBooleanExtra(EXTRA_JITTER, false);
        curLat = lat; curLon = lon;

        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTI_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(NOTI_ID, n);

        if (!running) {
            lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
            try {
                for (String p : PROVIDERS) setupProvider(p);
            } catch (SecurityException e) {
                fail("Chưa chọn \"Vị Trí Ảo\" làm ứng dụng vị trí mô phỏng trong Tùy chọn nhà phát triển.");
                return START_NOT_STICKY;
            }
            try {
                fused = LocationServices.getFusedLocationProviderClient(this);
                fused.setMockMode(true);
            } catch (Throwable t) { Log.w(TAG, "fused mock mode", t); fused = null; }
            running = true;
            handler.post(tick);
        }
        broadcastState(null);
        return START_STICKY;
    }

    private void setupProvider(String name) {
        try { lm.removeTestProvider(name); } catch (Exception ignored) {}
        // power=1 (thấp), accuracy=1 (chính xác cao)
        lm.addTestProvider(name, false, false, false, false, true, true, true, 1, 1);
        lm.setTestProviderEnabled(name, true);
    }

    private void pushLocation() {
        double la = lat, lo = lon;
        float acc = 3f;
        if (jitter) {
            // dao động ~ vài mét quanh điểm đã chọn
            la += (rnd.nextGaussian() * 2.0) / 111_320.0;
            lo += (rnd.nextGaussian() * 2.0) / (111_320.0 * Math.cos(Math.toRadians(lat)));
            acc = 3f + rnd.nextFloat() * 5f;
        }
        for (String p : PROVIDERS) {
            Location l = make(p, la, lo, acc);
            lm.setTestProviderLocation(p, l);
        }
        if (fused != null) {
            try { fused.setMockLocation(make("fused", la, lo, acc)); } catch (Throwable t) { Log.w(TAG, "fused", t); }
        }
    }

    private Location make(String provider, double la, double lo, float acc) {
        Location l = new Location(provider);
        l.setLatitude(la);
        l.setLongitude(lo);
        l.setAccuracy(acc);
        l.setAltitude(10 + (jitter ? rnd.nextDouble() * 2 : 0));
        l.setSpeed(0f);
        l.setBearing(0f);
        l.setTime(System.currentTimeMillis());
        l.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
        if (Build.VERSION.SDK_INT >= 26) {
            l.setVerticalAccuracyMeters(acc * 1.5f);
            l.setSpeedAccuracyMetersPerSecond(0.1f);
            l.setBearingAccuracyDegrees(1f);
        }
        return l;
    }

    private void fail(String msg) {
        running = false;
        handler.removeCallbacks(tick);
        cleanup();
        broadcastState(msg);
        stopForeground(true);
        stopSelf();
    }

    private void stopMock() {
        running = false;
        handler.removeCallbacks(tick);
        cleanup();
        broadcastState(null);
        stopForeground(true);
        stopSelf();
    }

    private void cleanup() {
        if (lm != null) {
            for (String p : PROVIDERS) {
                try { lm.setTestProviderEnabled(p, false); } catch (Exception ignored) {}
                try { lm.removeTestProvider(p); } catch (Exception ignored) {}
            }
        }
        if (fused != null) {
            try { fused.setMockMode(false); } catch (Throwable ignored) {}
            fused = null;
        }
    }

    private void broadcastState(String error) {
        Intent i = new Intent(ACTION_STATE).setPackage(getPackageName());
        if (error != null) i.putExtra(EXTRA_ERROR, error);
        sendBroadcast(i);
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Đang giả lập vị trí", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), piFlags);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, MockService.class).setAction(ACTION_STOP), piFlags);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return b.setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Đang giả lập vị trí")
                .setContentText(String.format(Locale.US, "%.6f, %.6f", lat, lon))
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(null, "Dừng", stop).build())
                .build();
    }

    @Override
    public void onDestroy() {
        if (running) { running = false; handler.removeCallbacks(tick); cleanup(); }
        super.onDestroy();
    }
}
