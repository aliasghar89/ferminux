// QR payload parsing + raw-image decoding.
// Runs against the SAME module the UI imports (src/lib/qr.ts) via Node's
// native type stripping — no build step, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import {
  parseQrPayload,
  parseEip681Number,
  buildEip681Uri,
  checksumAddress,
  decodeQrImage,
} from '../src/lib/qr.ts';

const CHAIN = 3961;
const A = '0x8ba1f109551bD432803012645Ac136ddd64DBA72'; // checksummed
const B = '0x7F16433359E4eF704E90cE08460c6238E45130f7'; // the live Ferminux miner
const TOKEN = '0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178'; // AZNT on chain 3961

const ok = (input, chain = CHAIN) => {
  const r = parseQrPayload(input, chain);
  assert.equal(r.ok, true, `expected ${JSON.stringify(input)} to parse, got: ${r.ok ? '' : r.error}`);
  return r.target;
};
const bad = (input, code, chain = CHAIN) => {
  const r = parseQrPayload(input, chain);
  assert.equal(r.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
  assert.equal(r.code, code, `wrong code for ${JSON.stringify(input)}: ${r.code} (${r.error})`);
  assert.ok(r.error.length > 10, 'rejection must carry a human explanation');
  return r;
};

/* ---------------- plain addresses ---------------- */

test('plain address: accepts a correctly checksummed 0x address', () => {
  assert.deepEqual(ok(A), { kind: 'address', address: A });
});

test('plain address: normalises all-lowercase and all-uppercase to EIP-55', () => {
  assert.equal(ok(A.toLowerCase()).address, A);
  assert.equal(ok('0x' + A.slice(2).toUpperCase()).address, A);
});

test('plain address: trims surrounding whitespace and newlines', () => {
  assert.equal(ok(`  ${A}\n`).address, A);
});

test('plain address: rejects a bad EIP-55 checksum', () => {
  const flipped = A.replace('0x8ba1', '0x8Ba1');
  assert.notEqual(flipped, A);
  bad(flipped, 'bad-address');
});

test('plain address: a bare address carries no chain id or amount', () => {
  const t = ok(A);
  assert.equal(t.chainId, undefined);
  assert.equal(t.amount, undefined);
});

/* ---------------- EIP-681, native ---------------- */

test('eip-681: ethereum:0xADDR with no chain id', () => {
  assert.deepEqual(ok(`ethereum:${A}`), { kind: 'address', address: A });
});

test('eip-681: ethereum:0xADDR@3961 keeps the chain id', () => {
  assert.deepEqual(ok(`ethereum:${A}@3961`), { kind: 'address', address: A, chainId: 3961 });
});

test('eip-681: the scheme is case-insensitive and the pay- prefix is accepted', () => {
  assert.equal(ok(`ETHEREUM:${A}@3961`).address, A);
  assert.equal(ok(`ethereum:pay-${A}@3961`).address, A);
  assert.equal(ok(`ethereum:PAY-${A}@3961`).address, A);
});

test('eip-681: hex chain id 0xF79 is the same chain as 3961', () => {
  assert.equal(ok(`ethereum:${A}@0xF79`).chainId, 3961);
});

test('eip-681: value=1e18 is one whole FMX in wei', () => {
  const t = ok(`ethereum:${A}@3961?value=1e18`);
  assert.equal(t.kind, 'address');
  assert.equal(t.amount, 10n ** 18n);
});

test('eip-681: value in exponent form with a fraction (2.014e18) is exact', () => {
  assert.equal(ok(`ethereum:${A}@3961?value=2.014e18`).amount, 2_014_000_000_000_000_000n);
  assert.equal(ok(`ethereum:${A}@3961?value=6e18`).amount, 6_000_000_000_000_000_000n);
  assert.equal(ok(`ethereum:${A}@3961?value=1.000000000000000001e18`).amount, 10n ** 18n + 1n);
});

test('eip-681: value as a plain wei integer', () => {
  assert.equal(ok(`ethereum:${A}@3961?value=1500000000000000000`).amount, 1_500_000_000_000_000_000n);
  assert.equal(ok(`ethereum:${A}@3961?value=1`).amount, 1n);
});

test('eip-681: extra parameters (gas, gasLimit, gasPrice) are ignored, not fatal', () => {
  const t = ok(`ethereum:${A}@3961?value=1e18&gas=21000&gasPrice=1000000007&label=Coffee`);
  assert.equal(t.amount, 10n ** 18n);
  assert.equal(t.address, A);
});

test('eip-681: an empty value parameter is treated as "no amount"', () => {
  assert.equal(ok(`ethereum:${A}@3961?value=`).amount, undefined);
});

test('eip-681: a lowercase address inside the URI is checksummed on the way out', () => {
  assert.equal(ok(`ethereum:${A.toLowerCase()}@3961?value=1e18`).address, A);
});

/* ---------------- EIP-681, ERC-20 transfer ---------------- */

test('erc20: transfer form returns token, recipient and base-unit amount', () => {
  const t = ok(`ethereum:${TOKEN}@3961/transfer?address=${B}&uint256=1000000`);
  assert.deepEqual(t, {
    kind: 'erc20-transfer',
    address: B,
    tokenAddress: TOKEN,
    amount: 1_000_000n,
    chainId: 3961,
  });
});

test('erc20: transfer with an exponent amount and no chain id', () => {
  const t = ok(`ethereum:${TOKEN}/transfer?address=${B}&uint256=2.5e6`);
  assert.equal(t.kind, 'erc20-transfer');
  assert.equal(t.amount, 2_500_000n);
  assert.equal(t.chainId, undefined);
});

test('erc20: transfer without uint256 is a recipient-only request', () => {
  const t = ok(`ethereum:${TOKEN}@3961/transfer?address=${B}`);
  assert.equal(t.kind, 'erc20-transfer');
  assert.equal(t.amount, undefined);
  assert.equal(t.address, B);
});

test('erc20: a missing or invalid recipient parameter is rejected', () => {
  bad(`ethereum:${TOKEN}@3961/transfer?uint256=100`, 'malformed');
  bad(`ethereum:${TOKEN}@3961/transfer?address=&uint256=100`, 'malformed');
  bad(`ethereum:${TOKEN}@3961/transfer?address=0xdeadbeef&uint256=100`, 'bad-address');
  bad(`ethereum:${TOKEN}@3961/transfer?address=${B.replace('0x7F', '0x7f')}&uint256=1`, 'bad-address');
});

test('erc20: any function other than transfer() is refused by name', () => {
  const r = bad(`ethereum:${TOKEN}@3961/approve?address=${B}&uint256=1`, 'unsupported-function');
  assert.match(r.error, /approve/);
  bad(`ethereum:${TOKEN}@3961/transferFrom?address=${B}`, 'unsupported-function');
});

/* ---------------- rejections ---------------- */

test('reject: wrong chain id names the chain the code was for', () => {
  const r = bad(`ethereum:${A}@1?value=1e18`, 'wrong-chain');
  assert.match(r.error, /Ethereum mainnet/);
  assert.match(r.error, /chain 1\b/);
  assert.match(r.error, /3961/);

  assert.match(bad(`ethereum:${A}@137`, 'wrong-chain').error, /Polygon/);
  assert.match(bad(`ethereum:${A}@56`, 'wrong-chain').error, /BNB Smart Chain/);
  // Unknown chain ids still report the number rather than pretending to know it.
  assert.match(bad(`ethereum:${A}@777777`, 'wrong-chain').error, /chain 777777/);
  // The ERC-20 form is chain-checked too.
  bad(`ethereum:${TOKEN}@1/transfer?address=${B}&uint256=1`, 'wrong-chain');
});

test('reject: malformed addresses', () => {
  bad(`ethereum:0x123@3961`, 'bad-address');
  bad(`ethereum:not-an-address@3961`, 'bad-address');
  bad(`ethereum:@3961`, 'bad-address');
  bad(`0x8ba1f109551bD432803012645Ac136ddd64DBA7`, 'malformed'); // 39 hex chars → not an address at all
  bad(`0xZZa1f109551bD432803012645Ac136ddd64DBA72`, 'malformed');
});

test('reject: unsupported schemes are named back to the user', () => {
  const r = bad('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'unsupported-scheme');
  assert.match(r.error, /bitcoin/);
  assert.match(bad('https://ferminux.net/wallet/', 'unsupported-scheme').error, /https/);
  assert.match(bad('wc:8a5e5bdc@2?relay-protocol=irn', 'unsupported-scheme').error, /wc/);
  bad('solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', 'unsupported-scheme');
});

test('reject: empty payloads', () => {
  bad('', 'empty');
  bad('   ', 'empty');
  bad('\n\t ', 'empty');
});

test('reject: junk input', () => {
  bad('hello world', 'malformed');
  bad('{"to":"0x1234"}', 'malformed');
  bad('WIFI:S:Ferminux;T:WPA;P:hunter2;;', 'unsupported-scheme'); // "WIFI:" is a scheme, just not ours
  bad('ethereum:', 'malformed');
});

test('reject: structurally broken ethereum: URIs', () => {
  bad(`ethereum:${A}@3961@3961`, 'malformed');
  bad(`ethereum:${A}@3961/transfer/extra`, 'malformed');
  bad(`ethereum:${A}@abc`, 'malformed');
  bad(`ethereum:${A}@`, 'malformed');
});

test('reject: amounts that are not a whole number of base units', () => {
  bad(`ethereum:${A}@3961?value=1.5`, 'bad-amount'); // 1.5 wei
  bad(`ethereum:${A}@3961?value=1e-3`, 'bad-amount'); // negative exponent
  bad(`ethereum:${A}@3961?value=-1e18`, 'bad-amount');
  bad(`ethereum:${A}@3961?value=abc`, 'bad-amount');
  bad(`ethereum:${A}@3961?value=1,5`, 'bad-amount');
  bad(`ethereum:${TOKEN}@3961/transfer?address=${B}&uint256=0.5`, 'bad-amount');
});

/* ---------------- number + address helpers ---------------- */

test('parseEip681Number: integer, decimal-exponent and rejection cases', () => {
  assert.equal(parseEip681Number('0'), 0n);
  assert.equal(parseEip681Number('1000'), 1000n);
  assert.equal(parseEip681Number('1e18'), 10n ** 18n);
  assert.equal(parseEip681Number('1E18'), 10n ** 18n);
  assert.equal(parseEip681Number('1e+18'), 10n ** 18n);
  assert.equal(parseEip681Number('2.014e18'), 2_014_000_000_000_000_000n);
  assert.equal(parseEip681Number('6.0e18'), 6_000_000_000_000_000_000n);
  assert.equal(parseEip681Number('0.000000000000000001e18'), 1n);
  assert.equal(parseEip681Number(' 1e18 '), 10n ** 18n);
  // No float rounding anywhere: this value is not representable in a double.
  assert.equal(parseEip681Number('1.234567890123456789e18'), 1_234_567_890_123_456_789n);
  for (const junk of ['', '1.5', '1e-3', '-1', '1.2.3', '0x10', 'NaN', 'Infinity', '1 000', '1e99999']) {
    assert.equal(parseEip681Number(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
});

test('checksumAddress: mirrors the Send form validator', () => {
  assert.equal(checksumAddress(A), A);
  assert.equal(checksumAddress(A.toLowerCase()), A);
  assert.equal(checksumAddress(A.replace('0x8ba1', '0x8Ba1')), null);
  assert.equal(checksumAddress('0x123'), null);
  assert.equal(checksumAddress(''), null);
});

/* ---------------- the receive side ---------------- */

test('buildEip681Uri: encodes chain id, and the amount when requested', () => {
  assert.equal(buildEip681Uri(A, { chainId: CHAIN }), `ethereum:${A}@3961`);
  assert.equal(buildEip681Uri(A.toLowerCase(), { chainId: CHAIN }), `ethereum:${A}@3961`);
  assert.equal(
    buildEip681Uri(A, { chainId: CHAIN, amountWei: 10n ** 18n }),
    `ethereum:${A}@3961?value=1000000000000000000`,
  );
  // A zero request is an open-ended request, not "please send 0".
  assert.equal(buildEip681Uri(A, { chainId: CHAIN, amountWei: 0n }), `ethereum:${A}@3961`);
});

test('buildEip681Uri output round-trips back through the parser', () => {
  for (const amountWei of [undefined, 1n, 6n * 10n ** 18n, 123_456_789_012_345_678n]) {
    const uri = buildEip681Uri(B, { chainId: CHAIN, amountWei });
    const t = ok(uri);
    assert.equal(t.kind, 'address');
    assert.equal(t.address, B);
    assert.equal(t.chainId, CHAIN);
    assert.equal(t.amount, amountWei);
  }
});

/* ---------------- image decoding ---------------- */

/** Render a QR to RGBA pixels the way a canvas would, so jsQR can be tested headlessly. */
function renderQrToImageData(text, { scale = 6, quiet = 4, invert = false } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const modules = qr.modules.data;
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const inside = mx >= 0 && my >= 0 && mx < size && my < size;
      const dark = inside ? modules[my * size + mx] === 1 : false;
      const lum = (dark ? 0 : 255) ^ (invert ? 255 : 0);
      const i = (y * dim + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = lum;
      data[i + 3] = 255;
    }
  }
  return { data, width: dim, height: dim };
}

test('decodeQrImage: round-trips an EIP-681 receive code through jsQR', () => {
  const uri = buildEip681Uri(B, { chainId: CHAIN, amountWei: 6n * 10n ** 18n });
  const { data, width, height } = renderQrToImageData(uri);
  assert.equal(decodeQrImage(data, width, height), uri);
  // …and the decoded text is something the Send form can act on.
  const t = ok(decodeQrImage(data, width, height));
  assert.equal(t.address, B);
  assert.equal(t.amount, 6n * 10n ** 18n);
});

test('decodeQrImage: round-trips a plain address and an ERC-20 request', () => {
  for (const payload of [A, `ethereum:${TOKEN}@3961/transfer?address=${B}&uint256=1000000`]) {
    const { data, width, height } = renderQrToImageData(payload);
    assert.equal(decodeQrImage(data, width, height), payload);
  }
});

test('decodeQrImage: inverted images need attemptBoth (the still-image path)', () => {
  const { data, width, height } = renderQrToImageData(A, { invert: true });
  assert.equal(decodeQrImage(data, width, height, { inversionAttempts: 'dontInvert' }), null);
  assert.equal(decodeQrImage(data, width, height, { inversionAttempts: 'attemptBoth' }), A);
});

test('decodeQrImage: returns null (never throws) for blank and malformed buffers', () => {
  const blank = new Uint8ClampedArray(64 * 64 * 4).fill(255);
  assert.equal(decodeQrImage(blank, 64, 64), null);
  assert.equal(decodeQrImage(new Uint8ClampedArray(0), 0, 0), null);
  assert.equal(decodeQrImage(new Uint8ClampedArray(16), 100, 100), null); // buffer too small for the dimensions
  assert.equal(decodeQrImage(blank, -1, 10), null);
});
