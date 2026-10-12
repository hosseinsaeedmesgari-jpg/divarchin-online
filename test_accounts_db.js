'use strict';
// Simulated PostgreSQL query layer; does NOT replace a live Supabase smoke test.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const Module=require('node:module');
process.env.DATABASE_URL='postgresql://demo:pass@127.0.0.1/db';
process.env.PGSSLMODE='disable';
const users=new Map(), sessions=new Map(), matches=new Set(), matchData=[];
class FakePool {
  on(){}
  async connect(){return {query:this.query.bind(this),release(){}};}
  async query(sql,p=[]){
    const q=sql.trim().replace(/\s+/g,' ').toUpperCase();
    const out=(rows=[],rowCount=rows.length)=>({rows,rowCount});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(q))return out();
    if(q.startsWith('INSERT INTO DIVARCHIN_USERS')){
      if([...users.values()].some(u=>u.username.toLowerCase()===p[1].toLowerCase())){const e=new Error('duplicate');e.code='23505';throw e;}
      users.set(p[0],{id:p[0],username:p[1],password_salt:p[2],password_hash:p[3],recovery_hash:p[4],rating:1000,wins:0,losses:0});return out([],1);
    }
    if(q.startsWith('INSERT INTO DIVARCHIN_SESSIONS')){sessions.set(p[0],p[1]);return out([],1);}
    if(q.startsWith('SELECT U.ID,U.USERNAME')) {const id=sessions.get(p[0]);return out(id?[users.get(id)]:[]);}
    if(q.startsWith('SELECT * FROM DIVARCHIN_USERS WHERE LOWER'))return out([...users.values()].filter(u=>u.username.toLowerCase()===p[0].toLowerCase()));
    if(q.startsWith('DELETE FROM DIVARCHIN_SESSIONS WHERE USER_ID')){for(const [k,v] of sessions)if(v===p[0])sessions.delete(k);return out();}
    if(q.startsWith('DELETE FROM DIVARCHIN_SESSIONS WHERE TOKEN_HASH')){sessions.delete(p[0]);return out();}
    if(q.startsWith('UPDATE DIVARCHIN_USERS SET PASSWORD')){const u=users.get(p[3]);Object.assign(u,{password_salt:p[0],password_hash:p[1],recovery_hash:p[2]});return out();}
    if(q.startsWith('SELECT ID,RATING FROM DIVARCHIN_USERS'))return out([users.get(p[0]),users.get(p[1])].sort((a,b)=>a.id.localeCompare(b.id)));
    if(q.startsWith('INSERT INTO DIVARCHIN_MATCHES')){if(matches.has(p[0]))return out([],0);matches.add(p[0]);matchData.push({id:p[0],room_code:p[1],player0:p[2],player1:p[3],winner:p[4],reason:p[5],duration_seconds:p[6],played_at:new Date()});return out([{id:p[0]}]);}
    if(q.startsWith('UPDATE DIVARCHIN_USERS SET RATING')){const u=users.get(p[3]);u.rating=Math.max(0,u.rating+p[0]);u.wins+=p[1];u.losses+=p[2];return out([],1);}
    if(q.startsWith('SELECT ID,USERNAME,RATING,WINS,LOSSES FROM DIVARCHIN_USERS'))return out([...users.values()].filter(u=>u.wins+u.losses>0).sort((a,b)=>b.rating-a.rating));
    if(q.startsWith('SELECT M.ID,M.PLAYED_AT'))return out(matchData.filter(m=>m.player0===p[0]||m.player1===p[0]).map(m=>({...m,opponent:users.get(m.player0===p[0]?m.player1:m.player0).username})));
    if(q.startsWith('SELECT COUNT(*)::INT AS N'))return out([{n:[...users.values()].filter(u=>(u.wins+u.losses)>0&&(u.rating>p[0]||(u.rating===p[0]&&u.wins>p[1]))).length}]);
    throw new Error('unmocked SQL: '+sql);
  }
}
const native=Module._load;
Module._load=function(name,par,main){if(name==='pg')return {Pool:FakePool};return native.apply(this,arguments);};
const accounts=require('./accounts');Module._load=native;
function req(cookie=''){return {headers:{cookie,'x-forwarded-proto':'https'},socket:{remoteAddress:'user-'+crypto.randomBytes(4).toString('hex')}};}
function res(){const hdr={};return {setHeader(k,v){hdr[k]=v;},removeHeader(k){delete hdr[k];},getCookie(){return hdr['Set-Cookie']?.split(';')[0]||'';}};}
(async()=>{
  let r=res();const first=await accounts.register(req(),r,{username:'PlayerOne',password:'abcdefgh123'});
  const cookie1=r.getCookie();assert.ok(cookie1.startsWith('divarchin_session='));
  assert.ok(first.recoveryCode);
  assert.equal((await accounts.getUser(req(cookie1))).id,first.user.id);
  let sec=res();const second=await accounts.register(req(),sec,{username:'بازیکن_۲',password:'abcdefgh456'});
  assert.notEqual(first.user.id,second.user.id);
  assert.ok(await accounts.login(req(),res(),{username:'PlayerOne',password:'abcdefgh123'}));
  await assert.rejects(()=>accounts.login(req(),res(),{username:'PlayerOne',password:'WRONGPASS'}),e=>e.status===401);
  await assert.rejects(()=>accounts.register(req(),res(),{username:'playerone',password:'abcdefgh789'}),e=>e.status===409);
  const id=crypto.randomUUID();
  const match={id,room:'AA1111',ids:[first.user.id,second.user.id],winner:0,reason:'goal',duration:60};
  assert.equal(await accounts.saveRankedMatch(match),true);
  assert.equal(await accounts.saveRankedMatch(match),false);
  const scores=await accounts.leaderboard();
  assert.equal(scores.length,2);assert.equal(scores[0].wins,1);assert.equal(scores[1].losses,1);
  assert.equal(scores[0].rating+scores[1].rating,2000);
  const prof=await accounts.profile(req(cookie1));
  assert.equal(prof.total,1);assert.equal(prof.winRate,100);assert.equal(prof.bestStreak,1);assert.equal(prof.history[0].won,true);
  await assert.rejects(()=>accounts.profile(req()),e=>e.status===401);
  const replacement=await accounts.recover(req(),res(),{username:'PlayerOne',recoveryCode:first.recoveryCode,password:'newsecurepass111'});
  assert.ok(replacement.recoveryCode!==first.recoveryCode);
  assert.equal(await accounts.getUser(req(cookie1)),null);
  await assert.rejects(()=>accounts.recover(req(),res(),{username:'PlayerOne',recoveryCode:first.recoveryCode,password:'newsecurepass123'}),e=>e.status===401);
  console.log('PASS: mocked-db registration, login, duplicate protection, ranked Elo/idempotence, recovery and session revocation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
