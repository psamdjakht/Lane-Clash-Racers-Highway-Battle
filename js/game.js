(() => {
  'use strict';
  const CAR_COLORS = ['green','orange','red','white','blue','purple','pink','yellow'];
  const CAR_FILES = CAR_COLORS.map(x => `assets/cars/car-${x}.png`);
  const PERSPECTIVE_CAR_FILES = CAR_COLORS.map(color => ({
    n:`assets/cars/perspective/car-${color}-n.png`,
    ne:`assets/cars/perspective/car-${color}-ne.png`,
    nw:`assets/cars/perspective/car-${color}-nw.png`
  }));
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
      this.totalDistance=this.settings.mode==='race' ? Math.max(3200,(this.duration||120)*128) : Infinity;
      this.seed=room.seed||12345;
      this.rng=new RNG(this.seed);
      this.courseRng=new RNG(this.seed ^ 0x9e3779b9);
      this.items=[]; this.dynamicItems=[]; this.nextCourseZ=160; this.itemSerial=0;
      this.racers=new Map(); this.local=null; this.ai=[];
      this.running=false; this.ended=false; this.startAt=0; this.lastTs=0; this.elapsed=0;
      this.sendAccumulator=0; this.firstFinishAt=0; this.endlessEndSent=false;
      this.viewDistance=640; this.playerAnchorRatio=.875; this.collisionGap=72; this.carFrontWorld=58; this.carRearWorld=22; this.keys={}; this.images={cars:[],perspectiveCars:[],avatars:[],obstacles:{}};
      this.curvePhase=(this.seed%997)*.00617; this.roadSliceDepth=12;
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
      const normalizedSlot=Math.max(0,Number(slot)||0);
      const startLane=normalizedSlot%this.lanes;
      const startDistance=-Math.floor(normalizedSlot/this.lanes)*72;
      return {id,name,avatar:Number(avatar)||1,color:Number(color)||0,slot:normalizedSlot,isAI,
        lane:startLane,targetLane:startLane,lanePos:startLane,
        distance:startDistance,prevDistance:startDistance,speed:0,targetSpeed:104,score:0,coins:0,finished:false,finishTime:null,
        invincibleUntil:0,shield:0,ghostUntil:0,magnetUntil:0,jammedUntil:0,boostUntil:0,boostAmount:0,
        lastHit:0,lastCarHit:0,lastDecision:0,nextBlockedNotice:0,aiReaction:lerp(.78,.18,diff/10)+Math.random()*.18,
        aiSkill:clamp(diff/10+(Math.random()-.5)*.18,.1,1),collected:new Set(),hitObstacles:new Set(),local:false,displayDistance:0,
        netDistance:null,netLanePos:null,netReceivedAt:0};
    }

    async load(){
      const loadImage=src=>new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=reject;im.src=src;});
      this.images.cars=await Promise.all(CAR_FILES.map(loadImage));
      this.images.perspectiveCars=await Promise.all(PERSPECTIVE_CAR_FILES.map(async frames=>({n:await loadImage(frames.n),ne:await loadImage(frames.ne),nw:await loadImage(frames.nw)})));
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
      const now=performance.now();
      if(now<this.local.jammedUntil)return;
      // Mỗi lần chỉ chuyển đúng một làn và phải ổn định xe trước khi chuyển tiếp.
      if(Math.abs(this.local.lanePos-this.local.targetLane)>.08)return;
      const current=clamp(Math.round(this.local.lanePos),0,this.lanes-1);
      const candidate=clamp(current+dir,0,this.lanes-1);
      if(candidate===current)return;
      // Không cho xe chui xuyên hoặc chồng lên xe đang chiếm làn bên cạnh.
      if(this.isLaneOccupiedFor(this.local,candidate,62)){
        this.local.speed*=.94;
        if(now>=this.local.nextBlockedNotice){this.local.nextBlockedNotice=now+700;this.showGrade('BỊ CHẶN');}
        return;
      }
      this.local.lane=current;
      this.local.targetLane=candidate;
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
      this.checkRacerCollision(ts);this.resolveTrafficSpacing(ts);this.checkLocalItems(ts);this.updateNitro(ts);
      this.sendAccumulator+=dt;
      if(this.sendAccumulator>=1/(Number(window.LCR_CONFIG.STATE_SEND_HZ)||10)){
        this.sendAccumulator=0;this.broadcastState();
      }
      this.checkEnd(ts);
    }

    currentBaseSpeed(r){
      const progress=this.settings.mode==='race'?clamp(r.distance/this.totalDistance,0,1):clamp(this.elapsed/240,0,1);
      return 104+progress*62;
    }

    updateRacer(r,dt,ts,isAI){
      r.prevDistance=r.distance;
      if(r.finished){r.speed=Math.max(0,r.speed-dt*40);return;}
      const base=this.currentBaseSpeed(r)+(isAI?(r.aiSkill-.5)*9:0);
      const boost=ts<r.boostUntil?r.boostAmount:0;if(ts>=r.boostUntil)r.boostAmount=0;
      let desiredSpeed=clamp(base+boost,70,235);
      // Xe phía sau phải giữ khoảng cách thay vì chạy xuyên vào xe phía trước.
      const ahead=this.findNearestAhead(r,r.targetLane,185);
      if(ahead){
        const gap=ahead.distance-r.distance;
        const safeGap=this.collisionGap+clamp((r.speed||0)*.06,0,10);
        if(gap<safeGap*2.25){
          const followSpeed=Math.max(32,(ahead.speed||55)+(gap-safeGap)*.52);
          desiredSpeed=Math.min(desiredSpeed,followSpeed);
        }
      }
      r.targetSpeed=desiredSpeed;
      r.speed=lerp(r.speed||0,r.targetSpeed,clamp(dt*(boost?5.4:3.8),0,1));
      const delta=r.targetLane-r.lanePos;
      const laneRate=ts<r.jammedUntil?2.35:3.65;
      const step=clamp(delta,-laneRate*dt,laneRate*dt);
      r.lanePos=clamp(r.lanePos+step,0,this.lanes-1);
      if(Math.abs(r.lanePos-r.targetLane)<.018){r.lanePos=r.targetLane;r.lane=r.targetLane;}
      r.distance+=r.speed*dt;
      if(this.settings.mode==='race'&&r.distance>=this.totalDistance){
        r.distance=this.totalDistance;r.finished=true;r.finishTime=this.elapsed;if(!this.firstFinishAt)this.firstFinishAt=ts;
        if(r.local)this.network.sendGame({type:'finish',playerId:r.id,finishTime:r.finishTime,distance:r.distance,score:r.score});
      }
    }

    findNearestAhead(r,lane,maxDistance=180){
      let best=null,bestGap=Infinity;
      for(const other of this.racers.values()){
        if(other.id===r.id||other.finished)continue;
        const occupies=Math.abs(other.lanePos-lane)<.5 || (Math.abs(other.targetLane-lane)<.05&&Math.abs(other.lanePos-lane)<.9);
        if(!occupies)continue;
        const gap=other.distance-r.distance;
        if(gap>0&&gap<bestGap&&gap<maxDistance){best=other;bestGap=gap;}
      }
      return best;
    }

    isLaneOccupiedFor(r,lane,range=60){
      for(const other of this.racers.values()){
        if(other.id===r.id||other.finished)continue;
        const occupies=Math.abs(other.lanePos-lane)<.52 || (Math.abs(other.targetLane-lane)<.05&&Math.abs(other.lanePos-lane)<.92);
        if(occupies&&Math.abs(other.distance-r.distance)<range)return true;
      }
      return false;
    }

    extrapolateRemote(r,dt){
      if(r.finished)return;
      if(r.netDistance==null){r.distance+=(r.speed||0)*dt*.55;return;}
      const age=Math.min(.22,(performance.now()-r.netReceivedAt)/1000);
      const predicted=r.netDistance+(r.speed||0)*age;
      r.distance=lerp(r.distance,predicted,clamp(dt*10,0,1));
      r.lanePos=lerp(r.lanePos,r.netLanePos??r.targetLane,clamp(dt*12,0,1));
      if(Math.abs(r.lanePos-r.targetLane)<.025){r.lanePos=r.targetLane;r.lane=r.targetLane;}
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
      if(Math.abs(r.lanePos-r.targetLane)>.08)return;
      const threats=this.items.concat(this.dynamicItems).filter(i=>i.kind==='obstacle'||i.kind==='oil').filter(i=>i.z>r.distance&&i.z-r.distance<230);
      const laneRisk=Array(this.lanes).fill(0);
      for(const i of threats){const d=i.z-r.distance;laneRisk[i.lane]+=Math.max(1,250-d);}
      for(const other of this.racers.values())if(other.id!==r.id&&!other.finished){
        const d=other.distance-r.distance;
        for(let lane=0;lane<this.lanes;lane++){
          const occupies=Math.abs(other.lanePos-lane)<.54 || (Math.abs(other.targetLane-lane)<.05&&Math.abs(other.lanePos-lane)<.9);
          if(!occupies)continue;
          if(Math.abs(d)<62)laneRisk[lane]+=1200;
          else if(d>0&&d<165)laneRisk[lane]+=Math.max(80,230-d);
        }
      }
      if(Math.random()>.55-r.aiSkill*.3){
        for(const i of this.items){if(i.z>r.distance&&i.z-r.distance<190&&(i.kind==='coin'||i.kind==='power'))laneRisk[i.lane]-=i.kind==='power'?55:22;}
      }
      const current=clamp(Math.round(r.lanePos),0,this.lanes-1);
      const choices=[current];if(current>0)choices.push(current-1);if(current<this.lanes-1)choices.push(current+1);
      choices.sort((a,b)=>laneRisk[a]-laneRisk[b]+(Math.random()-.5)*(1-r.aiSkill)*65);
      const chosen=choices[0];
      if(chosen!==current&&!this.isLaneOccupiedFor(r,chosen,64)){r.lane=current;r.targetLane=chosen;}
      else {r.lane=current;r.targetLane=current;}
    }

    obstacleProfile(item){
      if(item.kind==='oil')return {halfDepth:17,laneHalf:.43};
      if(item.type==='traffic')return {halfDepth:38,laneHalf:.39};
      if(item.type==='pylon')return {halfDepth:10,laneHalf:.22};
      return {halfDepth:13,laneHalf:.36};
    }

    itemTouchesRacer(r,item){
      const profile=this.obstacleProfile(item);
      const lateral=Math.abs(item.lane-r.lanePos);
      if(lateral>profile.laneHalf+.28)return false;
      const previous=r.prevDistance??r.distance;
      const frontPrev=previous+this.obstacleFrontWorld;
      const frontNow=r.distance+this.obstacleFrontWorld;
      const rearNow=r.distance-this.carRearWorld;
      const obstacleNear=item.z-profile.halfDepth;
      const obstacleFar=item.z+profile.halfDepth;
      return frontNow>=obstacleNear&&rearNow<=obstacleFar&&frontPrev<=obstacleFar;
    }

    localVisualObstacleTouch(item){
      const r=this.local;
      const carPoint=this.project(0,r.lanePos),angle=this.vehicleHeading(0,r);
      const metrics=this.carMetrics(r,1.04,true,carPoint.laneW,angle);
      // Mũi xe nằm gần đầu sprite; chạm ở mũi là va chạm ngay, không đợi vật cản lọt vào giữa thân xe.
      const noseX=carPoint.x+Math.sin(angle)*metrics.height*.90;
      const noseY=carPoint.y-Math.cos(angle)*metrics.height*.90;
      const rel=item.z-r.distance,previousRel=item.z-(r.prevDistance??r.distance);
      const point=this.project(rel,item.lane),previousPoint=this.project(previousRel,item.lane);
      const obstacle=this.obstacleVisualMetrics(item,point);
      const previousObstacle=this.obstacleVisualMetrics(item,previousPoint);
      const horizontal=Math.abs(point.x-noseX)<=obstacle.width*.48+metrics.width*.27;
      const obstacleTop=point.y-obstacle.height, obstacleBottom=point.y;
      const previousBottom=previousPoint.y;
      const crossed=previousBottom<noseY-1&&obstacleBottom>=noseY-1;
      const touching=obstacleTop<=noseY+4&&obstacleBottom>=noseY-4;
      return horizontal&&(crossed||touching);
    }

    obstacleVisualMetrics(item,p){
      if(item.kind==='oil')return {width:clamp(62*p.scale,12,p.laneW*.76),height:clamp(17*p.scale,4,18)};
      const im=this.images.obstacles[item.type]||this.images.obstacles.barrier;
      const base=item.type==='traffic'?102:72;
      const width=clamp(base*p.scale,12,p.laneW*.82);
      return {width,height:width*(im?.height||1)/(im?.width||1)};
    }

    pickupTouchesRacer(r,item){
      const previous=r.prevDistance??r.distance;
      const frontPrev=previous+this.carFrontWorld*.82;
      const frontNow=r.distance+this.carFrontWorld*.82;
      return frontNow>=item.z-7&&r.distance-this.carRearWorld<=item.z+12&&frontPrev<=item.z+12;
    }

    racersTouch(a,b){
      if(Math.abs(a.lanePos-b.lanePos)>=.49)return false;
      const aFront=a.distance+this.carFrontWorld,aRear=a.distance-this.carRearWorld;
      const bFront=b.distance+this.carFrontWorld,bRear=b.distance-this.carRearWorld;
      return aFront>=bRear&&bFront>=aRear;
    }

    aiCollisions(r,ts){
      if(ts<r.invincibleUntil||ts<r.ghostUntil)return;
      for(const item of this.items.concat(this.dynamicItems)){
        if((item.kind!=='obstacle'&&item.kind!=='oil')||r.hitObstacles.has(item.id))continue;
        if(this.itemTouchesRacer(r,item)){
          r.hitObstacles.add(item.id);
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
        const laneDist=Math.abs(item.lane-r.lanePos);
        if(item.kind==='coin'&&ts<r.magnetUntil&&item.z>r.distance-30&&item.z-r.distance<230&&laneDist<=2.1){this.collectCoin(item,r);continue;}
        if(item.kind==='coin'||item.kind==='power'){
          if(laneDist>.43||!this.pickupTouchesRacer(r,item))continue;
          if(item.kind==='coin')this.collectCoin(item,r);
          else {r.collected.add(item.id);this.applyPower(item.type,ts);}
          continue;
        }
        if((item.kind==='obstacle'||item.kind==='oil')&&!r.hitObstacles.has(item.id)&&ts>=r.invincibleUntil&&ts>=r.ghostUntil&&this.localVisualObstacleTouch(item)){
          r.hitObstacles.add(item.id);this.hitObstacle(item,ts);
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
      const r=this.local;if(ts<r.invincibleUntil||ts<r.ghostUntil||ts-r.lastCarHit<700)return;
      for(const other of this.racers.values()){
        if(other.id===r.id||other.finished)continue;
        if(this.racersTouch(r,other)){
          if(r.shield>0){r.shield--;r.lastCarHit=ts;this.showGrade('SHIELD');return;}
          r.speed*=.70;r.lastCarHit=ts;r.invincibleUntil=ts+Number(this.settings.invincibleSeconds||2)*1000;
          const safeLane=clamp(Math.round(r.lanePos),0,this.lanes-1);r.targetLane=safeLane;r.lane=safeLane;
          this.showGrade('VA CHẠM');return;
        }
      }
    }

    resolveTrafficSpacing(ts){
      const racers=[...this.racers.values()].filter(r=>!r.finished);
      for(let i=0;i<racers.length;i++)for(let j=i+1;j<racers.length;j++){
        const a=racers[i],b=racers[j];
        if(Math.abs(a.lanePos-b.lanePos)>=.48)continue;
        const gap=Math.abs(a.distance-b.distance);
        if(gap>=this.collisionGap)continue;
        let front,behind;
        if(Math.abs(a.distance-b.distance)<.01){front=(a.slot<=b.slot?a:b);behind=front===a?b:a;}
        else {front=a.distance>b.distance?a:b;behind=front===a?b:a;}
        const canAdjust=behind.local||(behind.isAI&&this.isHost);
        if(canAdjust){
          behind.distance=Math.max(0,front.distance-this.collisionGap);
          behind.speed=Math.min(behind.speed||0,Math.max(28,(front.speed||50)*.91));
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
      const isNew=!r;
      if(!r){r=this.makeRacer({id:s.id,name:s.name,avatar:s.avatar,color:s.color,slot:0,isAI:String(s.id).startsWith('AI-')});this.racers.set(r.id,r);}
      Object.assign(r,{name:s.name,avatar:s.avatar,color:s.color,targetLane:clamp(Number(s.targetLane)||0,0,this.lanes-1),lane:clamp(Number(s.lane)||0,0,this.lanes-1),speed:s.speed,score:s.score,coins:s.coins,finished:s.finished,finishTime:s.finishTime});
      r.netDistance=Number(s.distance)||0;r.netLanePos=clamp(Number(s.lanePos)||0,0,this.lanes-1);r.netReceivedAt=performance.now();
      if(isNew||Math.abs(r.distance-r.netDistance)>220){r.distance=r.netDistance;r.lanePos=r.netLanePos;}
      if(s.invincible)r.invincibleUntil=Math.max(r.invincibleUntil,performance.now()+180);
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
      this.hud.speed.textContent=Math.round(r.speed*1.88);this.hud.rank.textContent=`${rank}/${this.racers.size}`;this.hud.score.textContent=Math.max(0,Math.round(r.score));this.hud.coin.textContent=r.coins;
      if(this.settings.mode==='race'){
        const p=clamp(r.distance/this.totalDistance,0,1);this.hud.progress.style.width=`${p*100}%`;this.hud.distance.textContent=`${Math.round(p*100)}%`;this.hud.timer.textContent=formatTime(this.elapsed);
      }else{
        this.hud.progress.style.width=`${(r.distance%1000)/10}%`;this.hud.distance.textContent=`${Math.floor(r.distance)} m`;this.hud.timer.textContent=this.duration>0?formatTime(this.duration-this.elapsed):formatTime(this.elapsed);
      }
      const effects=[];const t=performance.now();if(r.shield)effects.push('🛡 Khiên');if(t<r.ghostUntil)effects.push('👻 Xuyên vật cản');if(t<r.magnetUntil)effects.push('🧲 Nam châm');if(t<r.invincibleUntil)effects.push('✨ Bất tử');
      this.hud.effects.innerHTML=effects.map(x=>`<span class="effect-badge">${x}</span>`).join('');
    }

    cameraGeometry(){
      const compact=this.width<700;
      const horizon=this.height*(compact?.255:.275);
      const roadBottom=this.height*1.09;
      const playerY=this.height*this.playerAnchorRatio;
      const projectionExponent=1.42;
      const playerT=clamp((playerY-horizon)/(roadBottom-horizon),.01,.99);
      const playerQ=Math.pow(playerT,1/projectionExponent);
      const rearDistance=this.viewDistance*(1/playerQ-1);
      return {horizon,roadBottom,playerY,projectionExponent,playerQ,rearDistance};
    }

    roadGeometry(y){
      const {horizon,roadBottom}=this.cameraGeometry();
      const t=clamp((y-horizon)/(roadBottom-horizon),0,1);
      const eased=Math.pow(t,1.06);
      const maxRoadW=this.width*(this.width<700?.975:.82);
      const desiredLaneW=clamp(this.width/(this.lanes+3.05),78,190);
      const bottomW=Math.min(maxRoadW,desiredLaneW*this.lanes+82);
      const topW=Math.max(105,Math.min(this.width*.27,bottomW*.285));
      const width=lerp(topW,bottomW,eased);
      return {width,t,eased};
    }

    curveRaw(z){
      const phase=this.curvePhase;
      const warm=clamp((z-180)/520,0,1);const envelope=warm*warm*(3-2*warm);
      return envelope*(
        Math.sin(z/940+phase)*1.12+
        Math.sin(z/1760+phase*1.83)*.72+
        Math.sin(z/510+phase*.61)*.30
      );
    }

    curveSlopeAt(z){
      const e=6;
      return (this.curveRaw(z+e)-this.curveRaw(z-e))/(e*2);
    }

    roadCurveOffsetLanes(relDistance){
      const baseZ=this.local?.distance||0;
      const z=baseZ+relDistance;
      // Camera nhìn theo tiếp tuyến ngay tại xe, nên đoạn dưới bánh xe luôn ổn định;
      // phần đường phía trước mới uốn cong giống game OutRun/pseudo-3D.
      const raw=this.curveRaw(z)-this.curveRaw(baseZ)-this.curveSlopeAt(baseZ)*relDistance;
      const fade=clamp(Math.abs(relDistance)/75,0,1);
      const limit=Math.min(2.8,Math.max(.9,this.lanes*.34));
      return clamp(raw*fade*2.75,-limit,limit);
    }

    projectFraction(relDistance,fraction){
      const {horizon,roadBottom,projectionExponent,playerQ,rearDistance}=this.cameraGeometry();
      const q=clamp((this.viewDistance-relDistance)/(this.viewDistance+rearDistance),0,1);
      const y=horizon+Math.pow(q,projectionExponent)*(roadBottom-horizon);
      const g=this.roadGeometry(y);const laneW=g.width/this.lanes;
      const requestedShift=this.roadCurveOffsetLanes(relDistance)*laneW;
      const maxShift=Math.max(0,(this.width-g.width)/2-8);
      const centerX=this.width/2+clamp(requestedShift,-maxShift,maxShift);
      const playerNormalized=clamp(q/playerQ,0,1);
      const scale=lerp(.10,1.04,Math.pow(playerNormalized,1.26));
      return {x:centerX+(fraction-.5)*g.width,y,scale,laneW,q,centerX,width:g.width};
    }

    project(relDistance,lane){return this.projectFraction(relDistance,(lane+.5)/this.lanes);}

    vehicleHeading(relDistance,r){
      const steer=clamp((r.targetLane-r.lanePos)*.78,-.52,.52);
      if(r.local&&Math.abs(steer)<.02)return 0;
      const here=this.project(relDistance,r.lanePos);
      const ahead=this.project(relDistance+48,clamp(r.lanePos+steer,0,this.lanes-1));
      return clamp(Math.atan2(ahead.x-here.x,here.y-ahead.y),-.36,.36);
    }

    render(){
      const c=this.ctx,w=this.width,h=this.height;if(!w||!h)return;
      const sky=c.createLinearGradient(0,0,0,h*.64);sky.addColorStop(0,'#79c9ef');sky.addColorStop(1,'#e8f7ff');c.fillStyle=sky;c.fillRect(0,0,w,h);
      this.drawBackground(c,w,h);this.drawRoad(c,w,h);this.drawWorldItems(c);this.drawRacers(c);this.drawSpeedLines(c);
    }

    drawBackground(c,w,h){
      const {horizon}=this.cameraGeometry();
      c.fillStyle='#a7ca91';c.beginPath();c.moveTo(0,horizon+35);
      for(let x=0;x<=w;x+=75)c.lineTo(x,horizon-9+Math.sin(x*.011+this.local.distance*.00012)*26);
      c.lineTo(w,h*.58);c.lineTo(0,h*.58);c.fill();
      c.fillStyle='#679760';c.beginPath();c.moveTo(0,horizon+67);
      for(let x=0;x<=w;x+=58)c.lineTo(x,horizon+23+Math.sin(x*.019+1.4)*21);
      c.lineTo(w,h*.64);c.lineTo(0,h*.64);c.fill();
      c.fillStyle='#4f9e63';c.fillRect(0,horizon+50,w,h-(horizon+50));
      for(let i=0;i<20;i++){
        const x=(i*149-(this.local.distance*.10)%149+w)%w;
        const y=horizon+68+(i%3)*19;
        c.fillStyle=i%2?'#2e7445':'#3a8650';c.fillRect(x,y,5,30);c.beginPath();c.arc(x+2,y,12,0,Math.PI*2);c.fill();
      }
    }

    fillQuad(c,a,b,d,e,color){
      c.fillStyle=color;c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.lineTo(e.x,e.y);c.lineTo(d.x,d.y);c.closePath();c.fill();
    }

    drawRoad(c,w,h){
      const {rearDistance}=this.cameraGeometry();
      const near=-rearDistance,far=this.viewDistance,step=this.roadSliceDepth;
      const samples=[];
      for(let rel=far;rel>near;rel-=step){
        samples.push({
          left:this.projectFraction(rel,0),right:this.projectFraction(rel,1),
          shoulderLeft:this.projectFraction(rel,-.035),shoulderRight:this.projectFraction(rel,1.035)
        });
      }
      samples.push({
        left:this.projectFraction(near,0),right:this.projectFraction(near,1),
        shoulderLeft:this.projectFraction(near,-.035),shoulderRight:this.projectFraction(near,1.035)
      });
      const fillStrip=(leftKey,rightKey,color)=>{
        c.fillStyle=color;c.beginPath();
        c.moveTo(samples[0][leftKey].x,samples[0][leftKey].y);
        for(let i=1;i<samples.length;i++)c.lineTo(samples[i][leftKey].x,samples[i][leftKey].y);
        for(let i=samples.length-1;i>=0;i--)c.lineTo(samples[i][rightKey].x,samples[i][rightKey].y);
        c.closePath();c.fill();
      };
      // Một polygon liền cho vai đường và một polygon liền cho mặt nhựa:
      // không còn các khe ngang khiến mặt đường giống tấm lưới hoặc vật thể trôi lệch.
      fillStrip('shoulderLeft','shoulderRight','#c8b991');
      fillStrip('left','right','#263b38');
      c.lineWidth=5;c.strokeStyle='#f4e4bd';c.lineJoin='round';
      for(const key of ['left','right']){
        c.beginPath();c.moveTo(samples[0][key].x,samples[0][key].y);
        for(let i=1;i<samples.length;i++)c.lineTo(samples[i][key].x,samples[i][key].y);
        c.stroke();
      }
      const dashPeriod=78,dashLength=34;
      const first=Math.floor((this.local.distance-rearDistance)/dashPeriod)-1;
      const last=Math.ceil((this.local.distance+this.viewDistance)/dashPeriod)+1;
      for(let lane=1;lane<this.lanes;lane++){
        const fraction=lane/this.lanes;
        for(let n=first;n<=last;n++){
          const z0=n*dashPeriod,z1=z0+dashLength;
          const rel0=z0-this.local.distance,rel1=z1-this.local.distance;
          if(rel1<-rearDistance||rel0>this.viewDistance)continue;
          const nearP=this.projectFraction(rel0,fraction),farP=this.projectFraction(rel1,fraction);
          c.strokeStyle='rgba(255,255,255,.91)';c.lineWidth=clamp(1+nearP.scale*4.3,1.1,5.6);c.lineCap='round';
          c.beginPath();c.moveTo(farP.x,farP.y);c.lineTo(nearP.x,nearP.y);c.stroke();
        }
      }
      if(this.settings.mode==='race'){
        const rel=this.totalDistance-this.local.distance;
        if(rel>-rearDistance&&rel<this.viewDistance){
          const depth=20,rows=2;
          for(let row=0;row<rows;row++)for(let col=0;col<this.lanes*4;col++){
            const farRel=rel+row*depth/rows,nearRel=rel+(row+1)*depth/rows;
            const f0=col/(this.lanes*4),f1=(col+1)/(this.lanes*4);
            const a=this.projectFraction(farRel,f0),b=this.projectFraction(farRel,f1),d=this.projectFraction(nearRel,f0),e=this.projectFraction(nearRel,f1);
            this.fillQuad(c,a,b,d,e,(col+row)%2?'#fff':'#111');
          }
        }
      }
    }

    drawWorldItems(c){
      const visible=this.items.concat(this.dynamicItems).filter(i=>!this.local.collected.has(i.id)&&i.z-this.local.distance>-26&&i.z-this.local.distance<this.viewDistance).sort((a,b)=>b.z-a.z);
      for(const item of visible){const rel=item.z-this.local.distance,p=this.project(rel,item.lane);if(p.y<this.height*.14)continue;
        if(item.kind==='coin')this.drawCoin(c,p.x,p.y,p.scale,item.value);
        else if(item.kind==='power')this.drawPower(c,p.x,p.y,p.scale,item.type);
        else this.drawObstacle(c,p,item,rel);
      }
    }

    drawCoin(c,x,y,s,value){const r=clamp(7.5*s,2.6,16);c.save();c.translate(x,y);c.fillStyle=value>=50?'#fff2a0':'#ffd34f';c.strokeStyle='#de8d19';c.lineWidth=Math.max(1,2*s);c.beginPath();c.ellipse(0,0,r*.65,r,0,0,Math.PI*2);c.fill();c.stroke();c.fillStyle='#bd7919';c.font=`${Math.max(6,10*s)}px sans-serif`;c.textAlign='center';c.textBaseline='middle';c.fillText('$',0,0);c.restore();}

    drawPower(c,x,y,s,type){const icons={shield:'🛡',ghost:'👻',magnet:'🧲',turbo:'⚡',shockwave:'💥',oil:'🛢'};const r=clamp(14*s,6,28);c.save();c.translate(x,y);c.fillStyle='rgba(255,255,255,.93)';c.strokeStyle='#ff9b42';c.lineWidth=Math.max(1,3*s);c.beginPath();c.arc(0,0,r,0,Math.PI*2);c.fill();c.stroke();c.font=`${Math.max(10,22*s)}px "Segoe UI Emoji"`;c.textAlign='center';c.textBaseline='middle';c.fillText(icons[type]||'?',0,1);c.restore();}

    drawObstacle(c,p,item,rel){
      const im=this.images.obstacles[item.type]||this.images.obstacles.barrier;
      const metrics=this.obstacleVisualMetrics(item,p);
      const ahead=this.project(rel+38,item.lane),angle=clamp(Math.atan2(ahead.x-p.x,p.y-ahead.y),-.34,.34);
      c.save();c.translate(p.x,p.y);c.rotate(angle);
      if(item.kind==='oil'){c.fillStyle='rgba(25,20,18,.86)';c.beginPath();c.ellipse(0,0,metrics.width*.46,metrics.height*.54,0,0,Math.PI*2);c.fill();}
      else c.drawImage(im,-metrics.width/2,-metrics.height,metrics.width,metrics.height);
      c.restore();
    }

    carFrame(r,angle){
      const frames=this.images.perspectiveCars[r.color%this.images.perspectiveCars.length];
      if(!frames)return {image:this.images.cars[r.color%this.images.cars.length],residual:angle};
      // Góc cua của đường cao tốc thường nhỏ. Dùng sprite nhìn từ sau và xoay đúng tiếp tuyến
      // giúp mũi xe luôn cùng hướng mặt đường, không bị nghiêng ngang như sprite isometric 45°.
      return {image:frames.n,residual:angle};
    }

    carMetrics(r,s,isLocal,laneW,angle=0){
      const frame=this.carFrame(r,angle),im=frame.image;
      let height=clamp(132*s,11,isLocal?145:136);
      let width=height*(im.width/im.height);
      const maxWidth=laneW*.64;
      if(width>maxWidth){const k=maxWidth/width;width*=k;height*=k;}
      return {frame,width,height,residual:frame.residual};
    }

    drawRacers(c){
      const list=[...this.racers.values()].filter(r=>r.id!==this.local.id).map(r=>({r,rel:r.distance-this.local.distance})).filter(x=>x.rel>-10&&x.rel<this.viewDistance).sort((a,b)=>b.rel-a.rel);
      for(const {r,rel} of list){const safeRel=Math.max(-10,rel),p=this.project(safeRel,r.lanePos);this.drawCar(c,r,p.x,p.y,p.scale*.94,false,p.laneW,this.vehicleHeading(safeRel,r));}
      const p=this.project(0,this.local.lanePos);this.drawCar(c,this.local,p.x,p.y,1.04,true,p.laneW,this.vehicleHeading(0,this.local));
    }

    drawCar(c,r,x,y,s,isLocal,laneW,angle=0){
      const metrics=this.carMetrics(r,s,isLocal,laneW,angle),im=metrics.frame.image;
      const width=metrics.width,height=metrics.height;const blink=performance.now()<r.invincibleUntil&&Math.floor(performance.now()/105)%2===0;
      c.save();c.translate(x,y);c.rotate(metrics.residual);
      c.globalAlpha=.30;c.fillStyle='#07120f';c.beginPath();c.ellipse(0,-2,width*.39,Math.max(3,width*.11),0,0,Math.PI*2);c.fill();
      c.globalAlpha=blink?.28:1;c.shadowColor=isLocal?'rgba(255,210,80,.74)':'rgba(0,0,0,.24)';c.shadowBlur=isLocal?16:6;
      c.drawImage(im,-width/2,-height,width,height);c.shadowBlur=0;
      const avSize=clamp(21*s,7,29),av=this.images.avatars[(r.avatar-1)%this.images.avatars.length];
      c.fillStyle='rgba(255,255,255,.95)';c.beginPath();c.arc(0,-height*.66,avSize*.55,0,Math.PI*2);c.fill();try{c.drawImage(av,-avSize/2,-height*.66-avSize/2,avSize,avSize);}catch{}
      c.restore();
      c.save();c.font=`800 ${clamp(10*s,8,14)}px sans-serif`;c.textAlign='center';c.fillStyle='#fff';c.strokeStyle='rgba(0,0,0,.72)';c.lineWidth=3;c.strokeText(r.name,x,y+14*s);c.fillText(r.name,x,y+14*s);c.restore();
    }

    drawSpeedLines(c){
      if(this.local.speed<112)return;const strength=clamp((this.local.speed-112)/90,0,1);
      c.strokeStyle=`rgba(255,255,255,${.10+.32*strength})`;c.lineWidth=2;
      for(let i=0;i<16;i++){const x=(i*109+this.local.distance*7.2)%this.width,y=(i*67+this.local.distance*10.5)%this.height;c.beginPath();c.moveTo(x,y);c.lineTo(x+(x-this.width/2)*.07,y+26+58*strength);c.stroke();}
    }
  }

  window.HighwayGame=HighwayGame;
})();
