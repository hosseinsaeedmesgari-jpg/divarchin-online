'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, 'public');
const rooms = new Map();
const SIDES = ['بالا', 'پایین'];
const MAX_BODY = 16 * 1024;
const MAX_ROOMS = 3000;

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
function initialState() {
  return {
    pawns: [{ r: 8, c: 4 }, { r: 0, c: 4 }],
    walls: [], remaining: [10, 10], turn: 0, winner: null,
    moveNumber: 1, startedAt: Date.now()
  };
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
    players: room.players.map((p,i)=>({id:i,name:p.name,side:SIDES[i]})),
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
function publish(room) {
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
  if (route==='/api/health' && req.method==='GET') return send(res,200,{ok:true});
  if (route==='/api/create' && req.method==='POST') {
    if (rooms.size>=MAX_ROOMS) return fail(res,503,'فعلاً اتاق جدید نمی‌توان ساخت.');
    const code=createRoomCode(), secret=token();
    const room={code,players:[{name:cleanName(data.name),token:secret,listeners:new Set()}],game:initialState(),lastActivity:Date.now()};
    rooms.set(code,room);
    return send(res,201,{room:code,token:secret,state:publicState(room,0)});
  }
  if (route==='/api/join' && req.method==='POST') {
    const code=String(data.room||'').trim().toUpperCase(), room=rooms.get(code);
    if (!room) return fail(res,404,'اتاق پیدا نشد. کد رو بررسی کن.');
    if (room.players.length>=2) return fail(res,409,'این اتاق دو بازیکن دارد و پر شده است.');
    const secret=token();
    room.players.push({name:cleanName(data.name),token:secret,listeners:new Set()});
    publish(room);
    return send(res,200,{room:code,token:secret,state:publicState(room,1)});
  }
  const session=auth(url.searchParams,data);
  if (!session) return fail(res,401,'دسترسی به اتاق مجاز نیست یا اتاق منقضی شده.');
  const {room,id}=session, s=room.game;
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
  if (route==='/api/restart' && req.method==='POST') {
    if (room.players.length<2) return fail(res,409,'بازیکن دوم هنوز نرسیده.');
    if (s.winner===null) return fail(res,409,'بازی هنوز تمام نشده.');
    room.game=initialState();
    publish(room);
    return send(res,200,{ok:true});
  }
  if (route==='/api/action' && req.method==='POST') {
    if (room.players.length!==2) return fail(res,409,'منتظر بازیکن دوم باشید.');
    if (s.winner!==null) return fail(res,409,'بازی تمام شده است.');
    if (s.turn!==id) return fail(res,409,'هنوز نوبت تو نیست.');
    if (data.type==='move') {
      const r=data.r,c=data.c;
      if (!Number.isInteger(r)||!Number.isInteger(c)||!legalMoves(s,id).some(p=>p.r===r&&p.c===c)) return fail(res,400,'این حرکت مجاز نیست.');
      s.pawns[id]={r,c};
      if (r===(id===0?0:8)) s.winner=id;
    } else if (data.type==='wall') {
      if (s.remaining[id]===0) return fail(res,400,'دیوارهای تو تمام شده.');
      const {o,r,c}=data;
      if (!legalWall(s,o,r,c)) return fail(res,400,'اینجا نمی‌شود دیوار گذاشت؛ مسیر دو بازیکن باید باز بماند.');
      s.walls.push({o,r,c}); s.remaining[id]--;
    } else return fail(res,400,'عمل ناشناخته است.');
    if (s.winner===null) { s.turn=1-s.turn; s.moveNumber++; }
    publish(room);
    return send(res,200,{ok:true});
  }
  return fail(res,404,'مسیر پیدا نشد.');
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
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff'});
    if (req.method==='HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
const server=http.createServer((req,res)=>{
  let url;
  try {url=new URL(req.url, 'http://localhost');} catch {return fail(res,400,'آدرس نامعتبر است.');}
  if (url.pathname.startsWith('/api/')) {api(req,res,url).catch(e=>{console.error(e);if(!res.headersSent) fail(res,500,'خطای داخلی سرور.');});}
  else serveStatic(req,res,url);
});
setInterval(()=>{
  const now=Date.now();
  for (const [code,room] of rooms) {
    if (now-room.lastActivity>1000*60*60*4) {
      for (const p of room.players) for (const res of p.listeners) res.end();
      rooms.delete(code); continue;
    }
    for (const p of room.players) for (const res of p.listeners) {
      try {res.write(': keepalive\n\n');} catch {p.listeners.delete(res);}
    }
  }
},25_000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`Divarchin listening on http://localhost:${PORT}`));
module.exports={initialState,hasWallBlock,legalWall,legalMoves,reachable};
