const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express(), server = http.createServer(app), io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
const users = new Map(), sessions = new Map();
// Use a persistent disk/volume in hosting and set DATA_DIR to its mount path.
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'roxopay-data.json');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function loadData() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (const [key, user] of Object.entries(saved.users || {})) users.set(key, user);
    console.log(`Dados persistentes carregados: ${users.size} conta(s).`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Não foi possível ler os dados salvos:', err.message);
  }
}
function saveData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const tempFile = dataFile + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify({ users: Object.fromEntries(users) }, null, 2), { mode: 0o600 });
  fs.renameSync(tempFile, dataFile);
}
loadData();
function snapshot(username) {
  const me = users.get(username);
  return { me: { username: me.username, balance: me.balance },
    people: [...users.values()].filter(u => u.username !== username).map(u => ({ username: u.username })),
    transactions: me.transactions.slice(0, 30) };
}
function pushUpdate(username) {
  for (const [socketId, name] of sessions.entries()) if (name === username) io.to(socketId).emit('refresh', snapshot(username));
}
io.on('connection', socket => {
  socket.on('login', ({ username, password } = {}) => {
    username = String(username || '').trim(); password = String(password || '');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username) || password.length < 4) return socket.emit('loginResult', { ok: false, error: 'Nome ou senha fictícia inválidos.' });
    const key = username.toLowerCase(); let u = users.get(key);
    if (u && u.passwordHash !== hash(password)) return socket.emit('loginResult', { ok: false, error: 'Senha incorreta para esse usuário.' });
    if (!u) { u = { username, passwordHash: hash(password), balance: 0, transactions: [] }; users.set(key, u); saveData(); }
    sessions.set(socket.id, key); socket.emit('loginResult', { ok: true, user: { username: u.username, balance: u.balance }, data: snapshot(key) });
  });
  socket.on('addFunds', ({ amount } = {}) => {
    const key = sessions.get(socket.id), u = users.get(key), n = Number(amount);
    if (!u) return socket.emit('actionResult', { action: 'funds', ok: false, message: 'Entre no simulador primeiro.' });
    if (!Number.isFinite(n) || n < 1 || n > 10000) return socket.emit('actionResult', { action: 'funds', ok: false, message: 'Informe um valor entre R$ 1 e R$ 10.000.' });
    const value = Math.round(n * 100) / 100; u.balance = Math.round((u.balance + value) * 100) / 100;
    u.transactions.unshift({ title: 'Saldo de teste adicionado', amount: value, sign: '+', time: Date.now(), note: 'Crédito fictício' });
    saveData(); pushUpdate(key); socket.emit('actionResult', { action: 'funds', ok: true, message: 'Saldo fictício adicionado e salvo.', data: snapshot(key) });
  });
  socket.on('pix', ({ recipient, amount, note } = {}) => {
    const key = sessions.get(socket.id), from = users.get(key), toKey = String(recipient || '').trim().toLowerCase(), to = users.get(toKey), n = Number(amount);
    const fail = message => socket.emit('actionResult', { action: 'pix', ok: false, message });
    if (!from) return fail('Entre no simulador primeiro.');
    if (!to) return fail('Destinatário não encontrado. Peça para a pessoa criar uma conta no simulador.');
    if (toKey === key) return fail('Escolha outro usuário como destinatário.');
    if (!Number.isFinite(n) || n <= 0 || n > 10000) return fail('Informe um valor maior que zero e até R$ 10.000.');
    const value = Math.round(n * 100) / 100;
    if (from.balance + 1e-8 < value) return fail('Saldo fictício insuficiente. Adicione saldo de teste.');
    from.balance = Math.round((from.balance - value) * 100) / 100; to.balance = Math.round((to.balance + value) * 100) / 100;
    const cleanNote = String(note || '').slice(0, 80);
    from.transactions.unshift({ title: 'Pix fictício enviado para ' + to.username, amount: value, sign: '-', time: Date.now(), note: cleanNote });
    to.transactions.unshift({ title: 'Pix fictício recebido de ' + from.username, amount: value, sign: '+', time: Date.now(), note: cleanNote });
    saveData(); pushUpdate(key); pushUpdate(toKey); socket.emit('actionResult', { action: 'pix', ok: true, message: 'Transferência fictícia realizada e salva!', data: snapshot(key) });
  });
  socket.on('disconnect', () => sessions.delete(socket.id));
});
const port = process.env.PORT || 3000;
server.listen(port, () => console.log('RoxoPay demo rodando na porta ' + port));
