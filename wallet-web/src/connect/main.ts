// connect.html entry. Inside a frame this page is only ever the invisible
// status responder (frame.ts); a framed wallet screen could be overlaid and
// clicked through, so the UI is never rendered there.
function framed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // a cross-origin parent throws on access: definitely framed
  }
}

if (framed()) {
  void import('./frame.ts').then((m) => m.runStatusFrame());
} else {
  void import('./mount.tsx');
}
