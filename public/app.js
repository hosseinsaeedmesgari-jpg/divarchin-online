(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = {
    lobby:$('lobby'),game:$('game'),name:$('playerName'),roomInput:$('roomCodeInput'),
    create:$('createBtn'),join:$('joinBtn'),lobbyError:$('lobbyError'),
    gameCode:$('gameCode'),board:$('board'),turnStatus:$('turnStatus'),
    gameError:$('gameError'),copyLink:$('copyLinkBtn'),copyCode:$('copyCodeBtn'),
    inviteNote:$('inviteNote'),winnerOverlay:$('winnerOverlay'),winnerTitle:$('winnerTitle'),winnerText:$('winnerText'),
    rematch:$('rematchBtn'),newRoom:$('newRoomBtn')
  };
  let room='', secret='', state=null, stream=null, mode='move', hover=null, sending=false;
  const ctx=el.board.getContext('2d');
  const W=600, H=600, CELL=50, GAP=10, STEP=CELL+GAP, ORIGIN=(W-(9*CELL+8*GAP))/2;
  const colors={me:'#6af0db', opponent:'#ffb381', grid:'#293d5b', board:'#111e32'};

  function msg(node,message) {node.textContent=message;node.hidden=!message;}
  function name() {return el.name.value.trim().slice(0,18)||'بازیکن';}
  function setBusy(b) {el.create.disabled=b;el.join.disabled=b;}
  async function request(endpoint, body=null) {
    const options=body===null?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
    let response;
    try {response=await fetch(endpoint,options);} catch {throw new Error('اتصال به سرور قطع شده. اینترنتت رو بررسی کن.');}
    let data;
    try {data=await response.json();} catch {throw new Error('پاسخ سرور قابل خواندن نبود.');}
    if (!response.ok) throw new Error(data.error || 'مشکلی پیش آمده.');
    return data;
  }
  function link() {
    const u = new URL(window.location.href);
    u.searchParams.set('room',room);
    return u.toString();
  }
  function setSession(data) {
    room=data.room;secret=data.token;state=data.state;
    sessionStorage.setItem('divarchin-'+room,secret);
    sessionStorage.setItem('divarchin-last',room);
    const url=new URL(location.href);url.searchParams.set('room',room);
    history.replaceState(null,'',url);
    el.lobby.hidden=true;el.game.hidden=false;
    el.gameCode.textContent=room;
    el.winnerOverlay.hidden=true;
    msg(el.lobbyError,'');
    render();
    connect();
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function connect() {
    if(stream) stream.close();
    stream=new EventSource(`/api/events?room=${encodeURIComponent(room)}&token=${encodeURIComponent(secret)}`);
    stream.onmessage=ev=>{
      try {
        const payload=JSON.parse(ev.data);
        if(payload.type==='state') {state=payload.state;render();}
      } catch(err) {console.warn('Bad event',err);}
    };
    stream.onerror=()=>{
      if(!state) return;
      el.turnStatus.textContent='در حال اتصال مجدد به سرور...';
      el.turnStatus.className='turn-status';
    };
  }
  async function create() {
    msg(el.lobbyError,'');setBusy(true);
    try {setSession(await request('/api/create',{name:name()}));}
    catch(err) {msg(el.lobbyError,err.message);} finally {setBusy(false);}
  }
  async function join() {
    const code=el.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g,'').trim();
    if(code.length!==6) {msg(el.lobbyError,'کد اتاق باید ۶ کاراکتر باشه.');return;}
    msg(el.lobbyError,'');setBusy(true);
    try {setSession(await request('/api/join',{room:code,name:name()}));}
    catch(err) {msg(el.lobbyError,err.message);} finally {setBusy(false);}
  }
  function isMyTurn() {return !!state && !state.waiting && state.winner===null && state.turn===state.you;}
  function updateModeButtons() {
    document.querySelectorAll('[data-mode]').forEach(btn=>{
      const candidate=btn.dataset.mode;
      btn.classList.toggle('selected',candidate===mode);
      btn.disabled=!!state && candidate!=='move' && state.remaining[state.you]===0;
    });
  }
  function render() {
    if(!state)return;
    state.players.forEach((p,id)=>{
      $(id===0?'player0Name':'player1Name').textContent=p.name+(id===state.you?' (تو)':'');
    });
    if(state.players.length<2) $('player1Name').textContent='منتظر دوستت...';
    $('player0Walls').textContent=state.remaining[0]+' 🧱';
    $('player1Walls').textContent=state.remaining[1]+' 🧱';
    $('player0').classList.toggle('active',!state.waiting && state.winner===null && state.turn===0);
    $('player1').classList.toggle('active',!state.waiting && state.winner===null && state.turn===1);
    el.turnStatus.className='turn-status';
    if(state.waiting) el.turnStatus.textContent='⏳ منتظر دوستت هستیم؛ لینک دعوت رو براش بفرست!';
    else if(state.winner!==null) el.turnStatus.textContent=state.winner===state.you?'🏆 برنده شدی!':'🎯 بازی تموم شد!';
    else if(isMyTurn()) {el.turnStatus.textContent='✨ نوبت توئه! حرکت کن یا دیوار بذار';el.turnStatus.classList.add('mine');}
    else {el.turnStatus.textContent=`⏳ نوبت ${state.players[state.turn].name} ـه`;el.turnStatus.classList.add('opponent');}
    if(state.remaining[state.you]===0 && mode!=='move') {mode='move';hover=null;}
    updateModeButtons();
    el.winnerOverlay.hidden=state.winner===null;
    if(state.winner!==null) {
      const win=state.winner===state.you;
      el.winnerTitle.textContent=win?'بردی! آفرین 🎉':'این دفعه دوستت برد!';
      el.winnerText.textContent=win?'زودتر از حریفت به اون طرف صفحه رسیدی.':'یه دست دیگه بازی کن و جبران کن!';
    }
    draw();
  }
  function roundRect(x,y,w,h,r,fill,stroke) {
    ctx.beginPath();ctx.roundRect(x,y,w,h,r);
    if(fill) {ctx.fillStyle=fill;ctx.fill();}
    if(stroke) {ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke();}
  }
  function pawn(x,y,fill,label) {
    ctx.save();
    ctx.shadowColor=fill;ctx.shadowBlur=19;
    ctx.fillStyle=fill;ctx.beginPath();ctx.arc(x,y,19,0,Math.PI*2);ctx.fill();
    ctx.shadowBlur=0;ctx.strokeStyle='#ffffffa8';ctx.lineWidth=3;ctx.stroke();
    ctx.fillStyle='#142233';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold 16px Tahoma,sans-serif';ctx.fillText(label,x,y+1);
    ctx.restore();
  }
  function wallRect(o,r,c) {
    if(o==='h') return {x:ORIGIN+c*STEP-2,y:ORIGIN+r*STEP+CELL+1,w:2*CELL+GAP+4,h:GAP-2};
    return {x:ORIGIN+c*STEP+CELL+1,y:ORIGIN+r*STEP-2,w:GAP-2,h:2*CELL+GAP+4};
  }
  function draw() {
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#0c172c';ctx.fillRect(0,0,W,H);
    roundRect(ORIGIN-9,ORIGIN-9,9*CELL+8*GAP+18,9*CELL+8*GAP+18,18,'#283451','#3c506d');
    for(let r=0;r<9;r++) for(let c=0;c<9;c++) {
      let cell=r===0?'#1f393f':r===8?'#45342f':'#1b2940';
      roundRect(ORIGIN+c*STEP,ORIGIN+r*STEP,CELL,CELL,5,cell);
    }
    if(state) {
      if(isMyTurn()&&mode==='move') for(const p of state.legalMoves) {
        const x=ORIGIN+p.c*STEP+CELL/2,y=ORIGIN+p.r*STEP+CELL/2;
        ctx.fillStyle='#78eedba6';ctx.beginPath();ctx.arc(x,y,11,0,Math.PI*2);ctx.fill();
        ctx.strokeStyle='#a6fff2';ctx.lineWidth=2;ctx.stroke();
      }
      for(const w of state.walls) {
        const a=wallRect(w.o,w.r,w.c);
        ctx.save();ctx.shadowColor='#aa90ff77';ctx.shadowBlur=9;
        roundRect(a.x,a.y,a.w,a.h,3,'#b39af9');ctx.restore();
      }
      if(hover && isMyTurn() && mode!=='move' && state.remaining[state.you]>0) {
        const a=wallRect(mode,hover.r,hover.c);
        ctx.save();ctx.globalAlpha=.7;roundRect(a.x,a.y,a.w,a.h,3,'#60e6d5');ctx.restore();
      }
      for(let i=0;i<state.pawns.length;i++) {
        const p=state.pawns[i];pawn(ORIGIN+p.c*STEP+CELL/2,ORIGIN+p.r*STEP+CELL/2,i===0?colors.me:colors.opponent,i+1);
      }
      if(state.waiting) {
        roundRect(130,258,340,83,15,'#142b3aea','#537d8b');
        ctx.fillStyle='#ffffff';ctx.textAlign='center';ctx.font='bold 19px Tahoma,sans-serif';ctx.fillText('منتظر بازیکن دوم...',300,305);
      }
    }
  }
  function canvasCoords(ev) {
    const box=el.board.getBoundingClientRect();
    return {x:(ev.clientX-box.left)*W/box.width,y:(ev.clientY-box.top)*H/box.height};
  }
  function candidateWall(p,o) {
    let best=null,dist=Infinity;
    for(let r=0;r<8;r++)for(let c=0;c<8;c++) {
      const a=wallRect(o,r,c), mx=a.x+a.w/2,my=a.y+a.h/2;
      const d=(mx-p.x)**2+(my-p.y)**2;
      if(d<dist){dist=d;best={r,c};}
    }
    return best;
  }
  async function action(payload) {
    if(sending)return;
    if(!isMyTurn()) {msg(el.gameError,state.waiting?'منتظر بازیکن دوم باش.':'الان نوبت تو نیست.');return;}
    sending=true;msg(el.gameError,'');
    try {await request('/api/action',{...payload,room,token:secret});}
    catch(err){msg(el.gameError,err.message);}finally{sending=false;}
  }
  el.board.addEventListener('pointermove',ev=>{
    if(!state||mode==='move'||!isMyTurn())return;
    hover=candidateWall(canvasCoords(ev),mode);draw();
  });
  el.board.addEventListener('pointerleave',()=>{hover=null;draw();});
  el.board.addEventListener('click',ev=>{
    if(!state||!isMyTurn())return;
    const p=canvasCoords(ev);
    if(mode==='move') {
      const c=Math.round((p.x-ORIGIN-CELL/2)/STEP),r=Math.round((p.y-ORIGIN-CELL/2)/STEP);
      if(r<0||r>8||c<0||c>8)return;
      if(!state.legalMoves.some(q=>q.r===r&&q.c===c)) {msg(el.gameError,'فقط می‌تونی به خونه‌های مشخص‌شده حرکت کنی.');return;}
      action({type:'move',r,c});
    } else {
      const place=candidateWall(p,mode);
      action({type:'wall',o:mode,r:place.r,c:place.c});
    }
  });
  document.querySelectorAll('[data-mode]').forEach(btn=>btn.addEventListener('click',()=>{
    mode=btn.dataset.mode;hover=null;msg(el.gameError,'');updateModeButtons();draw();
  }));
  async function copy(text,success) {
    try {
      if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const t=document.createElement('textarea');t.value=text;t.style.position='fixed';t.style.opacity='0';document.body.appendChild(t);t.select();
        if(!document.execCommand('copy'))throw new Error('copy blocked');
        t.remove();
      }
      el.inviteNote.textContent=success;
    } catch {el.inviteNote.textContent='کپی خودکار نشد؛ کد اتاق رو به دوستت بگو: '+room;}
  }
  el.copyLink.addEventListener('click',()=>copy(link(),'لینک دعوت کپی شد ✓'));
  el.copyCode.addEventListener('click',()=>copy(room,'کد اتاق کپی شد ✓'));
  el.create.addEventListener('click',create);el.join.addEventListener('click',join);
  el.roomInput.addEventListener('keydown',ev=>{if(ev.key==='Enter')join();});
  el.name.addEventListener('keydown',ev=>{if(ev.key==='Enter')create();});
  el.rematch.addEventListener('click',async()=>{
    el.rematch.disabled=true;
    try {await request('/api/restart',{room,token:secret});msg(el.gameError,'');}
    catch(err){msg(el.gameError,err.message);}finally{el.rematch.disabled=false;}
  });
  el.newRoom.addEventListener('click',()=>{
    if(stream)stream.close();stream=null;
    room='';secret='';state=null;mode='move';hover=null;
    sessionStorage.removeItem('divarchin-last');
    history.replaceState(null,'',location.pathname);
    el.lobby.hidden=false;el.game.hidden=true;el.winnerOverlay.hidden=true;
    msg(el.gameError,'');el.inviteNote.textContent='';
    window.scrollTo({top:0,behavior:'smooth'});
  });
  async function init() {
    const code=(new URL(location.href)).searchParams.get('room')||sessionStorage.getItem('divarchin-last');
    if(!code) {draw();return;}
    const normalized=code.toUpperCase();el.roomInput.value=normalized;
    const saved=sessionStorage.getItem('divarchin-'+normalized);
    if(saved) {
      try {
        const data=await request(`/api/state?room=${encodeURIComponent(normalized)}&token=${encodeURIComponent(saved)}`);
        setSession({room:normalized,token:saved,state:data.state});return;
      } catch {sessionStorage.removeItem('divarchin-'+normalized);sessionStorage.removeItem('divarchin-last');}
    }
    draw();
  }
  init();
})();
