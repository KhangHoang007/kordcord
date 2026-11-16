'use strict';
/* E2E test: register 2 users -> create server -> invite -> user2 joins ->
   create channel -> realtime message via Socket.io -> history -> revoke invite.
   Run: npm install && npm install --no-save socket.io-client && node test-e2e.js
   Starts its own server on PORT 3456 with a temp data file. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
const check = (name, cond, extra='') => { console.log((cond?'PASS':'FAIL')+' | '+name+(extra?' | '+extra:'')); if(!cond) failures++; };

async function api(p, { method='GET', token, body } = {}) {
  const r = await fetch(BASE+p, { method, headers: { 'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}) }, body: body?JSON.stringify(body):undefined });
  const d = await r.json().catch(()=>({}));
  return { status: r.status, data: d };
}
const wait = ms => new Promise(r=>setTimeout(r,ms));

(async()=>{
  const dataFile = path.join(__dirname,'data','data.json');
  const backup = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : null;
  if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  const srv = spawn('node',['server.js'],{ cwd: __dirname, env:{...process.env, PORT:String(PORT), APP_SECRET:'test-secret'}, stdio:'pipe' });
  try {
    let up=false; for(let i=0;i<40;i++){ try{ const h=await api('/api/health'); if(h.data.ok){up=true;break;} }catch{} await wait(250); }
    check('server starts + health OK', up);

    const suffix = Date.now().toString(36);
    const r1 = await api('/api/register',{method:'POST',body:{username:'owner_'+suffix,displayName:'Owner Test',password:'secret123'}});
    check('register user1', r1.status===200 && !!r1.data.token);
    const dup = await api('/api/register',{method:'POST',body:{username:'owner_'+suffix,password:'secret123'}});
    check('duplicate username rejected (409)', dup.status===409);
    const badLogin = await api('/api/login',{method:'POST',body:{username:'owner_'+suffix,password:'wrong-pass'}});
    check('wrong password rejected (401)', badLogin.status===401);
    const login = await api('/api/login',{method:'POST',body:{username:'owner_'+suffix,password:'secret123'}});
    check('login user1', login.status===200);
    const t1 = r1.data.token;

    const noAuth = await api('/api/servers');
    check('servers list requires auth (401)', noAuth.status===401);

    const cs = await api('/api/servers',{method:'POST',token:t1,body:{name:'Server Test '+suffix}});
    check('create server', cs.status===200 && !!cs.data.server);
    const sid = cs.data.server.id, inviteCode = cs.data.inviteCode;
    check('default invite code issued', !!inviteCode, inviteCode);

    const chs = await api(`/api/servers/${sid}/channels`,{token:t1});
    const texts = chs.data.channels.filter(c=>c.type==='text'), voices = chs.data.channels.filter(c=>c.type==='voice');
    check('default channels: 2 text + 2 voice', texts.length===2 && voices.length===2, `text=${texts.length} voice=${voices.length}`);

    const r2 = await api('/api/register',{method:'POST',body:{username:'friend_'+suffix,displayName:'Friend Test',password:'secret456'}});
    const t2 = r2.data.token;
    const stranger = await api(`/api/servers/${sid}/channels`,{token:t2});
    check('non-member blocked from channels (403)', stranger.status===403);

    const preview = await api('/api/invite/'+inviteCode);
    check('invite preview shows server', preview.status===200 && preview.data.server.id===sid);
    const join = await api('/api/invite/'+inviteCode+'/join',{method:'POST',token:t2,body:{}});
    check('user2 joins via invite', join.status===200);
    const joinAgain = await api('/api/invite/'+inviteCode+'/join',{method:'POST',token:t2,body:{}});
    check('re-join is idempotent', joinAgain.status===200);
    const members = await api(`/api/servers/${sid}/members`,{token:t1});
    check('member list = 2', members.data.members.length===2, 'count='+members.data.members.length);
    check('owner role present', members.data.members.some(m=>m.role==='owner'));

    const nc = await api(`/api/servers/${sid}/channels`,{method:'POST',token:t2,body:{name:'Kênh Mới Test',type:'text'}});
    check('member can create text channel', nc.status===200 && nc.data.channel.name==='kenh-moi-test', nc.data.channel && nc.data.channel.name);
    const nv = await api(`/api/servers/${sid}/channels`,{method:'POST',token:t1,body:{name:'Voice Test',type:'voice'}});
    check('create voice channel', nv.status===200 && nv.data.channel.type==='voice');

    // Realtime message: user2 listens, user1 sends
    const { io } = require('socket.io-client');
    const s1 = io(BASE,{auth:{token:t1}}), s2 = io(BASE,{auth:{token:t2}});
    await Promise.all([new Promise(r=>s1.on('connect',r)), new Promise(r=>s2.on('connect',r))]);
    check('both sockets connect', s1.connected && s2.connected);
    const chanId = texts[0].id;
    const got = new Promise(r=>s2.on('new-message',m=>{ if(m.channelId===chanId) r(m); }));
    const ack = await new Promise(r=>s1.emit('send-message',{serverId:sid,channelId:chanId,content:'Xin chào từ test E2E'},r));
    check('send-message ack ok', ack && ack.ok===true);
    const msg = await Promise.race([got, wait(3000).then(()=>null)]);
    check('user2 receives realtime message', !!msg && msg.content==='Xin chào từ test E2E');
    const hist = await api(`/api/servers/${sid}/messages?channelId=${chanId}`,{token:t2});
    check('message persisted in history', hist.data.messages.some(m=>m.content==='Xin chào từ test E2E'));
    s1.close(); s2.close();

    // Guest mode: join with only a display name, no account
    const guest = await api('/api/invite/'+inviteCode+'/guest-join',{method:'POST',body:{displayName:'Khach Test'}});
    check('guest joins via link without account', guest.status===200 && !!guest.data.token && guest.data.user.isGuest===true);
    const tg = guest.data.token;
    const gChannels = await api(`/api/servers/${sid}/channels`,{token:tg});
    check('guest can read channels', gChannels.status===200);
    const gMembers = await api(`/api/servers/${sid}/members`,{token:tg});
    check('member list = 3 after guest joins', gMembers.data.members.length===3, 'count='+gMembers.data.members.length);
    check('guest flagged in member list', gMembers.data.members.some(m=>m.isGuest && m.role==='guest'));
    const gCreateCh = await api(`/api/servers/${sid}/channels`,{method:'POST',token:tg,body:{name:'hack-channel',type:'text'}});
    check('guest cannot create channel (403)', gCreateCh.status===403);
    const gCreateSrv = await api('/api/servers',{method:'POST',token:tg,body:{name:'Guest Server'}});
    check('guest cannot create server (403)', gCreateSrv.status===403);
    const gCreateInv = await api(`/api/servers/${sid}/invite`,{method:'POST',token:tg,body:{}});
    check('guest cannot create invite (403)', gCreateInv.status===403);
    const gBadName = await api('/api/invite/'+inviteCode+'/guest-join',{method:'POST',body:{displayName:'x'}});
    check('guest name too short rejected (400)', gBadName.status===400);
    // Guest chats in realtime
    const sg = io(BASE,{auth:{token:tg}}), s1b = io(BASE,{auth:{token:t1}});
    await Promise.all([new Promise(r=>sg.on('connect',r)), new Promise(r=>s1b.on('connect',r))]);
    const gotByOwner = new Promise(r=>s1b.on('new-message',m=>{ if(m.content==='Chao tu khach') r(m); }));
    const gAck = await new Promise(r=>sg.emit('send-message',{serverId:sid,channelId:chanId,content:'Chao tu khach'},r));
    check('guest send-message ack ok', gAck && gAck.ok===true);
    const gMsg = await Promise.race([gotByOwner, wait(3000).then(()=>null)]);
    check('owner receives guest realtime message', !!gMsg && gMsg.author.isGuest===true);
    sg.close(); s1b.close();
    // Owner toggles guests off -> new guest blocked; on again -> allowed
    const off = await api(`/api/servers/${sid}/settings`,{method:'PATCH',token:t1,body:{allowGuests:false}});
    check('owner disables guest mode', off.status===200 && off.data.server.allowGuests===false);
    const nonOwnerToggle = await api(`/api/servers/${sid}/settings`,{method:'PATCH',token:t2,body:{allowGuests:true}});
    check('non-owner cannot change settings (403)', nonOwnerToggle.status===403);
    const blockedGuest = await api('/api/invite/'+inviteCode+'/guest-join',{method:'POST',body:{displayName:'Khach Bi Chan'}});
    check('guest blocked when guest mode off (403)', blockedGuest.status===403);
    const on = await api(`/api/servers/${sid}/settings`,{method:'PATCH',token:t1,body:{allowGuests:true}});
    check('owner re-enables guest mode', on.status===200 && on.data.server.allowGuests===true);
    const guest2 = await api('/api/invite/'+inviteCode+'/guest-join',{method:'POST',body:{displayName:'Khach Thu Hai'}});
    check('guest joins again after re-enable', guest2.status===200);

    // Voice stage signalling: join, peers, cam/share state sync, leave
    const v1 = io(BASE,{auth:{token:t1}}), v2 = io(BASE,{auth:{token:t2}});
    await Promise.all([new Promise(r=>v1.on('connect',r)), new Promise(r=>v2.on('connect',r))]);
    const voiceChan = voices[0].id;
    const v1Joined = new Promise(r=>v1.on('voice-user-joined',d=>r(d)));
    v1.emit('voice-join',{channelId:voiceChan});
    await wait(300);
    const v2Peers = new Promise(r=>v2.on('voice-peers',d=>r(d)));
    v2.emit('voice-join',{channelId:voiceChan});
    const peersData = await Promise.race([v2Peers, wait(3000).then(()=>null)]);
    check('voice: second joiner gets existing peers list', !!peersData && peersData.peers.length===1);
    const joinedData = await Promise.race([v1Joined, wait(3000).then(()=>null)]);
    check('voice: first member notified of joiner', !!joinedData && joinedData.socketId===v2.id);
    const stateForV1 = new Promise(r=>v1.on('voice-participant-state',d=>{ if(d.user.sharing) r(d); }));
    v2.emit('voice-state',{camOn:true,sharing:true,muted:false});
    const st = await Promise.race([stateForV1, wait(3000).then(()=>null)]);
    check('voice: screen-share state syncs to peers', !!st && st.user.camOn===true && st.user.sharing===true);
    const stateForV2 = new Promise(r=>v2.on('voice-participant-state',d=>{ if(d.user.muted) r(d); }));
    v1.emit('voice-state',{camOn:false,sharing:false,muted:true});
    const st2 = await Promise.race([stateForV2, wait(3000).then(()=>null)]);
    check('voice: mute state syncs to peers', !!st2 && st2.user.muted===true);
    const leftEvt = new Promise(r=>v1.on('voice-user-left',d=>r(d)));
    v2.emit('voice-leave',{});
    const leftData = await Promise.race([leftEvt, wait(3000).then(()=>null)]);
    check('voice: leave notifies peers', !!leftData && leftData.socketId===v2.id);
    v1.close(); v2.close();

    // Invite: create new + revoke
    const inv2 = await api(`/api/servers/${sid}/invite`,{method:'POST',token:t1,body:{}});
    check('create second invite', inv2.status===200 && inv2.data.inviteCode!==inviteCode);
    const del = await api('/api/invite/'+inv2.data.inviteCode,{method:'DELETE',token:t1});
    check('owner revokes invite', del.status===200);
    const gone = await api('/api/invite/'+inv2.data.inviteCode);
    check('revoked invite 404', gone.status===404);
  } catch(e) {
    check('E2E exception: '+e.message, false);
  } finally {
    srv.kill();
    await wait(300);
    if (backup) fs.writeFileSync(dataFile, backup); else if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  }
  console.log(failures===0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures===0?0:1);
})();
