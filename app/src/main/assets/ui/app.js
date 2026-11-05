'use strict';

const symbols = {
  wave: 'M1 12h5l2.5-4L11 18l3-14 3 12 2-6 2 2h2',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M18 6 6 18',
  search: 'M15.5 15.5 21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  server: 'M4 4h16v7H4zM4 13h16v7H4zM7 7.5h.1M7 16.5h.1',
  users: 'M15 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m17 0v-2a4 4 0 0 0-3-4m-5-7a3 3 0 1 1-6 0 3 3 0 0 1 6 0m3-3a3 3 0 0 1 0 6',
  user: 'M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  plus: 'M12 5v14M5 12h14',
  send: 'm3 4 18 8-18 8 3-8Zm3 8h15',
  smile: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8 14c2 3 6 3 8 0M9 9h.01M15 9h.01',
  voice: 'M4 14v4M9 10v8m6-12v12m5-8v8',
  chat: 'M4 4h16v12H9l-5 4V4Z',
  tag: 'M10 4 7 20M17 4l-3 16M5 9h15M4 15h15',
  chevron: 'm9 5 7 7-7 7',
  more: 'M5 12h.01m7 0h.01m7 0h.01',
  file: 'M6 3h8l4 4v14H6V3Zm8 0v5h4m-9 5h6m-6 4h6',
  pin: 'm9 4 11 8-4 1-3 5-1-4-4-3-4 1 5-4zm2 10-6 7',
  link: 'M10 13a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2m2 6a4 4 0 0 0-6 0l-4 4a4 4 0 0 0 6 6l2-2'
};
const emojis = ['👍', '❤️', '😂', '🔥', '🎮', '👀', '💀', '🤘', '🎉', '😎', '🫡', '💚'];
const accents = [['lime', 'Verde-lima'], ['mint', 'Menta'], ['lilac', 'Lilás'], ['amber', 'Âmbar'], ['ice', 'Azul-gelo']];
const roles = { owner: 'Dono', admin: 'Admin', member: 'Membro' };
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#toast');
const pending = new Map();
const photoCache = new Map();
const drafts = new Map();
let sequence = 0;
let toastTimer;

const model = {
  connection: { mode: 'start', base: '', authenticated: false },
  data: null, server: null, channel: null, page: 'chat', drawer: false,
  voice: {}, hd: false, offline: false, authRegister: false, sending: false,
  loadVersion: 0, stateVersion: 0, messages: [], more: false, signature: ''
};

function native(action, args = {}) {
  if (!window.FrequenciaAndroid) return Promise.reject(new Error('Abra este aplicativo no Android.'));
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.FrequenciaAndroid.post(JSON.stringify({ id, action, args }));
  });
}
const request = (method, path, data) => native('request', { method, path, data });
const endpoint = (channel = model.channel) => '/api/channels/' + channel.id;
const messages = (channel = model.channel) => endpoint(channel) + '/messages';
const local = () => model.connection.mode === 'demo';
const online = () => model.connection.mode === 'online' && model.connection.authenticated;

