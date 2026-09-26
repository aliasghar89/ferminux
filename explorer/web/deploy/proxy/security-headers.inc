# Security headers for every static response (included per location: add_header does not inherit once a
# location sets its own). The CSP hashes the ONE inline script in index.html (the motion tier, before first
# paint). If that script changes, recompute the hash (DEPLOY.md, "CSP hash") or the page loses it silently.
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'sha256-UZZ2Y784oy0r0hDtbbp69jCVh3RgpsGGDCL8Yjm/Pdc='; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://ferminux.net; font-src 'self'; connect-src 'self' https://rpc.ferminux.net https://ferminux.net; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
