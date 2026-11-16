'use strict';
/* KordCord — Discord-like app
   - Auth (scrypt hash, HMAC token, no external auth deps)
   - Servers / members / roles, text + voice channels
   - Realtime messages + typing + presence via Socket.io
   - Voice via WebRTC mesh signalling over Socket.io
   - Invite links: /invite/:code  (preview + join)
   Storage: data/data.json (JSON file). On Render free the disk is ephemeral —
   data resets on redeploy/restart. Set up a Postgres/Supabase DATABASE_URL
   version later if you need permanent storage for a large community.
*/
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.APP_SECRET || 'dev-secret-change-on-render';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let db;
function freshDb() { return { users: [], servers: [], members: [], channels: [], messages: [], invites: [] }; }
function loadDb() {
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { db = freshDb(); saveDb(); }
  for (const k of Object.keys(freshDb())) if (!Array.isArray(db[k])) db[k] = [];
}
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 1)); } catch (e) { console.error('saveDb', e); }
  }, 50);
}
loadDb();

const id = () => crypto.randomUUID();
const code = (n = 8) => crypto.randomBytes(12).toString('base64url').slice(0, n);
const COLORS = ['#5865f2','#57f287','#fee75c','#eb459e','#ed4245','#f26522','#3ba55c','#7289da'];
const colorFor = (s) => COLORS[[...s].reduce((a,c)=>a+c.charCodeAt(0),0) % COLORS.length];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, user) {
  if (!user.passHash || !user.salt) return false;
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.passHash));
}
function signToken(user) {
  const payload = { uid: user.id, username: user.username, exp: Date.now() + 7*24*3600*1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function parseToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== expect) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; }
  catch { return null; }
}
const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, color: u.color, isGuest: !!u.isGuest });
const userById = (uid) => db.users.find(u => u.id === uid);
const isMember = (serverId, uid) => db.members.some(m => m.serverId === serverId && m.userId === uid);
const memberRole = (serverId, uid) => (db.members.find(m => m.serverId === serverId && m.userId === uid) || {}).role;

function createServerFor(owner, name) {
  const server = { id: id(), name: name.trim(), ownerId: owner.id, color: colorFor(name), allowGuests: true, createdAt: Date.now() };
  db.servers.push(server);
  db.members.push({ serverId: server.id, userId: owner.id, role: 'owner', joinedAt: Date.now() });
  const mk = (n, type, category) => db.channels.push({ id: id(), serverId: server.id, name: n, type, category, createdAt: Date.now() });
  mk('chung', 'text', 'KÊNH CHAT');
  mk('thong-bao', 'text', 'KÊNH CHAT');
  mk('Phòng Voice 1', 'voice', 'KÊNH VOICE');
  mk('Phòng Voice 2', 'voice', 'KÊNH VOICE');
  const inv = { code: code(8), serverId: server.id, createdBy: owner.id, createdAt: Date.now(), expiresAt: null, uses: 0 };
  db.invites.push(inv);
  saveDb();
  return { server, invite: inv };
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const p = parseToken(h.replace(/^Bearer\s+/i, ''));
  if (!p) return res.status(401).json({ error: 'Chưa đăng nhập hoặc phiên hết hạn' });
  req.user = userById(p.uid);
  if (!req.user) return res.status(401).json({ error: 'Tài khoản không tồn tại' });
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true, users: db.users.length, servers: db.servers.length, time: Date.now() }));

app.post('/api/register', (req, res) => {
  const { username, displayName, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Thiếu username hoặc mật khẩu' });
  const uname = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,24}$/.test(uname)) return res.status(400).json({ error: 'Username 3-24 ký tự, chỉ chữ thường/số/._-' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });
  if (db.users.some(u => u.username === uname)) return res.status(409).json({ error: 'Username đã có người dùng' });
  const { salt, hash } = hashPassword(String(password));
  const user = { id: id(), username: uname, displayName: String(displayName || username).trim().slice(0, 40), salt, passHash: hash, color: colorFor(uname), createdAt: Date.now() };
  db.users.push(user); saveDb();
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.users.find(u => u.username === String(username || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user)) return res.status(401).json({ error: 'Sai username hoặc mật khẩu' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/servers', auth, (req, res) => {
  const mine = db.members.filter(m => m.userId === req.user.id).map(m => m.serverId);
  res.json({ servers: db.servers.filter(s => mine.includes(s.id)).map(s => ({ ...s, role: memberRole(s.id, req.user.id), memberCount: db.members.filter(m => m.serverId === s.id).length })) });
});

app.post('/api/servers', auth, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Khách không tạo server được — hãy đăng ký tài khoản' });
  const name = String((req.body || {}).name || '').trim();
  if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Tên server 2-60 ký tự' });
  const { server, invite } = createServerFor(req.user, name);
  res.json({ server, inviteCode: invite.code });
});