window.frequenciaEvent = (event, payload) => {
  const data = JSON.parse(payload);
  if (event === 'reply') {
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(Object.assign(new Error(data.error), { status: data.status }));
    else task.resolve(data.data);
  } else if (event === 'call') {
    model.voice = data;
    renderVoice();
  } else if (event === 'back') {
    if (dialog.open) dialog.close();
    else if (model.drawer) toggleDrawer(false);
    else if (model.data && model.page !== 'chat') changePage('chat');
    else if (model.data) toggleDrawer(true);
  }
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', symbols[name] || symbols.wave);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', name === 'more' ? '3' : '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}
function button(text, action, className = 'btn') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', async () => {
    if (node.disabled) return;
    node.disabled = true;
    try { await action(); } catch (error) { await report(error); }
    finally { node.disabled = false; }
  });
  return node;
}
function iconButton(name, title, action, extra = '') {
  const node = button('', action, 'icon ' + extra);
  node.setAttribute('aria-label', title);
  node.title = title;
  node.append(icon(name));
  return node;
}
function brand() {
  const node = element('div', 'brand');
  node.append(icon('wave'), element('span', '', 'FREQUÊNCIA'));
  return node;
}
function section(text) { return element('h3', 'section eyebrow', text); }
function toast(text) {
  clearTimeout(toastTimer);
  notice.textContent = text;
  notice.hidden = false;
  toastTimer = setTimeout(() => { notice.hidden = true; }, 4200);
}
async function report(error) {
  if (error.status === 401 && online()) {
    const state = await native('bootstrap');
    if (!state.authenticated) {
      reset(state);
      if (dialog.open) dialog.close();
    }
  }
  toast(error.message || 'Tente novamente.');
}
function showDialog(title) {
  const header = element('div', 'dialog-head');
  const heading = element('h2', '', title);
  heading.id = 'dialog-title';
  header.append(heading, iconButton('close', 'Fechar', () => dialog.close()));
  const content = element('div');
  dialog.replaceChildren(header, content);
  if (!dialog.open) dialog.showModal();
  return content;
}
function form(parent, fields, caption, submit) {
  const node = element('form', 'stack');
  const inputs = {};
  for (const spec of fields) {
    const field = element('label', 'field');
    const input = document.createElement(spec.options ? 'select' : spec.lines ? 'textarea' : 'input');
    if (spec.options) {
      for (const [id, label] of spec.options) input.append(new Option(label, id));
    } else if (!spec.lines) input.type = spec.type || 'text';
    if (spec.max) input.maxLength = spec.max;
    if (spec.min) input.minLength = spec.min;
    if (spec.placeholder) input.placeholder = spec.placeholder;
    if (spec.autocomplete) input.autocomplete = spec.autocomplete;
    if (spec.mode) input.inputMode = spec.mode;
    if (spec.plain) { input.autocapitalize = 'none'; input.spellcheck = false; }
    input.required = !spec.optional;
    input.value = spec.value || '';
    inputs[spec.key] = input;
    field.append(element('span', '', spec.label), input);
    node.append(field);
  }
  const error = element('div', 'form-error');
  error.setAttribute('role', 'alert');
  const save = element('button', 'btn primary', caption);
  save.type = 'submit';
  node.append(error, save);
  node.addEventListener('submit', async event => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    error.textContent = '';
    try { await submit(Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]))); }
    catch (err) { error.textContent = err.message; }
    finally { save.disabled = false; }
  });
  parent.append(node);
}
function reset(connection) {
  model.connection = connection;
  model.data = null;
  model.server = null;
  model.channel = null;
  model.page = 'chat';
  model.drawer = false;
  model.offline = false;
  model.authRegister = false;
  model.loadVersion++;
  model.stateVersion++;
  model.voice = {};
  drafts.clear();
  photoCache.clear();
  document.documentElement.dataset.theme = 'lime';
  render();
}
async function enter(connection) {
  reset(connection);
  if (local() || online()) await loadState(true);
}
function address() {
  const panel = showDialog('Endereço do servidor');
  const lead = element('p', 'subtle small', 'Peça o endereço a quem hospeda o Frequência. Use HTTPS pela internet ou o IP do computador na mesma rede Wi-Fi.');
  panel.append(lead, section('Conexão'));
  form(panel, [{ key: 'address', label: 'Endereço', value: model.connection.base, placeholder: 'http://192.168.1.10:8787', max: 180, mode: 'url', plain: true }], 'Conectar', async values => {
    const connection = await native('configure', values);
    dialog.close();
    await enter(connection);
  });
}
function renderEntry() {
  const screen = element('section', 'entry');
  const graphic = element('div', 'tuner');
  graphic.append(element('span', 'eyebrow', 'FQ / SINAL DE COMUNIDADE'), icon('wave'));
  screen.append(brand(), graphic);
  if (local() || online()) {
    screen.append(element('h1', '', model.offline ? 'Sem conexão' : 'Sintonizando…'));
    if (model.offline) {
      const actions = element('div', 'actions');
      actions.append(button('Tentar novamente', () => loadState(true), 'btn primary'), button('Alterar servidor', address));
      screen.append(element('p', '', 'Confira se o servidor está ligado e acessível pelo seu aparelho.'), actions);
    }
  } else if (model.connection.mode === 'online') {
    const register = model.authRegister;
    screen.append(element('h1', '', register ? 'Crie sua conta.' : 'Entre na frequência.'), section('Sua conta'));
    const fields = [
      { key: 'handle', label: 'Usuário', placeholder: 'seu_usuario', max: 24, autocomplete: 'username', plain: true },
      { key: 'password', label: 'Senha', type: 'password', min: 8, max: 128, autocomplete: register ? 'new-password' : 'current-password' }
    ];
    if (register) {
      fields.unshift({ key: 'name', label: 'Nome de exibição', max: 32 });
      fields.push({ key: 'key', label: 'Código de cadastro (se exigido)', type: 'password', max: 128, optional: true });
    }
    form(screen, fields, register ? 'Criar conta' : 'Entrar', async data => {
      const connection = await native('login', { register, data });
      await enter(connection);
    });
    const actions = element('div', 'actions');
    actions.append(button(register ? 'Já tenho conta' : 'Criar conta', () => {
      model.authRegister = !register;
      render();
    }), button('Alterar servidor', address), button('Abrir demonstração', async () => enter(await native('demo'))));
    screen.append(actions);
  } else {
    screen.append(element('h1', '', 'Encontre sua turma.'), element('p', '', 'Servidores, conversas e chamadas. Tudo no mesmo canal.'));
    const actions = element('div', 'actions');
    actions.append(button('Experimentar Os Crias', async () => enter(await native('demo')), 'btn primary'), button('Conectar a um servidor', address));
    screen.append(actions);
  }
  app.replaceChildren(screen);
}
async function loadState(redraw = false) {
  const version = ++model.stateVersion;
  let data;
  try { data = await request('GET', '/api/state'); }
  catch (error) {
    if (version !== model.stateVersion) return;
    model.offline = true;
    if (!model.data) render();
    await report(error);
    return;
  }
  if (version !== model.stateVersion) return;
  model.offline = false;
  const previous = model.data;
  const previousChannel = model.channel?.id;
  model.data = data;
  model.server = data.servers.find(server => server.id === model.server?.id) || data.servers[0] || null;
  if (model.channel?.kind === 'dm') {
    const friend = data.friends.find(person => person.channel_id === model.channel.id && person.status === 'accepted');
    if (friend) model.channel.name = friend.name;
    else model.channel = null;
  }
  if (model.channel?.kind !== 'dm') {
    const channels = model.server?.channels || [];
    model.channel = channels.find(ch => ch.id === model.channel?.id) || channels.find(ch => ch.kind === 'text') || null;
  }
  document.documentElement.dataset.theme = data.me.accent || 'lime';
  if (previousChannel !== model.channel?.id) {
    model.messages = [];
    model.signature = '';
    model.more = false;
    model.loadVersion++;
    polling = false;
  }
  if (redraw || !previous || previousChannel !== model.channel?.id) {
    render();
    await loadMessages({ force: true });
  } else {
    if (model.page === 'friends' && JSON.stringify(previous.friends) !== JSON.stringify(data.friends)) renderPage();
    if (model.drawer && JSON.stringify(previous.servers) !== JSON.stringify(data.servers)) renderDrawer();
    renderSignal();
  }
}
function render() {
  if (!model.data) { renderEntry(); return; }
  const mast = element('header', 'mast');
  const menu = iconButton('menu', 'Abrir lista de canais', () => toggleDrawer(!model.drawer));
  menu.id = 'menu';
  mast.append(menu, brand(), element('div', 'signal'));
  const workspace = element('div', 'workspace');
  workspace.append(element('section', 'page'));
  const nav = element('nav', 'nav');
  nav.setAttribute('aria-label', 'Navegação');
  for (const [id, name, label] of [['chat', 'server', 'Servidores'], ['friends', 'users', 'Amigos'], ['profile', 'user', 'Perfil']]) {
    const link = button('', () => {
      if (id === 'chat' && model.page === 'chat') toggleDrawer(!model.drawer);
      else changePage(id);
    }, '');
    link.dataset.page = id;
    link.append(icon(name), element('span', '', label));
    nav.append(link);
  }
  app.replaceChildren(mast, workspace, nav);
  renderSignal();
  renderPage();
  renderDrawer();
}
function renderSignal() {
  const signal = app.querySelector('.signal');
  if (!signal) return;
  signal.className = 'signal' + (local() ? ' demo' : model.offline ? ' off' : '');
  signal.textContent = local() ? 'MODO DEMO' : model.offline ? 'SEM SINAL' : 'CONECTADO';
}
function changePage(page) {
  model.page = page;
  toggleDrawer(false);
  renderPage();
  if (page === 'chat') loadMessages({ force: true }).catch(report);
  if (page === 'friends') loadState().catch(report);
}
function renderPage() {
  app.querySelectorAll('.nav button').forEach(node => {
    if (node.dataset.page === model.page) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  const page = app.querySelector('.page');
  if (!page) return;
  if (model.page === 'chat') renderChat(page);
  else if (model.page === 'friends') renderFriends(page);
  else renderProfile(page);
  renderVoice();
}
function toggleDrawer(open) {
  model.drawer = open;
  renderDrawer();
  if (open && online()) loadState().catch(report);
}
function renderDrawer() {
  const root = app.querySelector('.workspace');
  const toggle = app.querySelector('#menu');
  if (!root || !toggle) return;
  toggle.setAttribute('aria-expanded', String(model.drawer));
  root.querySelectorAll('.drawer,.scrim').forEach(node => node.remove());
  if (!model.drawer) return;
  const scrim = button('', () => toggleDrawer(false), 'scrim');
  scrim.setAttribute('aria-label', 'Fechar menu');
  const drawer = element('aside', 'drawer');
  const rail = element('div', 'rail');
  const list = element('div', 'drawer-main');
  for (const server of model.data.servers) {
    const mark = button('', () => {
      selectServer(server);
      model.drawer = true;
      renderDrawer();
    }, 'server-icon');
    mark.setAttribute('aria-label', server.name);
    mark.setAttribute('aria-pressed', String(model.server?.id === server.id));
    if (local()) mark.append(icon('wave'));
    else mark.textContent = initials(server.name);
    rail.append(mark);
  }
  rail.append(iconButton('plus', 'Adicionar servidor', serverActions, 'outline'));
  list.append(element('div', 'eyebrow accent', 'SERVIDORES'));
  const server = model.server;
  if (server) {
    list.append(element('h2', '', server.name));
    const actions = element('div', 'drawer-actions');
    actions.append(button('Membros', members, 'btn compact'));
    if (['owner', 'admin'].includes(server.role) && !local()) {
      actions.append(button('Convite', invite, 'btn compact'), button('+ Canal', createChannel, 'btn compact'));
    }
    list.append(actions);
    for (const [kind, label] of [['text', 'TEXTO'], ['voice', 'VOZ']]) {
      list.append(section(label));
      for (const channel of server.channels.filter(ch => ch.kind === kind)) {
        const row = button('', () => kind === 'voice' ? joinCall(channel) : chooseChannel(channel), 'channel-row');
        row.append(icon(kind === 'voice' ? 'voice' : 'tag'), element('span', '', channel.name));
        row.setAttribute('aria-pressed', String(channel.id === model.channel?.id || channel.id === model.voice.channel));
        list.append(row);
      }
    }
  } else {
    list.append(element('h2', '', 'Sua turma'), element('p', 'subtle', 'Crie um servidor ou entre com o código de alguém.'));
  }
  drawer.append(rail, list);
  root.append(scrim, drawer);
}
function isManager() { return ['owner', 'admin'].includes(model.server?.role) && model.channel?.kind !== 'dm'; }
function selectServer(server) {
  model.server = server;
  const ch = server.channels.find(item => item.kind === 'text');
  if (ch) chooseChannel(ch);
}
function chooseChannel(channel) {
  model.channel = channel;
  model.page = 'chat';
  model.messages = [];
  model.signature = '';
  model.more = false;
  toggleDrawer(false);
  renderPage();
  loadMessages({ force: true }).catch(report);
}
function connectPrompt(text = 'Este recurso funciona com um servidor conectado.') {
  const content = showDialog('Conecte um servidor');
  content.append(element('p', 'subtle', text), button('Configurar servidor', address, 'btn primary'));
}
function serverActions() {
  if (local()) return connectPrompt();
  const panel = showDialog('Adicionar servidor');
  const menu = element('div', 'dialog-list');
  menu.append(button('Criar servidor', () => {
    form(showDialog('Criar servidor'), [{ key: 'name', label: 'Nome do servidor', max: 40 }], 'Criar', async data => {
      const server = await request('POST', '/api/servers', data);
      dialog.close();
      await loadState();
      selectServer(server);
    });
  }), button('Entrar com convite', () => {
    form(showDialog('Entrar com convite'), [{ key: 'code', label: 'Código', max: 30, plain: true }], 'Entrar', async data => {
      const server = await request('POST', '/api/join', data);
      dialog.close();
      await loadState();
      selectServer(server);
    });
  }));
  panel.append(menu);
}
function createChannel() {
  const server = model.server;
  form(showDialog('Novo canal'), [
    { key: 'name', label: 'Nome', max: 32 },
    { key: 'kind', label: 'Tipo', options: [['text', 'Texto'], ['voice', 'Voz']], value: 'text' }
  ], 'Criar canal', async data => {
    await request('POST', '/api/servers/' + server.id + '/channels', data);
    dialog.close();
    await loadState(true);
  });
}
async function invite() {
  const { code } = await request('POST', '/api/servers/' + model.server.id + '/invites');
  const panel = showDialog('Convite de ' + model.server.name);
  panel.append(element('p', 'subtle', 'Válido por 7 dias. Compartilhe com quem você quer convidar.'), element('p', 'invite-code', code),
    button('Copiar convite', async () => { await native('copy', { value: code }); toast('Convite copiado.'); }, 'btn primary'));
}
async function members() {
  const server = model.server;
  if (!server) return;
  const { items } = await request('GET', '/api/servers/' + server.id + '/members');
  const panel = showDialog('Membros de ' + server.name);
  for (const user of items) {
    const row = personRow(user, roles[user.role]);
    if (server.role === 'owner' && user.role !== 'owner' && !local()) {
      row.append(button(user.role === 'admin' ? 'Tirar admin' : 'Tornar admin', async () => {
        await request('PATCH', '/api/servers/' + server.id + '/members/' + user.id, { role: user.role === 'admin' ? 'member' : 'admin' });
        await members();
      }, 'btn compact'));
    }
    panel.append(row);
  }
}
function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toUpperCase();
}
let activePhotos = 0;
const photoQueue = [];
function pumpPhotos() {
  while (activePhotos < 3 && photoQueue.length) {
    const { file, resolve, reject } = photoQueue.shift();
    activePhotos++;
    native('image', { file }).then(resolve, reject).finally(() => { activePhotos--; pumpPhotos(); });
  }
}
function attachPhoto(node, file) {
  if (!file || !online()) return;
  let photo = photoCache.get(file);
  if (!photo) {
    photo = new Promise((resolve, reject) => photoQueue.push({ file, resolve, reject }));
    photoCache.set(file, photo);
    if (photoCache.size > 18) photoCache.delete(photoCache.keys().next().value);
    pumpPhotos();
  }
  photo.then(({ data }) => {
    if (!node.isConnected || !/^data:image\/(?:png|jpeg|gif|webp);base64,/.test(data)) return;
    const img = element('img');
    img.alt = '';
    img.src = data;
    node.append(img);
  }).catch(() => {});
}
function avatar(user) {
  const node = element('span', 'avatar', initials(user.name));
  node.dataset.tint = user.accent || 'lime';
  node.setAttribute('aria-hidden', 'true');
  attachPhoto(node, user.avatar);
  return node;
}
function personRow(user, details = '') {
  const row = element('div', 'person');
  const text = element('div', 'person-meta');
  text.append(element('strong', '', user.name), element('small', '', '@' + user.handle + (details ? ' · ' + details : '')));
  row.append(avatar(user), text);
  return row;
}
function renderFriends(page) {
  const screen = element('div', 'screen');
  const head = element('div', 'screen-head');
  head.append(element('h1', '', 'Amigos'), button('+ Adicionar', addFriend, 'btn primary compact'));
  screen.append(element('div', 'eyebrow accent', 'MENSAGENS DIRETAS'), head);
  const items = model.data.friends;
  if (!items.length) screen.append(element('p', 'subtle', 'Adicione alguém pelo @usuário para começar.'));
  const pending = items.filter(item => item.status !== 'accepted');
  if (pending.length) screen.append(section('Pedidos de amizade'));
  for (const item of pending) {
    const incoming = item.requester !== model.data.me.id;
    const row = personRow(item, incoming ? 'Recebido' : 'Enviado');
    if (incoming) row.append(button('Aceitar', async () => {
      await request('POST', '/api/friends/' + item.id + '/accept');
      await loadState();
    }, 'btn compact'));
    row.append(iconButton('close', incoming ? 'Recusar' : 'Cancelar pedido', async () => {
      await request('DELETE', '/api/friends/' + item.id);
      await loadState();
    }));
    screen.append(row);
  }
  const friends = items.filter(item => item.status === 'accepted');
  if (friends.length) screen.append(section('Sua lista'));
  for (const item of friends) {
    const row = personRow(item, local() ? 'Conta de exemplo' : '');
    row.append(iconButton('chat', 'Conversar com ' + item.name, async () => {
      if (local()) return connectPrompt();
      const channel = await request('POST', '/api/friends/' + item.id + '/dm');
      const friend = model.data.friends.find(friend => friend.id === item.id);
      if (friend) friend.channel_id = channel.id;
      chooseChannel(channel);
    }, 'outline'));
    if (!local()) row.append(iconButton('more', 'Opções de ' + item.name, () => {
      const panel = showDialog(item.name);
      panel.append(element('p', 'subtle', item.bio || '@' + item.handle), button('Remover amizade', async () => {
        await request('DELETE', '/api/friends/' + item.id);
        dialog.close();
        await loadState();
      }, 'btn danger'));
    }));
    screen.append(row);
  }
  page.replaceChildren(screen, element('div', 'voice-dock'));
}
function addFriend() {
  if (local()) return connectPrompt();
  form(showDialog('Adicionar amigo'), [{ key: 'handle', label: 'Usuário', placeholder: '@nome', max: 24, plain: true }], 'Enviar pedido', async values => {
    await request('POST', '/api/friends', values);
    dialog.close();
    await loadState();
    toast('Pedido enviado.');
  });
}
function renderProfile(page) {
  const user = model.data.me;
  const screen = element('div', 'screen');
  const card = element('div', 'profile');
  const banner = element('div', 'banner');
  banner.append(icon('wave'));
  attachPhoto(banner, user.banner);
  const copy = element('div', 'profile-copy');
  copy.append(personRow(user, local() ? 'Demonstração local' : 'Conta Frequência'));
  if (user.bio) copy.append(element('p', 'subtle', user.bio));
  card.append(banner, copy);
  screen.append(element('div', 'eyebrow accent', 'SUA IDENTIDADE'), element('h1', '', 'Perfil'), card);
  const actions = element('div', 'actions');
  actions.append(button('Editar perfil', () => {
    form(showDialog('Editar perfil'), [
      { key: 'name', label: 'Nome de exibição', max: 32, value: user.name },
      { key: 'bio', label: 'Sobre mim', max: 160, value: user.bio, lines: true, optional: true },
      { key: 'accent', label: 'Cor do app', options: accents, value: user.accent || 'lime' }
    ], 'Salvar', async data => {
      await request('PATCH', '/api/me', data);
      dialog.close();
      await loadState(true);
    });
  }, 'btn primary'));
  for (const [key, label] of [['avatar', 'Avatar'], ['banner', 'Banner']]) {
    actions.append(button(label, () => {
      if (local()) return connectPrompt('Envie seu avatar ou banner em PNG, JPEG, GIF ou WebP ao conectar um servidor.');
      const panel = showDialog(label);
      const options = element('div', 'actions');
      panel.append(element('p', 'subtle', 'PNG, JPEG, GIF ou WebP de até 2 MiB e 2048 × 2048 px. GIF animado liberado.'), options);
      options.append(button('Escolher imagem', async () => {
        const result = await native('upload', { target: '/api/me/' + key });
        if (!result.cancelled) { dialog.close(); await loadState(true); }
      }, 'btn primary'));
      if (user[key]) options.append(button('Remover imagem', async () => {
        await request('DELETE', '/api/me/' + key);
        dialog.close();
        await loadState(true);
      }, 'btn danger'));
    }));
  }
  screen.append(actions, section('Chamadas'));
  const hd = element('label', 'person');
  const check = element('input');
  check.type = 'checkbox';
  check.checked = model.hd;
  check.addEventListener('change', () => { model.hd = check.checked; });
  const desc = element('span', 'person-meta');
  desc.append(element('strong', '', 'Compartilhar em até 1080p'), element('small', '', 'Nas próximas chamadas · qualidade depende do aparelho e da conexão.'));
  hd.append(check, desc);
  screen.append(hd, section('Conexão'));
  screen.append(element('p', 'subtle small', local() ? 'A demonstração salva mensagens neste aparelho.' : model.connection.base));
  const connection = element('div', 'actions');
  connection.append(button(local() ? 'Conectar a um servidor' : 'Alterar servidor', address));
  if (online()) connection.append(button('Sair da conta', async () => enter(await native('logout')), 'btn danger'));
  screen.append(connection);
  page.replaceChildren(screen, element('div', 'voice-dock'));
}

function renderChat(page) {
  const channel = model.channel;
  if (!channel) {
    const screen = element('div', 'screen');
    screen.append(element('div', 'eyebrow accent', 'SEUS SERVIDORES'), element('h1', '', 'Entre na frequência'),
      element('p', 'subtle', 'Monte um servidor para sua turma ou use o código de um convite.'));
    const actions = element('div', 'actions');
    actions.append(button('Adicionar servidor', serverActions, 'btn primary'));
    screen.append(actions);
    page.replaceChildren(screen, element('div', 'voice-dock'));
    return;
  }
  const top = element('header', 'channel-top');
  const title = element('div', 'channel-title');
  const label = channel.kind === 'dm' ? 'Mensagem direta' : model.server?.name || 'Servidor';
  const name = element('h1');
  if (channel.kind !== 'dm') name.append(element('b', '', '#'));
  name.append(document.createTextNode(channel.name));
  title.append(element('span', 'eyebrow', label), name);
  top.append(title, iconButton('search', 'Buscar mensagens', searchMessages),
    iconButton('pin', 'Mensagens fixadas', () => messageResults('Mensagens fixadas', '?pins=1')));
  top.append(channel.kind === 'dm' ? iconButton('voice', 'Entrar na chamada', () => joinCall(channel))
    : iconButton('users', 'Ver membros', members));
  const scroll = element('div', 'chat');
  scroll.id = 'chat-scroll';
  scroll.setAttribute('aria-label', 'Mensagens em ' + channel.name);
  const dock = element('div', 'voice-dock');
  const compose = element('form', 'compose');
  const add = iconButton('plus', 'Anexar arquivo (até 100 MiB)', async () => {
    if (local()) return connectPrompt('Conecte um servidor para enviar anexos de até 100 MiB.');
    const result = await native('upload', { target: endpoint(channel) + '/files' });
    if (!result.cancelled && model.channel?.id === channel.id) {
      toast('Arquivo enviado.');
      await loadMessages({ force: true, jump: true });
    }
  }, 'outline');
  const input = element('textarea');
  input.rows = 1;
  input.maxLength = 4000;
  input.placeholder = channel.kind === 'dm' ? 'Mensagem direta' : 'Mensagem em #' + channel.name;
  input.setAttribute('aria-label', input.placeholder);
  input.value = drafts.get(channel.id) || '';
  input.addEventListener('input', () => { drafts.set(channel.id, input.value); });
  const wrap = element('div', 'input-wrap');
  wrap.append(input, iconButton('smile', 'Inserir emoji', () => {
    emojiPicker('Escolher emoji', emoji => {
      if (input.value.length + emoji.length <= input.maxLength) input.value += emoji;
      drafts.set(channel.id, input.value);
      input.focus();
    });
  }));
  const send = element('button', 'icon send');
  send.type = 'submit';
  send.setAttribute('aria-label', 'Enviar mensagem');
  send.append(icon('send'));
  compose.append(add, wrap, send);
  compose.addEventListener('submit', async event => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value || model.sending) return;
    model.sending = true;
    send.disabled = true;
    try {
      await request('POST', messages(channel), { body: value });
      if (input.value.trim() === value) {
        input.value = '';
        drafts.delete(channel.id);
      }
      if (model.channel?.id === channel.id) await loadMessages({ force: true, jump: true });
    } catch (error) { await report(error); }
    finally { model.sending = false; send.disabled = false; }
  });
  page.replaceChildren(top, scroll, dock, compose);
  drawMessages({ jump: true });
}
function renderVoice() {
  const dock = app.querySelector('.voice-dock');
  if (!dock) return;
  const active = model.voice.channel;
  const channel = model.channel?.kind === 'dm' ? model.channel : model.server?.channels.find(channel => channel.kind === 'voice');
  if (!active && (!channel || model.page !== 'chat')) {
    dock.replaceChildren();
    dock.hidden = true;
    return;
  }
  dock.hidden = false;
  const status = active ? model.voice.reconnecting ? 'Reconectando…'
    : model.voice.connected ? (model.voice.count + ' na chamada' + (model.voice.screen ? ' · Tela ativa' : '')) : 'Conectando…'
    : local() ? 'Voz · prévia' : model.data?.media ? 'Voz · tocar para entrar' : 'Voz · servidor de chamadas não configurado';
  const card = button('', () => active ? native('showCall') : joinCall(channel), 'voice-card' + (active ? ' live' : ''));
  const caption = element('span', 'voice-text');
  caption.append(element('strong', '', active ? model.voice.name : channel.kind === 'dm' ? 'Chamada com ' + channel.name : channel.name), element('small', '', status));
  card.append(icon('voice'), caption, icon('chevron'));
  dock.replaceChildren(card);
}
async function joinCall(channel) {
  if (local()) return connectPrompt('Use um servidor Frequência com chamadas configuradas para testar microfone, câmera e tela.');
  await native('joinCall', { channel: channel.id, label: channel.name, hd: model.hd });
  toggleDrawer(false);
}

