(() => {
  'use strict';
  const CAR_FILES = ['green','orange','red','white','blue','purple','pink','yellow'].map(x => `assets/cars/car-${x}.png`);
  const AVATAR = i => `assets/avatars/avatar-${String(i).padStart(2,'0')}.png`;
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const lerp = (a,b,t) => a+(b-a)*t;
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const formatTime = seconds => {
    seconds = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  };

  class RNG {
    constructor(seed=1){this.s=(seed>>>0)||1;}
    next(){this.s=(this.s*1664525+1013904223)>>>0;return this.s/4294967296;}
    int(a,b){return Math.floor(this.next()*(b-a+1))+a;}
    pick(a){return a[Math.floor(this.next()*a.length)];}
  }

  class HighwayGame {
    constructor({canvas, room, profile, network, isHost, onEnd, hud}) {
      this.canvas=canvas; this.ctx=canvas.getContext('2d'); this.room=room; this.profile=profile;
      this.network=network; this.isHost=isHost; this.onEnd=onEnd; this.hud=hud;
      this.settings={
        ...(room.settings||{}), mode:room.mode, maxPlayers:room.max_players, laneCount:room.lane_count,
        durationSeconds:room.duration_seconds, aiDifficulty:room.ai_difficulty,
        obstacleDensity:room.obstacle_density, powerupDensity:room.powerup_density
      };
      this.lanes=clamp(Number(this.settings.laneCount)||4,2,8);
      this.duration=Number(this.settings.durationSeconds)||0;
      this.totalDistance=this.settings.mode==='race' ? Math.max(2500,(this.duration||120)*92) : Infinity;
      this.seed=room.seed||12345;
      this.rng=new RNG(this.seed);
      this.courseRng=new RNG(this.seed ^ 0x9e3779b9);
      this.items=[]; this.dynamicItems=[]; this.nextCourseZ=160; this.itemSerial=0;
      this.racers=new Map(); this.local=null; this.ai=[];
      this.running=false; this.ended=false; this.startAt=0; this.lastTs=0; this.elapsed=0;
      this.sendAccumulator=0; this.firstFinishAt=0; this.endlessEndSent=false;
      this.viewDistance=900; this.keys={}; this.images={cars:[],avatars:[],obstacles:{}};
      this.nitro={active:false,start:0,passDuration:.72,pos:0,pass:0,nextIndex:0,nextEndless:850};
      this.lastFrameRequest=0; this.resizeObserver=null;
      this.boundResize=()=>this.resize();
      this.colors=['#40b883','#ffb13b','#e85555','#f1f1f1','#3d8ef5','#8d62d9','#ff71ad','#f2d54f'];
      this.setupRacers();
      this.setupInput();
    }

    setupRacers(){
      const humans=(this.room.players||[]).slice().sort((a,b)=>a.slot-b.slot);
      humans.forEach((p,index)=>{
        const r=this.makeRacer({id:p.player_id,name:p.name,avatar:p.avatar,color:p.color??index,slot:p.slot??index,isAI:false});
        this.racers.set(r.id,r); if(r.id===this.profile.id){this.local=r; r.local=true;}
      });
      if(!this.local){
        const r=this.makeRacer({id:this.profile.id,name:this.profile.name,avatar:this.profile.avatar,color:this.profile.color||0,slot:0,isAI:false});
        this.racers.set(r.id,r);this.local=r;r.local=true;
      }
      const missing=Math.max(0,(Number(this.settings.maxPlayers)||4)-humans.length);
      for(let i=0;i<missing;i++){
        const slot=humans.length+i;
        const r=this.makeRacer({id:`AI-${this.seed}-${i}`,name:`AI ${i+1}`,avatar:(slot%22)+1,color:slot%8,slot,isAI:true});
        this.racers.set(r.id,r);this.ai.push(r);
      }
    }

    makeRacer({id,name,avatar,color,slot,isAI}){
      const diff=Number(this.settings.aiDifficulty||6);
      return {id,name,avatar:Number(avatar)||1,color:Number(color)||0,slot:Number(slot)||0,isAI,
        lane:clamp(Number(slot)||0,0,this.lanes-1),targetLane:clamp(Number(slot)||0,0,this.lanes-1),lanePos:clamp(Number(slot)||0,0,this.lanes-1),
        distance:0,speed:0,targetSpeed:72,score:0,coins:0,finished:false,finishTime:null,
        invincibleUntil:0,shield:0,ghostUntil:0,magnetUntil:0,jammedUntil:0,boostUntil:0,boostAmount:0,
        lastHit:0,lastDecision:0,aiReaction:lerp(.78,.18,diff/10)+Math.random()*.18,
        aiSkill:clamp(diff/10+(Math.random()-.5)*.18,.1,1),collected:new Set(),local:false,displayDistance:0};
    }

    async load(){
      const loadImage=src=>new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=src;});
      this.images.cars=await Promise.all(CAR_FILES.map(loadImage));
      this.images.avatars=await Promise.all(Array.from({length:22},(_,i)=>loadImage(AVATAR(i+1))));
      const pairs={barrier:'assets/obstacles/barrier-red.png',pylon:'assets/obstacles/pylon.png',traffic:'assets/obstacles/traffic-car.png'};
      await Promise.all(Object.entries(pairs).map(async([k,v])=>this.images.obstacles[k]=await loadImage(v)));
      this.resize();
    }

    setupInput(){
      this.onKeyDown=e=>{
        if(['ArrowLeft','ArrowRight','ArrowUp',' ','a','A','d','D'].includes(e.key))e.preventDefault();
        if(e.repeat)return;
        if(e.key==='ArrowLeft'||e.key==='a'||e.key==='A')this.move(-1);
        if(e.key==='ArrowRight'||e.key==='d'||e.key==='D')this.move(1);
        if(e.key==='ArrowUp'||e.key===' ')this.hitNitro();
      };
      window.addEventListener('keydown',this.onKeyDown,{passive:false});
      window.addEventListener('resize',this.boundResize);
      let startX=0,startY=0;
      this.onPointerDown=e=>{startX=e.clientX;startY=e.clientY;};
      this.onPointerUp=e=>{const dx=e.clientX-startX,dy=e.clientY-startY;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy))this.move(dx>0?1:-1);};
      this.canvas.addEventListener('pointerdown',this.onPointerDown);
      this.canvas.addEventListener('pointerup',this.onPointerUp);
    }

    bindButtons({left,right,boost}){
      const fire=(button,fn)=>{button.onpointerdown=e=>{e.preventDefault();fn();};};
      fire(left,()=>this.move(-1));fire(right,()=>this.move(1));fire(boost,()=>this.hitNitro());
    }

    destroy(){
      this.running=false; cancelAnimationFrame(this.lastFrameRequest);
      window.removeEventListener('keydown',this.onKeyDown);window.removeEventListener('resize',this.boundResize);
      if(this.onPointerDown)this.canvas.removeEventListener('pointerdown',this.onPointerDown);if(this.onPointerUp)this.canvas.removeEventListener('pointerup',this.onPointerUp);
    }

    start(startAt){
      this.startAt=startAt||Date.now()+3000;this.running=true;this.lastTs=performance.now();
      this.lastFrameRequest=requestAnimationFrame(ts=>this.loop(ts));
    }

    resize(){
      const dpr=Math.min(2,window.devicePixelRatio||1);const rect=this.canvas.getBoundingClientRect();
      this.canvas.width=Math.max(1,Math.floor(rect.width*dpr));this.canvas.height=Math.max(1,Math.floor(rect.height*dpr));
      this.ctx.setTransform(dpr,0,0,dpr,0,0);this.width=rect.width;this.height=rect.height;this.dpr=dpr;
    }

    move(dir){
      if(!this.running||this.ended||Date.now()<this.startAt||this.local.finished)return;
      if(performance.now()<this.local.jammedUntil)return;
      this.local.targetLane=clamp(this.local.targetLane+dir,0,this.lanes-1);
    }

    hitNitro(){
      if(!this.nitro.active)return;
      const d=Math.abs(this.nitro.pos-.5), perfectHalf=clamp(Number(this.settings.perfectZone||5),2,12)/200;
      let grade,amount,duration,points;
      if(d<=perfectHalf){grade='PERFECT';amount=82;duration=4.2;points=50;}
      else if(d<=perfectHalf+.075){grade='GREAT';amount=52;duration=3.1;points=25;}
      else if(d<=perfectHalf+.19){grade='COOL';amount=26;duration=2;points=10;}
      else {grade='BAD';amount=7;duration=.7;points=0;}
      this.local.boostAmount=Math.max(this.local.boostAmount,amount);this.local.boostUntil=performance.now()+duration*1000;
      this.local.score+=points;this.nitro.active=false;this.hud.nitroPanel.hidden=true;this.showGrade(grade);
    }

    showGrade(text){
      const el=this.hud.gradePop;el.textContent=text;el.classList.remove('show');void el.offsetWidth;el.classList.add('show');
    }

    loop(ts){
      if(!this.running)return;
      const dt=Math.min(.035,Math.max(0,(ts-this.lastTs)/1000));this.lastTs=ts;
      const now=Date.now();
      if(now<this.startAt){this.updateCountdown(now);this.render();this.lastFrameRequest=requestAnimationFrame(t=>this.loop(t));return;}
      this.hud.countdown.textContent='';
      if(!this.ended){this.elapsed=(now-this.startAt)/1000;this.update(dt,ts);}
      this.render();this.updateHud();
      this.lastFrameRequest=requestAnimationFrame(t=>this.loop(t));
    }

    updateCountdown(now){
      const n=Math.ceil((this.startAt-now)/1000);this.hud.countdown.textContent=n>0?n:'GO!';
    }

    update(dt,ts){
      this.ensureCourse(this.local.distance+this.viewDistance+1200);
      this.updateRacer(this.local,dt,ts,false);
      if(this.isHost)this.updateAI(dt,ts);
      for(const r of this.racers.values())if(!r.local&&!r.isAI)this.extrapolateRemote(r,dt);
      if(!this.isHost)for(const r of this.ai)this.extrapolateRemote(r,dt);
      this.checkLocalItems(ts);this.checkRacerCollision(ts);this.updateNitro(ts);
      this.sendAccumulator+=dt;
      if(this.sendAccumulator>=1/(Number(window.LCR_CONFIG.STATE_SEND_HZ)||10)){
        this.sendAccumulator=0;this.broadcastState();
      }
      this.checkEnd(ts);
    }

    currentBaseSpeed(r){
      const progress=this.settings.mode==='race'?clamp(r.distance/this.totalDistance,0,1):clamp(this.elapsed/240,0,1);
      return 70+progress*38;
    }

    updateRacer(r,dt,ts,isAI){
      if(r.finished){r.speed=Math.max(0,r.speed-dt*40);return;}
      if(ts<r.jammedUntil){};
      const base=this.currentBaseSpeed(r)+(isAI?(r.aiSkill-.5)*9:0);
      const boost=ts<r.boostUntil?r.boostAmount:0;if(ts>=r.boostUntil)r.boostAmount=0;
      r.targetSpeed=clamp(base+boost,45,175);r.speed=lerp(r.speed||0,r.targetSpeed,clamp(dt*(boost?4.5:2.2),0,1));
      r.lanePos=lerp(r.lanePos,r.targetLane,clamp(dt*(ts<r.jammedUntil?3.2:8.5),0,1));
      r.distance+=r.speed*dt;
      if(this.settings.mode==='race'&&r.distance>=this.totalDistance){
        r.distance=this.totalDistance;r.finished=true;r.finishTime=this.elapsed;if(!this.firstFinishAt)this.firstFinishAt=ts;
        if(r.local)this.network.sendGame({type:'finish',playerId:r.id,finishTime:r.finishTime,distance:r.distance,score:r.score});
      }
    }

    extrapolateRemote(r,dt){
      if(r.finished)return;r.distance+=(r.speed||0)*dt*.7;r.lanePos=lerp(r.lanePos,r.targetLane,clamp(dt*7,0,1));
    }

    updateAI(dt,ts){
      for(const r of this.ai){
        if(r.finished)continue;
        if(ts-r.lastDecision>r.aiReaction*1000){r.lastDecision=ts;this.aiDecide(r,ts);}
        this.updateRacer(r,dt,ts,true);this.aiCollisions(r,ts);
        if(Math.random()<dt*(.012+.025*r.aiSkill)){r.boostAmount=35+35*r.aiSkill;r.boostUntil=ts+(1.5+2*r.aiSkill)*1000;}
      }
    }

    aiDecide(r,ts){
      const threats=this.items.concat(this.dynamicItems).filter(i=>i.kind==='obstacle'||i.kind==='oil').filter(i=>i.z>r.distance&&i.z-r.distance<210);
      const laneRisk=Array(this.lanes).fill(0);
      for(const i of threats){const d=i.z-r.distance;laneRisk[i.lane]+=Math.max(1,230-d);}
      for(const other of this.racers.values())if(other.id!==r.id){const d=other.distance-r.distance;if(d>0&&d<130)laneRisk[Math.round(other.lanePos)]+=90;}
      if(Math.random()>.55-r.aiSkill*.3){
        for(const i of this.items){if(i.z>r.distance&&i.z-r.distance<190&&(i.kind==='coin'||i.kind==='power'))laneRisk[i.lane]-=i.kind==='power'?55:22;}
      }
      const choices=[r.targetLane];if(r.targetLane>0)choices.push(r.targetLane-1);if(r.targetLane<this.lanes-1)choices.push(r.targetLane+1);
      choices.sort((a,b)=>laneRisk[a]-laneRisk[b]+(Math.random()-.5)*(1-r.aiSkill)*80);
      if(Math.random()<.08*(1-r.aiSkill))r.targetLane=clamp(r.targetLane+(Math.random()<.5?-1:1),0,this.lanes-1);else r.targetLane=choices[0];
    }

    aiCollisions(r,ts){
      if(ts<r.invincibleUntil||ts<r.ghostUntil)return;
      for(const item of this.items.concat(this.dynamicItems)){
        if(item.kind!=='obstacle'&&item.kind!=='oil')continue;
        if(Math.abs(item.z-r.distance)<24&&Math.abs(item.lane-r.lanePos)<.42){
          if(r.shield>0){r.shield--;return;}r.speed*=.48;r.invincibleUntil=ts+Number(this.settings.invincibleSeconds||2)*1000;r.score-=20;return;
        }
      }
    }

    ensureCourse(untilZ){
      while(this.nextCourseZ<untilZ){
        const density=clamp(Number(this.settings.obstacleDensity||6),1,10);
        const phase=this.settings.mode==='race'?clamp(this.nextCourseZ/this.totalDistance,0,1):clamp(this.nextCourseZ/14000,0,1);
        const spacing=(lerp(270,125,density/10)+this.courseRng.next()*80)*(1-phase*.24);
        this.nextCourseZ+=spacing;
        this.generatePattern(this.nextCourseZ);
      }
    }

    generatePattern(z){
      const phase=this.settings.mode==='race'?clamp(z/this.totalDistance,0,1):clamp(z/14000,0,1);
      const maxBlock=Math.max(1,Math.min(this.lanes-1,Math.ceil(this.lanes*(.14+.025*Number(this.settings.obstacleDensity||6)+phase*.14))));
      const blockCount=this.courseRng.int(1,maxBlock);const lanes=[...Array(this.lanes).keys()];
      for(let i=lanes.length-1;i>0;i--){const j=this.courseRng.int(0,i);[lanes[i],lanes[j]]=[lanes[j],lanes[i]];}
      const blocked=new Set(lanes.slice(0,blockCount));
      for(const lane of blocked){
        const type=this.courseRng.next()<.2?'traffic':this.courseRng.next()<.42?'pylon':'barrier';
        this.items.push({id:`i${this.itemSerial++}`,kind:'obstacle',type,lane,z:z+this.courseRng.int(-14,14)});
      }
      const open=lanes.filter(l=>!blocked.has(l));
      if(open.length){
        const coinLane=this.courseRng.pick(open);const count=this.courseRng.int(2,5);
        for(let i=0;i<count;i++)this.items.push({id:`i${this.itemSerial++}`,kind:'coin',lane:coinLane,z:z-95-i*35,value:10});
        const pChance=.12+Number(this.settings.powerupDensity||5)*.045;
        if(this.courseRng.next()<pChance){
          const types=['shield','ghost','magnet','turbo','shockwave','oil'];
          this.items.push({id:`i${this.itemSerial++}`,kind:'power',type:this.courseRng.pick(types),lane:this.courseRng.pick(open),z:z-48});
        }
      }
      if(this.courseRng.next()<.18&&open.length>1){
        const lane=this.courseRng.pick(open);for(let i=0;i<6;i++)this.items.push({id:`i${this.itemSerial++}`,kind:'coin',lane,z:z+70+i*34,value:i===5?50:10});
      }
    }

    checkLocalItems(ts){
      const r=this.local;
      for(const item of this.items.concat(this.dynamicItems)){
        if(r.collected.has(item.id))continue;
        const laneDist=Math.abs(item.lane-r.lanePos),zDist=Math.abs(item.z-r.distance);
        if(item.kind==='coin'&&ts<r.magnetUntil&&item.z>r.distance-30&&item.z-r.distance<230&&laneDist<=2.1){this.collectCoin(item,r);continue;}
        if(zDist>27||laneDist>.43)continue;
        if(item.kind==='coin')this.collectCoin(item,r);
        else if(item.kind==='power'){r.collected.add(item.id);this.applyPower(item.type,ts);}
        else if((item.kind==='obstacle'||item.kind==='oil')&&ts>=r.invincibleUntil&&ts>=r.ghostUntil){
          r.collected.add(item.id);this.hitObstacle(item,ts);
        }
      }
    }

    collectCoin(item,r){r.collected.add(item.id);r.coins+=item.value>=50?5:1;r.score+=item.value||10;}

    hitObstacle(item,ts){
      const r=this.local;if(r.shield>0){r.shield--;this.showGrade('SHIELD');return;}
      r.speed*=.42;r.score=Math.max(0,r.score-30);r.invincibleUntil=ts+Number(this.settings.invincibleSeconds||2)*1000;r.lastHit=ts;this.showGrade('CRASH');
    }

    applyPower(type,ts){
      const r=this.local;
      if(type==='shield'){r.shield=1;this.showGrade('SHIELD');}
      if(type==='ghost'){r.ghostUntil=ts+2200;r.invincibleUntil=Math.max(r.invincibleUntil,r.ghostUntil);this.showGrade('GHOST');}
      if(type==='magnet'){r.magnetUntil=ts+5000;this.showGrade('MAGNET');}
      if(type==='turbo'){r.boostAmount=48;r.boostUntil=ts+2200;this.showGrade('TURBO');}
      if(type==='shockwave'){
        this.showGrade('SHOCKWAVE');this.network.sendGame({type:'effect',effect:'shockwave',sourceId:r.id,distance:r.distance,lane:r.lanePos});
        this.applyShockwaveToAI(r.id,r.distance,r.lanePos);
      }
      if(type==='oil'){
        this.showGrade('OIL');const hazard={id:`oil-${r.id}-${Date.now()}`,kind:'oil',type:'oil',lane:Math.round(r.lanePos),z:r.distance-35,expiresAt:r.distance+2500};
        this.dynamicItems.push(hazard);this.network.sendGame({type:'hazard',hazard});
      }
    }

    applyShockwaveToAI(sourceId,distance,lane){
      if(!this.isHost)return;
      for(const r of this.ai)if(r.id!==sourceId&&Math.abs(r.distance-distance)<130&&Math.abs(r.lanePos-lane)<=1.2){
        const dir=r.lanePos<=lane?-1:1;r.targetLane=clamp(r.targetLane+dir,0,this.lanes-1);r.speed*=.7;r.jammedUntil=performance.now()+600;
      }
    }

    checkRacerCollision(ts){
      const r=this.local;if(ts<r.invincibleUntil||ts<r.ghostUntil)return;
      for(const other of this.racers.values()){
        if(other.id===r.id||other.finished)continue;
        if(Math.abs(other.distance-r.distance)<25&&Math.abs(other.lanePos-r.lanePos)<.38){
          if(r.shield>0){r.shield--;return;}
          r.speed*=.68;r.invincibleUntil=ts+Number(this.settings.invincibleSeconds||2)*1000;r.score+=10;r.targetLane=clamp(r.targetLane+(r.lanePos<=other.lanePos?-1:1),0,this.lanes-1);return;
        }
      }
    }

    updateNitro(ts){
      if(this.nitro.active){
        const elapsed=(ts-this.nitro.start)/1000;const phase=elapsed/this.nitro.passDuration;const pass=Math.floor(phase);
        if(pass>=4){this.nitro.active=false;this.hud.nitroPanel.hidden=true;this.showGrade('MISS');return;}
        const p=phase-pass;this.nitro.pos=pass%2===0?p:1-p;this.nitro.pass=pass;
        this.hud.nitroDot.style.left=`${this.nitro.pos*100}%`;this.hud.nitroPasses.textContent=`Lượt ${pass+1}/4`;return;
      }
      if(this.local.finished)return;
      let trigger=false;
      if(this.settings.mode==='race'){
        const marks=[.2,.4,.6,.8];if(this.nitro.nextIndex<marks.length&&this.local.distance/this.totalDistance>=marks[this.nitro.nextIndex]){this.nitro.nextIndex++;trigger=true;}
      }else if(this.local.distance>=this.nitro.nextEndless){this.nitro.nextEndless+=900;trigger=true;}
      if(trigger){
        this.nitro.active=true;this.nitro.start=ts;this.nitro.passDuration=clamp(1.06-Number(this.settings.nitroSpeed||7)*.055,.46,1);this.hud.nitroPanel.hidden=false;
      }
    }

    broadcastState(){
      const state=this.serializeRacer(this.local);const payload={type:'state',playerId:this.local.id,state};
      if(this.isHost)payload.aiStates=this.ai.map(r=>this.serializeRacer(r));
      this.network.sendGame(payload);
    }

    serializeRacer(r){return {id:r.id,name:r.name,avatar:r.avatar,color:r.color,lane:r.lane,targetLane:r.targetLane,lanePos:r.lanePos,distance:r.distance,speed:r.speed,score:r.score,coins:r.coins,finished:r.finished,finishTime:r.finishTime,invincible:performance.now()<r.invincibleUntil};}

    handleNetworkMessage(msg){
      if(!msg||this.ended)return;
      if(msg.type==='state'&&msg.playerId!==this.local.id){this.mergeRemote(msg.state);for(const s of msg.aiStates||[])this.mergeRemote(s);}
      if(msg.type==='finish'&&msg.playerId!==this.local.id){const r=this.racers.get(msg.playerId);if(r){r.finished=true;r.finishTime=msg.finishTime;r.distance=msg.distance||this.totalDistance;if(!this.firstFinishAt)this.firstFinishAt=performance.now();}}
      if(msg.type==='hazard'&&msg.hazard&&!this.dynamicItems.some(i=>i.id===msg.hazard.id))this.dynamicItems.push(msg.hazard);
      if(msg.type==='effect'&&msg.effect==='shockwave'&&msg.sourceId!==this.local.id){
        if(Math.abs(this.local.distance-msg.distance)<130&&Math.abs(this.local.lanePos-msg.lane)<=1.2&&performance.now()>=this.local.invincibleUntil){
          const dir=this.local.lanePos<=msg.lane?-1:1;this.local.targetLane=clamp(this.local.targetLane+dir,0,this.lanes-1);this.local.speed*=.7;this.local.jammedUntil=performance.now()+700;this.showGrade('HIT!');
        }
      }
      if(msg.type==='end')this.end(msg.reason||'Kết thúc');
    }

    mergeRemote(s){
      if(!s||s.id===this.local.id)return;let r=this.racers.get(s.id);
      if(!r){r=this.makeRacer({id:s.id,name:s.name,avatar:s.avatar,color:s.color,slot:0,isAI:String(s.id).startsWith('AI-')});this.racers.set(r.id,r);}
      Object.assign(r,{name:s.name,avatar:s.avatar,color:s.color,targetLane:s.targetLane,lane:s.lane,lanePos:s.lanePos,distance:s.distance,speed:s.speed,score:s.score,coins:s.coins,finished:s.finished,finishTime:s.finishTime});
    }

    checkEnd(ts){
      if(this.ended)return;
      if(this.settings.mode==='endless'&&this.duration>0&&this.elapsed>=this.duration){if(this.isHost&&!this.endlessEndSent){this.endlessEndSent=true;this.network.sendGame({type:'end',reason:'Hết thời gian'});}this.end('Hết thời gian');return;}
      if(this.settings.mode==='race'){
        const finished=[...this.racers.values()].filter(r=>r.finished);
        if(finished.length&&this.firstFinishAt===0)this.firstFinishAt=ts;
        if(this.isHost&&this.firstFinishAt&&(finished.length===this.racers.size||ts-this.firstFinishAt>7000)){
          this.network.sendGame({type:'end',reason:'Đã về đích'});this.end('Đã về đích');
        }
      }
    }

    end(reason){
      if(this.ended)return;this.ended=true;this.nitro.active=false;this.hud.nitroPanel.hidden=true;
      const results=[...this.racers.values()].sort((a,b)=>{
        if(this.settings.mode==='endless')return b.score-a.score||b.distance-a.distance;
        if(a.finished&&b.finished)return (a.finishTime??9999)-(b.finishTime??9999);
        if(a.finished)return -1;if(b.finished)return 1;return b.distance-a.distance;
      }).map((r,i)=>({...this.serializeRacer(r),place:i+1}));
      setTimeout(()=>this.onEnd?.(reason,results),550);
    }

    updateHud(){
      const r=this.local;const ordered=[...this.racers.values()].sort((a,b)=>this.settings.mode==='endless'?b.score-a.score:b.distance-a.distance);
      const rank=Math.max(1,ordered.findIndex(x=>x.id===r.id)+1);
      this.hud.speed.textContent=Math.round(r.speed*2.55);this.hud.rank.textContent=`${rank}/${this.racers.size}`;this.hud.score.textContent=Math.max(0,Math.round(r.score));this.hud.coin.textContent=r.coins;
      if(this.settings.mode==='race'){
        const p=clamp(r.distance/this.totalDistance,0,1);this.hud.progress.style.width=`${p*100}%`;this.hud.distance.textContent=`${Math.round(p*100)}%`;this.hud.timer.textContent=formatTime(this.elapsed);
      }else{
        this.hud.progress.style.width=`${(r.distance%1000)/10}%`;this.hud.distance.textContent=`${Math.floor(r.distance)} m`;this.hud.timer.textContent=this.duration>0?formatTime(this.duration-this.elapsed):formatTime(this.elapsed);
      }
      const effects=[];const t=performance.now();if(r.shield)effects.push('🛡 Khiên');if(t<r.ghostUntil)effects.push('👻 Xuyên vật cản');if(t<r.magnetUntil)effects.push('🧲 Nam châm');if(t<r.invincibleUntil)effects.push('✨ Bất tử');
      this.hud.effects.innerHTML=effects.map(x=>`<span class="effect-badge">${x}</span>`).join('');
    }

    roadGeometry(y){
      const horizon=this.height*.18,bottom=this.height*.98,t=clamp((y-horizon)/(bottom-horizon),0,1);const eased=Math.pow(t,1.35);
      const topW=Math.max(110,this.width*.14),bottomW=Math.min(this.width*.96,105*this.lanes+100);const w=lerp(topW,bottomW,eased);
      const curve=Math.sin((this.local.distance+y*1.7)/780)*this.width*.035*(1-t);
      return {left:this.width/2-w/2+curve,width:w,t};
    }

    project(relDistance,lane){
      const horizon=this.height*.18,bottom=this.height*.94;const q=clamp(1-relDistance/this.viewDistance,0,1);const y=horizon+Math.pow(q,1.55)*(bottom-horizon);const g=this.roadGeometry(y);const laneW=g.width/this.lanes;return {x:g.left+(lane+.5)*laneW,y,scale:lerp(.18,1.05,Math.pow(q,1.6)),laneW};
    }

    render(){
      const c=this.ctx,w=this.width,h=this.height;if(!w||!h)return;
      const sky=c.createLinearGradient(0,0,0,h*.65);sky.addColorStop(0,'#77c7ee');sky.addColorStop(1,'#e9f7ff');c.fillStyle=sky;c.fillRect(0,0,w,h);
      this.drawBackground(c,w,h);this.drawRoad(c,w,h);this.drawWorldItems(c);this.drawRacers(c);this.drawSpeedLines(c);
    }

    drawBackground(c,w,h){
      c.fillStyle='#9cc789';c.beginPath();c.moveTo(0,h*.42);for(let x=0;x<=w;x+=80)c.lineTo(x,h*.31+Math.sin(x*.013+this.local.distance*.0009)*34);c.lineTo(w,h*.62);c.lineTo(0,h*.62);c.fill();
      c.fillStyle='#60945d';c.beginPath();c.moveTo(0,h*.5);for(let x=0;x<=w;x+=55)c.lineTo(x,h*.39+Math.sin(x*.02+1.4)*24);c.lineTo(w,h*.66);c.lineTo(0,h*.66);c.fill();
      c.fillStyle='#4f9e63';c.fillRect(0,h*.52,w,h*.48);
      for(let i=0;i<18;i++){const x=(i*137-(this.local.distance*1.7)%137+w)%w;const y=h*.48+(i%3)*18;c.fillStyle=i%2?'#2e7445':'#3a8650';c.fillRect(x,y,5,32);c.beginPath();c.arc(x+2,y,13,0,Math.PI*2);c.fill();}
    }

    drawRoad(c,w,h){
      const horizon=h*.18,bottom=h*.99;const gt=this.roadGeometry(horizon),gb=this.roadGeometry(bottom);
      c.fillStyle='#263b38';c.beginPath();c.moveTo(gt.left,horizon);c.lineTo(gt.left+gt.width,horizon);c.lineTo(gb.left+gb.width,bottom);c.lineTo(gb.left,bottom);c.closePath();c.fill();
      c.strokeStyle='#e7d9ba';c.lineWidth=8;c.beginPath();c.moveTo(gt.left,horizon);c.lineTo(gb.left,bottom);c.moveTo(gt.left+gt.width,horizon);c.lineTo(gb.left+gb.width,bottom);c.stroke();
      const offset=(this.local.distance*1.8)%120;
      for(let lane=1;lane<this.lanes;lane++){
        for(let k=0;k<11;k++){
          const rel=k*120-offset;const q=clamp(1-rel/1200,0,1);const y=horizon+Math.pow(q,1.5)*(bottom-horizon);const y2=Math.min(bottom,y+lerp(3,34,q));
          const g1=this.roadGeometry(y),g2=this.roadGeometry(y2);const x1=g1.left+g1.width*lane/this.lanes,x2=g2.left+g2.width*lane/this.lanes;
          c.strokeStyle='rgba(255,255,255,.8)';c.lineWidth=lerp(1,5,q);c.beginPath();c.moveTo(x1,y);c.lineTo(x2,y2);c.stroke();
        }
      }
      for(let k=0;k<16;k++){const rel=k*85-(this.local.distance*2.4)%85;const q=clamp(1-rel/1000,0,1);const y=horizon+Math.pow(q,1.5)*(bottom-horizon);const g=this.roadGeometry(y);c.fillStyle=`rgba(255,255,255,${.03+.07*q})`;c.fillRect(g.left,y,g.width,lerp(1,4,q));}
      if(this.settings.mode==='race'){
        const rel=this.totalDistance-this.local.distance;if(rel>0&&rel<this.viewDistance){const p=this.project(rel,0);const g=this.roadGeometry(p.y);const size=Math.max(3,p.scale*17);for(let x=g.left;x<g.left+g.width;x+=size)for(let row=0;row<2;row++){c.fillStyle=((Math.floor((x-g.left)/size)+row)%2)?'#fff':'#111';c.fillRect(x,p.y+row*size,size,size);}}
      }
    }

    drawWorldItems(c){
      const visible=this.items.concat(this.dynamicItems).filter(i=>!this.local.collected.has(i.id)&&i.z-this.local.distance>-20&&i.z-this.local.distance<this.viewDistance).sort((a,b)=>b.z-a.z);
      for(const item of visible){const rel=item.z-this.local.distance,p=this.project(rel,item.lane);if(p.y<this.height*.17)continue;
        if(item.kind==='coin')this.drawCoin(c,p.x,p.y,p.scale,item.value);
        else if(item.kind==='power')this.drawPower(c,p.x,p.y,p.scale,item.type);
        else this.drawObstacle(c,p,item);
      }
    }

    drawCoin(c,x,y,s,value){const r=clamp(7*s,3,15);c.save();c.translate(x,y);c.fillStyle=value>=50?'#fff2a0':'#ffd34f';c.strokeStyle='#de8d19';c.lineWidth=Math.max(1,2*s);c.beginPath();c.ellipse(0,0,r*.65,r,0,0,Math.PI*2);c.fill();c.stroke();c.fillStyle='#bd7919';c.font=`${Math.max(6,10*s)}px sans-serif`;c.textAlign='center';c.textBaseline='middle';c.fillText('$',0,0);c.restore();}

    drawPower(c,x,y,s,type){const icons={shield:'🛡',ghost:'👻',magnet:'🧲',turbo:'⚡',shockwave:'💥',oil:'🛢'};const r=clamp(14*s,7,28);c.save();c.translate(x,y);c.fillStyle='rgba(255,255,255,.93)';c.strokeStyle='#ff9b42';c.lineWidth=Math.max(1,3*s);c.beginPath();c.arc(0,0,r,0,Math.PI*2);c.fill();c.stroke();c.font=`${Math.max(10,22*s)}px "Segoe UI Emoji"`;c.textAlign='center';c.textBaseline='middle';c.fillText(icons[type]||'?',0,1);c.restore();}

    drawObstacle(c,p,item){let im=this.images.obstacles[item.type]||this.images.obstacles.barrier;let base= item.type==='traffic'?95:70;const width=clamp(base*p.scale,12,p.laneW*.82);const ratio=im.height/im.width;c.save();if(item.kind==='oil'){c.fillStyle='rgba(25,20,18,.86)';c.beginPath();c.ellipse(p.x,p.y,width*.46,width*.16,0,0,Math.PI*2);c.fill();}else c.drawImage(im,p.x-width/2,p.y-width*ratio,width,width*ratio);c.restore();}

    drawRacers(c){
      const list=[...this.racers.values()].filter(r=>r.id!==this.local.id).map(r=>({r,rel:r.distance-this.local.distance})).filter(x=>x.rel>-45&&x.rel<this.viewDistance).sort((a,b)=>b.rel-a.rel);
      for(const {r,rel} of list){const p=this.project(rel,r.lanePos);this.drawCar(c,r,p.x,p.y,p.scale*.9,false);}
      const p=this.project(5,this.local.lanePos);this.drawCar(c,this.local,p.x,Math.min(this.height*.84,p.y-15),1.08,true);
    }

    drawCar(c,r,x,y,s,isLocal){
      const im=this.images.cars[r.color%this.images.cars.length];const road=this.roadGeometry(y);const width=Math.min(clamp(66*s,20,isLocal?105:96),(road.width/this.lanes)*.82);const ratio=im.height/im.width;const blink=performance.now()<r.invincibleUntil&&Math.floor(performance.now()/110)%2===0;
      c.save();c.globalAlpha=blink ? .3 : 1;c.shadowColor=isLocal?'rgba(255,210,80,.8)':'rgba(0,0,0,.25)';c.shadowBlur=isLocal?18:8;c.drawImage(im,x-width/2,y-width*ratio,width,width*ratio);c.shadowBlur=0;
      const avSize=clamp(23*s,10,32);const av=this.images.avatars[(r.avatar-1)%this.images.avatars.length];c.fillStyle='rgba(255,255,255,.9)';c.beginPath();c.arc(x,y-width*ratio*.72,avSize*.55,0,Math.PI*2);c.fill();try{c.drawImage(av,x-avSize/2,y-width*ratio*.72-avSize/2,avSize,avSize);}catch{}
      c.font=`800 ${clamp(10*s,8,15)}px sans-serif`;c.textAlign='center';c.fillStyle='#fff';c.strokeStyle='rgba(0,0,0,.65)';c.lineWidth=3;c.strokeText(r.name,x,y+14*s);c.fillText(r.name,x,y+14*s);c.restore();
    }

    drawSpeedLines(c){if(this.local.speed<118)return;const strength=clamp((this.local.speed-118)/45,0,1);c.strokeStyle=`rgba(255,255,255,${.15+.35*strength})`;c.lineWidth=2;for(let i=0;i<18;i++){const x=(i*83+this.local.distance*5)%this.width,y=(i*59+this.local.distance*7)%this.height;c.beginPath();c.moveTo(x,y);c.lineTo(x+(x-this.width/2)*.08,y+30+50*strength);c.stroke();}}
  }

  window.HighwayGame=HighwayGame;
})();