app.get('/api/servers/:sid/channels', auth, (req, res) => {
  if (!isMember(req.params.sid, req.user.id)) return res.status(403).json({ error: 'Bạn chưa là thành viên server này' });
  res.json({ channels: db.channels.filter(c => c.serverId === req.params.sid) });
});

app.post('/api/servers/:sid/channels', auth, (req, res) => {
  if (!isMember(req.params.sid, req.user.id)) return res.status(403).json({ error: 'Bạn chưa là thành viên server này' });
  if (req.user.isGuest) return res.status(403).json({ error: 'Khách không tạo kênh được — hãy đăng ký tài khoản' });
  const { name, type } = req.body || {};
  const clean = String(name || '').trim();
  if (clean.length < 1 || clean.length > 40) return res.status(400).json({ error: 'Tên kênh 1-40 ký tự' });
  const slug = clean.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'kenh';
  const ch = { id: id(), serverId: req.params.sid, name: type === 'voice' ? clean : slug, type: type === 'voice' ? 'voice' : 'text', category: type === 'voice' ? 'KÊNH VOICE' : 'KÊNH CHAT', createdAt: Date.now() };
  db.channels.push(ch); saveDb();
  io.to('server:' + req.params.sid).emit('channels-changed', { serverId: req.params.sid });
  res.json({ channel: ch });
});

app.get('/api/servers/:sid/members', auth, (req, res) => {
  if (!isMember(req.params.sid, req.user.id)) return res.status(403).json({ error: 'Bạn chưa là thành viên server này' });
  const members = db.members.filter(m => m.serverId === req.params.sid).map(m => ({ ...publicUser(userById(m.userId) || { id: m.userId, username: '?', displayName: '?', color: '#999' }), role: m.role, online: onlineUsers.has(m.userId) }));
  res.json({ members });
});

app.get('/api/servers/:sid/messages', auth, (req, res) => {
  if (!isMember(req.params.sid, req.user.id)) return res.status(403).json({ error: 'Bạn chưa là thành viên server này' });
  const channelId = req.query.channelId;
  const msgs = db.messages.filter(m => m.serverId === req.params.sid && m.channelId === channelId).slice(-100)
    .map(m => ({ ...m, author: publicUser(userById(m.userId) || { id: m.userId, username: '?', displayName: '?', color: '#999' }) }));
  res.json({ messages: msgs });
});

app.post('/api/servers/:sid/invite', auth, (req, res) => {
  if (!isMember(req.params.sid, req.user.id)) return res.status(403).json({ error: 'Bạn chưa là thành viên server này' });
  if (req.user.isGuest) return res.status(403).json({ error: 'Khách không tạo link mời được' });
  const inv = { code: code(8), serverId: req.params.sid, createdBy: req.user.id, createdAt: Date.now(), expiresAt: null, uses: 0 };
  db.invites.push(inv); saveDb();
  res.json({ inviteCode: inv.code, url: `/invite/${inv.code}` });
});

app.get('/api/servers/:sid/invite', auth, (req, res) => {
  if (!isMember(req.params.sid, req.user.id)) return res.status(403).json({ error: 'Bạn chưa là thành viên server này' });
  let inv = [...db.invites].reverse().find(i => i.serverId === req.params.sid);
  if (!inv) { inv = { code: code(8), serverId: req.params.sid, createdBy: req.user.id, createdAt: Date.now(), expiresAt: null, uses: 0 }; db.invites.push(inv); saveDb(); }
  res.json({ inviteCode: inv.code, url: `/invite/${inv.code}` });
});

