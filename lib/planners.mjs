// Mouse path baseline: desktop-touch-human-plugin (MIT), ghost-cursor (MIT).
// Typing cadence/correction concepts adapted from human-type realism.py (MIT).
// See THIRD-PARTY-NOTICES.md. No Python or input-injection code is used here.
import {path as ghostPath} from 'ghost-cursor';
import {randomInt} from 'node:crypto';

function number(value,min,max,name){
  if(!Number.isFinite(value)||value<min||value>max)throw new RangeError(`Invalid ${name}`);
  return value;
}
function point(p){if(!p||typeof p!=='object')throw new TypeError('Missing point');number(p.x,-100000,100000,'x');number(p.y,-100000,100000,'y');return p;}
function rect(b){
  if(!b||typeof b!=='object')throw new TypeError('Missing bounds');
  number(b.x,-100000,100000,'bounds.x');number(b.y,-100000,100000,'bounds.y');
  number(b.width,1,100000,'bounds.width');number(b.height,1,100000,'bounds.height');return b;
}
export function inside(p,b){return !!p&&!!b&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=b.x&&p.y>=b.y&&p.x<b.x+b.width&&p.y<b.y+b.height;}
function pixel(p,b){
  const q={x:Math.round(p.x),y:Math.round(p.y)};
  if(b){q.x=Math.max(Math.ceil(b.x),Math.min(Math.ceil(b.x+b.width)-1,q.x));q.y=Math.max(Math.ceil(b.y),Math.min(Math.ceil(b.y+b.height)-1,q.y));}
  return q;
}
export function planMove({from,to,durationMs,jitterPx=.7,overshootPx=0,bounds,gesture='move'}){
  point(from);point(to);
  if(!['move','click','drag'].includes(gesture))throw new TypeError('Invalid gesture');
  if(bounds){rect(bounds);if(!inside(from,bounds)||!inside(to,bounds))throw new RangeError('Point outside allowed bounds');}
  from=pixel(from,bounds);to=pixel(to,bounds);
  const distance=Math.hypot(to.x-from.x,to.y-from.y);
  durationMs??=Math.round(Math.max(200,Math.min(1200,180+distance*.625))*(gesture==='drag'?1.25:1));
  number(durationMs,100,15000,'durationMs');number(jitterPx,0,5,'jitterPx');number(overshootPx,0,30,'overshootPx');
  // ghost-cursor's zero-length Bezier construction can produce NaN. A
  // stationary request is a dwell, including endpoints rounded to one pixel.
  if(distance===0)return {durationMs,points:[{...from,atMs:0},{...to,atMs:durationMs}],algorithm:'stationary dwell v1'};
  const over=pixel({x:to.x+(distance?overshootPx*(to.x-from.x)/distance:0),y:to.y+(distance?overshootPx*(to.y-from.y)/distance:0)},bounds);
  const raw=ghostPath(from,over,{spreadOverride:Math.max(15,Math.min(100,distance*.18)),moveSpeed:50});
  const count=Math.max(2,Math.ceil(durationMs/12)),split=overshootPx?.85:1;
  const points=[];let noiseX=0,noiseY=0;
  for(let i=0;i<=count;i++){
    const t=i/count;let p;
    if(t<=split){const u=t/split,e=u*u*(3-2*u),pos=e*(raw.length-1),idx=Math.floor(pos),a=raw[idx],b=raw[Math.min(raw.length-1,idx+1)],f=pos%1;p={x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f};}
    else{const u=(t-split)/(1-split),e=u*u*(3-2*u);p={x:over.x+(to.x-over.x)*e,y:over.y+(to.y-over.y)*e};}
    noiseX=noiseX*.7+(Math.random()-.5)*jitterPx;noiseY=noiseY*.7+(Math.random()-.5)*jitterPx;
    const envelope=Math.sin(Math.PI*t);
    points.push({...pixel({x:p.x+noiseX*envelope,y:p.y+noiseY*envelope},bounds),atMs:t*durationMs});
  }
  points[0]={x:from.x,y:from.y,atMs:0};points[count]={x:to.x,y:to.y,atMs:durationMs};
  return {durationMs,points,algorithm:'ghost-cursor@1.4.2 + eased timing + bounded jitter'};
}

