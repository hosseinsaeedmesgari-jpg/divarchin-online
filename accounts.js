'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {promisify} = require('node:util');
const scrypt = promisify(crypto.scrypt);
const enabled = Boolean(process.env.DATABASE_URL);
const {Pool} = enabled ? require('pg') : {Pool:null};
// Download the project's root CA from Supabase Dashboard > Database Settings > SSL Configuration.
// Place it next to this file as supabase-ca.crt (PEM format).
const caFile = path.join(__dirname, 'supabase-ca.crt');
function verifiedConnectionString(value) {
  const u = new URL(value);
  // node-postgres replaces the SSL object if any SSL parameters occur in the URI.
  // We configure verified TLS explicitly below, instead of trusting URI SSL options.
  ['sslmode','sslcert','sslkey','sslrootcert'].forEach(k => u.searchParams.delete(k));
  return u.toString();
}
if (enabled && !fs.existsSync(caFile)) {
  console.error('Supabase TLS: missing supabase-ca.crt. Download the CA certificate from your Supabase project.');
}
const pool = enabled ? new Pool({
  connectionString: verifiedConnectionString(process.env.DATABASE_URL),
  max:5,
  idleTimeoutMillis:20_000,
  connectionTimeoutMillis:8_000,
  ssl: {
    rejectUnauthorized: true,
    // No insecure fallback: without the cert the OS trust store will be used,
    // which may reject Supabase's private CA until the cert is installed.
    ...(fs.existsSync(caFile) ? {ca: fs.readFileSync(caFile, 'utf8')} : {})
  }
}) : null;
if (pool) pool.on('error',e=>console.error('Postgres connection error:',e.message));
const COOKIE='divarchin_session';
const SESSION_DAYS=30;
const DUMMY_SALT='096e8c1712330d11d96450b77887c649';
const DEFAULT_HASH='ab'.repeat(64);
const attempts=new Map();
function AppError(status,message){const e=new Error(message);e.status=status;return e;}
function digest(t) {return crypto.createHash('sha256').update(t,'utf8').digest('hex');}
function freshSecret() {return crypto.randomBytes(32).toString('base64url');}
function validUsername(x){
  if (typeof x !== 'string') return '';
  const name=x.trim().normalize('NFC');
  return name.length>=3 && name.length<=24 && /^[\p{L}\p{N}_.]+$/u.test(name) ? name : '';
}
function validPassword(x){return typeof x==='string'&&x.length>=8&&x.length<=128&&Buffer.byteLength(x,'utf8')<=256;}
function recoveryCode(){return crypto.randomBytes(24).toString('hex').toUpperCase().match(/.{1,8}/g).join('-');}
function normalizeRecoveryCode(x){return typeof x==='string'?x.toUpperCase().replace(/[-\s]/g,''):'';}
function cookieToken(req){
  const cookie=req.headers.cookie||'';
  const match=cookie.match(/(?:^|;\s*)divarchin_session=([^;]*)/);
  return match && /^[A-Za-z0-9_-]{30,100}$/.test(match[1])?match[1]:null;
}
function cookieHeader(req,token){
  // Render terminates HTTPS before Node. Local HTTP tests can still use the cookie.
  const secure=(process.env.NODE_ENV==='production' || process.env.RENDER==='true' || req.headers['x-forwarded-proto']==='https')?'; Secure':'';
  return `${COOKIE}=${token||''}; HttpOnly; SameSite=Lax; Path=/; ${token?`Max-Age=${SESSION_DAYS*86400}`:'Max-Age=0'}${secure}`;
}
function rate(req,key,max=10,periodMs=15*60*1000){
  // Untrusted X-Forwarded-For is intentionally ignored; use socket peer IP.
  // Behind a proxy this might bucket multiple users together; a managed edge limiter
  // is recommended before large-scale public release.
  const ip=req.socket?.remoteAddress||'unknown';
  const id=key+':'+ip;const now=Date.now();
  const item=attempts.get(id);
  if(!item||now>item.reset){attempts.set(id,{count:1,reset:now+periodMs});return;}
  item.count++;
  if(item.count>max)throw AppError(429,'تلاش‌های زیادی انجام شده. لطفاً چند دقیقه بعد دوباره امتحان کن.');
}
setInterval(()=>{const now=Date.now();for(const [k,v] of attempts) if(v.reset<now) attempts.delete(k);},300_000).unref();
async function hashPassword(pass,salt){return (await scrypt(pass,Buffer.from(salt,'hex'),64,{N:16384,r:8,p:1,maxmem:32*1024*1024})).toString('hex');}
function constantMatch(a,b){const ba=Buffer.from(a||'','hex'),bb=Buffer.from(b||'','hex');return ba.length===bb.length&&crypto.timingSafeEqual(ba,bb);}
async function verifyPassword(pass,salt,stored){const actual=await hashPassword(pass,salt);return constantMatch(actual,stored);}
function checkEnabled(){if(!enabled)throw AppError(503,'ثبت‌نام و رنکینگ هنوز فعال نشده‌اند؛ باید دیتابیس به سرور وصل شود.');}
function publicUser(row){return row?{id:row.id,username:row.username,rating:row.rating,wins:row.wins,losses:row.losses}:null;}
async function getUser(req){
  if(!enabled)return null;
  const token=cookieToken(req);if(!token)return null;
  const {rows}=await pool.query(`SELECT u.id,u.username,u.rating,u.wins,u.losses FROM divarchin_sessions s JOIN divarchin_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`,[digest(token)]);
  return publicUser(rows[0]);
}
async function issueSession(req,res,userId,client=pool){
  const raw=freshSecret();
  await client.query(`INSERT INTO divarchin_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')`,[digest(raw),userId]);
  res.setHeader('Set-Cookie',cookieHeader(req,raw));
}
async function register(req,res,data){
  checkEnabled();rate(req,'register',7,60*60*1000);
  const username=validUsername(data.username);
  if(!username)throw AppError(400,'نام کاربری باید ۳ تا ۲۴ حرف یا عدد یا _ یا نقطه باشد.');
  if(!validPassword(data.password))throw AppError(400,'رمز باید ۸ تا ۱۲۸ کاراکتر باشد.');
  const salt=crypto.randomBytes(16).toString('hex');
  const passHash=await hashPassword(data.password,salt);
  const code=recoveryCode();const id=crypto.randomUUID();
  try{
    await pool.query(`INSERT INTO divarchin_users(id,username,password_salt,password_hash,recovery_hash) VALUES($1,$2,$3,$4,$5)`,[id,username,salt,passHash,digest(normalizeRecoveryCode(code))]);
  }catch(e){if(e.code==='23505')throw AppError(409,'این نام کاربری قبلاً گرفته شده.');throw e;}
  await issueSession(req,res,id);
  return {user:{id,username,rating:1000,wins:0,losses:0},recoveryCode:code};
}
async function login(req,res,data){
  checkEnabled();rate(req,'login',15);
  const username=validUsername(data.username), password=data.password;
  if(!username || typeof password!=='string' || password.length>128)throw AppError(401,'نام کاربری یا رمز عبور اشتباه است.');
  const {rows}=await pool.query(`SELECT * FROM divarchin_users WHERE LOWER(username)=LOWER($1)`,[username]);
  const user=rows[0];
  const ok=await verifyPassword(password,user?.password_salt||DUMMY_SALT,user?.password_hash||DEFAULT_HASH);
  if(!user||!ok)throw AppError(401,'نام کاربری یا رمز عبور اشتباه است.');
  await issueSession(req,res,user.id);
  return {user:publicUser(user)};
}
async function recover(req,res,data){
  checkEnabled();rate(req,'recover',7,60*60*1000);
  const username=validUsername(data.username);
  const code=normalizeRecoveryCode(data.recoveryCode);
  if(!username|| !/^[0-9A-F]{48}$/.test(code)||!validPassword(data.password))throw AppError(400,'نام کاربری، کد بازیابی یا رمز جدید نامعتبر است.');
  const nextSalt=crypto.randomBytes(16).toString('hex');
  const nextHash=await hashPassword(data.password,nextSalt);
  const nextCode=recoveryCode();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const {rows}=await client.query(`SELECT * FROM divarchin_users WHERE LOWER(username)=LOWER($1) FOR UPDATE`,[username]);
    const user=rows[0];
    if(!user||!constantMatch(digest(code),user.recovery_hash))throw AppError(401,'اطلاعات بازیابی اشتباه است.');
    await client.query(`UPDATE divarchin_users SET password_salt=$1,password_hash=$2,recovery_hash=$3 WHERE id=$4`,[nextSalt,nextHash,digest(normalizeRecoveryCode(nextCode)),user.id]);
    await client.query(`DELETE FROM divarchin_sessions WHERE user_id=$1`,[user.id]);
    await issueSession(req,res,user.id,client);
    await client.query('COMMIT');
    return {user:publicUser(user),recoveryCode:nextCode};
  }catch(e){await client.query('ROLLBACK');res.removeHeader('Set-Cookie');throw e;}
  finally{client.release();}
}
async function logout(req,res){
  if(enabled){const raw=cookieToken(req);if(raw)await pool.query('DELETE FROM divarchin_sessions WHERE token_hash=$1',[digest(raw)]);}
  res.setHeader('Set-Cookie',cookieHeader(req,''));return {ok:true};
}
async function leaderboard(){
  checkEnabled();
  const {rows}=await pool.query(`SELECT id,username,rating,wins,losses FROM divarchin_users WHERE wins+losses>0 ORDER BY rating DESC,wins DESC,id ASC LIMIT 50`);
  return rows.map(publicUser);
}
async function profile(req){
  checkEnabled();
  const user=await getUser(req);
  if(!user)throw AppError(401,'برای مشاهده پروفایل باید وارد حساب خودت شوی.');
  // Only query results produced by the server's ranked-match transaction.
  const {rows}=await pool.query(`
    SELECT m.id,m.played_at,m.reason,m.duration_seconds,m.winner,
      CASE WHEN m.player0=$1 THEN p1.username ELSE p0.username END AS opponent
    FROM divarchin_matches m
    JOIN divarchin_users p0 ON p0.id=m.player0
    JOIN divarchin_users p1 ON p1.id=m.player1
    WHERE m.player0=$1 OR m.player1=$1
    ORDER BY m.played_at DESC,m.id DESC`,[user.id]);
  let streak=0,bestStreak=0;
  for (let i=rows.length-1;i>=0;i--) {
    streak=rows[i].winner===user.id ? streak+1:0;
    bestStreak=Math.max(bestStreak,streak);
  }
  const total=user.wins+user.losses;
  const history=rows.slice(0,30).map(row=>({id:row.id,at:row.played_at,opponent:row.opponent,won:row.winner===user.id,reason:row.reason,durationSeconds:row.duration_seconds}));
  const above=await pool.query(`SELECT COUNT(*)::int AS n FROM divarchin_users WHERE wins+losses>0 AND (rating>$1 OR (rating=$1 AND wins>$2))`,[user.rating,user.wins]);
  return {...user,total,winRate:total?Math.round(user.wins*1000/total)/10:0,currentStreak:streak,bestStreak,rank:total?above.rows[0].n+1:null,history};
}
async function saveRankedMatch(match){
  checkEnabled();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Stable lock ordering avoids deadlocks between matches involving shared users.
    const {rows}=await client.query(`SELECT id,rating FROM divarchin_users WHERE id=$1 OR id=$2 ORDER BY id FOR UPDATE`,[match.ids[0],match.ids[1]]);
    if(rows.length!==2)throw new Error('Ranked participants no longer exist');
    const insert=await client.query(`INSERT INTO divarchin_matches(id,room_code,player0,player1,winner,reason,duration_seconds) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [match.id,match.room,match.ids[0],match.ids[1],match.ids[match.winner],match.reason,match.duration]);
    if(!insert.rowCount){await client.query('COMMIT');return false;}
    const a=rows.find(r=>r.id===match.ids[0]).rating, b=rows.find(r=>r.id===match.ids[1]).rating;
    const expectedA=1/(1+Math.pow(10,(b-a)/400));
    const delta=Math.max(1,Math.round(24*(match.winner===0 ? (1-expectedA) : expectedA)));
    for(let id=0;id<2;id++){
      const win=id===match.winner;
      const change=win?delta:-delta;
      await client.query(`UPDATE divarchin_users SET rating=GREATEST(0,rating+$1), wins=wins+$2, losses=losses+$3 WHERE id=$4`,[change,win?1:0,win?0:1,match.ids[id]]);
    }
    await client.query('COMMIT');return true;
  }catch(e){await client.query('ROLLBACK');throw e;}
  finally{client.release();}
}
module.exports={enabled,getUser,register,login,recover,logout,leaderboard,profile,saveRankedMatch,AppError,validUsername,validPassword,normalizeRecoveryCode,hashPassword,verifyPassword,digest,recoveryCode};