app.get('/api/invite/:code', (req, res) => {
  const inv = db.invites.find(i => i.code === req.params.code);
  if (!inv) return res.status(404).json({ error: 'Link mời không tồn tại hoặc đã bị thu hồi' });
  if (inv.expiresAt && inv.expiresAt < Date.now()) return res.status(410).json({ error: 'Link mời đã hết hạn' });
  const server = db.servers.find(s => s.id === inv.serverId);
  res.json({ server: { id: server.id, name: server.name, color: server.color, allowGuests: server.allowGuests !== false, memberCount: db.members.filter(m => m.serverId === server.id).length } });
});

app.post('/api/invite/:code/guest-join', (req, res) => {
  const inv = db.invites.find(i => i.code === req.params.code);
  if (!inv) return res.status(404).json({ error: 'Link mời không tồn tại hoặc đã bị thu hồi' });
  if (inv.expiresAt && inv.expiresAt < Date.now()) return res.status(410).json({ error: 'Link mời đã hết hạn' });
  const server = db.servers.find(s => s.id === inv.serverId);
  if (server.allowGuests === false) return res.status(403).json({ error: 'Server này đã tắt chế độ khách — hãy đăng ký tài khoản để vào' });
  const displayName = String((req.body || {}).displayName || '').trim().slice(0, 40);
  if (displayName.length < 2) return res.status(400).json({ error: 'Tên hiển thị tối thiểu 2 ký tự' });
  const guest = { id: id(), username: 'guest_' + code(10).toLowerCase(), displayName, salt: '', passHash: '', isGuest: true, color: colorFor(displayName + Date.now()), createdAt: Date.now() };
  db.users.push(guest);
  db.members.push({ serverId: server.id, userId: guest.id, role: 'guest', joinedAt: Date.now() });
  inv.uses++; saveDb();
  io.to('server:' + server.id).emit('members-changed', { serverId: server.id });
  res.json({ token: signToken(guest), user: publicUser(guest), server });
});

app.patch('/api/servers/:sid/settings', auth, (req, res) => {
  const server = db.servers.find(s => s.id === req.params.sid);
  if (!server) return res.status(404).json({ error: 'Không tìm thấy server' });
  if (memberRole(req.params.sid, req.user.id) !== 'owner') return res.status(403).json({ error: 'Chỉ chủ server mới đổi cài đặt được' });
  if (typeof (req.body || {}).allowGuests === 'boolean') server.allowGuests = req.body.allowGuests;
  saveDb();
  res.json({ server });
});

app.post('/api/invite/:code/join', auth, (req, res) => {
  const inv = db.invites.find(i => i.code === req.params.code);
  if (!inv) return res.status(404).json({ error: 'Link mời không tồn tại hoặc đã bị thu hồi' });
  if (inv.expiresAt && inv.expiresAt < Date.now()) return res.status(410).json({ error: 'Link mời đã hết hạn' });
  if (!isMember(inv.serverId, req.user.id)) {
    db.members.push({ serverId: inv.serverId, userId: req.user.id, role: 'member', joinedAt: Date.now() });
    inv.uses++; saveDb();
    io.to('server:' + inv.serverId).emit('members-changed', { serverId: inv.serverId });
  }
  const server = db.servers.find(s => s.id === inv.serverId);
  res.json({ server, alreadyMember: true });
});

app.delete('/api/invite/:code', auth, (req, res) => {
  const idx = db.invites.findIndex(i => i.code === req.params.code);
  if (idx < 0) return res.status(404).json({ error: 'Không tìm thấy link mời' });
  const inv = db.invites[idx];
  const role = memberRole(inv.serverId, req.user.id);
  if (role !== 'owner' && inv.createdBy !== req.user.id) return res.status(403).json({ error: 'Chỉ chủ server hoặc người tạo link mới thu hồi được' });
  db.invites.splice(idx, 1); saveDb();
  res.json({ ok: true });
});

// Invite landing + SPA fallback
app.get('/invite/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const onlineUsers = new Set();
const socketUser = new Map(); // socketId -> userId
const voiceRooms = new Map(); // channelId -> Map(socketId -> userPublic)

io.use((socket, next) => {
  const p = parseToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!p) return next(new Error('unauthorized'));
  socket.userId = p.uid;
  next();
});

