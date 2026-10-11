(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = {
    lobby:$('lobby'),game:$('game'),name:$('playerName'),roomInput:$('roomCodeInput'),
    create:$('createBtn'),join:$('joinBtn'),lobbyError:$('lobbyError'),
    gameCode:$('gameCode'),gameDuration:$('gameDuration'),board:$('board'),turnStatus:$('turnStatus'),
    gameError:$('gameError'),copyLink:$('copyLinkBtn'),copyCode:$('copyCodeBtn'),
    inviteNote:$('inviteNote'),winnerOverlay:$('winnerOverlay'),winnerTitle:$('winnerTitle'),winnerText:$('winnerText'),
    rematch:$('rematchBtn'),newRoom:$('newRoomBtn'),
    previewControls:$('wallPreviewControls'),previewHelp:$('previewHelp'),
    confirmWall:$('confirmWallBtn'),cancelWall:$('cancelWallBtn')
  };
  let room='', secret='', state=null, stream=null, mode='move', hover=null, selectedWall=null;
  let sending=false, pointerKind='mouse', touchingWall=false, clockReceivedAt=0, lastMoveNumber=-1;
  const ctx=el.board.getContext('2d');
  const W=600, H=600, CELL=50, GAP=10, STEP=CELL+GAP, ORIGIN=(W-(9*CELL+8*GAP))/2;
  const colors={cyan:'#6af0db', orange:'#ffb381'};
  const colorName={cyan:'فیروزه‌ای',orange:'نارنجی'};
  const coarsePointer=window.matchMedia('(pointer: coarse)').matches;

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
    const u=new URL(window.location.href);
    u.searchParams.set('room',room);
    return u.toString();
  }
  function acceptState(next) {
    if (!state || next.moveNumber !== lastMoveNumber || next.winner !== null || next.turn !== next.you) {
      selectedWall=null;
      hover=null;
    }
    state=next;
    clockReceivedAt=performance.now();
    lastMoveNumber=next.moveNumber;
    render();
  }
  function setSession(data) {
    room=data.room;secret=data.token;
    sessionStorage.setItem('divarchin-'+room,secret);
    sessionStorage.setItem('divarchin-last',room);
    const url=new URL(location.href);url.searchParams.set('room',room);
    history.replaceState(null,'',url);
    el.lobby.hidden=true;el.game.hidden=false;
    el.gameCode.textContent=room;
    el.winnerOverlay.hidden=true;
    msg(el.lobbyError,'');
    acceptState(data.state);
    connect();
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function connect() {
    if (stream) stream.close();
    stream=new EventSource(`/api/events?room=${encodeURIComponent(room)}&token=${encodeURIComponent(secret)}`);
    stream.onmessage=ev=>{
      try {
        const payload=JSON.parse(ev.data);
        if(payload.type==='state') acceptState(payload.state);
      } catch(err) {console.warn('Bad event',err);}
    };
    stream.onerror=()=>{
      if (!state) return;
      el.turnStatus.textContent='در حال اتصال مجدد به سرور...';
      el.turnStatus.className='turn-status';
    };
  }
  async function create() {
    msg(el.lobbyError,'');setBusy(true);
    const durationSeconds=Number(document.querySelector('input[name="duration"]:checked').value);
    const hostColor=document.querySelector('input[name="hostColor"]:checked').value;
    try {setSession(await request('/api/create',{name:name(),durationSeconds,hostColor}));}
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
  function isWallMode() {return mode==='h'||mode==='v';}
  function colorOf(id) {return state && state.players[id] ? colors[state.players[id].color] : (id===0?colors.cyan:colors.orange);}
  function updateModeButtons() {
    document.querySelectorAll('[data-mode]').forEach(btn=>{
      const candidate=btn.dataset.mode;
      btn.classList.toggle('selected',candidate===mode);
      btn.disabled=!!state && candidate!=='move' && state.remaining[state.you]===0;
    });
  }
  function renderPreviewControls() {
    const visible=isWallMode() && isMyTurn() && state.remaining[state.you]>0 && (coarsePointer || pointerKind!=='mouse' || selectedWall!==null);
    el.previewControls.hidden=!visible;
    el.confirmWall.disabled=!selectedWall || sending;
    el.previewHelp.textContent=selectedWall ? '🧱 دیوار روشن پیش‌نمایشه؛ برای گذاشتنش «تأیید دیوار» رو بزن.' : '📍 اول جای دیوار رو روی صفحه لمس کن؛ هنوز چیزی ثبت نمی‌شه.';
    el.board.classList.toggle('wall-mode',isWallMode() && isMyTurn());
  }
  function render() {
    if(!state) return;
    state.players.forEach((p,id)=>{
      $(id===0?'player0Name':'player1Name').textContent=p.name+(id===state.you?' (تو)':'');
    });
    if(state.players.length<2) $('player1Name').textContent='منتظر دوستت...';
    $('player0Walls').textContent=state.remaining[0]+' 🧱';
    $('player1Walls').textContent=state.remaining[1]+' 🧱';
    for (const id of [0,1]) {
      $('player'+id).style.setProperty('--piece-color',colorOf(id));
      $('player'+id).classList.toggle('active',!state.waiting && state.winner===null && state.turn===id);
    }
    const mins=state.settings.durationSeconds/60;
    el.gameDuration.textContent=`${mins===1?'۱':'۳'} دقیقه برای هر نفر`;
    $('goal0').textContent=`↑ هدف ${colorName[state.players[0].color]}`;
    $('goal1').textContent=`هدف ${colorName[state.players[1]?.color || (state.players[0].color==='cyan'?'orange':'cyan')]} ↓`;
    el.turnStatus.className='turn-status';
    if(state.waiting) el.turnStatus.textContent='⏳ منتظر دوستت هستیم؛ لینک دعوت رو براش بفرست!';
    else if(state.winner!==null) el.turnStatus.textContent=state.winner===state.you?'🏆 برنده شدی!':'🎯 بازی تموم شد!';
    else if(isMyTurn()) {el.turnStatus.textContent='✨ نوبت توئه! حرکت کن یا دیوار بذار';el.turnStatus.classList.add('mine');}
    else {el.turnStatus.textContent=`⏳ نوبت ${state.players[state.turn].name} ـه`;el.turnStatus.classList.add('opponent');}
    if(state.remaining[state.you]===0 && isWallMode()) {mode='move';hover=null;selectedWall=null;}
    updateModeButtons();
    renderPreviewControls();
    el.winnerOverlay.hidden=state.winner===null;
    if(state.winner!==null) {
      const win=state.winner===state.you;
      el.winnerTitle.textContent=win?'بردی! آفرین 🎉':'این دفعه دوستت برد!';
      el.winnerText.textContent=state.endReason==='timeout' ?
        (win?'زمان دوستت و فرصت ۲ ثانیه‌ای اون تموم شد.':'زمان اصلی و فرصت ۲ ثانیه‌ای تو تموم شد.') :
        (win?'زودتر از حریفت به اون طرف صفحه رسیدی.':'یه دست دیگه بازی کن و جبران کن!');
    }
    draw();
    updateClocks();
  }
  function formatTime(ms) {
    if(ms<=0) return '00:00';
    if(ms<10000) return (ms/1000).toFixed(1)+' ث';
    const seconds=Math.ceil(ms/1000);
    return String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');
  }
  function activeElapsed() {
    if(!state || state.time.turnStartedAt===null) return 0;
    const elapsedAtSync=state.time.serverNow-state.time.turnStartedAt;
    return Math.max(0,elapsedAtSync+performance.now()-clockReceivedAt);
  }
  function updateClocks() {
    if(!state) return;
    for(const id of [0,1]) {
      const active=!state.waiting && state.winner===null && state.turn===id;
      const reserve=state.time.remainingMs[id];
      const elapsed=active?activeElapsed():0;
      const reserveLeft=Math.max(0,reserve-elapsed);
      const graceLeft=active && reserveLeft===0 ? Math.max(0,reserve+2000-elapsed) : 0;
      const clock=$('player'+id+'Clock');
      clock.textContent=formatTime(reserveLeft>0?reserveLeft:graceLeft);
      clock.classList.toggle('urgent',active && (reserveLeft<=10000));
      clock.classList.toggle('grace',active && reserveLeft===0);
    }
    if(!state.waiting && state.winner===null && state.turn===state.you && state.time.remainingMs[state.you]<=activeElapsed()) {
      el.turnStatus.textContent='⚡ زمان اصلی تموم شده؛ فقط ۲ ثانیه برای این نوبت!';
    }
  }
  setInterval(updateClocks,100);
  function roundRect(x,y,w,h,r,fill,stroke) {
    ctx.beginPath();ctx.roundRect(x,y,w,h,r);
    if(fill) {ctx.fillStyle=fill;ctx.fill();}
    if(stroke) {ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke();}
  }
  function pawn(x,y,fill) {
    ctx.save();
    ctx.shadowColor=fill;ctx.shadowBlur=19;
    ctx.fillStyle=fill;ctx.beginPath();ctx.arc(x,y,19,0,Math.PI*2);ctx.fill();
    ctx.shadowBlur=0;ctx.strokeStyle='#ffffffa8';ctx.lineWidth=3;ctx.stroke();
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
      const cell=r===0?'#1f393f':r===8?'#45342f':'#1b2940';
      roundRect(ORIGIN+c*STEP,ORIGIN+r*STEP,CELL,CELL,5,cell);
    }
    if(!state)return;
    if(isMyTurn()&&mode==='move') for(const p of state.legalMoves) {
      const x=ORIGIN+p.c*STEP+CELL/2,y=ORIGIN+p.r*STEP+CELL/2;
      ctx.fillStyle='#78eedba6';ctx.beginPath();ctx.arc(x,y,11,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='#a6fff2';ctx.lineWidth=2;ctx.stroke();
    }
    for(const w of state.walls) {
      const a=wallRect(w.o,w.r,w.c), color=colorOf(w.owner === 1 ? 1 : 0);
      ctx.save();ctx.shadowColor=color;ctx.shadowBlur=9;
      roundRect(a.x,a.y,a.w,a.h,3,color);ctx.restore();
    }
    const preview=selectedWall || hover;
    if(preview && isMyTurn() && isWallMode() && state.remaining[state.you]>0) {
      const a=wallRect(mode,preview.r,preview.c), color=colorOf(state.you);
      ctx.save();ctx.globalAlpha=.55;ctx.shadowColor=color;ctx.shadowBlur=13;
      roundRect(a.x,a.y,a.w,a.h,3,color);
      if(selectedWall) roundRect(a.x-3,a.y-3,a.w+6,a.h+6,4,null,'#ffffff');
      ctx.restore();
    }
    for(let id=0;id<state.pawns.length;id++) {
      const p=state.pawns[id];pawn(ORIGIN+p.c*STEP+CELL/2,ORIGIN+p.r*STEP+CELL/2,colorOf(id));
    }
    if(state.waiting) {
      roundRect(130,258,340,83,15,'#142b3aea','#537d8b');
      ctx.fillStyle='#ffffff';ctx.textAlign='center';ctx.font='bold 19px Tahoma,sans-serif';ctx.fillText('منتظر بازیکن دوم...',300,305);
    }
  }
  function canvasCoords(ev) {
    const box=el.board.getBoundingClientRect();
    return {x:(ev.clientX-box.left)*W/box.width,y:(ev.clientY-box.top)*H/box.height};
  }
  function candidateWall(p,o) {
    let best=null,dist=Infinity;
    for(let r=0;r<8;r++)for(let c=0;c<8;c++) {
      const a=wallRect(o,r,c),mx=a.x+a.w/2,my=a.y+a.h/2;
      const d=(mx-p.x)**2+(my-p.y)**2;
      if(d<dist){dist=d;best={r,c};}
    }
    return best;
  }
  async function action(payload) {
    if(sending)return;
    if(!isMyTurn()) {msg(el.gameError,state.waiting?'منتظر بازیکن دوم باش.':'الان نوبت تو نیست.');return;}
    sending=true;renderPreviewControls();msg(el.gameError,'');
    try {await request('/api/action',{...payload,room,token:secret});}
    catch(err){msg(el.gameError,err.message);}finally{sending=false;renderPreviewControls();}
  }
  // Mouse keeps the old hover-to-preview + click-to-place flow.
  // On touch/pen: touch/drag first previews; only explicit confirmation places a wall.
  el.board.addEventListener('pointerdown',ev=>{
    pointerKind=ev.pointerType || 'mouse';
    if(!state||!isMyTurn()||!isWallMode()||pointerKind==='mouse')return;
    touchingWall=true;
    selectedWall=candidateWall(canvasCoords(ev),mode);
    el.board.setPointerCapture?.(ev.pointerId);
    renderPreviewControls();draw();
  });
  el.board.addEventListener('pointermove',ev=>{
    if(!state||!isMyTurn()||!isWallMode())return;
    if(ev.pointerType==='mouse') {
      if(!selectedWall)hover=candidateWall(canvasCoords(ev),mode);
    } else if(touchingWall) {
      selectedWall=candidateWall(canvasCoords(ev),mode);
      renderPreviewControls();
    }
    draw();
  });
  el.board.addEventListener('pointerup',()=>{touchingWall=false;});
  el.board.addEventListener('pointercancel',()=>{touchingWall=false;});
  el.board.addEventListener('pointerleave',ev=>{
    if(ev.pointerType==='mouse'){hover=null;draw();}
  });
  el.board.addEventListener('click',ev=>{
    if(!state||!isMyTurn())return;
    const p=canvasCoords(ev);
    if(mode==='move') {
      const c=Math.round((p.x-ORIGIN-CELL/2)/STEP),r=Math.round((p.y-ORIGIN-CELL/2)/STEP);
      if(r<0||r>8||c<0||c>8)return;
      if(!state.legalMoves.some(q=>q.r===r&&q.c===c)) {msg(el.gameError,'فقط می‌تونی به خونه‌های مشخص‌شده حرکت کنی.');return;}
      action({type:'move',r,c});
    } else {
      if(pointerKind!=='mouse' || coarsePointer) {
        selectedWall=candidateWall(p,mode);
        hover=null;renderPreviewControls();draw();
      } else {
        const place=candidateWall(p,mode);
        action({type:'wall',o:mode,r:place.r,c:place.c});
      }
    }
  });
  el.confirmWall.addEventListener('click',()=>{
    if(!selectedWall || !isWallMode())return;
    action({type:'wall',o:mode,r:selectedWall.r,c:selectedWall.c});
  });
  el.cancelWall.addEventListener('click',()=>{selectedWall=null;hover=null;renderPreviewControls();draw();});
  document.querySelectorAll('[data-mode]').forEach(btn=>btn.addEventListener('click',()=>{
    mode=btn.dataset.mode;hover=null;selectedWall=null;msg(el.gameError,'');
    updateModeButtons();renderPreviewControls();draw();
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
  el.rematch.addEventListener('click',async()=>{
    el.rematch.disabled=true;
    try {await request('/api/restart',{room,token:secret});msg(el.gameError,'');}
    catch(err){msg(el.gameError,err.message);}finally{el.rematch.disabled=false;}
  });
  el.newRoom.addEventListener('click',()=>{
    if(stream)stream.close();stream=null;
    room='';secret='';state=null;mode='move';hover=null;selectedWall=null;lastMoveNumber=-1;
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
