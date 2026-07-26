(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const profileKey = 'lcr-profile-v1';
  const screens = {home:$('homeScreen'),room:$('roomScreen'),game:$('gameScreen')};
  const state = {network:null, profile:null, rooms:[], room:null, game:null, isHost:false, gameChannelReady:false, joining:false};

  function showScreen(name){Object.entries(screens).forEach(([k,v])=>v.classList.toggle('active',k===name));}
  function toast(text){const el=$('toast');el.textContent=text;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),2600);}
  function makeId(){return crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random().toString(36).slice(2)}`;}
  function loadProfile(){
    let saved=null;try{saved=JSON.parse(localStorage.getItem(profileKey)||'null');}catch{}
    let id='';try{id=sessionStorage.getItem('lcr-session-player-id')||'';}catch{}
    if(!id){id=makeId();try{sessionStorage.setItem('lcr-session-player-id',id);}catch{}}
    return {id,name:saved?.name||`Tay đua ${Math.floor(Math.random()*900+100)}`,avatar:Number(saved?.avatar)||1,color:Number(saved?.color)||0};
  }
  function saveProfile(){
    const name=$('playerName').value.trim().slice(0,18)||'Tay đua';
    state.profile.name=name;state.profile.color=(state.profile.avatar-1)%8;
    try{localStorage.setItem(profileKey,JSON.stringify({name:state.profile.name,avatar:state.profile.avatar,color:state.profile.color}));}catch{}
    toast('Đã lưu hồ sơ người chơi.');
  }

  function setupAvatars(){
    const grid=$('avatarGrid');grid.innerHTML='';
    for(let i=1;i<=22;i++){
      const b=document.createElement('button');b.type='button';b.className='avatar-option';b.dataset.avatar=i;
      b.innerHTML=`<img src="assets/avatars/avatar-${String(i).padStart(2,'0')}.png" alt="Avatar ${i}">`;
      b.addEventListener('click',()=>{state.profile.avatar=i;state.profile.color=(i-1)%8;renderAvatarSelection();});grid.appendChild(b);
    }
    renderAvatarSelection();
  }
  function renderAvatarSelection(){document.querySelectorAll('.avatar-option').forEach(b=>b.classList.toggle('selected',Number(b.dataset.avatar)===state.profile.avatar));}

  function setupSelects(){
    const max=$('maxPlayersInput'),lanes=$('laneCountInput');
    for(let i=2;i<=8;i++){max.add(new Option(`${i} tay đua`,i));lanes.add(new Option(`${i} làn`,i));}
    max.value='4';lanes.value='auto';
    const ranges=[['aiDifficultyInput','aiDifficultyOutput','/10'],['obstacleDensityInput','obstacleDensityOutput','/10'],['powerupDensityInput','powerupDensityOutput','/10'],['nitroSpeedInput','nitroSpeedOutput','/10'],['perfectZoneInput','perfectZoneOutput','%']];
    for(const [input,out,suffix] of ranges){const sync=()=>$(out).textContent=`${$(input).value}${suffix}`;$(input).addEventListener('input',sync);sync();}
    $('durationPreset').addEventListener('change',()=>{$('durationCustom').disabled=$('durationPreset').value!=='custom';});
    document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>applyPreset(b.dataset.preset)));
  }

  function applyPreset(name){
    const presets={
      family:{ai:4,obs:4,pow:6,nitro:5,perfect:8,inv:2.5},
      balanced:{ai:6,obs:6,pow:5,nitro:7,perfect:5,inv:2},
      competitive:{ai:8,obs:7,pow:4,nitro:9,perfect:3,inv:1.5},
      chaos:{ai:7,obs:10,pow:10,nitro:8,perfect:5,inv:2}
    }[name];if(!presets)return;
    $('aiDifficultyInput').value=presets.ai;$('obstacleDensityInput').value=presets.obs;$('powerupDensityInput').value=presets.pow;$('nitroSpeedInput').value=presets.nitro;$('perfectZoneInput').value=presets.perfect;$('invincibleInput').value=presets.inv;
    ['aiDifficultyInput','obstacleDensityInput','powerupDensityInput','nitroSpeedInput','perfectZoneInput'].forEach(id=>$(id).dispatchEvent(new Event('input')));
  }

  function readSettings(){
    const maxPlayers=Number($('maxPlayersInput').value);const laneRaw=$('laneCountInput').value;
    let duration=$('durationPreset').value==='custom'?Number($('durationCustom').value):Number($('durationPreset').value);
    const mode=$('modeInput').value;if(mode==='race'&&duration===0)duration=120;
    return {
      name:$('roomNameInput').value.trim()||'Phòng đua',mode,maxPlayers,
      laneCount:laneRaw==='auto'?Math.max(4,maxPlayers):Number(laneRaw),durationSeconds:Math.max(0,Math.min(1800,duration||0)),
      aiDifficulty:Number($('aiDifficultyInput').value),obstacleDensity:Number($('obstacleDensityInput').value),
      powerupDensity:Number($('powerupDensityInput').value),nitroSpeed:Number($('nitroSpeedInput').value),
      perfectZone:Number($('perfectZoneInput').value),invincibleSeconds:Number($('invincibleInput').value)||2
    };
  }

  async function init(){
    state.profile=loadProfile();$('playerName').value=state.profile.name;setupAvatars();setupSelects();bindUI();
    state.network=new LCRNetwork(window.LCR_CONFIG);const result=await state.network.init();
    $('connectionPill').textContent=result.mode==='online'?'Online · Supabase Realtime':'Demo cục bộ · cần cấu hình Supabase';
    $('connectionPill').style.color=result.mode==='online'?'#17694f':'#9a5b17';
    state.network.subscribeLobby(loadRooms);await loadRooms();
    const code=new URLSearchParams(location.search).get('room');if(code)await joinRoom(code,true);
    if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
  }

  function bindUI(){
    $('saveProfileBtn').addEventListener('click',saveProfile);$('createRoomBtn').addEventListener('click',()=>{saveProfile();$('createRoomDialog').showModal();});
    $('refreshRoomsBtn').addEventListener('click',loadRooms);$('createRoomForm').addEventListener('submit',createRoom);
    $('roomList').addEventListener('click',e=>{const b=e.target.closest('[data-join]');if(b)joinRoom(b.dataset.join);});
    $('leaveRoomBtn').addEventListener('click',leaveRoom);$('copyRoomLinkBtn').addEventListener('click',copyRoomLink);$('startRaceBtn').addEventListener('click',startRace);
    $('leftBtn').addEventListener('contextmenu',e=>e.preventDefault());$('rightBtn').addEventListener('contextmenu',e=>e.preventDefault());
    $('nitroHitBtn').addEventListener('pointerdown',e=>{e.preventDefault();state.game?.hitNitro();});
    $('gameMenuBtn').addEventListener('click',()=>$('gameMenuDialog').showModal());$('quitRaceBtn').addEventListener('click',quitRace);
    $('backToRoomBtn').addEventListener('click',backToRoom);
  }

  async function loadRooms(){
    try{state.rooms=await state.network.listRooms();renderRooms();}catch(error){console.error(error);toast('Không tải được danh sách phòng.');}
  }
  function renderRooms(){
    const list=$('roomList');if(!state.rooms.length){list.innerHTML='<div class="empty-state"><strong>Chưa có phòng nào đang mở.</strong><p>Hãy tạo phòng đầu tiên hoặc mở link mời từ người khác.</p></div>';return;}
    list.innerHTML=state.rooms.map(r=>{
      const count=r.player_count??r.players?.length??0;const settings=r.settings||{};
      return `<article class="room-card"><div><h4>${escapeHtml(r.name)}</h4><div class="room-meta"><span class="tag">${r.mode==='endless'?'Đua mãi':'Đua về đích'}</span><span class="tag">${count}/${r.max_players} người</span><span class="tag">${r.lane_count} làn</span><span class="tag">AI ${r.ai_difficulty}/10</span></div></div><button class="primary" data-join="${escapeHtml(r.code)}">Vào phòng</button></article>`;
    }).join('');
  }

  async function createRoom(event){
    event.preventDefault();saveProfile();const settings=readSettings();
    try{
      const room=await state.network.createRoom(settings,state.profile);$('createRoomDialog').close();await enterRoom(await state.network.getRoom(room.code)||room);history.replaceState(null,'',`${location.pathname}?room=${room.code}`);
    }catch(error){console.error(error);toast(error.message||'Không tạo được phòng.');}
  }

  async function joinRoom(code,fromLink=false){
    if(state.joining)return;state.joining=true;saveProfile();
    try{
      const room=await state.network.joinRoom(String(code).toUpperCase(),state.profile);await enterRoom(room);history.replaceState(null,'',`${location.pathname}?room=${room.code}`);if(fromLink)toast(`Đã vào phòng ${room.code}.`);
    }catch(error){console.error(error);toast(error.message||'Không vào được phòng.');if(fromLink)history.replaceState(null,'',location.pathname);}
    finally{state.joining=false;}
  }

  async function enterRoom(room){
    state.room=room;state.isHost=room.host_id===state.profile.id||(room.players||[]).some(p=>p.player_id===state.profile.id&&p.is_host);
    showScreen('room');renderRoom();state.network.unsubscribeRoom();state.network.subscribeRoom(room,onRoomChanged);
    await state.network.openGameChannel(room.code,state.profile.id,onGameMessage);state.gameChannelReady=true;
  }

  async function onRoomChanged(room){
    if(!room){toast('Phòng đã bị đóng.');await leaveRoom(false);return;}
    state.room=room;state.isHost=room.host_id===state.profile.id||(room.players||[]).some(p=>p.player_id===state.profile.id&&p.is_host);renderRoom();
  }

  function renderRoom(){
    const r=state.room;if(!r)return;$('roomTitle').textContent=r.name;$('roomCode').textContent=r.code;
    const settings=r.settings||{};const duration=r.duration_seconds===0?'Không giới hạn':`${r.duration_seconds} giây`;
    $('settingsSummary').innerHTML=[['Chế độ',r.mode==='endless'?'Đua mãi – tính điểm':'Đua về đích'],['Thời lượng',duration],['Đường đua',`${r.lane_count} làn`],['AI',`${r.ai_difficulty}/10`],['Chướng ngại',`${r.obstacle_density}/10`],['Power-up',`${r.powerup_density}/10`]].map(([a,b])=>`<div class="summary-item"><span>${a}</span><strong>${b}</strong></div>`).join('');
    const players=(r.players||[]).slice().sort((a,b)=>a.slot-b.slot);$('playerCount').textContent=`${players.length}/${r.max_players} người thật`;
    const slots=[];for(let i=0;i<r.max_players;i++){const p=players.find(x=>x.slot===i);if(p)slots.push(`<div class="player-slot ${p.is_host?'host':''}"><img src="assets/avatars/avatar-${String(p.avatar).padStart(2,'0')}.png"><div><strong>${escapeHtml(p.name)}</strong><small>${p.is_host?'Chủ phòng':'Người chơi'} · Làn ${i+1}</small></div></div>`);else slots.push(`<div class="player-slot empty"><div class="avatar-placeholder">🤖</div><div><strong>AI sẽ tự điền</strong><small>Slot ${i+1}</small></div></div>`);} $('playerSlots').innerHTML=slots.join('');
    $('startRaceBtn').style.display=state.isHost?'inline-flex':'none';$('hostHint').textContent=state.isHost?'Khi bắt đầu, AI sẽ tự lấp toàn bộ chỗ trống.':'Đang chờ chủ phòng bắt đầu cuộc đua.';
  }

  async function startRace(){
    if(!state.isHost||!state.room||!state.gameChannelReady)return;
    try{
      const fresh=await state.network.getRoom(state.room.code);if(fresh)state.room=fresh;
      await state.network.setRoomStatus(state.room.id,'racing');const payload={type:'start',startAt:Date.now()+3800,seed:state.room.seed,room:state.room};
      await state.network.sendGame(payload);await beginGame(payload);
    }catch(error){console.error(error);toast(error.message||'Không bắt đầu được cuộc đua.');}
  }

  async function onGameMessage(msg){
    if(!msg)return;
    if(msg.type==='start'&&!state.game)await beginGame(msg);
    else if(msg.type==='reset'){await backToRoom();}
    else state.game?.handleNetworkMessage(msg);
  }

  async function beginGame(payload){
    if(state.game)return;state.room=payload.room||state.room;showScreen('game');
    const hud={speed:$('speedHud'),rank:$('rankHud'),score:$('scoreHud'),coin:$('coinHud'),progress:$('raceProgress'),distance:$('distanceHud'),timer:$('timerHud'),effects:$('effectStrip'),countdown:$('countdownOverlay'),nitroPanel:$('nitroPanel'),nitroDot:$('nitroDot'),nitroPasses:$('nitroPasses'),gradePop:$('gradePop')};
    try{
      state.game=new HighwayGame({canvas:$('gameCanvas'),room:state.room,profile:state.profile,network:state.network,isHost:state.isHost,onEnd:handleGameEnd,hud});
      await state.game.load();state.game.bindButtons({left:$('leftBtn'),right:$('rightBtn'),boost:$('boostBtn')});state.game.start(payload.startAt);
    }catch(error){console.error(error);toast('Không tải được tài nguyên game.');state.game?.destroy();state.game=null;showScreen('room');}
  }

  function handleGameEnd(reason,results){
    if(state.isHost&&state.room)state.network.setRoomStatus(state.room.id,'waiting').catch(console.error);
    $('resultTitle').textContent=reason;$('resultList').innerHTML=results.map(r=>`<div class="result-row"><div class="place">${r.place}</div><img src="assets/avatars/avatar-${String(r.avatar).padStart(2,'0')}.png"><div><strong>${escapeHtml(r.name)}</strong><small>${state.room.mode==='endless'?`${Math.round(r.distance)} m`:(r.finishTime?`${r.finishTime.toFixed(2)} giây`:'Chưa về đích')}</small></div><strong>${Math.round(r.score)} điểm</strong></div>`).join('');
    if(!$('resultDialog').open)$('resultDialog').showModal();
  }

  async function backToRoom(){
    if($('resultDialog').open)$('resultDialog').close();if($('gameMenuDialog').open)$('gameMenuDialog').close();state.game?.destroy();state.game=null;
    if(state.room){const fresh=await state.network.getRoom(state.room.code).catch(()=>null);if(fresh)state.room=fresh;showScreen('room');renderRoom();}else showScreen('home');
  }

  async function quitRace(){
    if($('gameMenuDialog').open)$('gameMenuDialog').close();state.game?.destroy();state.game=null;await leaveRoom();
  }

  async function leaveRoom(updateHistory=true){
    try{if(state.room)await state.network.leaveRoom(state.room,state.profile.id);}catch(error){console.error(error);}state.network.unsubscribeRoom();await state.network.closeGameChannel();state.gameChannelReady=false;state.game?.destroy();state.game=null;state.room=null;state.isHost=false;showScreen('home');if(updateHistory)history.replaceState(null,'',location.pathname);await loadRooms();
  }

  async function copyRoomLink(){
    const link=`${location.origin}${location.pathname}?room=${state.room.code}`;try{await navigator.clipboard.writeText(link);toast('Đã sao chép link mời.');}catch{prompt('Sao chép link này:',link);}
  }

  window.addEventListener('beforeunload',()=>{if(state.room&&!state.isHost&&state.network?.isOnline)state.network.client?.from('room_players').delete().eq('room_id',state.room.id).eq('player_id',state.profile.id).then(()=>{});});
  init().catch(error=>{console.error(error);toast('Game khởi động không thành công.');});
})();
