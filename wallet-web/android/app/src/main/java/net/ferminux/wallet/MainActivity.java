package net.ferminux.wallet;

import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Tapjacking: Android 11 and older deliver touches that pass through another app's overlay,
        // so a window drawn on top could steer a tap onto Approve / Send. Drop touches while another
        // app's window covers the wallet. Android 12+ already blocks touches through untrusted overlays.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setFilterTouchesWhenObscured(true);
        }
    }
}
