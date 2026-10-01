package com.cirkla.factoryprint;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import cn.com.wewin.extapi.imp.IPrintLabelCallback;
import cn.com.wewin.extapi.model.Block;
import cn.com.wewin.extapi.model.Label;
import cn.com.wewin.extapi.model.QrcodeBlock;
import cn.com.wewin.extapi.model.TextBlock;
import cn.com.wewin.extapi.universal.WwCommon;
import cn.com.wewin.extapi.universal.WwPrintUtils;

/**
 * Factory Print -- prints Factory QR labels on the MakeID D50 with MakeID's
 * official SDK (github.com/MakeID-Developer/label-print).
 *
 * Opened by the Factory web app's "Print on D50" button with
 *   factoryprint://print?d=<base64url JSON {"source":..,"labels":[{"q":qr,"t":text},..]}>
 * Prints every label in one job: MakeID's own printer list (Bluetooth and
 * Wi-Fi/LAN) picks and connects the printer; each label is drawn by the SDK
 * -- QR code centred on top, its Pallet Number / Location ID underneath.
 * Label size, rotation and preferred connection are remembered.
 */
public class MainActivity extends AppCompatActivity implements IPrintLabelCallback {

    private static final int REQ_PERMISSIONS = 7;

    private static class Item {
        final String qr;
        final String text;
        Item(String qr, String text) { this.qr = qr; this.text = text; }
    }

    private final List<Item> items = new ArrayList<>();
    private String source = "";
    private boolean pendingTest = false;
    private int printTotal = 0;

    private SharedPreferences prefs;
    private TextView jobView, statusView;
    private RadioButton btBluetooth, btWifi;
    private EditText widthEdit, heightEdit;
    private Spinner rotationSpinner;
    private Button printButton, testButton, backButton;