let polling = false;
let pageLoading = false;
async function loadMessages({ force = false, jump = false } = {}) {
  const channel = model.channel;
  if (!channel || model.page !== 'chat' || (polling && !force) || pageLoading && !force) return;
  polling = true;
  const version = ++model.loadVersion;
  try {
    const { items, more } = await request('GET', messages(channel));
    if (version !== model.loadVersion || model.channel?.id !== channel.id) return;
    const oldest = items[0]?.id ?? 0;
    // Pages already fetched remain accessible while the latest page updates.
    model.messages = more ? model.messages.filter(msg => msg.id < oldest).concat(items) : items;
    if (!more) model.more = false;
    else if (model.messages.length === items.length) model.more = true;
    const signature = JSON.stringify(model.messages);
    model.offline = false;
    renderSignal();
    if (signature !== model.signature || force) {
      model.signature = signature;
      drawMessages({ jump });
    }
  } catch (error) {
    if (version !== model.loadVersion) return;
    model.offline = true;
    renderSignal();
    if (force || error.status === 401) await report(error);
    else if (error.status === 404 && channel.kind === 'dm') await loadState(true);
  } finally {
    if (version === model.loadVersion) polling = false;
  }
}
async function history() {
  const channel = model.channel;
  const before = model.messages[0]?.id;
  if (!before || pageLoading) return;
  pageLoading = true;
  try {
    const result = await request('GET', messages(channel) + '?before=' + before);
    if (model.channel?.id !== channel.id) return;
    model.messages = result.items.concat(model.messages);
    model.more = result.more;
    model.signature = JSON.stringify(model.messages);
    drawMessages({ prepend: true });
  } finally { pageLoading = false; }
}
const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const calendar = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
function drawMessages({ jump = false, prepend = false } = {}) {
  const scroll = app.querySelector('#chat-scroll');
  const channel = model.channel;
  if (!scroll || !channel) return;
  const previousHeight = scroll.scrollHeight;
  const previousTop = scroll.scrollTop;
  const stick = previousHeight > scroll.clientHeight && previousHeight - previousTop - scroll.clientHeight < 52;
  const intro = element('div', 'chat-intro');
  const copy = element('div');
  copy.append(element('div', 'eyebrow', channel.kind === 'dm' ? 'FREQUÊNCIA PRIVADA' : 'CANAL DE TEXTO'),
    element('h2', '', channel.kind === 'dm' ? channel.name : 'Bem-vindo a #' + channel.name));
  intro.append(element('div', 'channel-icon', channel.kind === 'dm' ? '@' : '#'), copy);
  const items = [intro];
  if (model.more) {
    const top = element('div', 'history');
    top.append(button('Carregar mensagens anteriores', history, 'btn compact'));
    items.push(top);
  }
  let day = '';
  for (const item of model.messages) {
    const date = calendar.format(new Date(item.created_at));
    if (date !== day) {
      day = date;
      items.push(element('div', 'dayline eyebrow', day));
    }
    items.push(messageRow(item));
  }
  if (!model.messages.length) items.push(element('p', 'empty', 'Mande a primeira mensagem.'));
  scroll.replaceChildren(...items);
  scroll.scrollTop = jump || stick && !prepend ? scroll.scrollHeight : prepend ? previousTop + scroll.scrollHeight - previousHeight : previousTop;
}
function messageRow(message, inDialog = false) {
  const row = element('article', 'message');
  const content = element('div', 'message-main');
  if (message.pinned) content.append(element('div', 'pin-label', 'FIXADA'));
  const meta = element('div', 'message-meta');
  const date = new Date(message.created_at);
  const time = element('time', '', clock.format(date));
  time.dateTime = date.toISOString();
  meta.append(element('strong', '', message.name), time);
  if (message.edited) meta.append(element('small', 'subtle', 'editada'));
  content.append(meta);
  if (message.body) content.append(element('p', 'message-text', message.body));
  if (message.file_id) {
    const file = button('', async () => {
      const saved = await native('download', { target: message.file_id, name: message.file_name });
      if (!saved.cancelled) toast('Arquivo salvo.');
    }, 'file');
    const description = element('span');
    const mb = message.file_size / 1048576;
    description.append(element('strong', '', message.file_name), element('small', 'subtle',
      (mb < 1 ? Math.ceil(message.file_size / 1024) + ' KiB' : mb.toFixed(1) + ' MiB') + ' · Baixar'));
    file.append(icon('file'), description);
    content.append(file);
  }
  if (message.reactions?.length) {
    const reactions = element('div', 'reactions');
    for (const reaction of message.reactions) {
      const chip = button(reaction.emoji + ' ' + reaction.count, () => mutate(message.id, 'POST', '/reaction', { emoji: reaction.emoji }),
        'reaction' + (reaction.mine ? ' active' : ''));
      chip.setAttribute('aria-pressed', String(Boolean(reaction.mine)));
      reactions.append(chip);
    }
    content.append(reactions);
  }
  row.append(avatar(message), content);
  if (!inDialog) row.append(iconButton('more', 'Opções da mensagem de ' + message.name, () => messageMenu(message), 'more'));
  return row;
}
function emojiPicker(title, selected) {
  const grid = element('div', 'emoji-grid');
  for (const emoji of emojis) grid.append(button(emoji, async () => {
    dialog.close();
    await selected(emoji);
  }, ''));
  showDialog(title).append(grid);
}
async function mutate(id, method, suffix = '', data) {
  const channel = model.channel;
  const result = await request(method, messages(channel) + '/' + id + suffix, data);
  if (model.channel?.id !== channel.id) return;
  if (method === 'DELETE') model.messages = model.messages.filter(message => message.id !== id);
  else if (result.id) model.messages = model.messages.map(message => message.id === id ? result : message);
  else if (suffix === '/pin' || method === 'PATCH') {
    model.messages = model.messages.map(message => message.id === id ?
      (suffix === '/pin' ? { ...message, pinned: data.pinned } : { ...message, body: data.body, edited: 1 }) : message);
  }
  await loadMessages({ force: true });
}
function messageMenu(message) {
  const own = message.user_id === model.data.me.id;
  const panel = showDialog('Mensagem de ' + message.name);
  const list = element('div', 'dialog-list');
  list.append(button('Reagir', () => emojiPicker('Reagir à mensagem', emoji => mutate(message.id, 'POST', '/reaction', { emoji }))));
  if (message.body) list.append(button('Copiar texto', async () => {
    await native('copy', { value: message.body });
    dialog.close();
    toast('Texto copiado.');
  }));
  if (isManager() || model.channel.kind === 'dm') list.append(button(message.pinned ? 'Desafixar' : 'Fixar mensagem', async () => {
    await mutate(message.id, 'POST', '/pin', { pinned: !message.pinned });
    dialog.close();
  }));
  if (own && message.body) list.append(button('Editar mensagem', () => {
    form(showDialog('Editar mensagem'), [{ key: 'body', label: 'Mensagem', value: message.body, max: 4000, lines: true }], 'Salvar', async data => {
      await mutate(message.id, 'PATCH', '', data);
      dialog.close();
    });
  }));
  if (own || isManager()) list.append(button('Apagar mensagem', () => {
    const confirm = showDialog('Apagar mensagem?');
    confirm.append(element('p', 'subtle', 'A mensagem será removida deste canal.'), button('Apagar', async () => {
      await mutate(message.id, 'DELETE');
      dialog.close();
    }, 'btn danger'));
  }, 'btn danger'));
  panel.append(list);
}
function searchMessages() {
  form(showDialog('Buscar neste canal'), [{ key: 'q', label: 'Palavra ou trecho', max: 120 }], 'Buscar', data =>
    messageResults('Resultados', '?q=' + encodeURIComponent(data.q)));
}
async function messageResults(title, query) {
  const channel = model.channel;
  const result = await request('GET', messages(channel) + query);
  const panel = showDialog(title);
  const list = element('div');
  const older = button('Carregar mais resultados', async () => {
    const next = await request('GET', messages(channel) + query + '&before=' + older.dataset.before);
    append(next);
  }, 'btn compact');
  function append(data) {
    for (const item of [...data.items].reverse()) list.append(messageRow(item, true));
    older.hidden = !data.more;
    older.dataset.before = String(data.items[0]?.id || 1);
  }
  if (!result.items.length) panel.append(element('p', 'subtle', 'Nenhuma mensagem encontrada.'));
  panel.append(list, older);
  append(result);
}

let ticks = 0;
setInterval(() => {
  if (document.hidden || !online() || !model.data) return;
  if (model.page === 'chat') loadMessages().catch(report);
  if (++ticks % 5 === 0) loadState().catch(report);
}, 2100);
native('bootstrap').then(enter).catch(report);
