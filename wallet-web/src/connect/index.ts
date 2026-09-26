// What the rest of the wallet may mount or call from the connect feature.
//
//   <ConnectedSites />   the approved-sites list with Revoke (self-contained)
//
// The store functions are exported for a badge or a count elsewhere.
import './connect.css';

export { ConnectedSites } from './ConnectedSites.tsx';
export { SITES_KEY, loadSites, onSitesChange, relativeTime, revokeSite, type ConnectedSite } from './sites.ts';
