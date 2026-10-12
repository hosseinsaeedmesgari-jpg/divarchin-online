'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const accounts = require('./accounts');
const bot = require('./bot');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, 'public');
const rooms = new Map();
const SIDES = ['بالا', 'پایین'];
const MAX_BODY = 16 * 1024;
const MAX_ROOMS = 3000;
const MAX_CHAT_LENGTH = 280;
const CHAT_LIMIT = 80;
const CHAT_INTERVAL_MS = 800;

function cleanName(value) {
  return (typeof value === 'string' ? value.trim().slice(0, 18) : '') || 'بازیکن';
}
function createRoomCode() {
  let code;
  do { code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); }
  while (rooms.has(code));
  return code;
}
function token() { return crypto.randomBytes(24).toString('base64url'); }
function initialState(durationSeconds = 180) {
  return {
    // The server owns both chess clocks; clients only display them.
    time: { durationSeconds, remainingMs: durationSeconds === 0 ? [null, null] : [durationSeconds * 1000, durationSeconds * 1000], turnStartedAt: null, lastBonus: null },
    endReason: null,
    pawns: [{ r: 8, c: 4 }, { r: 0, c: 4 }],
    walls: [], remaining: [10, 10], turn: 0, winner: null,
    moveNumber: 1, startedAt: Date.now()
  };
}
// The server is authoritative. Unlimited games never expire. Timed games lose
// immediately when their active player's reserve is exhausted; no grace period.
function expireIfNeeded(room, now = Date.now()) {
  const s = room.game;
  if (room.settings.durationSeconds === 0 || room.players.length !== 2 ||
      s.winner !== null || s.time.turnStartedAt === null) return false;
  const elapsed = Math.max(0, now - s.time.turnStartedAt);
  if (elapsed < s.time.remainingMs[s.turn]) return false;
  s.time.remainingMs[s.turn] = 0;
  s.winner = 1 - s.turn;
  s.endReason = 'timeout';
  s.time.turnStartedAt = null;
  return true;
}
// Applies exactly +1000ms, never a fractional/inferred bonus. It activates when
// the clock has fallen strictly below half of the original chosen duration.
function settleTurnClock(game, player, now) {
  const duration = game.time.durationSeconds;
  if (duration === 0) return;
  const elapsed = Math.max(0, now - game.time.turnStartedAt);
  const left = Math.max(0, game.time.remainingMs[player] - elapsed);
  const bonus = left > 0 && left < duration * 500 && elapsed <= 1000 ? 1000 : 0;
  game.time.remainingMs[player] = left + bonus;
  game.time.lastBonus = bonus ? {player, moveNumber:game.moveNumber, valueMs:1000} : null;
}
function playerId(room, candidate) { return room.players.findIndex(p => p.token === candidate); }
function isInside(r,c) { return r >= 0 && r < 9 && c >= 0 && c < 9; }
function hasWallBlock(walls, a, b) {
  if (!isInside(b.r,b.c) || Math.abs(a.r-b.r) + Math.abs(a.c-b.c) !== 1) return true;
  for (const w of walls) {
    if (a.r !== b.r && w.o === 'h' && w.r === Math.min(a.r,b.r) && (w.c === a.c || w.c+1 === a.c)) return true;
    if (a.c !== b.c && w.o === 'v' && w.c === Math.min(a.c,b.c) && (w.r === a.r || w.r+1 === a.r)) return true;
  }
  return false;
}
function reachable(walls, start, goal) {
  const queue = [start], seen = new Set([start.r*9+start.c]);
  for (let i=0;i<queue.length;i++) {
    const a = queue[i];
    if (a.r === goal) return true;
    for (const [dr,dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const b = {r:a.r+dr,c:a.c+dc}, key = b.r*9+b.c;
      if (!isInside(b.r,b.c) || seen.has(key) || hasWallBlock(walls,a,b)) continue;
      seen.add(key); queue.push(b);
    }
  }
  return false;
}
function legalWall(game,o,r,c) {
  if ((o !== 'h' && o !== 'v') || !Number.isInteger(r) || !Number.isInteger(c) || r<0 || r>7 || c<0 || c>7) return false;
  for (const w of game.walls) {
    if (w.o === o && (o === 'h' ? w.r===r && Math.abs(w.c-c)<2 : w.c===c && Math.abs(w.r-r)<2)) return false;
    if (w.o !== o && w.r === r && w.c === c) return false;
  }
  const trial = game.walls.concat({o,r,c});
  return reachable(trial,game.pawns[0],0) && reachable(trial,game.pawns[1],8);
}
function legalMoves(game, id) {
  const me = game.pawns[id], opp = game.pawns[1-id], result = [], marked = new Set();
  const add = (p) => { const k = `${p.r},${p.c}`; if (!marked.has(k)) {marked.add(k); result.push(p);} };
  for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    const near={r:me.r+dr,c:me.c+dc};
    if (hasWallBlock(game.walls,me,near)) continue;
    if (near.r!==opp.r || near.c!==opp.c) {add(near); continue;}
    const beyond={r:opp.r+dr,c:opp.c+dc};
    if (!hasWallBlock(game.walls,opp,beyond)) { add(beyond); continue; }
    const perp = dr===0 ? [[-1,0],[1,0]] : [[0,-1],[0,1]];
    for (const [pr,pc] of perp) {
      const side = {r:opp.r+pr,c:opp.c+pc};
      if (!hasWallBlock(game.walls,opp,side)) add(side);
    }
  }
  return result;
}
function publicState(room, id) {
  const s=room.game;
  return {
    room:room.code, you:id,
    players: room.players.map((p,i)=>({id:i,name:p.name,registered:!!p.accountId,side:SIDES[i], color: i === 0 ? room.settings.hostColor : (room.settings.hostColor === 'cyan' ? 'orange' : 'cyan')})),
    settings: room.settings,
    bot: !!room.bot,
    rematchVotes: room.rematchVotes ? Array.from(room.rematchVotes) : [],
    ratedRecorded: room.ratedRecorded === true,
    chat: room.chat.slice(-CHAT_LIMIT),
    time: { ...s.time, remainingMs: [...s.time.remainingMs], serverNow: Date.now() },
    endReason: s.endReason,
    waiting:room.players.length<2,
    pawns:s.pawns, walls:s.walls, remaining:s.remaining,
    turn:s.turn, winner:s.winner, moveNumber:s.moveNumber,
    legalMoves:room.players.length===2 && s.winner===null && s.turn===id ? legalMoves(s,id) : []
  };
}
function pushToPlayer(room,id) {
  const wire=`data: ${JSON.stringify({type:'state',state:publicState(room,id)})}\n\n`;
  for (const res of room.players[id].listeners) {
    try {res.write(wire);} catch {room.players[id].listeners.delete(res);}
  }
}
async function recordResult(room) {
  if(!room.settings.ranked || room.game.winner===null) return true;
  if(room.ratedRecorded) return true;
  if(room.recording) return false;
  room.recording=true;
  try {
    await accounts.saveRankedMatch({
      id:room.matchId,room:room.code,
      ids:room.players.map(p=>p.accountId),winner:room.game.winner,
      reason:room.game.endReason||'goal',duration:room.settings.durationSeconds
    });
    room.ratedRecorded=true;
    room.recording=false;
    publish(room);
    return true;
  }catch(e){console.error('Ranked result save failed:',e);room.recording=false;return false;}
}
function publish(room) {
  if(room.game.winner!==null && room.settings.ranked && !room.ratedRecorded && !room.recording) {
    void recordResult(room);
  }
  room.lastActivity=Date.now();
  room.players.forEach((_,i)=>pushToPlayer(room,i));
}
function send(res,status,payload) {
  if (res.writableEnded) return;
  const body=JSON.stringify(payload);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(body);
}
function fail(res,status,message) {send(res,status,{error:message});}
function readBody(req) {
  return new Promise((resolve,reject)=>{
    let data='', bytes=0;
    req.on('data',chunk=>{bytes+=chunk.length; if (bytes>MAX_BODY) {reject(new Error('درخواست بیش از حد بزرگ است.'));req.destroy();} else data+=chunk;});
    req.on('end',()=>{try {resolve(JSON.parse(data||'{}'));} catch {reject(new Error('اطلاعات نامعتبر است.'));}});
    req.on('error',reject);
  });
}
function auth(query,data) {
  const code=String(data.room||query.get('room')||'').toUpperCase();
  const room=rooms.get(code);
  if (!room) return null;
  const secret=String(data.token||query.get('token')||'');
  const id=playerId(room,secret);
  if (id<0) return null;
  return {room,id};
}
async function api(req,res,url) {
  const route=url.pathname;
  let data={};
  if (req.method==='POST') {
    try {data=await readBody(req);} catch(e) {return fail(res,400,e.message);}
  }
  if (route==='/api/health' && req.method==='GET') return send(res,200,{ok:true,accountsEnabled:accounts.enabled});
  if (route==='/api/account/me' && req.method==='GET') return send(res,200,{enabled:accounts.enabled,user:await accounts.getUser(req)});
  if (route==='/api/leaderboard' && req.method==='GET') return send(res,200,{players:await accounts.leaderboard()});
  if (route==='/api/account/profile' && req.method==='GET') return send(res,200,{profile:await accounts.profile(req)});
  if (route==='/api/account/register' && req.method==='POST') return send(res,201,await accounts.register(req,res,data));
  if (route==='/api/account/login' && req.method==='POST') return send(res,200,await accounts.login(req,res,data));
  if (route==='/api/account/recover' && req.method==='POST') return send(res,200,await accounts.recover(req,res,data));
  if (route==='/api/account/logout' && req.method==='POST') return send(res,200,await accounts.logout(req,res));
  if ((route==='/api/create' || route==='/api/bot/create') && req.method==='POST') {
    if (rooms.size>=MAX_ROOMS) return fail(res,503,'فعلاً اتاق جدید نمی‌توان ساخت.');
    const code=createRoomCode(), secret=token();
    const durationSeconds = [0,60,180].includes(data.durationSeconds) ? data.durationSeconds : 180;
    const hostColor = data.hostColor === 'orange' ? 'orange' : 'cyan';
    const isBot=route==='/api/bot/create';
    const difficulty=['easy','medium','hard'].includes(data.difficulty)?data.difficulty:'medium';
    const ranked=!isBot && data.ranked===true;
    const actor=ranked?await accounts.getUser(req):await accounts.getUser(req).catch(()=>null);
    if(ranked && !actor) return fail(res,403,'برای ساخت مسابقه رنک‌دار باید وارد حساب شوی.');
    const settings = { durationSeconds, hostColor, ranked };
    const participants=[{name:actor?.username||cleanName(data.name),accountId:actor?.id||null,token:secret,listeners:new Set()}];
    if(isBot)participants.push({name:'ربات '+({easy:'آسان',medium:'متوسط',hard:'سخت'}[difficulty]),accountId:null,token:token(),listeners:new Set(),bot:true});
    const room={code,settings,players:participants,bot:isBot?difficulty:null,
      game:initialState(durationSeconds),matchId:crypto.randomUUID(),ratedRecorded:false,recording:false,rematchVotes:new Set(),
      lastActivity:Date.now(),chat:[],chatCounter:0};
    rooms.set(code,room);
    if(isBot)room.game.time.turnStartedAt=Date.now();
    return send(res,201,{room:code,token:secret,state:publicState(room,0)});
  }
  if (route==='/api/join' && req.method==='POST') {
    const code=String(data.room||'').trim().toUpperCase(), room=rooms.get(code);
    if (!room) return fail(res,404,'اتاق پیدا نشد. کد رو بررسی کن.');
    if (room.players.length>=2) return fail(res,409,'این اتاق دو بازیکن دارد و پر شده است.');
    const actor=room.settings.ranked?await accounts.getUser(req):await accounts.getUser(req).catch(()=>null);
    if(room.settings.ranked && !actor) return fail(res,403,'این اتاق رنک‌دار است؛ ابتدا ثبت‌نام یا وارد حساب شو.');
    if(room.settings.ranked && actor.id===room.players[0].accountId) return fail(res,409,'نمی‌توانی با یک حساب در هر دو سمت بازی رنک‌دار باشی.');
    if(room.players.length>=2) return fail(res,409,'اتاق در همین لحظه پر شد.');
    const secret=token();
    room.players.push({name:actor?.username||cleanName(data.name),accountId:actor?.id||null,token:secret,listeners:new Set()});
    room.game.time.turnStartedAt = Date.now(); // No clock runs while waiting for a friend.
    publish(room);
    return send(res,200,{room:code,token:secret,state:publicState(room,1)});
  }
  const session=auth(url.searchParams,data);
  if (!session) return fail(res,401,'دسترسی به اتاق مجاز نیست یا اتاق منقضی شده.');
  const {room,id}=session, s=room.game;
  if (expireIfNeeded(room)) publish(room);
  if (route==='/api/state' && req.method==='GET') return send(res,200,{state:publicState(room,id)});
  if (route==='/api/events' && req.method==='GET') {
    res.writeHead(200,{
      'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-cache, no-transform','Connection':'keep-alive',
      'X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'
    });
    res.write(': connected\n\n');
    room.players[id].listeners.add(res);
    pushToPlayer(room,id);
    req.on('close',()=>room.players[id].listeners.delete(res));
    return;
  }
  if (route==='/api/chat' && req.method==='POST') {
    if (room.bot) return fail(res,409,'چت برای بازی با ربات فعال نیست.');
    if (room.players.length !== 2) return fail(res,409,'چت پس از ورود بازیکن دوم فعال می‌شود.');
    const message = typeof data.message === 'string' ? data.message.trim() : '';
    if (!message || message.length > MAX_CHAT_LENGTH || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(message)) {
      return fail(res,400,'پیام باید بین ۱ تا ۲۸۰ نویسه و بدون نویسه کنترلی باشد.');
    }
    const player=room.players[id], now=Date.now();
    if (player.lastChatAt && now-player.lastChatAt < CHAT_INTERVAL_MS) return fail(res,429,'لطفاً کمی بین پیام‌ها فاصله بگذار.');
    player.lastChatAt=now;
    const item={id:++room.chatCounter,from:id,message,at:now};
    room.chat.push(item);
    if (room.chat.length>CHAT_LIMIT) room.chat.shift();
    publish(room);
    return send(res,200,{ok:true,id:item.id});
  }
  if (route==='/api/restart' && req.method==='POST') {
    if (room.players.length<2) return fail(res,409,'بازیکن دوم هنوز نرسیده.');
    if (s.winner===null) return fail(res,409,'بازی هنوز تمام نشده.');
    if (room.bot) {
      room.game=initialState(room.settings.durationSeconds);room.game.time.turnStartedAt=Date.now();
      room.matchId=crypto.randomUUID();room.rematchVotes.clear();publish(room);
      return send(res,200,{ok:true});
    }
    if(room.settings.ranked){
      const user=await accounts.getUser(req);
      if(!user || user.id!==room.players[id].accountId) return fail(res,401,'برای ادامه مسابقه رنک‌دار وارد حساب خودت شو.');
      if(!room.ratedRecorded && !(await recordResult(room))) return fail(res,503,'نتیجه بازی در دیتابیس ثبت نشده؛ کمی بعد دوباره امتحان کن.');
    }
    room.rematchVotes.add(id);
    publish(room);
    if(room.rematchVotes.size!==2) return send(res,200,{ok:true,pending:true});
    room.game=initialState(room.settings.durationSeconds);
    room.matchId=crypto.randomUUID();room.ratedRecorded=false;room.recording=false;room.rematchVotes.clear();
    room.chat=[];room.chatCounter=0;
    room.game.time.turnStartedAt = Date.now();
    publish(room);
    return send(res,200,{ok:true});
  }
  if (route==='/api/action' && req.method==='POST') {
    if (room.players.length!==2) return fail(res,409,'منتظر بازیکن دوم باشید.');
    if (s.winner!==null) return fail(res,409,'بازی تمام شده است.');
    if (s.turn!==id) return fail(res,409,'هنوز نوبت تو نیست.');
    // Room secrets are bound to a verified account when the ranked room is joined.
    // Avoid a database round-trip on each move: time bonuses rely on server receipt time.
    if (data.type==='move') {
      const r=data.r,c=data.c;
      if (!Number.isInteger(r)||!Number.isInteger(c)||!legalMoves(s,id).some(p=>p.r===r&&p.c===c)) return fail(res,400,'این حرکت مجاز نیست.');
      s.pawns[id]={r,c};
      if (r===(id===0?0:8)) {s.winner=id;s.endReason='goal';}
    } else if (data.type==='wall') {
      if (s.remaining[id]===0) return fail(res,400,'دیوارهای تو تمام شده.');
      const {o,r,c}=data;
      if (!legalWall(s,o,r,c)) return fail(res,400,'اینجا نمی‌شود دیوار گذاشت؛ مسیر دو بازیکن باید باز بماند.');
      s.walls.push({o,r,c,owner:id}); s.remaining[id]--;
    } else return fail(res,400,'عمل ناشناخته است.');
    const now = Date.now();
    settleTurnClock(s,id,now);
    if (s.winner===null) {
      s.turn=1-s.turn;
      s.moveNumber++;
      s.time.turnStartedAt=now;
    } else {
      s.time.turnStartedAt=null;
    }
    publish(room);
    if (room.bot && s.winner===null && s.turn===1) queueBot(room);
    return send(res,200,{ok:true});
  }
  return fail(res,404,'مسیر پیدا نشد.');
}
function queueBot(room) {
  if(!room.bot || room.botPending)return;
  room.botPending=true;
  setTimeout(()=>{
    room.botPending=false;
    const s=room.game;
    if(s.winner!==null || s.turn!==1 || expireIfNeeded(room)) {publish(room);return;}
    try {
      const action=bot.chooseAction(s,room.bot,{legalMoves,legalWall,hasWallBlock});
      if(action.type==='move') {
        s.pawns[1]={r:action.r,c:action.c};
        if(action.r===8){s.winner=1;s.endReason='goal';}
      }else if(action.type==='wall' && s.remaining[1]>0 && legalWall(s,action.o,action.r,action.c)) {
        s.walls.push({o:action.o,r:action.r,c:action.c,owner:1});s.remaining[1]--;
      }else throw new Error('Bot action invalid');
      const now=Date.now();settleTurnClock(s,1,now);
      if(s.winner===null){s.turn=0;s.moveNumber++;s.time.turnStartedAt=now;}
      else s.time.turnStartedAt=null;
      publish(room);
    }catch(err){console.error('Bot turn error:',err);}
  },room.bot==='easy'?650:room.bot==='hard'?520:580).unref?.();
}
function serveStatic(req,res,url) {
  if (req.method!=='GET'&&req.method!=='HEAD') return fail(res,405,'روش درخواست مجاز نیست.');
  let reqPath;
  try {reqPath=decodeURIComponent(url.pathname);} catch {return fail(res,400,'آدرس نامعتبر است.');}
  const file = path.resolve(ROOT, '.' + (reqPath==='/'?'/index.html':reqPath));
  if (!(file===ROOT || file.startsWith(ROOT+path.sep))) return fail(res,403,'دسترسی مجاز نیست.');
  fs.stat(file,(err,stat)=>{
    if (err||!stat.isFile()) return fail(res,404,'صفحه پیدا نشد.');
    const ext=path.extname(file);
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.webmanifest':'application/manifest+json'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    if (req.method==='HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
const server=http.createServer((req,res)=>{
  let url;
  try {url=new URL(req.url, 'http://localhost');} catch {return fail(res,400,'آدرس نامعتبر است.');}
  if (url.pathname.startsWith('/api/')) {api(req,res,url).catch(e=>{
    if(e.status){if(!res.headersSent)fail(res,e.status,e.message);return;}
    console.error('API error:',e);if(!res.headersSent) fail(res,503,'خطای سرور یا اتصال دیتابیس؛ بعداً دوباره تلاش کن.');
  });}
  else serveStatic(req,res,url);
});
setInterval(()=>{
  const now=Date.now();
  for (const [code,room] of rooms) {
    if (expireIfNeeded(room, now)) publish(room);
    if(room.settings.ranked && room.game.winner!==null && !room.ratedRecorded && !room.recording) void recordResult(room);
    if (now-room.lastActivity>1000*60*60*4) {
      for (const p of room.players) for (const res of p.listeners) res.end();
      rooms.delete(code); continue;
    }
    for (const p of room.players) for (const res of p.listeners) {
      try {res.write(': keepalive\n\n');} catch {p.listeners.delete(res);}
    }
  }
},25_000).unref();
// Check deadlines independently of client connections or browser timers.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (expireIfNeeded(room, now)) publish(room);
  }
}, 100).unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`Divarchin listening on http://localhost:${PORT}`));
module.exports={initialState,hasWallBlock,legalWall,legalMoves,reachable,expireIfNeeded,settleTurnClock};