io.on('connection', (socket) => {
  const user = userById(socket.userId);
  if (!user) return socket.disconnect();
  socketUser.set(socket.id, user.id);
  onlineUsers.add(user.id);
  // join rooms of all servers the user belongs to
  db.members.filter(m => m.userId === user.id).forEach(m => socket.join('server:' + m.serverId));
  io.emit('presence', { userId: user.id, online: true });

  socket.on('join-server-room', ({ serverId }) => { if (isMember(serverId, user.id)) socket.join('server:' + serverId); });

  socket.on('send-message', ({ serverId, channelId, content }, cb) => {
    const text = String(content || '').trim();
    if (!text || text.length > 2000) return cb && cb({ error: 'Tin nhắn trống hoặc quá dài' });
    if (!isMember(serverId, user.id)) return cb && cb({ error: 'Chưa là thành viên' });
    const ch = db.channels.find(c => c.id === channelId && c.serverId === serverId && c.type === 'text');
    if (!ch) return cb && cb({ error: 'Kênh không tồn tại' });
    const msg = { id: id(), serverId, channelId, userId: user.id, content: text, createdAt: Date.now() };
    db.messages.push(msg); saveDb();
    io.to('server:' + serverId).emit('new-message', { ...msg, author: publicUser(user) });
    cb && cb({ ok: true, message: msg });
  });

  socket.on('typing', ({ serverId, channelId }) => {
    if (isMember(serverId, user.id)) socket.to('server:' + serverId).emit('typing', { channelId, user: publicUser(user) });
  });

  /* ---- Voice (WebRTC mesh signalling) ---- */
  socket.on('voice-join', ({ channelId }) => {
    const ch = db.channels.find(c => c.id === channelId && c.type === 'voice');
    if (!ch || !isMember(ch.serverId, user.id)) return;
    if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Map());
    const room = voiceRooms.get(channelId);
    const peers = [...room.entries()].map(([sid, u]) => ({ socketId: sid, user: u }));
    room.set(socket.id, { ...publicUser(user), camOn: false, sharing: false, muted: false });
    socket.voiceChannelId = channelId;
    socket.emit('voice-peers', { peers });
    socket.to('server:' + ch.serverId).emit('voice-participants', { channelId, participants: [...room.values()] });
    peers.forEach(p => { const s = io.sockets.sockets.get(p.socketId); if (s) s.emit('voice-user-joined', { socketId: socket.id, user: room.get(socket.id) }); });
  });
  socket.on('voice-state', ({ camOn, sharing, muted }) => {
    const channelId = socket.voiceChannelId; if (!channelId) return;
    const room = voiceRooms.get(channelId); if (!room || !room.has(socket.id)) return;
    const p = room.get(socket.id);
    p.camOn = !!camOn; p.sharing = !!sharing; p.muted = !!muted;
    const ch = db.channels.find(c => c.id === channelId);
    [...room.keys()].filter(sid => sid !== socket.id).forEach(sid => { const s = io.sockets.sockets.get(sid); if (s) s.emit('voice-participant-state', { socketId: socket.id, user: p }); });
    if (ch) io.to('server:' + ch.serverId).emit('voice-participants', { channelId, participants: [...room.values()] });
  });
  const relay = (ev) => socket.on(ev, ({ to, data }) => { const s = io.sockets.sockets.get(to); if (s) s.emit(ev, { from: socket.id, data }); });
  relay('voice-offer'); relay('voice-answer'); relay('voice-ice');
  const leaveVoice = () => {
    const channelId = socket.voiceChannelId; if (!channelId) return;
    const room = voiceRooms.get(channelId); if (room) {
      room.delete(socket.id);
      const ch = db.channels.find(c => c.id === channelId);
      if (ch) io.to('server:' + ch.serverId).emit('voice-participants', { channelId, participants: [...room.values()] });
      [...room.keys()].forEach(sid => { const s = io.sockets.sockets.get(sid); if (s) s.emit('voice-user-left', { socketId: socket.id }); });
    }
    socket.voiceChannelId = null;
  };
  socket.on('voice-leave', leaveVoice);

  socket.on('disconnect', () => {
    leaveVoice();
    socketUser.delete(socket.id);
    const still = [...socketUser.values()].includes(user.id);
    if (!still) { onlineUsers.delete(user.id); io.emit('presence', { userId: user.id, online: false }); }
  });
});

server.listen(PORT, () => console.log(`KordCord running on http://localhost:${PORT}`));
module.exports = { app, server };
