# Ferminux Wallet release (R8) rules.
# Capacitor ships keep rules for @CapacitorPlugin classes; the plugins below also reach
# their own classes through reflection / activity results, so they are kept whole.
-keep class com.getcapacitor.** { *; }
-keep class ee.forgr.biometric.** { *; }
-keep class com.capacitorjs.** { *; }
-keep class com.outsystems.plugins.barcode.** { *; }
-keep class com.getcapacitor.plugin.privacyscreen.** { *; }
-keep class net.ferminux.wallet.** { *; }

# The WebView bridge: methods called from JavaScript.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-dontwarn org.jetbrains.annotations.**
# The barcode library annotates its (kept) parameter model for Gson but does not ship Gson.
-dontwarn com.google.gson.annotations.SerializedName