    private static final String[] ROTATIONS = {"0°", "90°", "180°", "270°"};

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("factory_print", MODE_PRIVATE);
        buildUi();
        readIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readIntent(intent);
    }

    // ---------------------------------------------------------------- data in

    private void readIntent(Intent intent) {
        items.clear();
        source = "";
        Uri uri = intent != null ? intent.getData() : null;
        if (uri != null && "factoryprint".equals(uri.getScheme())) {
            try {
                String d = uri.getQueryParameter("d");
                byte[] raw = Base64.decode(d, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                JSONObject job = new JSONObject(new String(raw, StandardCharsets.UTF_8));
                source = job.optString("source", "");
                JSONArray labels = job.getJSONArray("labels");
                for (int i = 0; i < labels.length(); i++) {
                    JSONObject l = labels.getJSONObject(i);
                    items.add(new Item(l.getString("q"), l.optString("t", "")));
                }
            } catch (Exception e) {
                status("Couldn't read the labels from the Factory app: " + e.getMessage(), true);
            }
        }
        refreshJob();
    }

    private void refreshJob() {
        if (items.isEmpty()) {
            jobView.setText("No labels yet.\nIn the Factory app, open the QR codes, select labels and tap \"Print on D50\".");
            printButton.setEnabled(false);
            printButton.setText("Print labels");
        } else {
            String range = items.get(0).text + (items.size() > 1 ? "  →  " + items.get(items.size() - 1).text : "");
            jobView.setText(items.size() + " label" + (items.size() == 1 ? "" : "s")
                    + (source.isEmpty() ? "" : " from " + source) + "\n" + range);
            printButton.setEnabled(true);
            printButton.setText("Print " + items.size() + " label" + (items.size() == 1 ? "" : "s"));
        }
    }

    // ---------------------------------------------------------------- labels

    private float num(EditText e, float fallback) {
        try {
            float v = Float.parseFloat(e.getText().toString().trim());
            return v > 5 ? v : fallback;
        } catch (Exception ex) { return fallback; }
    }

    /** One label: QR centred near the top, the ID under it, inside the
     * printable 48 mm of the 50 mm roll. Sizes in mm. */
    private Label makeLabel(Item item, float w, float h, WwCommon.Oritention rotation) {
        Label label = new Label();
        label.labelWidth = w;
        label.labelHeight = h;
        label.oritention = rotation;

        float side = Math.min(w, h);
        float qrSize = side * 0.68f;                 // 34 mm on a 50 mm label
        QrcodeBlock qr = new QrcodeBlock();
        qr.x = (w - qrSize) / 2f;
        qr.y = side * 0.05f;                         // 2.5 mm top margin (quiet zone)
        qr.width = qrSize;
        qr.needResize = true;
        qr.content = item.qr;
        qr.oritention = WwCommon.Oritention.Oritention0;

        TextBlock text = new TextBlock();
        text.x = 2f;
        text.y = qr.y + qrSize + side * 0.03f;
        text.maxW = w - 4f;
        text.maxH = Math.max(4f, h - text.y - 1.5f);
        text.fontSize = Math.max(6f, side * 0.18f);  // ~9 on 50 mm; shrinks to fit (needResize)
        text.needResize = true;
        text.textStyle = Typeface.BOLD;
        text.horizontalAlignment = WwCommon.HorizontalAlignment.Center;
        text.verticalAlignment = WwCommon.VerticalAlignment.Center;
        text.oritention = WwCommon.Oritention.Oritention0;
        text.content = item.text;

        label.blocks = new Block[]{qr, text};
        return label;
    }

    private List<Label> buildLabels(boolean testOnly) {
        float w = num(widthEdit, 50f), h = num(heightEdit, 50f);
        WwCommon.Oritention rotation = WwCommon.Oritention.values()[rotationSpinner.getSelectedItemPosition()];
        List<Label> out = new ArrayList<>();
        if (testOnly) {
            out.add(makeLabel(new Item("FACTORY-PRINT-TEST", "TEST LABEL"), w, h, rotation));
        } else {
            for (Item i : items) out.add(makeLabel(i, w, h, rotation));
        }
        return out;
    }

    // ---------------------------------------------------------------- print

    private void startPrint(boolean testOnly) {
        savePrefs();
        if (!hasPermissions()) {
            pendingTest = testOnly;
            ActivityCompat.requestPermissions(this, neededPermissions(), REQ_PERMISSIONS);
            return;
        }
        List<Label> labels = buildLabels(testOnly);
        if (labels.isEmpty()) return;
        printTotal = labels.size();
        setBusy(true);
        status("Choose the D50 in the list (" + (btWifi.isChecked() ? "Wi-Fi" : "Bluetooth")
                + " shown first) — printing " + printTotal + " label" + (printTotal == 1 ? "" : "s") + "…", false);

        boolean wifi = btWifi.isChecked();
        WwPrintUtils printer = WwPrintUtils.getInstance(this);
        printer.setLocaleToEnglish(true);
        printer.setConnectType(wifi ? WwCommon.ConnectType.wifi : WwCommon.ConnectType.bluetooth);
        printer.setShowDeviceList(true);
        // MakeID's printer list offers both Bluetooth and Wi-Fi (LAN); open on the preferred one.
        printer.setSearchType(WwPrintUtils.WwSearchTypeBluetooth | WwPrintUtils.WwSearchTypeLAN);
        printer.setDefaultSearchType(wifi ? WwPrintUtils.WwSearchTypeLAN : WwPrintUtils.WwSearchTypeBluetooth);
        printer.setiPrintPieceLabelCallback(index -> runOnUiThread(() ->
                status("Printed " + (index + 1) + " of " + printTotal + "…", false)));
        try {
            printer.asyncPrint(labels, this);
        } catch (Exception e) {
            setBusy(false);
            status("Couldn't start printing: " + e.getMessage(), true);
        }
    }

    @Override
    public void OnPrintSuccessEvent() {
        runOnUiThread(() -> {
            setBusy(false);
            status("✓ Printed " + printTotal + " label" + (printTotal == 1 ? "" : "s") + ".", false);
            backButton.setVisibility(items.isEmpty() ? View.GONE : View.VISIBLE);
        });
    }

    @Override
    public void OnPrintErrorEvent(WwCommon.PrintResult result) {
        runOnUiThread(() -> {
            setBusy(false);
            status(explain(result), true);
        });
    }

    private String explain(WwCommon.PrintResult r) {
        if (r == null) return "Printing failed.";
        switch (r) {
            case connectError:
            case connectDeviceError:
                return "Couldn't connect to the printer. Make sure the D50 is on, and close MakeID Label Pro (it can hold the printer's connection) — then try again.";
            case permissionError:
                return "Bluetooth / Nearby devices permission is needed. Allow it in Settings → Apps → Factory Print → Permissions.";
            case labelTypeError:
                return "The printer reports a label mismatch. Check the 50 mm roll is loaded correctly and the label size here (e.g. 50 × 50 mm).";
            case printCancel:
                return "Printing cancelled.";
            case printingError:
                return "The printer is busy — wait for it to finish, then try again.";
            case createLabelError:
                return "Couldn't build the labels — check the label size.";
            case printSuccess:
                return "Printed.";
            default:
                return "Printing failed (" + r.name() + "). Check the printer and the roll, then try again.";
        }
    }

    // ---------------------------------------------------------------- permissions

    private String[] neededPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return new String[]{
                    Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_ADVERTISE,
                    Manifest.permission.ACCESS_FINE_LOCATION,
            };
        }
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    private boolean hasPermissions() {
        for (String p : neededPermissions()) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_PERMISSIONS) return;
        if (hasPermissions()) {
            startPrint(pendingTest);
        } else {
            status("Bluetooth / Nearby devices and Location permissions are needed to find the printer. "
                    + "Allow them in Settings → Apps → Factory Print → Permissions.", true);
        }
    }

    // ---------------------------------------------------------------- UI

    private void savePrefs() {
        prefs.edit()
                .putBoolean("wifi", btWifi.isChecked())
                .putFloat("w", num(widthEdit, 50f))
                .putFloat("h", num(heightEdit, 50f))
                .putInt("rotation", rotationSpinner.getSelectedItemPosition())
                .apply();
    }

    private void setBusy(boolean busy) {
        printButton.setEnabled(!busy && !items.isEmpty());
        testButton.setEnabled(!busy);
    }

    private void status(String msg, boolean error) {
        statusView.setText(msg);
        statusView.setTextColor(error ? 0xFFB3261E : 0xFF1F3A2D);
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private TextView label(String s) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(13);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(16), 0, dp(4));
        return t;
    }

    private EditText numberField(float value) {
        EditText e = new EditText(this);
        e.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        e.setText(value == Math.round(value) ? String.valueOf(Math.round(value)) : String.valueOf(value));
        e.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        return e;
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(20), dp(24), dp(24));

        TextView title = new TextView(this);
        title.setText("Factory Print · MakeID D50");
        title.setTextSize(22);
        title.setTypeface(Typeface.SERIF, Typeface.BOLD);
        root.addView(title);

        jobView = new TextView(this);
        jobView.setTextSize(16);
        jobView.setPadding(0, dp(12), 0, 0);
        root.addView(jobView);

        root.addView(label("Printer connection (shown first in MakeID's printer list)"));
        RadioGroup group = new RadioGroup(this);
        group.setOrientation(RadioGroup.HORIZONTAL);
        btBluetooth = new RadioButton(this);
        btBluetooth.setText("Bluetooth");
        btBluetooth.setId(View.generateViewId());
        btWifi = new RadioButton(this);
        btWifi.setText("Wi-Fi");
        btWifi.setId(View.generateViewId());
        group.addView(btBluetooth);
        group.addView(btWifi);
        if (prefs.getBoolean("wifi", false)) btWifi.setChecked(true); else btBluetooth.setChecked(true);
        root.addView(group);

        root.addView(label("Label size (mm) — 50 mm roll: 50 × 50"));
        LinearLayout size = new LinearLayout(this);
        size.setOrientation(LinearLayout.HORIZONTAL);
        size.setGravity(Gravity.CENTER_VERTICAL);
        widthEdit = numberField(prefs.getFloat("w", 50f));
        heightEdit = numberField(prefs.getFloat("h", 50f));
        TextView x = new TextView(this);
        x.setText("  ×  ");
        size.addView(widthEdit);
        size.addView(x);
        size.addView(heightEdit);
        root.addView(size);

        root.addView(label("Rotation"));
        rotationSpinner = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, ROTATIONS);
        rotationSpinner.setAdapter(adapter);
        rotationSpinner.setSelection(prefs.getInt("rotation", 1));   // 90°, as in MakeID's demo
        root.addView(rotationSpinner);

        printButton = new Button(this);
        printButton.setTextSize(16);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(24);
        printButton.setLayoutParams(lp);
        printButton.setOnClickListener(v -> startPrint(false));
        root.addView(printButton);

        testButton = new Button(this);
        testButton.setText("Print 1 test label");
        testButton.setOnClickListener(v -> startPrint(true));
        root.addView(testButton);

        statusView = new TextView(this);
        statusView.setTextSize(15);
        statusView.setPadding(0, dp(16), 0, 0);
        root.addView(statusView);

        backButton = new Button(this);
        backButton.setText("Back to Factory");
        backButton.setVisibility(View.GONE);
        backButton.setOnClickListener(v -> finish());   // returns to Chrome
        root.addView(backButton);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        setContentView(scroll);
    }
}
