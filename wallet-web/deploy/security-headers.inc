# Ferminux Wallet: the response headers, from the $fxw_* variables that
# deploy/csp.conf defines (that file must be included in http {} first).
#
# Include in the wallet.ferminux.net server block AND in every location that
# serves the wallet and sets an add_header of its own (its static-asset
# location, and `location ^~ /wallet/` on ferminux.net): in nginx a location
# that sets any add_header drops every add_header it would have inherited.
#
#     include /etc/nginx/wallet/security-headers.inc;
add_header Content-Security-Policy $fxw_csp always;
add_header Permissions-Policy $fxw_permissions always;
add_header Cross-Origin-Opener-Policy $fxw_coop always;
add_header X-Frame-Options $fxw_xfo always;
add_header Referrer-Policy no-referrer always;
add_header X-Content-Type-Options nosniff always;
add_header Strict-Transport-Security "max-age=31536000" always;
