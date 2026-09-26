// The password that guards keys on this device (vault, keystore files) must
// survive an offline guessing attack: what cracking lists try first is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passwordProblem } from '../src/lib/password.ts';

test('password: the first guesses of every cracking list are refused', () => {
  for (const pw of [
    '12345678', '123456789', '87654321', '11111111', '1234567890', '123456789012',
    'password', 'Password1', 'Password1!', 'P@ssw0rd', 'p@ssword123', 'passw0rd!',
    'qwerty123', 'qwertyuiop', 'Qwerty2024', '1q2w3e4r', '1qaz2wsx', 'zaq12wsx', 'asdfghjkl',
    'iloveyou', 'iloveyou2024', 'sunshine1', 'Summer2024!', 'michael1985', 'football99',
    'abcd1234', 'abcdefgh', 'aaaa1111', 'aaaaaaaa', 'abcabcabc', 'monkeymonkey', 'lovelove',
    'bitcoin123', 'Ethereum1!', 'metamask', 'ferminux', 'Ferminux2026', 'Ferminux#1', 'wallet123',
    'elephant', 'Keyboard',
  ]) {
    assert.ok(passwordProblem(pw), `"${pw}" should be refused`);
  }
});

test('password: under 8 characters is refused with the length rule', () => {
  assert.match(passwordProblem('Tq8#mZ2'), /at least 8/);
  assert.match(passwordProblem(''), /at least 8/);
});

test('password: passphrases and random passwords pass', () => {
  for (const pw of [
    'correct horse battery 3961',
    'ferminux multi 3961', // the ui-check password
    'embed check 3961',
    'multichain smoke 3961',
    'third-party walletconnect 3961',
    'Tq8#mZ2!pL',
    'blue-otter-lamp-94',
    'xk3vq9 plm2',
    'Gunəş çıxır səhər 7',
    'mountain river 2019',
  ]) {
    assert.equal(passwordProblem(pw), null, `"${pw}" should pass`);
  }
});
