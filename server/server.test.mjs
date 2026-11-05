import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const secret = 'local-test-fixture-1234567890-not-a-real-key';

async function start(directory) {
  const processHandle = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: directory,
      LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'test', LIVEKIT_API_SECRET: secret,
      REGISTRATION_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(processHandle, 'exit');
  let log = '';
  processHandle.stderr.on('data', chunk => { log += chunk; });
  let port;
  try {
    port = await Promise.race([
      once(processHandle.stdout, 'data').then(([chunk]) => Number(/"port":(\d+)/.exec(String(chunk))?.[1])),
      exit.then(() => { throw new Error('Falha ao iniciar: ' + log); }),
    ]);
    assert(port);
  } catch (error) {
    processHandle.kill();
    throw error;
  }
  const base = 'http://127.0.0.1:' + port;
  return {
    async stop() { processHandle.kill(); await exit; },
    async api(path, { method = 'GET', token, data, raw, status = 200, binary = false } = {}) {
      const headers = token ? { Authorization: 'Bearer ' + token } : {};
      if (data) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + '/api' + path, { method, headers, body: raw ?? (data ? JSON.stringify(data) : undefined) });
      assert.equal(response.status, status, path + ' · ' + (await response.clone().text()).slice(0, 300));
      return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
    }
  };
}

test('contas, convites privados, mensagens, arquivos, permissões e persistência', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frequencia-'));
  let instance = await start(directory);
  try {
    const { api } = instance;
    assert.deepEqual(await api('/health'), { app: 'frequencia', version: 1, media: true });
    const register = (name) => api('/register', { method: 'POST', data: { handle: name, name, password: 'senha-de-teste' } });
    const [alice, bob, outsider] = await Promise.all(['alice', 'bruno', 'carol'].map(register));
    const server = await api('/servers', { method: 'POST', token: alice.token, data: { name: 'Os Crias' } });
    const chat = server.channels.find(ch => ch.kind === 'text');
    const voice = server.channels.find(ch => ch.kind === 'voice');
    const path = '/channels/' + chat.id + '/messages';
    const call = '/channels/' + voice.id + '/call';
    await api(path, { token: bob.token, status: 404 });
    await api(call, { method: 'POST', token: outsider.token, status: 404 });
    await api('/servers/' + server.id + '/members', { token: outsider.token, status: 404 });
    const invite = await api('/servers/' + server.id + '/invites', { method: 'POST', token: alice.token });
    await api('/join', { method: 'POST', token: bob.token, data: invite });
    await api('/servers/' + server.id + '/channels', { method: 'POST', token: bob.token, data: { name: 'novo', kind: 'text' }, status: 403 });
    await api('/servers/' + server.id + '/members/' + bob.me.id, { method: 'PATCH', token: alice.token, data: { role: 'admin' } });
    const updated = await api('/servers/' + server.id + '/channels', { method: 'POST', token: bob.token, data: { name: 'novo', kind: 'text' } });
    assert(updated.channels.some(ch => ch.name === 'novo'));
    const joined = await api(call, { method: 'POST', token: bob.token });
    const [header, payload, signature] = joined.token.split('.');
    assert.equal(signature, createHmac('sha256', secret).update(header + '.' + payload).digest('base64url'));
    const grant = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(grant.video.room, 'frequencia-' + voice.id);
    assert.equal(grant.sub, bob.me.id);
    await api('/channels/' + chat.id + '/call', { method: 'POST', token: bob.token, status: 404 });

    const sent = await api(path, { method: 'POST', token: alice.token, data: { body: 'Bora jogar?' } });
    const stored = await api(path, { token: bob.token });
    assert.equal(stored.items[0].body, 'Bora jogar?');
    await api(path + '/' + sent.id, { method: 'PATCH', token: bob.token, data: { body: 'invasão' }, status: 403 });
    await api(path + '/' + sent.id, { method: 'PATCH', token: alice.token, data: { body: 'Bora jogar hoje?' } });
    await api(path + '/' + sent.id + '/pin', { method: 'POST', token: bob.token, data: { pinned: true } });
    await api(path + '/' + sent.id + '/reaction', { method: 'POST', token: bob.token, data: { emoji: '🎮' } });
    const result = await api(path + '?pins=1&q=jogar', { token: alice.token });
    assert.equal(result.items[0].edited, 1);
    assert.equal(result.items[0].pinned, 1);
    assert.deepEqual(result.items[0].reactions, [{ emoji: '🎮', count: 1, mine: 0 }]);
    const bytes = Buffer.from('arquivo de teste');
    const upload = await api('/channels/' + chat.id + '/files?name=teste.txt', { method: 'POST', token: bob.token, raw: bytes });
    assert.deepEqual(await api('/files/' + upload.file_id, { token: alice.token, binary: true }), bytes);
    await api('/files/' + upload.file_id, { token: outsider.token, status: 404 });
    await api('/me/avatar', { method: 'POST', token: alice.token, raw: bytes, status: 415 });
    const pixelGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const profile = await api('/me/avatar', { method: 'POST', token: alice.token, raw: pixelGif });
    assert.deepEqual(await api('/files/' + profile.avatar, { token: bob.token, binary: true }), pixelGif);

    await api('/friends/' + bob.me.id + '/dm', { method: 'POST', token: alice.token, status: 404 });
    await api('/friends', { method: 'POST', token: alice.token, data: { handle: bob.me.handle } });
    await api('/friends/' + bob.me.id + '/accept', { method: 'POST', token: alice.token, status: 404 });
    await api('/friends/' + alice.me.id + '/accept', { method: 'POST', token: bob.token });
    const dm = await api('/friends/' + bob.me.id + '/dm', { method: 'POST', token: alice.token });
    const dmPath = '/channels/' + dm.id + '/messages';
    await api(dmPath, { method: 'POST', token: bob.token, data: { body: 'Apenas para você.' } });
    await api(dmPath, { token: outsider.token, status: 404 });

    await instance.stop();
    instance = await start(directory);
    const after = await instance.api(path, { token: bob.token });
    assert.deepEqual(after.items.map(item => item.body), ['Bora jogar hoje?', '']);
    assert.deepEqual(await instance.api('/files/' + upload.file_id, { token: bob.token, binary: true }), bytes);
    await instance.api('/friends/' + alice.me.id, { method: 'DELETE', token: bob.token });
    await instance.api(dmPath, { token: alice.token, status: 404 });
    await instance.api('/logout', { method: 'POST', token: bob.token });
    await instance.api('/state', { token: bob.token, status: 401 });
  } finally {
    await instance.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