function rngFor(seed){let state=seed>>>0;return ()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}
const nearby={a:'sqwz',b:'vghn',c:'xdfv',d:'serfcx',e:'wsdr',f:'drtgvc',g:'ftyhbv',h:'gyujnb',i:'ujko',j:'huikmn',k:'jiolm',l:'kop',m:'njk',n:'bhjm',o:'iklp',p:'ol',q:'wa',r:'edft',s:'awedxz',t:'rfgy',u:'yhji',v:'cfgb',w:'qase',x:'zsdc',y:'tghu',z:'asx'};
export function replayTyping(events){const chars=[];for(const e of events){if(e.type==='char')chars.push(e.char);else if(e.type==='key'&&e.key==='backspace')chars.pop();else throw new TypeError('Unsupported typing event');}return chars.join('');}
export function planTyping({text,wpm=41,typoRate=0,seed}){
  if(typeof text!=='string'||!text.length||[...text].length>1000||/[\p{Cc}\p{Cs}\u2028\u2029]/u.test(text))throw new TypeError('Text must contain 1..1000 codepoints and no controls, line separators or unpaired surrogates');
  number(wpm,15,180,'wpm');number(typoRate,0,.3,'typoRate');
  seed??=randomInt(0,2147483647);number(seed,0,2147483647,'seed');if(!Number.isInteger(seed))throw new TypeError('Seed must be an integer');
  const chars=[...text],durationMs=chars.length*12000/wpm;
  if(durationMs>45000)throw new RangeError('Typing plan exceeds 45 seconds; split the text');
  const effectiveTypoRate=/[^\x20-\x7e]/u.test(text)?0:typoRate;
  const rng=rngFor(seed),events=[],weights=[];
  let drift=0,wordsLeft=1+Math.floor(rng()*3),fast=true,pendingPause=0;
  const add=(event,extra=0)=>{
    drift=Math.max(-.55,Math.min(.55,drift*.92+(rng()-.5)*.3));
    const c=event.char;
    const effort=c===' '?.74:c&&/[A-Z!@#$%^&*()_+{}:"<>?]/.test(c)?1.34:1;
    weights.push(Math.max(.1,effort*Math.exp(drift)*(.7+rng()*.6)*(fast?.75:1.15)+pendingPause+extra));
    pendingPause=0;events.push(event);
  };
  for(const char of chars){
    const choices=nearby[char.toLowerCase()];
    if(choices&&rng()<effectiveTypoRate){
      let wrong=choices[Math.floor(rng()*choices.length)];if(char!==char.toLowerCase())wrong=wrong.toUpperCase();
      add({type:'char',char:wrong});add({type:'key',key:'backspace'},2+rng()*3);add({type:'char',char},.5);
    }else add({type:'char',char});
    if(/[.!?]/.test(char))pendingPause+=2;
    else if(/[,;:]/.test(char))pendingPause+=.8;
    if(char===' '&&--wordsLeft===0){pendingPause+=2+rng()*2;wordsLeft=1+Math.floor(rng()*3);fast=!fast;}
  }
  const hold=e=>e.type==='char'?e.char.length*35:40;
  const overhead=events.reduce((sum,e)=>sum+hold(e),0),budget=durationMs-overhead;
  if(budget<0)throw new RangeError('Requested speed cannot accommodate input hold overhead and corrections; lower WPM or typoRate');
  const totalWeight=weights.reduce((a,b)=>a+b,0);let at=0;
  for(let i=0;i<events.length;i++){at+=budget*weights[i]/totalWeight;events[i].atMs=at;at+=hold(events[i]);}
  // Avoid accumulated floating-point overshoot at the final release deadline.
  events.at(-1).atMs=Math.min(events.at(-1).atMs,durationMs-hold(events.at(-1)));
  if(replayTyping(events)!==text)throw new Error('Typing replay validation failed');
  return {events,durationMs,targetWpm:wpm,characterCount:chars.length,seed,effectiveTypoRate,algorithm:'human-type-inspired JS cadence + corrected ASCII slips v1'};
}

export function planReading({from,segments,bounds}){
  point(from);rect(bounds);if(!inside(from,bounds))throw new RangeError('Reading origin outside client');
  if(!Array.isArray(segments)||!segments.length||segments.length>128)throw new RangeError('Reading requires 1..128 segments');
  let durationMs=0;
  for(const s of segments){
    if(!s||typeof s.region_id!=='string'||!s.region_id.trim()||typeof s.purpose!=='string'||!s.purpose.trim())throw new TypeError('Reading region_id and purpose required');
    rect(s.rect);if(s.rect.x<bounds.x||s.rect.y<bounds.y||s.rect.x+s.rect.width>bounds.x+bounds.width||s.rect.y+s.rect.height>bounds.y+bounds.height)throw new RangeError('Reading region outside client');
    if(!['top_to_bottom','left_to_right'].includes(s.direction))throw new TypeError('Invalid reading direction');
    number(s.duration_ms,100,60000,'reading duration_ms');durationMs+=s.duration_ms;
  }
  if(durationMs>60000)throw new RangeError('Reading plan exceeds 60 seconds');
  const points=[{...pixel(from,bounds),atMs:0}];let elapsed=0;
  for(const s of segments){
    const r=s.rect,vertical=s.direction==='top_to_bottom';
    const start=pixel({x:r.x+(vertical?r.width*.5:r.width*.1),y:r.y+(vertical?r.height*.1:r.height*.5)},r);
    const end=pixel({x:r.x+(vertical?r.width*.5:r.width*.9),y:r.y+(vertical?r.height*.9:r.height*.5)},r);
    const origin=points.at(-1),move=(a,b,t0,t1,allowed)=>{
      // Reuse the bounded Bezier path and eased velocity profile. Rescale time
      // so a reading leg may exceed the individual mouse tool's 15 s budget.
      const baseDuration=Math.max(100,Math.min(15000,t1-t0));
      const base=planMove({from:a,to:b,bounds:allowed,durationMs:baseDuration,jitterPx:0});
      for(const p of base.points.slice(1))points.push({x:p.x,y:p.y,atMs:t0+(t1-t0)*p.atMs/baseDuration});
    };
    move(origin,start,elapsed,elapsed+s.duration_ms*.15,bounds);
    points.push({...start,atMs:elapsed+s.duration_ms*.3});
    move(start,end,elapsed+s.duration_ms*.3,elapsed+s.duration_ms*.8,r);
    elapsed+=s.duration_ms;points.push({...end,atMs:elapsed});
  }
  if(points.length>12000)throw new RangeError('Reading plan exceeds 12000 frames; combine segments');
  return {durationMs,points,algorithm:'purposeful region traversal with dwell v1'};
}
