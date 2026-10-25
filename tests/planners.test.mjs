import test from 'node:test';
import assert from 'node:assert/strict';
import {planMove,planTyping,planReading,replayTyping,inside} from '../lib/planners.mjs';

test('typing replays exactly with deterministic corrected mistakes',()=>{
  const args={text:'The quick brown fox would really like this.',wpm:100,typoRate:.3,seed:42};
  const a=planTyping(args); assert.deepEqual(a,planTyping(args));
  assert.equal(replayTyping(a.events),args.text);
  assert.ok(a.events.some(e=>e.type==='key'));
  assert.equal(a.durationMs,[...args.text].length*12000/100);
  for(let i=0;i<a.events.length;i++) {
    const e=a.events[i],hold=e.type==='key'?40:e.char.length*35;
    assert.ok(e.atMs>=0);assert.ok(e.atMs+hold<= (a.events[i+1]?.atMs??a.durationMs)+1e-8);
  }
});
test('Unicode stays exact and has no invented typo/backspace',()=>{
  const text='中文 e\u0301 😀'; const p=planTyping({text,typoRate:.3,seed:1});
  assert.equal(p.effectiveTypoRate,0);assert.equal(p.characterCount,[...text].length);
  assert.equal(replayTyping(p.events),text);assert.ok(p.events.every(e=>e.type==='char'));
});
test('typing rejects invalid text, speed, duration and impossible hold budget',()=>{
  for(const text of ['', '\n', 'a\t', '\uD800', 'a'.repeat(1001)]) assert.throws(()=>planTyping({text}));
  assert.throws(()=>planTyping({text:'a',wpm:181}));
  assert.throws(()=>planTyping({text:'a',seed:1.1}));
  assert.throws(()=>planTyping({text:'a'.repeat(100),wpm:15}));
  assert.throws(()=>planTyping({text:'😀',wpm:180}),/hold|speed/i);
});
test('typing timings have variable cadence and group pauses',()=>{
  const p=planTyping({text:'one two three four five six seven eight nine ten',wpm:100,typoRate:0,seed:7});
  const gaps=p.events.slice(1).map((e,i)=>e.atMs-p.events[i].atMs-35);
  assert.ok(new Set(gaps.map(Math.round)).size>5);
  assert.ok(Math.max(...gaps)>Math.min(...gaps)*2);
});
test('correction sequences preserve replay and nonoverlapping holds across seeds',()=>{
  const text='Aa Bb cc zyx, one two three!';
  for(let seed=0;seed<200;seed++){
    const p=planTyping({text,wpm:100,typoRate:.3,seed});assert.equal(replayTyping(p.events),text);
    for(let i=0;i<p.events.length;i++){
      const e=p.events[i],hold=e.type==='char'?e.char.length*35:40;
      assert.ok(e.atMs+hold<=(p.events[i+1]?.atMs??p.durationMs)+1e-8);
    }
  }
});
test('move clips every curve point including rounded edges into bounds',t=>{
  t.mock.method(Math,'random',()=>.3);
  const bounds={x:-5.4,y:2.2,width:12.8,height:10.8};
  for(let i=0;i<20;i++) {
    const p=planMove({from:{x:-5,y:3},to:{x:7,y:12},durationMs:200,jitterPx:5,overshootPx:30,bounds});
    assert.ok(p.points.every(v=>inside(v,bounds)));assert.deepEqual(p.points.at(-1),{x:7,y:12,atMs:200});
    assert.ok(p.points.every((v,j)=>j===0||v.atMs>=p.points[j-1].atMs));
  }
  assert.throws(()=>planMove({from:{x:0,y:0},to:{x:2,y:2},bounds:{x:0,y:0,width:0,height:3}}));
});
test('reading validates full regions and produces bounded traversal/dwell within budget',t=>{
  t.mock.method(Math,'random',()=>.3);
  const bounds={x:0,y:0,width:300,height:200};
  const segments=[{region_id:'p1',rect:{x:20,y:20,width:100,height:100},purpose:'Read paragraph',direction:'top_to_bottom',duration_ms:1500}];
  const p=planReading({from:{x:1,y:1},segments,bounds});
  assert.equal(p.durationMs,1500);assert.ok(p.points.every(v=>inside(v,bounds)&&v.atMs<=1500));
  assert.ok(p.points.some((v,i)=>i&&v.x===p.points[i-1].x&&v.y===p.points[i-1].y));
  for(const patch of [{purpose:''},{direction:'random'},{duration_ms:60001},{rect:{x:290,y:0,width:30,height:5}}])
    assert.throws(()=>planReading({from:{x:1,y:1},segments:[{...segments[0],...patch}],bounds}));
  assert.throws(()=>planReading({from:{x:1,y:1},segments:[],bounds}));
});
test('reading follows bounded curved traversals and all emitted points are physical pixels',t=>{
  t.mock.method(Math,'random',()=>.3);
  const bounds={x:0,y:0,width:800,height:800};
  const p=planReading({from:{x:1.2,y:2.3},bounds,segments:[{region_id:'p',rect:{x:50,y:50,width:700,height:700},purpose:'Read',direction:'top_to_bottom',duration_ms:60000}]});
  const traversal=p.points.filter(v=>v.atMs>=18000&&v.atMs<=48000);
  assert.ok(new Set(traversal.map(v=>v.x)).size>2,'curve should vary perpendicular to traversal');
  assert.ok(p.points.length<=12000);assert.equal(p.points.at(-1).atMs,60000);
  assert.ok(p.points.every(v=>inside(v,bounds)&&Number.isInteger(v.x)&&Number.isInteger(v.y)));
  const move=planMove({from:{x:.1,y:.2},to:{x:799.9,y:799.9},bounds});
  assert.ok(move.points.every(v=>inside(v,bounds)&&Number.isInteger(v.x)&&Number.isInteger(v.y)));
});
test('identical and rounded-equal endpoints create finite stationary dwell plans',()=>{
  for(const [from,to] of [[{x:10,y:20},{x:10,y:20}],[{x:10.1,y:20.1},{x:10.2,y:20.2}]]){
    const p=planMove({from,to,durationMs:1000,jitterPx:5,overshootPx:30});
    assert.ok(p.points.every(v=>Number.isFinite(v.atMs)&&v.x===10&&v.y===20));
    assert.equal(p.points[0].atMs,0);assert.equal(p.points.at(-1).atMs,1000);
  }
  const p=planReading({from:{x:50,y:10},bounds:{x:0,y:0,width:100,height:100},segments:[{region_id:'same-start',rect:{x:0,y:0,width:100,height:100},purpose:'Read',direction:'top_to_bottom',duration_ms:1000}]});
  assert.ok(p.points.every(v=>Number.isFinite(v.x)&&Number.isFinite(v.y)&&Number.isFinite(v.atMs)));
  const tiny=planReading({from:{x:0,y:0},bounds:{x:0,y:0,width:1,height:1},segments:[{region_id:'tiny',rect:{x:0,y:0,width:1,height:1},purpose:'Read',direction:'top_to_bottom',duration_ms:1000}]});
  assert.ok(tiny.points.every(v=>v.x===0&&v.y===0));
});
test('typing rejects Unicode line and paragraph separators consistently with native validation',()=>{
  for(const text of ['first\u2028second','first\u2029second'])assert.throws(()=>planTyping({text}),/control|separator/i);
});
