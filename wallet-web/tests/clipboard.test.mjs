// A copied recovery phrase is wiped from the system clipboard (lib/secretClipboard.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteCopied, wipeSecretIfDue, secretPending, SECRET_CLIPBOARD_MS } from '../src/lib/secretClipboard.ts';

function fakeEnv({ readable = true, focused = true } = {}) {
  const env = {
    t: 0,
    content: '',
    clipboard: {
      readText: async () => env.content,
      writeText: async (text) => {
        if (!focused) throw new Error('Document is not focused.');
        env.content = text;
      },
    },
    canRead: async () => readable,
    now: () => env.t,
    focus() {
      focused = true;
    },
  };
  return env;
}

const PHRASE = 'test test test test test test test test test test test junk';

test('clipboard: a copied phrase is wiped once due, not before', async () => {
  const env = fakeEnv();
  env.content = PHRASE;
  noteCopied(PHRASE, true, env);
  env.t = SECRET_CLIPBOARD_MS - 1;
  await wipeSecretIfDue(env);
  assert.equal(env.content, PHRASE);
  env.t = SECRET_CLIPBOARD_MS;
  await wipeSecretIfDue(env);
  assert.equal(env.content, '');
  assert.equal(secretPending(), false);
  noteCopied('', false); // clear the real timer
});

test('clipboard: something copied since is left alone', async () => {
  const env = fakeEnv();
  env.content = PHRASE;
  noteCopied(PHRASE, true, env);
  env.content = 'an address the user copied elsewhere';
  env.t = SECRET_CLIPBOARD_MS;
  await wipeSecretIfDue(env);
  assert.equal(env.content, 'an address the user copied elsewhere');
  noteCopied('', false);
});

test('clipboard: a later copy by the wallet itself cancels the wipe', async () => {
  const env = fakeEnv({ readable: false });
  env.content = PHRASE;
  noteCopied(PHRASE, true, env);
  env.content = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  noteCopied(env.content, false, env);
  env.t = SECRET_CLIPBOARD_MS;
  await wipeSecretIfDue(env);
  assert.equal(env.content, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
});

test('clipboard: unreadable and unfocused: wiped when the page is back', async () => {
  const env = fakeEnv({ readable: false, focused: false });
  env.content = PHRASE;
  noteCopied(PHRASE, true, env);
  env.t = SECRET_CLIPBOARD_MS + 5_000;
  await wipeSecretIfDue(env);
  assert.equal(env.content, PHRASE, 'a background page may not write');
  assert.equal(secretPending(), true, 'still owed');
  env.focus();
  await wipeSecretIfDue(env);
  assert.equal(env.content, '');
  noteCopied('', false);
});
