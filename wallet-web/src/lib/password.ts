// What a password that guards keys on this device must survive.
//
// The stored vault sits in the browser's storage (on disk, unencrypted by the
// browser) and a keystore file sits in Downloads: malware that copies either
// tries passwords offline, as fast as scrypt allows (N=2^17: about 0.2 s per
// guess per CPU core, far less on GPUs). Length alone does not stop that:
// "12345678" or "Password1!" are among the first guesses of every cracking
// list. This refuses what such a list tries first; it is not an entropy meter.
//
// Pure module (no browser globals): the Node tests import it.

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Base words of the most-used passwords (breach lists), plus the words people
 * reach for on a crypto wallet. Compared after lower-casing, undoing common
 * letter swaps (p@ssw0rd) and dropping digits / symbols / spaces, so
 * "Password2024!" and "Ferminux#1" are caught too.
 */
const COMMON = new Set(
  (
    'password passwort passwd pass mypassword newpassword parol qwerty qwertyuiop qwertz azerty asdf asdfgh asdfghjkl ' +
    'zxcvbn zxcvbnm qazwsx zaqwsx qweasd qweasdzxc qwe asd zxc abc abcd abcde abcdef iloveyou loveyou love lover ' +
    'lovely loveme princess princesa sunshine football baseball basketball soccer hockey welcome admin administrator ' +
    'login letmein monkey dragon master shadow superman batman spiderman starwars pokemon trustno whatever freedom ' +
    'secret summer winter spring autumn internet computer cookie samsung chocolate butterfly liverpool arsenal ' +
    'chelsea barcelona realmadrid juventus manchester flower hello hellokitty mustang maggie ginger jessica ashley ' +
    'bailey nicole michelle matthew michael jennifer jordan hunter ranger buster harley andrew tigger charlie robert ' +
    'thomas daniel anthony joshua killer pepper cheese banana orange apple purple silver golden diamond angel angels ' +
    'baby babygirl family friends forever heaven jesus blessed money dollar million access changeme default test ' +
    'testing guest user root toor unknown nothing private privatekey mnemonic seed seedphrase recovery security ' +
    'secure bitcoin ethereum crypto wallet mywallet metamask satoshi nakamoto blockchain binance coinbase trezor ' +
    'ledger hodl lambo moon tothemoon ferminux fmx azerbaijan azerbaycan baku baki qarabag privet'
  ).split(' '),
);

/** Keyboard rows, the alphabet and the digits: any 4+ run of these (either way) is a first guess. */
const RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'abcdefghijklmnopqrstuvwxyz', '01234567890123456789'];

function isRun(s: string): boolean {
  if (s.length < 4) return false;
  return RUNS.some((r) => r.includes(s) || [...r].reverse().join('').includes(s));
}

/** "abcabc", "lovelove": the repeated unit, or null. */
function repeatedUnit(s: string): string | null {
  for (let n = 1; n <= s.length / 2; n += 1) {
    if (s.length % n === 0 && s.slice(0, n).repeat(s.length / n) === s) return s.slice(0, n);
  }
  return null;
}

function unleet(s: string): string {
  return s
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/7/g, 't');
}

function isGuessable(core: string): boolean {
  if (core === '') return true;
  if (COMMON.has(core) || isRun(core)) return true;
  const unit = repeatedUnit(core);
  return unit !== null && (unit.length <= 4 || COMMON.has(unit) || isRun(unit));
}

/**
 * Why this password is not good enough to guard keys, in words the UI can
 * show, or null when it is acceptable.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (new Set(lower).size < 5) return 'Too simple: use more different characters.';
  const firstGuess = 'This is one of the first passwords an attacker tries. Use a few unrelated words, or a password manager.';
  if (isGuessable(lower.replace(/\s+/g, ''))) return firstGuess;
  if (/^\d+$/.test(password) && password.length < 12) {
    return 'Digits alone are guessed quickly (dates, phone numbers). Add letters, or use a few words.';
  }
  // The letters once digits, symbols and spaces are dropped, with and without undoing l33t swaps.
  const plain = lower.replace(/[^a-z]/g, '');
  // Swaps are undone with and without the digits/symbols around the word ("p@ssword123").
  const swapped = [lower, lower.replace(/^[^a-z]+|[^a-z]+$/g, '')].map((v) => unleet(v).replace(/[^a-z]/g, ''));
  const decoration = lower.length - plain.length;
  if (decoration <= 6 && [plain, ...swapped].some(isGuessable)) return firstGuess;
  if (/^[a-z]+$/i.test(password) && password.length < 12) {
    return 'A single word is guessed quickly. Add another word, a number or a symbol.';
  }
  return null;
}
