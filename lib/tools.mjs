const object = (properties = {}, required = []) => ({type:'object',properties,required,additionalProperties:false});
const string = (maxLength=128) => ({type:'string',minLength:1,maxLength});
const number = (minimum,maximum) => ({type:'number',minimum,maximum});
const boolean = {type:'boolean'};
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const pause_policy=object({stable_ms:integer(100,2000),small_excursion_px:integer(1,200),large_range_px:integer(1,1000),large_path_px:integer(1,3000),sustained_ms:integer(200,2000),window_ms:integer(200,3000),lifetime_ms:integer(1000,300000)});
const hwnd = {type:'string',pattern:'^[1-9][0-9]{0,19}$'};
const rect = object({x:number(-100000,100000),y:number(-100000,100000),width:number(1,100000),height:number(1,100000)},['x','y','width','height']);
const segment = object({region_id:string(),rect,purpose:string(2000),direction:{enum:['top_to_bottom','left_to_right']},duration_ms:number(100,60000)},['region_id','rect','purpose','direction','duration_ms']);
const controls={threshold_px:integer(1,100),pause_policy};
const motion = {hwnd,x:number(-100000,100000),y:number(-100000,100000),duration_ms:number(100,15000),jitter_px:number(0,5),overshoot_px:number(0,30),...controls};
const typing = {hwnd,text:{type:'string',minLength:1,maxLength:2000},wpm:number(15,180),typo_rate:number(0,.3),seed:{type:'integer',minimum:0,maximum:2147483647},force_ime_off:boolean,...controls};
const reading = {hwnd,segments:{type:'array',minItems:1,maxItems:128,items:segment},replace:boolean,...controls};
const outcomes={type:'array',minItems:0,maxItems:12000,items:object({unit_id:string(),outcome:{enum:['applied','not_applied']}},['unit_id','outcome'])};
const point=object({x:integer(-2147483648,2147483647),y:integer(-2147483648,2147483647)},['x','y']);
const resolution={oneOf:[object({type:{enum:['continue']}},['type']),...['observed','finish'].map(type=>object({type:{enum:[type]},outcomes},['type','outcomes'])),object({type:{enum:['remaining_gesture']},gesture_id:string(),safe_anchor:point,outcomes},['type','gesture_id','safe_anchor','outcomes'])]};
const descriptions = {
  human_capabilities:'Report human mode and truthful limits. This service cannot see chat messages, page contents, or calls to other input tools.',
  human_mode:'Query current mode with empty arguments, or explicitly enable/disable human input. Every process starts disabled; a mode change cancels current work before returning.',
  human_observe:'Read native target identity, client geometry, focus, foreground, DPI and cursor. Does not capture images, focus a window, or cancel reading.',
  human_target_update:'Cancel current work with a barrier, then observe and replace the selected target. Never focuses or moves a window.',
  human_input_plan:'Preview a bounded plan without input or cancellation. Typing previews are pure and need no hwnd; pointer previews observe explicit hwnd for client bounds. Page freshness is the caller responsibility.',
  human_mouse_move:'Move from the observed cursor through a bounded human-style path; waits for completion. The cursor must already be inside the target client (use human_activate to enter). Cancels background reading first. No auto focus.',
  human_mouse_click:'Move to a client point and pulse the left button once; waits for completion. The cursor must already be inside the target client. Caller must freshly establish the intended UI target.',
  human_mouse_drag:'Drag with the left button from the current observed cursor to a client point; waits for completion. Does not pre-position the cursor.',
  human_type:'Type printable text using bounded character pulses and optional corrections; no paste, Enter, or arbitrary chords. IME change needs force_ime_off=true; remote delivery is not verified.',
  human_stop:'Cancel current or pending input and wait until no future injections are possible. Does not return the cursor or release user-owned input.',
  reading_start:'Begin autonomous pure pointer traversal of explicit client regions and return promptly. The cursor must already be inside the target client. No buttons or keys. New input, stop, target or mode changes cancel it; chat messages cannot.',
  reading_status:'Read reading operation status without cancelling it. deliveryVerified=false; no page or reading-comprehension detection.',
  reading_cancel:'Cancel reading with a no-future-injection barrier. An omitted operation_id selects the active reading operation.',
  timer_attach:'Attach an external-observation timer to an explicit target and section; never reads screen pixels or cancels input.',
  timer_prepare:'Prepare a bounded observation ticket before the caller reads a timer through an external source.',
  timer_calibrate:'Anchor a timer using a prepared ticket and caller-observed seconds. Observed expiry requires explicit expired_observed state.',
  timer_status:'Return the observed timer anchor and an uncertain estimate separately. Querying never cancels input.',
  timer_invalidate:'Invalidate a timer estimate after known external changes; does not inspect or mutate a page.',
  timer_detach:'Detach one external-observation timer without touching input.'
};
const schemas = {
  human_scroll:object({hwnd,delta:integer(-1200,1200),axis:{enum:['vertical','horizontal']},...controls},['hwnd','delta']),
  human_key:object({hwnd,key:string(32),modifiers:{type:'array',minItems:0,maxItems:2,items:{enum:['ctrl','shift']}},...controls},['hwnd','key']),
  ...Object.fromEntries(['copy','cut','paste'].map(action=>[`human_${action}`,object({hwnd,...controls},['hwnd'])])),
  human_activate:object({...motion,safe_area:object({x:integer(-2147483648,2147483647),y:integer(-2147483648,2147483647),width:integer(1,2147483647),height:integer(1,2147483647)},['x','y','width','height']),safe_area_confirmed:{enum:[true]}},['hwnd','x','y','safe_area','safe_area_confirmed']),
  human_pause:object({operation_id:string()}),human_resume:object({operation_id:string(),pause_revision:integer(1,64),external_checked:{enum:[true]},resolution}),human_status:object({operation_id:string()}),
  human_events:object({after_seq:integer(0,Number.MAX_SAFE_INTEGER),limit:integer(1,128),pending_only:boolean}),
  human_event_ack:object({event_id:string(),session_epoch:string(),pause_generation:integer(0,Number.MAX_SAFE_INTEGER),receipt_token:string()},['event_id','session_epoch','pause_generation','receipt_token']),
  human_capabilities:object(),human_mode:object({enabled:boolean}),human_observe:object({hwnd},['hwnd']),human_target_update:object({hwnd},['hwnd']),
  human_input_plan:{type:'object',oneOf:[...['move','click','drag'].map(kind=>object({kind:{enum:[kind]},...motion},['kind','hwnd','x','y'])),object({kind:{enum:['typing']},...typing},['kind','text']),object({kind:{enum:['reading']},...reading},['kind','hwnd','segments'])]},
  human_mouse_move:object(motion,['hwnd','x','y']),human_mouse_click:object(motion,['hwnd','x','y']),human_mouse_drag:object(motion,['hwnd','x','y']),human_type:object(typing,['hwnd','text']),
  human_stop:object({reason:string(512)}),reading_start:object(reading,['hwnd','segments']),reading_status:object({operation_id:string()}),reading_cancel:object({operation_id:string(),reason:string(512)}),
  timer_attach:object({target_id:string(),section_id:string(),timer_id:string()},['target_id','section_id']),timer_prepare:object({timer_id:string()},['timer_id']),
  timer_calibrate:object({timer_id:string(),ticket_id:string(),observed_seconds:{type:'integer',minimum:0,maximum:31536000},state:{enum:['running','paused_observed','expired_observed']}},['timer_id','ticket_id','observed_seconds']),
  timer_status:object({timer_id:string()},['timer_id']),timer_invalidate:object({timer_id:string(),reason:string(512)},['timer_id']),timer_detach:object({timer_id:string()},['timer_id'])
};
Object.assign(descriptions,{human_scroll:'One explicit wheel operation in Windows units, multiples of 120 up to 1200. No pixel/line inference.',human_key:'One allowlisted editing/navigation chord. Enter may submit. Clipboard actions require dedicated tools.',human_copy:'Explicit Ctrl+C using the system clipboard; contents never inspected.',human_cut:'Explicit Ctrl+X; may modify content. No clipboard content inspection.',human_paste:'Explicit Ctrl+V; may modify content. No clipboard content inspection.',human_activate:'Distinct guarded safe client click. Caller must freshly confirm the safe area does not edit, navigate or submit. Reobserve before any following input.',human_pause:'Pause with cleanup barrier, or latch admission while idle.',human_resume:'Explicit checked continuation. Fresh native observation follows pause cleanup. Empty arguments only clear idle pause; uncertain effects require exact external outcomes.',human_status:'Readonly operation status and pending safety events. Does not resume or cancel.',human_events:'Read bounded event history. Discovery is delayed; agent push is unsupported.',human_event_ack:'Acknowledge this MCP caller receipt using the event token. Never resumes input or proves model receipt.'});
const readonly = new Set(['human_capabilities','human_observe','human_input_plan','reading_status','timer_status','human_status','human_events']);
export const TOOLS = Object.entries(schemas).map(([name,inputSchema])=>({name,description:descriptions[name],inputSchema,annotations:{readOnlyHint:readonly.has(name),destructiveHint:!readonly.has(name),idempotentHint:['human_stop','reading_cancel','human_event_ack'].includes(name),openWorldHint:false}}));
export function toolError(code,message) { return Object.assign(new Error(message),{code}); }
function valid(value,schema) {
  if(schema.oneOf) return schema.oneOf.filter(s=>valid(value,s)).length===1;
  if(schema.anyOf) return schema.anyOf.some(s=>valid(value,s));
  if(schema.enum && !schema.enum.includes(value)) return false;
  if(schema.type==='object') return value!==null && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(k=>Object.hasOwn(schema.properties,k)) && schema.required.every(k=>Object.hasOwn(value,k)) && Object.entries(value).every(([k,v])=>valid(v,schema.properties[k]));
  if(schema.type==='array') return Array.isArray(value)&&value.length>=schema.minItems&&value.length<=schema.maxItems&&value.every(v=>valid(v,schema.items));
  if(schema.type==='string') return typeof value==='string' && (!schema.minLength||value.length>=schema.minLength) && (!schema.maxLength||value.length<=schema.maxLength) && (!schema.pattern||new RegExp(schema.pattern).test(value));
  if(schema.type==='number'||schema.type==='integer') return typeof value==='number'&&Number.isFinite(value)&&(schema.type!=='integer'||Number.isSafeInteger(value))&&value>=schema.minimum&&value<=schema.maximum;
  if(schema.type==='boolean') return typeof value==='boolean';
  return true;
}
export function validateTool(name,args) {
  const schema=schemas[name];
  if(!schema) throw toolError('unknown_tool',`Unknown tool: ${name}`);
  if(!valid(args,schema)) throw toolError('invalid_arguments',`Arguments do not match strict schema for ${name}`);
  if(name==='human_scroll'&&(args.delta===0||args.delta%120!==0))throw toolError('invalid_arguments','delta must be a nonzero multiple of 120');
  if(name==='human_key'){
    const mods=args.modifiers??[];
    const navigation=['left','right','up','down','home','end','page_up','page_down'];
    const allowed=mods.includes('shift')?navigation:mods.includes('ctrl')?['a','z','y','f','enter','backspace','delete',...navigation]:['enter','tab','escape','backspace','delete','insert',...navigation];
    if(new Set(mods).size!==mods.length||!allowed.includes(args.key))throw toolError('invalid_arguments','Unsupported key chord; clipboard shortcuts require explicit tools');
  }
  if(args.pause_policy){const p={stable_ms:350,small_excursion_px:80,large_range_px:180,large_path_px:240,sustained_ms:500,window_ms:3000,...args.pause_policy};if(p.small_excursion_px<(args.threshold_px??8)||p.large_range_px<=p.small_excursion_px||p.large_path_px<p.large_range_px||p.window_ms<Math.max(p.stable_ms,p.sustained_ms))throw toolError('invalid_arguments','Inconsistent pause policy');}
  if(name==='human_input_plan') {
    const required=args.kind==='typing'?['text']:args.kind==='reading'?['segments']:['x','y'];
    if(required.some(k=>args[k]===undefined)) throw toolError('invalid_arguments',`Missing ${required.join(', ')} for ${args.kind}`);
  }
}
