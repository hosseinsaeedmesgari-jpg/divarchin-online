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
    confirmWall:$('confirmWallBtn'),cancelWall:$('cancelWallBtn'),
    chatScreen:$('chatScreen'),chatMessages:$('chatMessages'),chatInput:$('chatInput'),chatForm:$('chatForm'),chatError:$('chatError'),chatCount:$('chatCharCount'),
    backToGame:$('backToGameBtn'),chatRoomCode:$('chatRoomCode'),chatClockNotice:$('chatClockNotice'),
    chatUnread:$('chatUnread'),chatUnreadSide:$('chatUnreadSide'),sendChat:$('sendChatBtn'),
    accountScreen:$('accountScreen'),leaderboardScreen:$('leaderboardScreen'),
    authForm:$('authForm'),authError:$('authError'),authTitle:$('authTitle'),
    authUsername:$('authUsername'),authPassword:$('authPassword'),authRepeat:$('authRepeat'),authRecovery:$('authRecovery'),
    recoveryCard:$('recoveryCodeCard'),recoveryCode:$('newRecoveryCode'),
    rankingItems:$('leaderboardItems'),rankingError:$('leaderboardError')
  };
  let room='', secret='', state=null, stream=null, mode='move', hover=null, selectedWall=null;
  let sending=false, pointerKind='mouse', touchingWall=false, clockReceivedAt=0, lastMoveNumber=-1;
  let chatOpen=false, seenChatId=0, chatSending=false, currentChatRoom='';
  let animation=null, animationFrame=0;
  let account=null, accountsEnabled=false, authMode='login';
  let currentView='', navStack=[], onExitConfirm=null, profileCache=null;
  const views=['splashScreen','dashboardScreen','lobby','botSetupScreen','profileScreen','historyScreen','settingsScreen','accountScreen','leaderboardScreen','game','chatScreen'];
  const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ctx=el.board.getContext('2d');
  const W=600, H=600, CELL=50, GAP=10, STEP=CELL+GAP, ORIGIN=(W-(9*CELL+8*GAP))/2;
  const colors={cyan:'#0ebfbd', orange:'#ec8935'};
  const colorName={cyan:'فیروزه‌ای',orange:'نارنجی'};
  const coarsePointer=window.matchMedia('(pointer: coarse)').matches;

  function msg(node,message) {node.textContent=message;node.hidden=!message;}
  function name() {return el.name.value.trim().slice(0,18)||'بازیکن';}
  function setBusy(b) {el.create.disabled=b;el.join.disabled=b;}
  function navigate(view, push=true) {
    if(!views.includes(view))return;
    if(push && currentView && currentView!==view) {
      navStack.push(currentView);
      if(navStack.length>30)navStack.shift();
      try { history.pushState({divarchin:true,view},'',location.href); } catch { /* history optional */ }
    }
    currentView=view;
    for(const id of views) $(id).hidden=id!==view;
    document.body.classList.toggle('showing-splash',view==='splashScreen');
    el.winnerOverlay.hidden = view!=='game' || !state || state.winner===null;
    if(view==='dashboardScreen') updateDashboard();
    if(view==='game' && state){render();updateClocks();}
    window.scrollTo({top:0,behavior:'instant'});
  }
  function showLobby(){navigate('dashboardScreen');}
  function updateDashboard(){
    $('dashGreeting').textContent=account?'سلام '+account.username+'!':'سلام، به دیوارچین خوش اومدی!';
    $('dashCaption').textContent=account?`امتیاز ${account.rating.toLocaleString('fa-IR')} • ${account.wins.toLocaleString('fa-IR')} برد`:'برای رنکینگ می‌تونی یک حساب رایگان بسازی.';
    $('dashboardGuestTip').hidden=!!account;
    $('dashboardResumeBtn').hidden=!state;
  }
  function showExitConfirmation(title,description,confirmed){
    $('exitConfirmTitle').textContent=title;
    $('exitConfirmText').textContent=description;
    onExitConfirm=confirmed;$('exitConfirmOverlay').hidden=false;
  }
  function leaveRoom(){
    if(stream)stream.close();stream=null;
    room='';secret='';state=null;mode='move';hover=null;selectedWall=null;lastMoveNumber=-1;
    chatOpen=false;seenChatId=0;currentChatRoom='';animation=null;navStack=[];
    if(animationFrame)cancelAnimationFrame(animationFrame);animationFrame=0;
    el.chatMessages.dataset.lastId='';
    sessionStorage.removeItem('divarchin-last');
    try{history.replaceState({divarchin:true},'',location.pathname);}catch{}
    msg(el.gameError,'');el.inviteNote.textContent='';
    updateDashboard();void refreshAccount();navigate('dashboardScreen');
  }
  function handleBack(){
    if(!$('exitConfirmOverlay').hidden){$('exitConfirmOverlay').hidden=true;return 'handled';}
    if(currentView==='game') {
      showExitConfirmation('خروج از مسابقه؟',
        'اگر مسابقه هنوز فعاله، با خروج ساعت بازی متوقف نمی‌شه و ممکنه زمانت تمام بشه. مطمئنی می‌خوای به داشبورد برگردی؟',
        leaveRoom);return 'handled';
    }
    if(currentView==='chatScreen'){closeChat();return 'handled';}
    if(currentView==='historyScreen'){
      const previous=navStack.pop();
      navigate(previous==='profileScreen'?'profileScreen':'dashboardScreen',false);return 'handled';
    }
    if(currentView==='splashScreen'||currentView==='dashboardScreen')return 'exit';
    const previous=navStack.pop();
    navigate(previous && previous!=='splashScreen' && previous!=='chatScreen' && previous!=='game' ? previous : 'dashboardScreen',false);
    return 'handled';
  }
  window.divarchinHandleBack=handleBack;
  // Browser back also navigates within the app instead of unexpectedly abandoning a timed match.
  window.addEventListener('popstate',()=>{
    const result=handleBack();
    if(result==='exit')showExitConfirmation('خروج از دیوارچین؟','برای خروج می‌تونی این برگه مرورگر رو ببندی.',()=>{ $('exitConfirmOverlay').hidden=true; });
    try{history.pushState({divarchin:true,view:currentView},'',location.href);}catch{}
  });
  $('exitCancelBtn').addEventListener('click',()=>{$('exitConfirmOverlay').hidden=true;onExitConfirm=null;});
  $('exitYesBtn').addEventListener('click',()=>{
    $('exitConfirmOverlay').hidden=true;
    const callback=onExitConfirm;onExitConfirm=null;
    if(callback)callback();
  });
  function renderAccount() {
    $('accountStatus').textContent=account?'@'+account.username : accountsEnabled?'مهمان':'حالت مهمان';
    $('accountDescription').textContent=account?'پروفایلت فعال است؛ می‌تونی بازی رنک‌دار بسازی و وارد جدول رتبه‌بندی بشی.':
      accountsEnabled?'بدون ثبت‌نام می‌تونی بازی دوستانه انجام بدی. برای حضور در رنکینگ باید ثبت‌نام کنی.':
        'بازی مهمان فعاله. برای ثبت‌نام و رنکینگ ابتدا باید دیتابیس توسط مدیر بازی تنظیم بشه.';
    $('accountStats').hidden=!account;
    if(account){$('accountWins').textContent='برد: '+account.wins;$('accountLosses').textContent='باخت: '+account.losses;$('accountRating').textContent='امتیاز: '+account.rating;el.name.value=account.username;el.name.disabled=true;}
    else el.name.disabled=false;
    updateDashboard();
    $('accountLoginBtn').hidden=!!account;
    $('accountLoginBtn').disabled=!accountsEnabled;
    $('accountLogoutBtn').hidden=!account;
    document.querySelectorAll('input[name="gameType"][value="ranked"]').forEach(x=>{
      x.disabled=!account;
      if(!account && x.checked)document.querySelector('input[name="gameType"][value="friendly"]').checked=true;
    });
  }
  async function refreshAccount() {
    try {const result=await request('/api/account/me');account=result.user;accountsEnabled=result.enabled;msg($('accountError'),'');}
    catch(e){account=null;accountsEnabled=false;msg($('accountError'),'اتصال به حساب کاربری برقرار نشد. بازی مهمان همچنان قابل استفاده است.');}
    renderAccount();
  }
  function openAuth(type='login') {
    if(!accountsEnabled)return;
    authMode=type;navigate('accountScreen');
    el.recoveryCard.hidden=true;el.authForm.hidden=false;
    el.authForm.reset();msg(el.authError,'');
    const texts={login:'ورود به حساب',register:'ساخت حساب جدید',recover:'بازیابی حساب'};
    el.authTitle.textContent=texts[type];
    $('authRepeatField').hidden=type!=='register';$('authRecoveryField').hidden=type!=='recover';
    el.authRepeat.required=type==='register';el.authRecovery.required=type==='recover';
    $('authPasswordLabel').textContent=type==='recover'?'رمز عبور جدید':'رمز عبور';
    el.authPassword.autocomplete=type==='login'?'current-password':'new-password';
    $('authSubmit').textContent=type==='register'?'ثبت‌نام':type==='recover'?'تغییر رمز عبور':'ورود';
    document.querySelectorAll('[data-auth-mode]').forEach(btn=>btn.className='btn '+(btn.dataset.authMode===type?'secondary':'ghost'));
    window.scrollTo(0,0);
  }
  async function submitAuth(ev){
    ev.preventDefault();
    const username=el.authUsername.value.trim(),password=el.authPassword.value;
    if(authMode==='register' && password!==el.authRepeat.value){msg(el.authError,'تکرار رمز عبور مطابقت نداره.');return;}
    const path={login:'/api/account/login',register:'/api/account/register',recover:'/api/account/recover'}[authMode];
    const body={username,password};if(authMode==='recover')body.recoveryCode=el.authRecovery.value;
    $('authSubmit').disabled=true;msg(el.authError,'');
    try{
      const result=await request(path,body);account=result.user;profileCache=null;renderAccount();
      el.authForm.reset();
      if(result.recoveryCode){
        el.authForm.hidden=true;el.recoveryCard.hidden=false;el.recoveryCode.textContent=result.recoveryCode;
      }else showLobby();
    }catch(e){msg(el.authError,e.message);}finally{$('authSubmit').disabled=false;}
  }
  function recoveryDone(){el.recoveryCode.textContent='';el.recoveryCard.hidden=true;showLobby();}
  async function openLeaderboard(){
    navigate('leaderboardScreen');
    el.rankingItems.replaceChildren();msg(el.rankingError,'');
    try{
      const data=await request('/api/leaderboard');
      if(!data.players.length){const p=document.createElement('p');p.textContent='هنوز مسابقه رنک‌داری ثبت نشده؛ اولین نفر باش!';el.rankingItems.append(p);}
      data.players.forEach((u,i)=>{
        const row=document.createElement('div');row.className='rank-row';
        const place=document.createElement('span');place.className='rank-place';place.textContent='#'+(i+1);
        const uname=document.createElement('span');uname.className='rank-name';uname.textContent=u.username;
        const score=document.createElement('span');score.className='rank-score';score.textContent=u.rating+' امتیاز';
        const info=document.createElement('span');info.className='rank-details';info.textContent=`${u.wins} برد • ${u.losses} باخت`;
        row.append(place,uname,score,info);el.rankingItems.append(row);
      });
    }catch(e){msg(el.rankingError,e.message);}
    window.scrollTo(0,0);
  }
  document.querySelectorAll('[data-auth-mode]').forEach(btn=>btn.addEventListener('click',()=>openAuth(btn.dataset.authMode)));
  $('accountLoginBtn').addEventListener('click',()=>openAuth());
  $('authBackBtn').addEventListener('click',()=>navigate('profileScreen'));
  $('leaderboardBackBtn').addEventListener('click',()=>navigate('dashboardScreen'));
  $('leaderboardBtn').addEventListener('click',openLeaderboard);
  el.authForm.addEventListener('submit',submitAuth);
  $('recoveryDoneBtn').addEventListener('click',recoveryDone);
  $('copyRecoveryBtn').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(el.recoveryCode.textContent);$('copyRecoveryBtn').textContent='کپی شد ✓';}
    catch{msg(el.authError,'کپی نشد؛ کد رو به صورت دستی یادداشت کن.');}
  });
  $('accountLogoutBtn').addEventListener('click',async()=>{
    try {await request('/api/account/logout',{});account=null;profileCache=null;renderAccount();}
    catch(e){msg($('accountError'),e.message);}
  });
  async function openProfile(){
    navigate('profileScreen');
    msg($('profileError'),'');
    $('profileDashboard').hidden=!account;
    if(!account){$('profileHistoryBtn').hidden=true;return;}
    $('profileHistoryBtn').hidden=false;
    try {
      const {profile}=await request('/api/account/profile');
      if(!account || profile.id!==account.id)return;
      profileCache=profile;
      $('profileDashboard').hidden=false;
      $('profileName').textContent='@'+profile.username;
      $('profileRank').textContent=profile.rank?'رتبه #'+profile.rank.toLocaleString('fa-IR'):'بدون رتبه';
      $('profileTotal').textContent=profile.total.toLocaleString('fa-IR');
      $('profileWinRate').textContent=profile.winRate.toLocaleString('fa-IR')+'٪';
      $('profileBestStreak').textContent=profile.bestStreak.toLocaleString('fa-IR');
      $('profileCurrentStreak').textContent=profile.currentStreak.toLocaleString('fa-IR');
    }catch(e){msg($('profileError'),e.message);}
  }
  async function openHistory(){
    navigate('historyScreen');
    msg($('historyError'),'');
    const list=$('historyItems');list.replaceChildren();
    if(!account){list.textContent='برای دیدن تاریخچه مسابقات باید ثبت‌نام یا وارد حساب بشی.';return;}
    try {
      if(!profileCache || profileCache.id!==account.id){const response=await request('/api/account/profile');profileCache=response.profile;}
      if(!profileCache.history.length){list.textContent='هنوز مسابقه رنک‌داری انجام ندادی.';return;}
      for(const entry of profileCache.history){
        const row=document.createElement('div');row.className='history-row';
        const result=document.createElement('b');result.className=entry.won?'history-win':'history-lose';result.textContent=entry.won?'پیروزی':'شکست';
        const detail=document.createElement('span');detail.textContent='حریف: '+entry.opponent;
        const stamp=document.createElement('small');stamp.textContent=new Date(entry.at).toLocaleDateString('fa-IR');
        row.append(result,detail,stamp);list.append(row);
      }
    }catch(e){msg($('historyError'),e.message);}
  }
  $('splashEnterBtn').addEventListener('click',()=>navigate('dashboardScreen'));
  $('dashboardPlayBtn').addEventListener('click',()=>navigate('lobby'));
  $('dashboardBotBtn').addEventListener('click',()=>navigate('botSetupScreen'));
  $('dashboardProfileBtn').addEventListener('click',openProfile);
  $('dashboardHistoryBtn').addEventListener('click',openHistory);
  $('dashboardRankingBtn').addEventListener('click',openLeaderboard);
  $('dashboardSettingsBtn').addEventListener('click',()=>navigate('settingsScreen'));
  $('dashboardResumeBtn').addEventListener('click',()=>{if(state)navigate('game');});
  $('lobbyBackBtn').addEventListener('click',()=>navigate('dashboardScreen'));
  $('botBackBtn').addEventListener('click',()=>navigate('dashboardScreen'));
  $('profileBackBtn').addEventListener('click',()=>navigate('dashboardScreen'));
  $('profileHistoryBtn').addEventListener('click',openHistory);
  $('historyBackBtn').addEventListener('click',()=>handleBack());
  $('settingsBackBtn').addEventListener('click',()=>navigate('dashboardScreen'));
  const motionSetting=localStorage.getItem('divarchin-low-motion')==='yes';
  $('motionToggle').checked=motionSetting;
  document.body.classList.toggle('low-motion',motionSetting);
  $('motionToggle').addEventListener('change',ev=>{
    localStorage.setItem('divarchin-low-motion',ev.target.checked?'yes':'no');
    document.body.classList.toggle('low-motion',ev.target.checked);
  });
  $('botStartBtn').addEventListener('click',async()=>{
    const button=$('botStartBtn');button.disabled=true;msg($('botError'),'');
    try{
      const data=await request('/api/bot/create',{name:name(),difficulty:$('botDifficulty').value,durationSeconds:Number($('botDuration').value),hostColor:$('botColor').value});
      setSession(data);
    }catch(e){msg($('botError'),e.message);}finally{button.disabled=false;}
  });
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
    if (!state || currentChatRoom !== next.room || (next.moveNumber===1 && state.moveNumber>1)) {
      seenChatId=Math.max(0,...(next.chat || []).map(x=>x.id));
      currentChatRoom=next.room;
    }
    const prior=state;
    state=next;
    if (prior && prior.room===next.room && prior.moveNumber<=next.moveNumber) animatePawns(prior.pawns,next.pawns);
    clockReceivedAt=performance.now();
    lastMoveNumber=next.moveNumber;
    if (next.ratedRecorded && (!prior || !prior.ratedRecorded || prior.room!==next.room)) {profileCache=null;void refreshAccount();}
    render();
    renderChat();
  }
  function setSession(data) {
    room=data.room;secret=data.token;
    sessionStorage.setItem('divarchin-'+room,secret);
    sessionStorage.setItem('divarchin-last',room);
    const url=new URL(location.href);url.searchParams.set('room',room);
    try{history.replaceState(null,'',url);}catch{}
    chatOpen=false;navigate('game');
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
    const ranked=document.querySelector('input[name="gameType"]:checked').value==='ranked';
    try {setSession(await request('/api/create',{name:name(),durationSeconds,hostColor,ranked}));}
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
      $(id===0?'player0Name':'player1Name').textContent=p.name+(p.registered?' ✓':'')+(id===state.you?' (تو)':'');
    });
    if(state.players.length<2) $('player1Name').textContent='منتظر دوستت...';
    $('player0Walls').textContent=state.remaining[0]+' 🧱';
    $('player1Walls').textContent=state.remaining[1]+' 🧱';
    for (const id of [0,1]) {
      $('player'+id).style.setProperty('--piece-color',colorOf(id));
      $('player'+id).classList.toggle('active',!state.waiting && state.winner===null && state.turn===id);
    }
    $('gameTypeLabel').textContent=state.bot?'🤖 تمرین با ربات • بدون امتیاز رنکینگ':state.settings.ranked?'🏆 مسابقه رنک‌دار • دو حساب ثبت‌شده':'نبرد دوستانه • اتاق خصوصی';
    $('inviteCard').hidden=!!state.bot; $('chatPromo').hidden=!!state.bot; $('openChatBtn').hidden=!!state.bot;
    const duration=state.settings.durationSeconds;
    el.gameDuration.textContent=duration===0?'∞ زمان نامحدود':`${duration===60?'۱':'۳'} دقیقه برای هر نفر`;
    $('goal0').textContent=`↑ هدف ${colorName[state.players[0].color]}`;
    $('goal1').textContent=`هدف ${colorName[state.players[1]?.color || (state.players[0].color==='cyan'?'orange':'cyan')]} ↓`;
    el.turnStatus.className='turn-status';
    if(state.waiting) el.turnStatus.textContent='⏳ منتظر دوستت هستیم؛ لینک دعوت رو براش بفرست!';
    else if(state.winner!==null) el.turnStatus.textContent=state.winner===state.you?'🏆 برنده شدی!':'🎯 بازی تموم شد!';
    else if(isMyTurn()) {el.turnStatus.textContent='✨ نوبت توئه! حرکت کن یا دیوار بذار';el.turnStatus.classList.add('mine');}
    else {el.turnStatus.textContent=`⏳ نوبت ${state.players[state.turn].name} ـه`;el.turnStatus.classList.add('opponent');}
    if (!state.waiting && state.winner===null && state.time.lastBonus && state.time.lastBonus.moveNumber===state.moveNumber-1) {
      el.turnStatus.textContent += ` • ⚡ +۱ ثانیه برای ${state.players[state.time.lastBonus.player].name}`;
    }
    if(state.remaining[state.you]===0 && isWallMode()) {mode='move';hover=null;selectedWall=null;}
    updateModeButtons();
    renderPreviewControls();
    el.winnerOverlay.hidden=state.winner===null || currentView!=='game';
    if(state.winner!==null) {
      const waitingRematch=(state.rematchVotes||[]).includes(state.you);
      el.rematch.disabled=waitingRematch;
      el.rematch.textContent=waitingRematch?'منتظر تأیید حریف...':'پیشنهاد بازی مجدد ↻';
      const win=state.winner===state.you;
      el.winnerTitle.textContent=win?'بردی! آفرین 🎉':'این دفعه دوستت برد!';
      el.winnerText.textContent=state.endReason==='timeout' ?
        (win?'زمان دوستت به صفر رسید.':'زمان تو به صفر رسید.') :
        (win?'زودتر از حریفت به اون طرف صفحه رسیدی.':'یه دست دیگه بازی کن و جبران کن!');
      if(state.settings.ranked) el.winnerText.textContent += state.ratedRecorded?' • نتیجه در رنکینگ ثبت شد.':' • در حال ثبت نتیجه رنک‌دار...';
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
      const clock=$('player'+id+'Clock');
      if (state.settings.durationSeconds===0) {
        clock.textContent='∞';clock.classList.remove('urgent','grace');continue;
      }
      const reserve=state.time.remainingMs[id];
      const elapsed=active?activeElapsed():0;
      const reserveLeft=Math.max(0,reserve-elapsed);
      clock.textContent=formatTime(reserveLeft);
      clock.classList.toggle('urgent',active && reserveLeft<=10000);
      clock.classList.toggle('grace',active && reserveLeft===0);
    }
    if(state.settings.durationSeconds!==0 && !state.waiting && state.winner===null && state.turn===state.you && state.time.remainingMs[state.you]<=activeElapsed()) {
      el.turnStatus.textContent='⏳ ساعت به صفر رسید؛ منتظر تأیید سرور...';
    }
    if(chatOpen && state) { el.chatClockNotice.textContent=state.settings.durationSeconds===0?'∞ بازی بدون محدودیت زمانی':isMyTurn()?'⏱ نوبت توئه؛ ساعت در حال شمارشه':'⏱ ساعت بازی همچنان فعاله'; }
  }
  setInterval(updateClocks,100);
  function roundRect(x,y,w,h,r,fill,stroke) {
    ctx.beginPath();ctx.roundRect(x,y,w,h,r);
    if(fill) {ctx.fillStyle=fill;ctx.fill();}
    if(stroke) {ctx.strokeStyle=stroke;ctx.lineWidth=2;ctx.stroke();}
  }
  function animatePawns(before,after) {
    const moved=after.findIndex((p,id)=>p.r!==before[id].r||p.c!==before[id].c);
    if(moved<0 || reduceMotion) return;
    const from=before[moved],to=after[moved];
    animation={id:moved,from:{...from},to:{...to},start:performance.now(),duration:340};
    if(animationFrame)cancelAnimationFrame(animationFrame);
    const frame=()=>{
      if(!animation) return;
      draw();
      if(performance.now()-animation.start<animation.duration) animationFrame=requestAnimationFrame(frame);
      else {animation=null;animationFrame=0;draw();}
    };
    animationFrame=requestAnimationFrame(frame);
  }
  function pawn(x,y,fill) {
    ctx.save();
    ctx.shadowColor='#2011078c';ctx.shadowBlur=12;ctx.shadowOffsetY=8;
    const foot=ctx.createLinearGradient(x-23,y+7,x+23,y+21);
    foot.addColorStop(0,'#163342');foot.addColorStop(.25,fill);foot.addColorStop(.7,fill);foot.addColorStop(1,'#2a2423');
    ctx.beginPath();ctx.ellipse(x,y+13,19,11,0,0,Math.PI*2);ctx.fillStyle=foot;ctx.fill();
    ctx.shadowBlur=0;ctx.shadowOffsetY=0;
    const stem=ctx.createLinearGradient(x-16,y-4,x+17,y+11);
    stem.addColorStop(0,'#fff3d0');stem.addColorStop(.18,fill);stem.addColorStop(.7,fill);stem.addColorStop(1,'#3d3034');
    roundRect(x-10,y-3,20,20,10,stem);
    const ball=ctx.createRadialGradient(x-7,y-14,1,x,y-6,19);
    ball.addColorStop(0,'#fff5d6');ball.addColorStop(.35,fill);ball.addColorStop(1,'#1b3540');
    ctx.beginPath();ctx.arc(x,y-9,15,0,Math.PI*2);ctx.fillStyle=ball;ctx.fill();
    ctx.strokeStyle='#ffffff55';ctx.lineWidth=1;ctx.stroke();
    ctx.restore();
  }
  function wallRect(o,r,c) {
    if(o==='h') return {x:ORIGIN+c*STEP-2,y:ORIGIN+r*STEP+CELL+1,w:2*CELL+GAP+4,h:GAP-2};
    return {x:ORIGIN+c*STEP+CELL+1,y:ORIGIN+r*STEP-2,w:GAP-2,h:2*CELL+GAP+4};
  }
  function wall(x) {
    const {o,r,c,owner}=x,a=wallRect(o,r,c),color=colorOf(owner??state.you);
    ctx.save();ctx.shadowColor='#422a1e95';ctx.shadowBlur=7;ctx.shadowOffsetY=4;
    roundRect(a.x,a.y,a.w,a.h,2,'#493122');
    ctx.shadowBlur=0;ctx.shadowOffsetY=0;
    const gr=ctx.createLinearGradient(a.x,a.y,a.x+a.w,a.y+a.h);
    gr.addColorStop(0,'#ffffff82');gr.addColorStop(.20,color);gr.addColorStop(.75,color);gr.addColorStop(1,'#453322');
    roundRect(a.x,a.y-2,a.w,a.h,2,gr,'#452d2080');
    ctx.restore();
  }
  function draw() {
    ctx.clearRect(0,0,W,H);
    const bg=ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,'#1e2732');bg.addColorStop(1,'#111923');ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
    ctx.save();ctx.shadowColor='#000a';ctx.shadowBlur=22;ctx.shadowOffsetY=7;
    roundRect(ORIGIN-15,ORIGIN-15,9*CELL+8*GAP+30,9*CELL+8*GAP+30,12,'#663e26');ctx.restore();
    const trim=ctx.createLinearGradient(0,0,W,H);trim.addColorStop(0,'#bd8551');trim.addColorStop(.5,'#7e4d2e');trim.addColorStop(1,'#3d241b');
    roundRect(ORIGIN-13,ORIGIN-13,9*CELL+8*GAP+26,9*CELL+8*GAP+26,11,trim,'#d3a46a');
    roundRect(ORIGIN-5,ORIGIN-5,9*CELL+8*GAP+10,9*CELL+8*GAP+10,4,'#724326');
    for(let r=0;r<9;r++) for(let c=0;c<9;c++) {
      const x=ORIGIN+c*STEP,y=ORIGIN+r*STEP;
      const wood=ctx.createLinearGradient(x,y,x+CELL,y+CELL);
      const even=(r+c)%2===0;
      wood.addColorStop(0,even?'#edc994':'#e4ba82');
      wood.addColorStop(.45,even?'#e8bb80':'#dbad73');
      wood.addColorStop(1,even?'#d7a66b':'#cfa06a');
      roundRect(x,y,CELL,CELL,2,wood,'#ad7b4c');
      ctx.save();ctx.globalAlpha=.11;ctx.strokeStyle='#80552b';ctx.lineWidth=1;
      ctx.beginPath();ctx.moveTo(x+9,y+8);ctx.bezierCurveTo(x+13,y+20,x+6,y+32,x+18,y+43);ctx.stroke();ctx.restore();
    }
    if(!state)return;
    if(isMyTurn()&&mode==='move') for(const p of state.legalMoves) {
      const x=ORIGIN+p.c*STEP+CELL/2,y=ORIGIN+p.r*STEP+CELL/2;
      ctx.save();ctx.shadowColor='#10bdb6';ctx.shadowBlur=10;ctx.fillStyle='#0caca5a8';ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#bcfff4';ctx.lineWidth=1.8;ctx.stroke();ctx.restore();
    }
    for(const w of state.walls)wall(w);
    const preview=selectedWall || hover;
    if(preview && isMyTurn() && isWallMode() && state.remaining[state.you]>0) {
      const a=wallRect(mode,preview.r,preview.c),color=colorOf(state.you);
      ctx.save();ctx.globalAlpha=.68;ctx.shadowColor=color;ctx.shadowBlur=12;
      roundRect(a.x,a.y,a.w,a.h,3,color);
      if(selectedWall)roundRect(a.x-3,a.y-3,a.w+6,a.h+6,5,null,'#ffffff');ctx.restore();
    }
    for(let id=0;id<state.pawns.length;id++) {
      let p=state.pawns[id];
      if(animation && animation.id===id) {
        const t=Math.min(1,Math.max(0,(performance.now()-animation.start)/animation.duration));
        const ease=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
        p={r:animation.from.r+(animation.to.r-animation.from.r)*ease,c:animation.from.c+(animation.to.c-animation.from.c)*ease};
      }
      pawn(ORIGIN+p.c*STEP+CELL/2,ORIGIN+p.r*STEP+CELL/2,colorOf(id));
    }
    if(state.waiting) {
      roundRect(122,265,356,72,15,'#172639ed','#bd8750');
      ctx.fillStyle='#fff8ef';ctx.textAlign='center';ctx.font='bold 22px "B Titr", Tahoma, sans-serif';ctx.fillText('منتظر ورود بازیکن دوم...',300,307);
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
  function openChat() {
    if (!state || state.bot) return;
    chatOpen=true;
    seenChatId=Math.max(0,...(state.chat||[]).map(x=>x.id));
    navigate('chatScreen');
    el.chatRoomCode.textContent=room;
    renderChat();updateClocks();
    window.scrollTo(0,0);
  }
  function closeChat() {
    chatOpen=false;navigate('game',false);
    renderChat();window.scrollTo(0,0);
  }
  function renderChat() {
    if(!state)return;
    const messages=state.chat||[];
    if(chatOpen) seenChatId=Math.max(seenChatId,...messages.map(x=>x.id),0);
    const unread=messages.filter(x=>x.id>seenChatId && x.from!==state.you).length;
    for(const node of [el.chatUnread,el.chatUnreadSide]) {
      node.hidden=!unread;
      node.textContent=unread>99?'۹۹+':unread.toLocaleString('fa-IR');
    }
    if(!chatOpen)return;
    const nearBottom=el.chatMessages.scrollHeight-el.chatMessages.scrollTop-el.chatMessages.clientHeight < 90;
    const priorLast=el.chatMessages.dataset.lastId||'';
    const nextLast=messages.map(x=>x.id).join(',');
    if(priorLast===nextLast)return;
    el.chatMessages.dataset.lastId=nextLast;
    el.chatMessages.replaceChildren();
    if(messages.length===0){
      const empty=document.createElement('p');empty.className='chat-empty';empty.textContent='هنوز پیامی نیست؛ اولین پیام رو تو بفرست! 👋';el.chatMessages.append(empty);
    }
    for(const item of messages) {
      const bubble=document.createElement('article');bubble.className='chat-bubble '+(item.from===state.you?'mine':'theirs');
      const head=document.createElement('div');head.className='chat-author';
      const dot=document.createElement('span');dot.className='color-dot '+(state.players[item.from]?.color||'cyan');
      const author=document.createElement('b');author.textContent=state.players[item.from]?.name||'بازیکن';
      const when=document.createElement('time');when.textContent=new Date(item.at).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'});
      head.append(dot,author,when);
      const body=document.createElement('p');body.textContent=item.message; // Never inject chat HTML.
      bubble.append(head,body);el.chatMessages.append(bubble);
    }
    if(nearBottom || !priorLast) el.chatMessages.scrollTop=el.chatMessages.scrollHeight;
  }
  el.chatForm.addEventListener('submit',async ev=>{
    ev.preventDefault();
    const message=el.chatInput.value.trim();
    if(!message||chatSending)return;
    chatSending=true;el.sendChat.disabled=true;msg(el.chatError,'');
    try {
      await request('/api/chat',{room,token:secret,message});
      el.chatInput.value='';el.chatCount.textContent='۰ / ۲۸۰';
    } catch(err) {msg(el.chatError,err.message);}
    finally {chatSending=false;el.sendChat.disabled=false;el.chatInput.focus();}
  });
  el.chatInput.addEventListener('input',()=>{
    el.chatCount.textContent=el.chatInput.value.length.toLocaleString('fa-IR')+' / ۲۸۰';
  });
  $('openChatBtn').addEventListener('click',openChat);
  $('openChatSideBtn').addEventListener('click',openChat);
  el.backToGame.addEventListener('click',closeChat);
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
    try {const result=await request('/api/restart',{room,token:secret});msg(el.gameError,'');if(result.pending)el.rematch.textContent='منتظر تأیید حریف...';}
    catch(err){msg(el.gameError,err.message);}finally{el.rematch.disabled=false;}
  });
  el.newRoom.addEventListener('click',()=>handleBack());
  $('winnerHomeBtn').addEventListener('click',()=>{if(state?.winner!==null)leaveRoom();else handleBack();});
  async function init() {
    await refreshAccount();
    const code=(new URL(location.href)).searchParams.get('room')||sessionStorage.getItem('divarchin-last');
    if(!code) {navigate(window.matchMedia('(max-width: 680px)').matches?'splashScreen':'dashboardScreen',false);draw();return;}
    const normalized=code.toUpperCase();el.roomInput.value=normalized;
    const saved=sessionStorage.getItem('divarchin-'+normalized);
    if(saved) {
      try {
        const data=await request(`/api/state?room=${encodeURIComponent(normalized)}&token=${encodeURIComponent(saved)}`);
        setSession({room:normalized,token:saved,state:data.state});return;
      } catch {sessionStorage.removeItem('divarchin-'+normalized);sessionStorage.removeItem('divarchin-last');}
    }
    navigate('lobby',false);draw();
  }
  init();
})();
