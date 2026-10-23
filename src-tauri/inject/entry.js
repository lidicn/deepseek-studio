"use strict";(()=>{var ja=Object.defineProperty;var zs=e=>{throw TypeError(e)};var Ja=(e,t,n)=>t in e?ja(e,t,{enumerable:!0,configurable:!0,writable:!0,value:n}):e[t]=n;var ce=(e,t,n)=>Ja(e,typeof t!="symbol"?t+"":t,n),Wa=(e,t,n)=>t.has(e)||zs("Cannot "+n);var Ks=(e,t,n)=>t.has(e)?zs("Cannot add the same private member more than once"):t instanceof WeakSet?t.add(e):t.set(e,n);var qs=(e,t,n)=>(Wa(e,t,"access private method"),n);var js=new Map;function Xa(e){let t=js.get(e);return t||(t=new EventTarget,js.set(e,t)),t}function Js(e){let t=Xa(e),n=new WeakMap,o={origin:e,postMessage(s){o._dispatch(s,o,[])},addEventListener(s,r){let i=a=>r(a.detail);n.set(r,i),t.addEventListener(s,i)},removeEventListener(s,r){let i=n.get(r);i&&t.removeEventListener(s,i)},_dispatch(s,r,i){let a=new Event("message");a.detail={data:s,origin:e,source:r,ports:i},t.dispatchEvent(a)}};return o}function Ws(e){let{target:t,sessionId:n,reportError:o}=e,s=new Set,r=i=>{let a=i.data;if(!(!a||a.__session!==n)&&a.__payload)for(let d of[...s])try{d(a.__payload)}catch(l){o?.("direct-port onMessage handler threw",l)}};return t.addEventListener("message",r),{sessionId:n,post(i){t.postMessage({__session:n,__payload:i})},onMessage(i){return s.add(i),()=>s.delete(i)},close(){t.removeEventListener("message",r),s.clear()}}}function Ro(e){let{target:t,sessionId:n,reportError:o}=e,s;return{origin:t.origin,sessionId:n,get connected(){return s!==void 0},start(){s||(s=Ws({target:t,sessionId:n,reportError:o}))},post(r){if(!s)throw new Error("direct-bridge: not connected; call start() first");s.post(r)},onMessage(r){return s||this.start(),s.onMessage(r)},acceptsSession(r){return r.origin===t.origin&&r.sessionId===n},disconnect(){s?.close(),s=void 0}}}function Xs(e){let t=e.target??Js(e.origin),n=Ro({target:t,sessionId:e.sessionId,reportError:e.reportError}),o=Ro({target:t,sessionId:e.sessionId,reportError:e.reportError});return n.start(),o.start(),{target:t,content:n,injected:o,disconnect(){n.disconnect(),o.disconnect()}}}var No=["https://chat.deepseek.com"];function Zs(e){return e?e.trim().toLowerCase():""}function Vs(e,t=No){let n=Zs(e);return n?t.map(Zs).includes(n):!1}function Pn(e={}){let t=e.reinjectOnRouteChange??!1,n=e.maxReinjections??8,o=0,s=!1,r=globalThis.history,i=()=>{if(!s){try{e.onRouteChange?.(globalThis.location?.pathname??"/")}catch{}if(t){if(o>=n){e.onLimit?.(o);return}o+=1,e.onReinject?.()}}},a=r?.pushState?.bind(r),d=r?.replaceState?.bind(r),l=()=>i(),A=(t||!!e.onRouteChange)&&r&&a&&d;return A&&r&&a&&d&&(r.pushState=(...u)=>{a(...u),i()},r.replaceState=(...u)=>{d(...u),i()}),A&&(globalThis.addEventListener("popstate",l),globalThis.addEventListener("hashchange",l)),{start(){s=!1},stop(){s=!0,A&&(globalThis.removeEventListener("popstate",l),globalThis.removeEventListener("hashchange",l))},get reinjectionCount(){return o}}}function Za(){let e=()=>{};return{signal:new AbortController().signal,active:!0,addCleanup:()=>async()=>e(),listen:()=>async()=>e(),observe:()=>async()=>e(),setTimeout:(t,n)=>setTimeout(t,n),clearTimeout:t=>clearTimeout(t),setInterval:(t,n)=>setInterval(t,n),clearInterval:t=>clearInterval(t),requestAnimationFrame:t=>setTimeout(()=>t(Date.now()),16),cancelAnimationFrame:t=>clearTimeout(t),ownRoot:t=>t,ownPort:t=>t,snapshot:()=>({total:0,byKind:{}})}}function Va(e){let t=e.capabilities,n={async start(){for(let o of t)await o.start(Za(),1);return 1},async stop(o){for(let s of t)await s.stop(o)},snapshot:()=>({state:"running",epoch:1,resources:{total:0,byKind:{}},capabilities:{}})};return{kernel:n,start:n.start,dispose:n.stop}}var er=async e=>Va({capabilities:e.capabilities});var el="deepseek-studio.injection-loader",tr=new Map;function tl(){return globalThis.location?.origin}async function nl(e){return er(e)}function ol(e){let t=e.originWhitelist??No,n=e.lifecycleFactory??nl,o=Pn({reinjectOnRouteChange:e.reinjectOnRouteChange,maxReinjections:e.maxReinjections,onReinject:()=>void A(),onLimit:u=>console.warn(`[injection-loader] reinjection limit ${u} reached, skip`)}),s,r="pending",i=0,a=!1;function d(){let u=globalThis.document?.readyState,x=u==="loading"||u===void 0;return!x&&e.strictInstallOrder?(r="failed",!1):(x||console.warn('[injection-loader] readyState !== "loading"; proceeding (fail-open)'),!0)}async function l(){try{s=await n({capabilities:e.capabilities,onError:(u,x)=>{r="failed",e.onStartupError?.(u)}}),await s.start(),r="running"}catch(u){r="failed",e.onStartupError?.(u)}}async function A(){s&&(await s.dispose("reinjection"),i+=1,await l())}return{install(){return a?{installed:!1,status:r,generation:i,reason:"already-installed"}:Vs(tl(),t)?d()?(a=!0,i+=1,r="running",l(),o.start(),{installed:!0,status:"running",generation:i}):(a=!0,{installed:!1,status:"failed",generation:i,reason:"install-order"}):(a=!0,r="skipped",{installed:!0,status:"skipped",generation:i,reason:"origin-not-allowed"})},getLifecycle:()=>s,getStatus:()=>r,getGeneration:()=>i,async dispose(u="manual"){o.stop(),s&&await s.dispose(u)}}}function nr(e){let t=Symbol.for(el),n=tr.get(t);if(n)return n.install();let o=ol(e);return tr.set(t,o),o.install()}var or=0;function sr(){return{id:"echo",start(e){e.addCleanup("listener",()=>{or=Date.now()}),or=Date.now()},async stop(){},async execute(){return{ok:!0}}}}function rr(e,t){for(let n of t){let o=Array.from(e.querySelectorAll(n));if(o.length>0)return o}return[]}function Ft(e,t){for(let n of t){let o=e.querySelector(n);if(o)return o}return null}function ir(e,t){let n=()=>{e.dispatchEvent(new Event("input",{bubbles:!0}))};if(e instanceof HTMLTextAreaElement){let o=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")?.set;return o?o.call(e,t):e.value=t,n(),!0}if(e instanceof HTMLInputElement){let o=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;return o?o.call(e,t):e.value=t,n(),!0}return e instanceof HTMLElement&&(e.isContentEditable||e.getAttribute("contenteditable")==="true")?(e.textContent=t,n(),!0):!1}function ar(e){let t={key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:!0,cancelable:!0};return e.dispatchEvent(new KeyboardEvent("keydown",t)),e.dispatchEvent(new KeyboardEvent("keypress",t)),e.dispatchEvent(new KeyboardEvent("keyup",t)),!0}function Gn(e){return e instanceof HTMLElement?(e.click(),!0):!1}var sl=[".ds-assistant-message-main-content",".ds-markdown",'[class*="message-item"]','[class*="chat-message"]',"#chat-messages > *",".message"],lr=/(^|\s)(user|human|你|我发)/i,cr=/(^|\s)(assistant|bot|ai|deepseek|助理|助手|思考|reasoning)/i;function rl(e){let t=(typeof e.className=="string"?e.className:"").toLowerCase(),n=(e.textContent??"").slice(0,48);return lr.test(t)||lr.test(n)?"user":cr.test(t)||cr.test(n)?"assistant":"unknown"}function dr(){return{id:"chat-read",start(){},async stop(){},async execute(){let e=globalThis.document;if(!e)return{ok:!1,error:"no-document"};let t=e.querySelector("#chat-container")??e.body,n=rr(t,sl);if(n.length===0)return{ok:!1,error:"no-messages-found"};let o=n.map(s=>({role:rl(s),text:(s.textContent??"").replace(/\s+/g," ").trim()})).filter(s=>s.text.length>0);return{ok:!0,data:{count:o.length,messages:o}}}}}var il=["textarea#chat-input","#chat-input",'[contenteditable="true"]',"textarea",".chat-input"];function Ar(){return{id:"chat-insert",start(){},async stop(){},async execute(e){let t=typeof e.text=="string"?e.text:"";if(t.length===0)return{ok:!1,error:"missing-text"};let n=globalThis.document;if(!n)return{ok:!1,error:"no-document"};let o=Ft(n,il);return o?ir(o,t)?{ok:!0,data:{inserted:t.length}}:{ok:!1,error:"input-not-writable"}:{ok:!1,error:"input-not-found"}}}}var al=['[data-testid="send-button"]','button[aria-label*="\u53D1\u9001" i]','button[aria-label*="send" i]',".send-button",'button[type="submit"]'];function ll(e){let t=Array.from(e.querySelectorAll("textarea")).find(n=>n.offsetWidth>0);return t||Ft(e,['[contenteditable="true"]'])}function cl(e){let t=e;for(let n=0;n<6&&t&&(t=t.parentElement,!!t);n++){let o=Ft(t,["div.ds-button--circle",".ds-button--circle","div.ds-button--filled",'[role="button"][aria-disabled="false"]']);if(o&&o.offsetWidth>0)return o}return null}function dl(e){return Ft(e,["div.ds-button--circle",".ds-button--circle"])}function ur(e){return e instanceof HTMLTextAreaElement||e instanceof HTMLInputElement?e.value:e.textContent??""}function pr(){return{id:"chat-send",start(){},async stop(){},async execute(){let e=globalThis.document;if(!e)return{ok:!1,error:"no-document"};let t=ll(e);if(t){let s=cl(t);if(s&&Gn(s))return{ok:!0,data:{sent:!0,via:"circle-button-near"}}}let n=dl(e);if(n&&Gn(n))return{ok:!0,data:{sent:!0,via:"circle-button-global"}};let o=Ft(e,al);if(o&&Gn(o))return{ok:!0,data:{sent:!0,via:"legacy-button"}};if(t){let s=ur(t);ar(t);let r=ur(t);return s.length===0||r.length===0||r!==s?{ok:!0,data:{sent:!0,via:"enter-key"}}:{ok:!1,error:"send-unconfirmed",data:{via:"enter-key",hint:"\u5408\u6210 Enter \u672A\u88AB\u91C7\u7EB3\uFF0C\u8F93\u5165\u6846\u5185\u5BB9\u672A\u53D8"}}}return{ok:!1,error:"send-button-not-found"}}}}var Al=["workspace","ask","auto","full"],en=["workspace","auto","full"];var it={workspace:"\u4EC5\u5DE5\u4F5C\u533A",ask:"\u8BE2\u95EE\u5BA1\u6279",auto:"\u98CE\u9669\u5BA1\u6279",full:"\u5B8C\u5168\u653E\u5F00"};function gr(e){return typeof e=="string"&&Al.includes(e)}var fr="ds-consent-style",ul=`
.ds-consent-overlay {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4);
  backdrop-filter: blur(2px);
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  animation: ds-consent-fade 120ms ease-out;
}
.ds-consent-card {
  min-width: 300px; max-width: 420px; padding: 20px 22px;
  border-radius: 16px; background: rgba(255,255,255,0.92);
  box-shadow: 0 12px 40px rgba(20,30,60,0.25);
  border: 1px solid rgba(77,107,254,0.18);
  color: #1F2329; animation: ds-consent-pop 120ms ease-out;
}
@media (prefers-color-scheme: dark) {
  .ds-consent-card { background: rgba(30,31,35,0.94); color: #E8EAED; border-color: rgba(77,107,254,0.35); }
}
.ds-consent-title { font-size: 13px; font-weight: 500; opacity: 0.7; }
.ds-consent-tool {
  margin-top: 8px; font-size: 15px; font-weight: 600; color: #4D6BFE;
}
@media (prefers-color-scheme: dark) { .ds-consent-tool { color: #6E8BFF; } }
.ds-consent-summary {
  margin-top: 10px; font-size: 13px; line-height: 1.5; opacity: 0.85;
  max-height: 140px; overflow: auto; word-break: break-all;
}
.ds-consent-badges { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
.ds-consent-badge {
  font-size: 11px; line-height: 1.4; padding: 2px 8px; border-radius: 999px;
  background: rgba(77,107,254,0.12); color: #4D6BFE; border: 1px solid rgba(77,107,254,0.25);
}
.ds-consent-badge[data-level="danger"] {
  background: rgba(212,56,13,0.12); color: #D4380D; border-color: rgba(212,56,13,0.3);
}
.ds-consent-badge[data-level="warn"] {
  background: rgba(212,138,13,0.14); color: #B26A00; border-color: rgba(212,138,13,0.3);
}
@media (prefers-color-scheme: dark) {
  .ds-consent-badge[data-level="danger"] { color: #FF7A5C; }
  .ds-consent-badge[data-level="warn"] { color: #E8A33D; }
}
.ds-consent-actions { margin-top: 18px; display: flex; gap: 10px; justify-content: flex-end; }
.ds-consent-actions button {
  border: none; border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 500;
  cursor: pointer; transition: transform 80ms ease, filter 80ms ease;
}
.ds-consent-actions button:hover { filter: brightness(1.05); }
.ds-consent-actions button:active { transform: scale(0.97); }
.ds-consent-deny { background: rgba(212,56,13,0.12); color: #D4380D; }
.ds-consent-allow-once { background: #4D6BFE; color: #fff; }
.ds-consent-allow-session { background: rgba(43,164,113,0.14); color: #2BA471; }
@keyframes ds-consent-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ds-consent-pop { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
`;function pl(){if(globalThis.document.getElementById(fr))return;let e=globalThis.document.createElement("style");e.id=fr,e.textContent=ul,globalThis.document.head.appendChild(e)}function mr(e,t){let n=globalThis.document,o=e.timeoutMs??6e4,s=!1,r;pl();let i=n.createElement("div");i.className="ds-consent-overlay",i.setAttribute("role","dialog"),i.setAttribute("aria-modal","true");let a=n.createElement("div");a.className="ds-consent-card";let d=n.createElement("div");d.className="ds-consent-title";let l=gl(e);d.textContent=l.title;let A=n.createElement("div");A.className="ds-consent-tool",A.textContent=l.headline;let u=fl(e.meta),x=n.createElement("div");x.className="ds-consent-summary",x.textContent=l.summary;let m=n.createElement("div");m.className="ds-consent-actions";let C=Mo(l.allowOnceLabel,"ds-consent-allow-once"),b=Mo("\u62D2\u7EDD","ds-consent-deny"),_=Mo(l.allowSessionLabel,"ds-consent-allow-session");m.append(C,b,_),a.append(d,A,...u?[u]:[],x,m),i.append(a),n.body.append(i);function S(R){s||(s=!0,r&&clearTimeout(r),i.remove(),n.removeEventListener("keydown",h),t(R))}function h(R){R.key==="Escape"?S("deny"):R.key==="Enter"&&S("allow-once")}return C.addEventListener("click",()=>S("allow-once")),b.addEventListener("click",()=>S("deny")),_.addEventListener("click",()=>S("allow-session")),i.addEventListener("click",R=>{R.target===i&&S("deny")}),n.addEventListener("keydown",h),r=setTimeout(()=>S("deny"),o),{decide:S,dispose(){r&&clearTimeout(r),i.remove(),n.removeEventListener("keydown",h)}}}function gl(e){if(e.tool==="policy.set"){let t=e.params?.mode,n=gr(t)?it[t]:"\u6240\u9009\u6863\u4F4D";return{title:"Studio \u8BF7\u6C42\u4FEE\u6539\u5BA1\u6279\u6863\u4F4D",headline:`\u5C06\u5BA1\u6279\u6863\u4F4D\u6539\u4E3A\u300C${n}\u300D`,summary:t==="full"?"\u5141\u8BB8\u540E\uFF0C\u540E\u7EED\u5DE5\u5177\u5C06\u6309\u201C\u5B8C\u5168\u653E\u5F00\u201D\u6267\u884C\uFF0C\u666E\u901A\u64CD\u4F5C\u53EF\u80FD\u4E0D\u518D\u9010\u6B21\u5411\u4F60\u786E\u8BA4\u3002\u8BF7\u786E\u8BA4\u4F60\u4E86\u89E3\u8FD9\u9879\u53D8\u66F4\u7684\u5F71\u54CD\u3002":`\u5141\u8BB8\u540E\uFF0C\u540E\u7EED\u5DE5\u5177\u5C06\u6309\u201C${n}\u201D\u6863\u4F4D\u6267\u884C\u3002\u8BE5\u8BBE\u7F6E\u4F1A\u6539\u53D8\u5DE5\u5177\u6267\u884C\u524D\u7684\u786E\u8BA4\u5F3A\u5EA6\u3002`,allowOnceLabel:"\u5141\u8BB8\u672C\u6B21\u4FEE\u6539",allowSessionLabel:"\u672C\u6B21\u4F1A\u8BDD\u5141\u8BB8\u4FEE\u6539"}}if(e.tool==="workspace.set"){let t=e.params?.root;return{title:"Studio \u8BF7\u6C42\u4FEE\u6539\u5DE5\u4F5C\u533A",headline:"\u5C06\u5DE5\u5177\u5DE5\u4F5C\u533A\u5207\u6362\u5230\u65B0\u76EE\u5F55",summary:`\u5141\u8BB8\u540E\uFF0C\u6587\u4EF6\u4E0E\u547D\u4EE4\u64CD\u4F5C\u5C06\u4EE5\u300C${typeof t=="string"&&t?t:"\u6240\u9009\u76EE\u5F55"}\u300D\u4F5C\u4E3A\u53EF\u4FE1\u6839\u76EE\u5F55\u3002`,allowOnceLabel:"\u5141\u8BB8\u672C\u6B21\u4FEE\u6539",allowSessionLabel:"\u672C\u6B21\u4F1A\u8BDD\u5141\u8BB8\u4FEE\u6539"}}return{title:"DeepSeek++ Studio \u8BF7\u6C42\u6267\u884C\u5DE5\u5177",headline:e.tool,summary:ml(e.params),allowOnceLabel:"\u5141\u8BB8\u4E00\u6B21",allowSessionLabel:"\u672C\u6B21\u4F1A\u8BDD\u5141\u8BB8"}}function fl(e){if(!e)return null;let t=[];e.riskLabel&&t.push({text:e.riskLabel,level:"danger"}),e.modeLabel&&t.push({text:e.modeLabel,level:"info"}),e.outside&&t.push({text:"\u5DE5\u4F5C\u533A\u5916",level:"warn"});for(let s of e.riskFlagLabels??[])t.push({text:s,level:"danger"});if(t.length===0)return null;let n=globalThis.document,o=n.createElement("div");o.className="ds-consent-badges";for(let s of t){let r=n.createElement("span");r.className="ds-consent-badge",r.dataset.level=s.level,r.textContent=s.text,o.append(r)}return o}function Mo(e,t){let n=globalThis.document.createElement("button");return n.className=t,n.textContent=e,n}function ml(e){if(e==null)return"\uFF08\u65E0\u53C2\u6570\uFF09";if(typeof e!="object")return String(e).slice(0,64);let t=Object.entries(e);return t.length===0?"\uFF08\u65E0\u53C2\u6570\uFF09":t.map(([n,o])=>{let s=typeof o=="string"?o:JSON.stringify(o),r=s.length>32?`${s.slice(0,32)}\u2026`:s;return`${n}: ${r}`}).join("\uFF1B")}var hr="ds-account-block-style",hl=`
.ds-account-block-overlay {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center;
  background: rgba(180, 24, 24, 0.97);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Microsoft YaHei", sans-serif;
}
.ds-account-block-card {
  max-width: 560px; margin: 0 24px; padding: 32px 28px;
  background: #fff; border-radius: 14px; color: #1a1a1a;
  box-shadow: 0 24px 60px rgba(0,0,0,.4);
}
.ds-account-block-title {
  font-size: 20px; font-weight: 700; color: #b41818; margin-bottom: 12px;
}
.ds-account-block-body {
  font-size: 15px; line-height: 1.7; color: #333; margin-bottom: 20px;
}
.ds-account-block-body strong { color: #b41818; }
.ds-account-block-hint {
  font-size: 13px; color: #666; margin-top: 16px; padding-top: 16px;
  border-top: 1px solid #eee;
}
`;function Cl(){let e=globalThis.document;if(!e||e.getElementById(hr))return;let t=e.createElement("style");t.id=hr,t.textContent=hl,e.head.appendChild(t)}var Cr=null;function Ir(e,t){let n=globalThis.document;if(!n||!n.body||Cr)return;Cl();let o=n.createElement("div");o.className="ds-account-block-overlay",o.setAttribute("role","alertdialog"),o.setAttribute("aria-modal","true");let s=n.createElement("div");s.className="ds-account-block-card";let r=n.createElement("div");r.className="ds-account-block-title",r.textContent="\u26A0\uFE0F \u8D26\u53F7\u51B2\u7A81 \u2014 \u672C\u7A97\u53E3\u5DF2\u505C\u7528";let i=n.createElement("div");i.className="ds-account-block-body",i.replaceChildren();let a=n.createElement("div");a.textContent=e;let d=n.createElement("div");if(d.innerHTML="\u540C\u4E00 DeepSeek \u8D26\u53F7\u5728\u591A\u4E2A\u7A97\u53E3\u5E76\u53D1\u767B\u5F55\u4F1A\u89E6\u53D1 <strong>\u98CE\u63A7\u5C01\u53F7</strong>\u3002",i.append(a,d),t){let A=n.createElement("div");A.textContent=`\u5DF2\u5360\u7528\u8BE5\u8D26\u53F7\u7684\u7A97\u53E3\uFF1Abot=${t}`,i.append(A)}let l=n.createElement("div");l.className="ds-account-block-hint",l.textContent="\u8BF7\u5173\u95ED\u672C\u7A97\u53E3\uFF0C\u6216\u5728\u672C\u7A97\u53E3\u767B\u51FA\u540E\u5207\u6362\u5230\u53E6\u4E00\u4E2A DeepSeek \u8D26\u53F7\u3002\u672C\u7A97\u53E3\u7684\u5DE5\u5177\u8C03\u7528\u5DF2\u88AB\u5BBF\u4E3B\u62D2\u7EDD\uFF08fail-closed\uFF09\u3002",s.append(r,i,l),o.append(s),n.body.append(o),Cr=o}var Il=75e3,yt=1;function yr(options){let capabilities=new Map(options.capabilities.map(e=>[e.id,e])),origin=options.origin??globalThis.location?.origin??"https://chat.deepseek.com",maxBackoff=options.maxBackoffMs??1e4,toolCallTimeoutMs=options.toolCallTimeoutMs??Il,ws=null,stopped=!1,backoff=500,reconnectTimer=null,tokenStorageHandler=null,pendingToolCalls=new Map,pendingKv=new Map,pendingEnvelope=new Map,connectedCallbacks=new Set;function failAllPending(e){for(let[t,n]of pendingToolCalls)clearTimeout(n.timer),pendingToolCalls.delete(t),n.resolve({ok:!1,error:e});for(let[t,n]of pendingKv)pendingKv.delete(t),n.resolve(void 0,e);for(let[t,n]of pendingEnvelope)pendingEnvelope.delete(t),n.resolve({ok:!1,error:e})}function send(e){if(ws&&ws.readyState===yt)try{ws.send(JSON.stringify(e))}catch(t){options.reportError?.("host-client send failed",t)}}function readAccountFingerprint(){try{let e=globalThis.localStorage?.getItem("userToken"),t=readUserToken(e);return t?(cachedRawToken===t||(cachedRawToken=t,cachedFingerprint=fingerprintHash(t)),cachedFingerprint):void 0}catch{return}}let cachedRawToken=null,cachedFingerprint;function readUserToken(e){if(!e||e.trim()==="null")return null;let t=e.trim();try{let n=JSON.parse(t);if(typeof n=="string")return n.trim()||null;if(n&&typeof n=="object"){let o=n.token??n.value??n.accessToken;return typeof o=="string"&&o.trim()?o.trim():null}}catch{}return t||null}function fingerprintHash(e){let t=2166136261,n=16777619;for(let s=0;s<e.length;s++){let r=e.charCodeAt(s);t=Math.imul(t^r,16777619)>>>0,n=Math.imul(n+r,268435515)>>>0}return((t^e.length*2654435761^n)>>>0).toString(16).padStart(8,"0")+(n>>>0).toString(16).padStart(8,"0")}function handle(msg){if(msg.type==="dispatch"){let e=capabilities.get(msg.tool);if(!e){send({type:"result",callId:msg.callId,ok:!1,error:"unknown-tool"});return}e.execute(msg.params??{}).then(t=>send({type:"result",callId:msg.callId,ok:t.ok,data:t.data,error:t.error})).catch(t=>send({type:"result",callId:msg.callId,ok:!1,error:t instanceof Error?t.message:String(t)}))}else if(msg.type==="consent-required")mr({tool:msg.tool,params:msg.params,meta:msg.meta},e=>{send({type:"consent-decision",callId:msg.callId,decision:e})});else if(msg.type==="tool-call-result"){let e=pendingToolCalls.get(msg.callId);e&&(clearTimeout(e.timer),pendingToolCalls.delete(msg.callId),e.resolve({ok:msg.ok,data:msg.data,error:msg.error,...msg.content!==void 0?{content:msg.content}:{},...msg.details!==void 0?{details:msg.details}:{},...msg.isError!==void 0?{isError:msg.isError}:{},...msg.terminate!==void 0?{terminate:msg.terminate}:{}}))}else if(msg.type==="kv-result"){let e=pendingKv.get(msg.requestId);e&&(pendingKv.delete(msg.requestId),msg.ok?e.resolve(msg.value):e.resolve(void 0,msg.error))}else if(msg.type==="runtime-envelope-result"){let e=pendingEnvelope.get(msg.requestId);e&&(pendingEnvelope.delete(msg.requestId),e.resolve(msg.response))}else if(msg.type==="memories-update")options.onMemoriesUpdate?.(msg.memories);else if(msg.type==="debug-eval"){if(!options.enableDebugEval){let{requestId:e}=msg;send({type:"debug-eval-result",requestId:e,ok:!1,result:"debug-eval disabled in production"});return}let{requestId,code}=msg;try{let result=eval(code);send({type:"debug-eval-result",requestId,ok:!0,result:typeof result=="string"?result:JSON.stringify(result)})}catch(e){send({type:"debug-eval-result",requestId,ok:!1,result:String(e)})}}else msg.type==="debug-reload"?location.reload():msg.type==="account-duplicate-block"&&Ir(msg.reason,msg.duplicateOf)}function onMessage(e){let t;try{t=JSON.parse(typeof e=="string"?e:String(e))}catch{return}handle(t)}function connectWs(){if(stopped)return;let t=(options.wsFactory??(n=>new globalThis.WebSocket(n)))(options.url);ws=t,t.onopen=()=>{backoff=500,send({type:"hello",origin,sessionId:crypto.randomUUID(),botId:options.botId,accountFingerprint:readAccountFingerprint()});for(let n of connectedCallbacks)try{n()}catch(o){options.reportError?.("host-client connected callback failed",o)}},t.onmessage=n=>onMessage(n.data),t.onclose=()=>{ws=null,failAllPending("disconnected"),stopped||scheduleReconnect()},t.onerror=()=>{try{t.close()}catch{}}}function scheduleReconnect(){let e=backoff;backoff=Math.min(backoff*2,maxBackoff),reconnectTimer=setTimeout(connectWs,e)}return{get connected(){return ws!==null&&ws.readyState===yt},onConnected(e){return connectedCallbacks.add(e),ws&&ws.readyState===yt&&queueMicrotask(()=>{try{e()}catch(t){options.reportError?.("host-client connected callback failed",t)}}),()=>connectedCallbacks.delete(e)},reportIntegrity(e){send({type:"integrity-alert",reason:e.reason,detail:e.detail})},sendToolCall(e){return new Promise(t=>{if(!ws||ws.readyState!==yt){t({ok:!1,error:"no-host"});return}let n=setTimeout(()=>{pendingToolCalls.delete(e.callId),t({ok:!1,error:"host-timeout"})},toolCallTimeoutMs);pendingToolCalls.set(e.callId,{resolve:t,timer:n}),send({type:"tool-call",callId:e.callId,invocationName:e.invocationName,params:e.params,botId:options.botId})})},connect(){stopped=!1,!tokenStorageHandler&&typeof globalThis.addEventListener=="function"&&(tokenStorageHandler=e=>{e.key==="userToken"&&(cachedRawToken=null,ws&&ws.readyState===yt&&send({type:"hello",origin,sessionId:crypto.randomUUID(),botId:options.botId,accountFingerprint:readAccountFingerprint()}))},globalThis.addEventListener("storage",tokenStorageHandler)),connectWs()},log(e){send({type:"log",text:e})},trace(e){send({type:"trace",line:e})},assistantReply(e,t){send({type:"assistant-reply",text:e,loop:t})},streamDelta(e){send({type:"stream-delta",text:e})},kvGet(e){return new Promise((t,n)=>{if(!ws||ws.readyState!==yt){t(void 0);return}let o=crypto.randomUUID(),s=setTimeout(()=>{pendingKv.delete(o),n(new Error("kv-get timeout"))},3e4);pendingKv.set(o,{resolve:(r,i)=>{clearTimeout(s),i?n(new Error(i)):t(r)}}),send({type:"kv-get",requestId:o,key:e})})},kvSet(e,t){return new Promise((n,o)=>{if(!ws||ws.readyState!==yt){n();return}let s=crypto.randomUUID(),r=setTimeout(()=>{pendingKv.delete(s),o(new Error("kv-set timeout"))},3e4);pendingKv.set(s,{resolve:(i,a)=>{clearTimeout(r),a?o(new Error(a)):n()}}),send({type:"kv-set",requestId:s,key:e,value:t})})},kvRemove(e){return new Promise((t,n)=>{if(!ws||ws.readyState!==yt){t();return}let o=crypto.randomUUID(),s=setTimeout(()=>{pendingKv.delete(o),n(new Error("kv-remove timeout"))},3e4);pendingKv.set(o,{resolve:(r,i)=>{clearTimeout(s),i?n(new Error(i)):t()}}),send({type:"kv-remove",requestId:o,key:e})})},sendEnvelope(e){return new Promise(t=>{if(!ws||ws.readyState!==yt){t({ok:!1,error:"no-host"});return}let n=setTimeout(()=>{pendingEnvelope.delete(e.requestId),t({ok:!1,error:"envelope timeout"})},3e4);pendingEnvelope.set(e.requestId,{resolve:o=>{clearTimeout(n),t(o)}}),send({type:"runtime-envelope",envelope:e})})},disconnect(){stopped=!0,reconnectTimer&&(clearTimeout(reconnectTimer),reconnectTimer=null),tokenStorageHandler&&typeof globalThis.removeEventListener=="function"&&globalThis.removeEventListener("storage",tokenStorageHandler),tokenStorageHandler=null;for(let e of pendingToolCalls.values())clearTimeout(e.timer),e.resolve({ok:!1,error:"disconnected"});if(pendingToolCalls.clear(),ws){try{ws.close()}catch{}ws=null}}}}var fn=class{constructor(t){this.names=t;ce(this,"tail","")}feed(t){let n=this.tail+t;this.tail="";let o=[],s="",r=0;for(;r<n.length;){let i=n.indexOf("<",r);if(i===-1){s+=n.slice(r);break}s+=n.slice(r,i);let a=n.slice(i),d=a.match(/^<([a-zA-Z_][\w.:-]*)>/);if(d&&this.names.includes(d[1])){let l=d[1],A=i+d[0].length,u=`</${l}>`,x=n.indexOf(u,A);if(x===-1){this.tail=n.slice(i);break}let m=n.slice(A,x),C=n.slice(i,x+u.length);o.push(this.make(l,m,C)),r=x+u.length}else{let l=a.match(/^<\/([a-zA-Z_][\w.:-]*)>/);if(l&&this.names.includes(l[1]))r=i+l[0].length;else if(/^<\/?[a-zA-Z_][\w.:-]*$/.test(a)||/^<\/?$/.test(a)){this.tail=n.slice(i);break}else s+="<",r=i+1}}return{calls:o,clean:s}}flush(){let t=this.tail;return this.tail="",{calls:[],clean:t}}make(t,n,o){let s={};try{let r=JSON.parse(n);r&&typeof r=="object"&&(s=r)}catch(r){let i=yl(n);if(i!==n)try{let a=JSON.parse(i);if(a&&typeof a=="object")return s=a,{id:this.genId(),invocationName:t,params:s,raw:o}}catch{}s={__invalid_json:!0,__error:r instanceof Error?r.message:String(r),__raw:n}}return{id:this.genId(),invocationName:t,params:s,raw:o}}genId(){return typeof globalThis.crypto<"u"&&typeof globalThis.crypto.randomUUID=="function"?globalThis.crypto.randomUUID():`call-${Date.now()}-${Math.random().toString(36).slice(2)}`}};function yl(e){let t="",n=!1,o=0;for(;o<e.length;){let s=e[o];if(s==="\\"&&n){t+=s,o+1<e.length?(t+=e[o+1],o+=2):o+=1;continue}if(s==='"'){if(!n)n=!0,t+=s;else{let r=o+1;for(;r<e.length&&(e[r]===" "||e[r]==="	"||e[r]===`
`);)r++;let i=e[r];i===","||i==="}"||i==="]"||i===":"||i===void 0?(n=!1,t+=s):t+='\\"'}o+=1;continue}t+=s,o+=1}return t}function El(e){if(!e||typeof e!="object")return null;let t=e;if(t.p!==void 0||!t.v||typeof t.v!="object"||Array.isArray(t.v))return null;let n=t.v.response;if(!n||typeof n!="object")return null;let o=n.fragments;return Array.isArray(o)&&o.length>0?o:null}var mn=class{constructor(){ce(this,"lineBuffer","");ce(this,"activeFragmentType",null);ce(this,"reasoningBuffer","");ce(this,"snapshotSeen",!1)}feed(t){let o=(this.lineBuffer+t).split(`
`);this.lineBuffer=o.pop()??"";let s="";for(let r of o)s+=this.extractLine(r);return s}flush(){let t=this.lineBuffer;return this.lineBuffer="",this.extractLine(t)}consumeReasoning(){let t=this.reasoningBuffer;return this.reasoningBuffer="",t}extractLine(t){let n=t.trim();if(!n.startsWith("data:"))return"";let o=n.slice(5).trim();if(!o||o==="[DONE]")return"";let s;try{s=JSON.parse(o)}catch{return""}if(s.p==="response/fragments"&&Array.isArray(s.v)){for(let a of s.v)if(a&&typeof a=="object"){let d=a.type;(d==="THINK"||d==="RESPONSE")&&(this.activeFragmentType=d)}let i="";for(let a of s.v){if(!a||typeof a!="object")continue;let d=a;typeof d.content=="string"&&(d.type==="THINK"?this.reasoningBuffer+=d.content:i+=d.content)}return i}let r=El(s);if(r){let i=!this.snapshotSeen;this.snapshotSeen=!0;for(let d of r){let l=d?.type;(l==="THINK"||l==="RESPONSE")&&(this.activeFragmentType=l)}if(!i)return"";let a="";for(let d of r){if(!d||typeof d!="object")continue;let l=d;typeof l.content=="string"&&(l.type==="THINK"?this.reasoningBuffer+=l.content:a+=l.content)}return a}if(typeof s.v=="string"){let i=String(s.p??"");return i&&!bl(i)?"":this.activeFragmentType==="THINK"?(this.reasoningBuffer+=s.v,""):s.v}if(Array.isArray(s.v)){let i="";for(let a of s.v){if(!a||typeof a!="object")continue;let d=a;typeof d.content=="string"&&(d.type==="THINK"?this.reasoningBuffer+=d.content:i+=d.content)}return i}return""}};function bl(e){if(!e.startsWith("response"))return!1;let t=e.split("/").pop();return t==="content"||t==="text"||t==="markdown"||t==="delta"}var hn=class{constructor(){ce(this,"buffer","");ce(this,"scanFrom",0)}push(t){return this.buffer+=t,this.drain()}finish(){let t=this.drain();return this.buffer&&(t.push(this.createFrame(this.buffer,"")),this.buffer=""),this.scanFrom=0,t}drain(){let t=[],n=/\r?\n\r?\n/g;n.lastIndex=this.scanFrom;let o=0,s;for(;(s=n.exec(this.buffer))!==null;)t.push(this.createFrame(this.buffer.slice(o,s.index),s[0])),o=s.index+s[0].length;return this.buffer=this.buffer.slice(o),this.scanFrom=Math.max(0,this.buffer.length-3),t}createFrame(t,n){let o="message",s=[];for(let d of t.split(`
`)){let l=d.indexOf(":");if(l===-1)continue;let A=d.slice(0,l).trim(),u=d.slice(l+1).trimStart();A==="event"?o=u:A==="data"&&s.push(u)}let r=s.join(`
`),i=r?{type:o,data:r}:null,a=null;if(r)try{a=JSON.parse(r)}catch{}return{block:t,event:i,parsed:a}}};function Cn(e){for(let t of e){let n=t.event?.type;if(n&&n.toLowerCase()==="close")return!0;let o=t.parsed;if(!(!o||typeof o!="object")){if(o.p==="response/status"&&o.v==="FINISHED")return!0;if(o.p==="response"&&Array.isArray(o.v))for(let s of o.v){if(!s||typeof s!="object")continue;let r=s;if(r.p==="quasi_status"&&r.v==="FINISHED")return!0}}}return!1}var Yn=Object.assign(Object.create(null),{shell_exec:{id:"shell.exec",adapt:e=>({command:typeof e.command=="string"?e.command:typeof e.cmd=="string"?e.cmd:"",...typeof e.timeout_ms=="number"?{timeoutMs:e.timeout_ms}:{},...typeof e.cwd=="string"?{cwd:e.cwd}:{}})},local_file_read:{id:"file.read",adapt:e=>({path:typeof e.path=="string"?e.path:"",...typeof e.start=="number"?{offset:e.start}:typeof e.offset=="number"?{offset:e.offset}:{},...typeof e.max_chars=="number"?{limit:e.max_chars}:typeof e.limit=="number"?{limit:e.limit}:{}})},local_file_write:{id:"file.write",adapt:e=>({path:typeof e.path=="string"?e.path:"",content:typeof e.content=="string"?e.content:""})},local_file_stat:{id:"file.stat",adapt:e=>({path:typeof e.path=="string"?e.path:""})},file_edit:{id:"file.edit",adapt:e=>({path:typeof e.path=="string"?e.path:"",edits:Array.isArray(e.edits)?e.edits:[],...typeof e.expectedSha256=="string"?{expectedSha256:e.expectedSha256}:{},...e.dryRun===!0?{dryRun:!0}:{}})},search_files:{id:"search_files",adapt:e=>({operation:typeof e.operation=="string"?e.operation:"list",...typeof e.root=="string"?{root:e.root}:{},...typeof e.query=="string"?{query:e.query}:{},...e.regex===!0?{regex:!0}:{},...e.caseInsensitive===!0?{caseInsensitive:!0}:{},...typeof e.glob=="string"?{glob:e.glob}:{},...typeof e.pattern=="string"?{pattern:e.pattern}:{},...typeof e.recursive=="boolean"?{recursive:e.recursive}:{},...typeof e.limit=="number"?{limit:e.limit}:{}})},memory_save:{id:"memory.save",adapt:e=>({type:typeof e.type=="string"?e.type:"user",name:typeof e.name=="string"?e.name:"",content:typeof e.content=="string"?e.content:"",tags:Array.isArray(e.tags)?e.tags:[]})},python_exec:{id:"python.exec",adapt:e=>({code:typeof e.code=="string"?e.code:""})},mcp_list:{id:"mcp.list",adapt:()=>({})},mcp_call:{id:"mcp.call",adapt:e=>({serverId:typeof e.serverId=="string"?e.serverId:"",tool:typeof e.tool=="string"?e.tool:typeof e.name=="string"?e.name:"",args:e.args&&typeof e.args=="object"?e.args:e.arguments&&typeof e.arguments=="object"?e.arguments:{}})}}),Er=Object.assign(Object.create(null),{mcp_test:{id:"mcp.test",adapt:e=>({config:e.config&&typeof e.config=="object"?e.config:{}})},"mcp.test":{id:"mcp.test",adapt:e=>({config:e.config&&typeof e.config=="object"?e.config:{}})},mcp_save:{id:"mcp.save",adapt:e=>({serverId:typeof e.serverId=="string"?e.serverId:typeof e.id=="string"?e.id:"",config:e.config&&typeof e.config=="object"?e.config:{}})},"mcp.save":{id:"mcp.save",adapt:e=>({serverId:typeof e.serverId=="string"?e.serverId:typeof e.id=="string"?e.id:"",config:e.config&&typeof e.config=="object"?e.config:{}})},"mcp.remove":{id:"mcp.remove",adapt:e=>e},"mcp.get":{id:"mcp.get",adapt:e=>e},"memory.delete":{id:"memory.delete",adapt:e=>e},"workspace.set":{id:"workspace.set",adapt:e=>e},"policy.set":{id:"policy.set",adapt:e=>e},"settings.get":{id:"settings.get",adapt:e=>e},"project.list":{id:"project.list",adapt:e=>e},"project.create":{id:"project.create",adapt:e=>e},"folder.pick":{id:"folder.pick",adapt:e=>e},"skill.list":{id:"skill.list",adapt:e=>e}}),Fu=Object.assign(Object.create(null),Yn,Er),Lo=Object.keys(Yn),Uu=Object.keys(Er),Hu=Object.keys(Yn);function br(e){return Object.prototype.hasOwnProperty.call(Yn,e)}function xl(e){if(!Array.isArray(e)||e.length===0)return null;let t=[];for(let n of e)n&&n.type==="text"&&typeof n.text=="string"&&t.push(n.text);return t.join("")}function kl(e){try{return JSON.stringify(e,null,2)}catch{return String(e)}}function wl(e){if(e.error)return e.error;if(e.data==null)return"";if(typeof e.data=="object"&&e.data!==null&&"stdout"in e.data){let t=e.data,n=typeof t.stdout=="string"?t.stdout:"",o=typeof t.stderr=="string"?t.stderr:"",s=t.exitCode,r=o.replace(/#< CLIXML[\s\S]*?<\/Objs>/g,"").replace(/System\.Management\.Automation\.[\s\S]*?Completed-1/g,"").replace(/\bCompleted-1\b/g,"").replace(/Preparing modules for first use\./g,"").trim(),i=[];return n.trim()&&i.push(n.trimEnd()),r&&i.push(`[stderr]
${r}`),!e.ok&&s!==void 0&&s!==0&&i.push(`[exit-code] ${s}`),i.join(`

`)||"(empty output)"}return typeof e.data=="string"?e.data:kl(e.data)}function xr(e){let t=xl(e.content),n=t!==null?t:wl(e);return e.isError!==!0?n:n?`[\u9519\u8BEF] ${n}`:"[\u9519\u8BEF]"}function kr(e){return!Array.isArray(e)||e.length===0?!1:e.every(t=>!!t&&t.terminate===!0)}var Bl=/<task_complete>\s*([\s\S]*?)\s*<\/task_complete>/,vl="\u4EE5\u4E0B\u662F\u5DE5\u5177\u7EED\u8DD1\u4EFB\u52A1\u521A\u521A\u6267\u884C\u7684\u5DE5\u5177\u7ED3\u679C\u3002\u8BF7\u50CF\u771F\u6B63\u7684 Agent \u4E00\u6837\uFF0C\u57FA\u4E8E\u539F\u59CB\u4EFB\u52A1\u548C\u8FD9\u4E9B\u5DE5\u5177\u7ED3\u679C\u7EE7\u7EED\u63A8\u8FDB\u3002",Ql="\u5982\u679C\u7ED3\u679C\u5DF2\u7ECF\u8DB3\u591F\uFF0C\u8BF7\u8F93\u51FA\u6700\u7EC8\u7ED3\u8BBA\uFF1B\u53EA\u6709\u786E\u5B9E\u9700\u8981\u66F4\u591A\u4FE1\u606F\u3001\u9A8C\u8BC1\u6216\u6587\u4EF6\u4FEE\u6539\u65F6\u624D\u7EE7\u7EED\u8C03\u7528\u5DE5\u5177\u3002",Sl="\u4E0D\u8981\u8981\u6C42\u7528\u6237\u70B9\u51FB\u7EE7\u7EED\uFF0C\u4E5F\u4E0D\u8981\u8F93\u51FA\u4F2A\u5DE5\u5177\u8C03\u7528 JSON\uFF1B\u9700\u8981\u7EE7\u7EED\u64CD\u4F5C\u65F6\u53EA\u8F93\u51FA\u53EF\u6267\u884C XML \u5DE5\u5177\u6807\u7B7E\u3002\u6587\u4EF6\u3001HTML \u9875\u9762\u4E0E\u56FE\u8868\u7B49\u4EA4\u4ED8\u7269\u8BF7\u76F4\u63A5\u7528 Markdown \u56F4\u680F\u4EE3\u7801\u5757\u8F93\u51FA\uFF08\u5982 ```html\u3001```mermaid\uFF09\uFF0C\u4E0D\u8981\u4F7F\u7528 artifact XML \u6807\u7B7E\u3002",Tl="\u81F3\u5C11\u4E00\u4E2A\u5DE5\u5177\u6267\u884C\u5931\u8D25\u3002\u4E0D\u8981\u56E0\u4E3A\u53EF\u6062\u590D\u9519\u8BEF\u5C31\u505C\u6B62\uFF1B\u5148\u9605\u8BFB summary/detail/error\uFF0C\u5E76\u4FEE\u6B63\u53C2\u6570\u6216\u6539\u7528\u5408\u9002\u7684\u4E0B\u4E00\u6B65\u7EE7\u7EED\u5B8C\u6210\u4EFB\u52A1\u3002";function vr(e){let t=Bl.exec(e);if(!t)return null;try{let n=JSON.parse(t[1]);return{summary:typeof n.summary=="string"?n.summary:t[1].trim(),artifacts:Array.isArray(n.artifacts)?n.artifacts.filter(o=>typeof o=="string"):[]}}catch{return{summary:t[1].trim(),artifacts:[]}}}function wr(e){let t=In(Nl(e),4e3),n=e.result===void 0?void 0:In(JSON.stringify(e.result),8e3);return{tool:e.invocationName,ok:e.ok,summary:In(Qr(e),400)??"",detail:t,output:n,error:e.ok?void 0:{code:void 0,message:e.error??"unknown",retryable:!1}}}function Dl(e){return{tool:e.invocationName,ok:e.ok,summary:In(Qr(e),400)??"",error:e.ok?void 0:{code:void 0,message:e.error??"unknown",retryable:!1},windowed:!0}}function Rl(e){if(e.length<=4)return e.map(wr);let t=e.slice(0,-4),n=e.slice(-4);return[...t.map(Dl),...n.map(wr)]}function Qr(e){if(!e.ok)return(e.error??"execution failed").slice(0,400);if(e.result&&typeof e.result=="object"&&"stdout"in e.result){let t=e.result,n=typeof t.stdout=="string"?t.stdout:"";return Br(n)||"(empty output)"}return typeof e.result=="string"?Br(e.result)||"(empty output)":"(completed)"}function Nl(e){if(!e.ok)return e.error??"execution failed";if(e.result&&typeof e.result=="object"&&"stdout"in e.result){let t=e.result,n=typeof t.stdout=="string"?t.stdout:"",o=typeof t.stderr=="string"?t.stderr:"",s=t.exitCode,r=[];return n.trim()&&r.push(n.trimEnd()),o.trim()&&r.push(`<stderr>
${o.trimEnd()}
</stderr>`),s!==void 0&&s!==0&&s!==""&&r.push(`<exit-code>${s}</exit-code>`),r.join(`

`)||"(empty output)"}if(typeof e.result=="string")return e.result;if(e.result===void 0||e.result===null)return"(empty output)";try{return JSON.stringify(e.result,null,2)}catch{return String(e.result)}}function Br(e){let t=e.trim(),n=t.indexOf(`
`);return(n===-1?t:t.slice(0,n)).slice(0,400)}function Sr(e,t,n){let o=t.some(r=>!r.ok),s=Rl(t);return[vl,Ql,Sl,"","<original_task>",In(e,8e3)??"","</original_task>",...o?["",Tl]:[],"","<tool_results>",JSON.stringify(s,null,2),"</tool_results>",...n?["","### Available Tools",n]:[]].join(`
`)}function In(e,t){return e&&(e.length>t?`${e.slice(0,t)}
...[truncated]`:e)}function Ml(e){if(!e)return null;let t;try{t=JSON.parse(e)}catch{let r=e.trimStart();if(r.startsWith("event:")||r.startsWith("data:"))return null;let i=e.toLowerCase();return["\u670D\u52A1\u5668\u6682\u65F6\u4E0D\u53EF\u7528","\u670D\u52A1\u5668\u4E0D\u53EF\u7528","\u670D\u52A1\u7E41\u5FD9","\u8BF7\u7A0D\u540E\u91CD\u8BD5","rate limit","too many requests","overloaded","temporarily unavailable","service unavailable"].some(d=>i.includes(d))?{retryable:!0,reason:"plain-text-upstream-busy"}:null}if(!t||typeof t!="object")return null;let n=t,o=typeof n.code=="number"?n.code:typeof n.status=="number"?n.status:void 0,s=n.error;return o===void 0&&!s||o===0&&!s?null:o===401||o===403||o===402||o===429?{retryable:o===429,reason:`body-error-${o}`}:{retryable:!0,reason:`body-error-${o??"unknown"}`}}function yn(e,t){if(e===0)return{verdict:"retryable",status:e,reason:"network-error"};if(e===429)return{verdict:"retryable",status:e,reason:"rate-limited",retryAfterMs:Ll(t)};if(e>=500&&e<600)return{verdict:"retryable",status:e,reason:`server-${e}`};if(e===401||e===403||e===402)return{verdict:"fatal",status:e,reason:`auth-billing-${e}`};if(e>=400)return{verdict:"fatal",status:e,reason:`client-${e}`};if(e>=200&&e<300){let n=Ml(t);return n?n.retryable?{verdict:"retryable",status:e,reason:n.reason}:{verdict:"fatal",status:e,reason:n.reason}:{verdict:"ok",status:e,reason:"success"}}return{verdict:"retryable",status:e,reason:`unclassified-${e}`}}function Ll(e){if(e)try{let t=JSON.parse(e),n=t.retryAfter??t.retry_after;if(typeof n=="number"&&n>0)return n*1e3}catch{}}function Tr(e,t){if(e&&e.toLowerCase()==="error")return{verdict:"fatal",status:200,reason:"sse-error-frame"};if(!t||typeof t!="object")return null;let n=t,o=typeof n.code=="number"?n.code:typeof n.status=="number"?n.status:void 0;return(o===0||o===429||o===500)&&(n.error||n.message)?{verdict:o===429||o===500?"retryable":"fatal",status:200,reason:`sse-error-payload-${o}`}:null}function Fo(e,t=300){return Math.min(2e3*2**Math.max(0,Math.min(e,2)),8e3)+Math.round(Math.random()*t)}var _l=new Set(["content-type","accept","user-agent","authorization","lang","x-device-id","x-device-model","x-client-build","x-client-bundle-id","x-client-platform","x-client-version","x-client-locale","x-client-timezone-offset"]);function Dr(e){let t={};for(let[n,o]of Object.entries(e))_l.has(n.toLowerCase())&&(t[n]=o);return t}var Fl=50,_o=[];function Uo(e){_o.push({at:Date.now(),...e}),_o.length>Fl&&_o.shift()}var Rr="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ADYCAEGEocAAQfigwAA2AgBBgKHAAEH4oMAANgIAQYyhwABBgKHAADYCAEGIocAAQYChwAA2AgBBlKHAAEGIocAANgIAQZChwABBiKHAADYCAEGcocAAQZChwAA2AgBBpKHAAEGYocAANgIAQZihwABBkKHAADYCAEGsocAAQaChwAA2AgBBoKHAAEGYocAANgIAQbShwABBqKHAADYCAEGoocAAQaChwAA2AgBBvKHAAEGwocAANgIAQbChwABBqKHAADYCAEHEocAAQbihwAA2AgBBuKHAAEGwocAANgIAQcyhwABBwKHAADYCAEHAocAAQbihwAA2AgBB1KHAAEHIocAANgIAQcihwABBwKHAADYCAEHcocAAQdChwAA2AgBB0KHAAEHIocAANgIAQeShwABB2KHAADYCAEHYocAAQdChwAA2AgBB7KHAAEHgocAANgIAQeChwABB2KHAADYCAEH0ocAAQeihwAA2AgBB6KHAAEHgocAANgIAQfyhwABB8KHAADYCAEHwocAAQeihwAA2AgBBhKLAAEH4ocAANgIAQfihwABB8KHAADYCAEGMosAAQYCiwAA2AgBBgKLAAEH4ocAANgIAQZSiwABBiKLAADYCAEGIosAAQYCiwAA2AgBBrKLAACABNgIAQZCiwABBiKLAADYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCAAwHCyACIARJIAEgAk1yDQAgACgCDEUNAwtBvKLAAEG8osAAKAIAIgAgASAAIAFJGzYCACABIANqIQRBgKDAACEAAkACQANAIAQgACgCACIGRwRAIAAoAggiAA0BDAILCyAAKAIMRQ0BC0GAoMAAIQADQAJAIAIgACgCACIETwRAIAIgBCAAKAIEaiIGSQ0BCyAAKAIIIQAMAQsLQayiwAAgATYCAEGkosAAIANBKGsiADYCACABIABBAXI2AgQgACABakEoNgIEQbiiwABBgICAATYCACACIAZBIGtBeHFBCGsiACAAIAJBEGpJGyIEQRs2AgRBgKDAACkCACEJIARBEGpBiKDAACkCADcCACAEIAk3AghBhKDAACADNgIAQYCgwAAgATYCAEGIoMAAIARBCGo2AgBBjKDAAEEANgIAIARBHGohAANAIABBBzYCACAAQQRqIgAg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QZyiwABBnKLAACgCACADcjYCAA8LAkACQCABIAQoAgAiAygCBEF4cUYEQCADIQIMAQsgAUEZIAJBAXZrQQAgAkEfRxt0IQUDQCADIAVBHXZBBHFqQRBqIgQoAgAiAkUNAiAFQQF0IQUgAiEDIAIoAgRBeHEgAUcNAAsLIAIoAggiASAANgIMIAIgADYCCCAAQQA2AhggACACNgIMIAAgATYCCA8LIAQgADYCACAAIAM2AhggACAANgIMIAAgADYCCAuBAgEFfyMAQYABayIEJAACfwJAAkAgASgCHCICQRBxRQRAIAJBIHENASAAIAEQDwwDC0H/ACECA0AgBCACIgNqIgUgAEEPcSICQTByIAJB1wBqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsMAQtB/wAhAgNAIAQgAiIDaiIFIABBD3EiAkEwciACQTdqIAJBCkkbOgAAIANBAWshAiAAQRBJIABBBHYhAEUNAAsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkMAQsgA0GBAU8EQCADEBgACyABQYCEwABBAiAFQYABIANrEAkLIARBgAFqJAALuQIAIAIEQCABIAJBiAFsaiECA0AgACAAKQMAIAEpAACFNwMAIAAgACkDCCABKQAIhTcDCCAAIAApAxAgASkAEIU3AxAgACAAKQMYIAEpABiFNwMYIAAgACkDICABKQAghTcDICAAIAApAyggASkAKIU3AyggACAAKQMwIAEpADCFNwMwIAAgACkDOCABKQA4hTcDOCAAIAApA0AgASkAQIU3A0AgACAAKQNIIAEpAEiFNwNIIAAgACkDUCABKQBQhTcDUCAAIAApA1ggASkAWIU3A1ggACAAKQNgIAEpAGCFNwNgIAAgACkDaCABKQBohTcDaCAAIAApA3AgASkAcIU3A3AgACAAKQN4IAEpAHiFNwN4IAAgACkDgAEgASkAgAGFNwOAASAAEAQgAUGIAWoiASACRw0ACwsLsAEBAn8jAEEgayIDJAAgASABIAJqIgJLBEBBAEEAECgAC0EIIAAoAgAiAUEBdCIEIAIgAiAESRsiAiACQQhNGyIEQQBIBEBBAEEAECgACyADIAEEfyADIAE2AhwgAyAAKAIENgIUQQEFQQALNgIYIANBCGogBCADQRRqEB0gAygCCEEBRgRAIAMoAgwgAygCEBAoAAsgAygCDCEBIAAgBDYCACAAIAE2AgQgA0EgaiQAC7ABAQR/IwBBIGsiASQAIAAoAgAiAkF/RgRAQQBBABAoAAtBCCACQQF0IgMgAkEBaiIEIAMgBEsbIgMgA0EITRsiA0EASARAQQBBABAoAAsgASACBH8gASACNgIcIAEgACgCBDYCFEEBBUEACzYCGCABQQhqIAMgAUEUahAdIAEoAghBAUYEQCABKAIMIAEoAhAQKAALIAEoAgwhAiAAIAM2AgAgACACNgIEIAFBIGokAAuOAQECfyABQRBPBEAgAEEAIABrQQNxIgNqIQIgAwRAA0AgAEEAOgAAIABBAWoiACACSQ0ACwsgAiABIANrIgFBfHEiA2ohACADQQBKBEADQCACQQA2AgAgAkEEaiICIABJDQALCyABQQNxIQELIAEEQCAAIAFqIQEDQCAAQQA6AAAgAEEBaiIAIAFJDQALCwtsAQN/AkACQCAAKAIAIgIEQCAAKAIEIgBBBGsoAgAiAUF4cSIDQQRBCCABQQNxIgEbIAJqSQ0BIAFBACADIAJBJ2pLGw0CIAAQBQsPC0H5ncAAQS5BqJ7AABAgAAtBuJ7AAEEuQeiewAAQIAALewEBfyMAQRBrIgMkAEH8nsAAQfyewAAoAgAiBEEBajYCAAJAIARBAEgNAAJAQciiwAAtAABFBEBBxKLAAEHEosAAKAIAQQFqNgIAQfiewAAoAgBBAE4NAQwCCyADQQhqIAAgARECAAALQciiwABBADoAACACRQ0AAAsAC2wCAX8BfiMAQTBrIgEkACABIAA2AgAgAUGAATYCBCABQQI2AgwgAUGAhsAANgIIIAFCAjcCFCABQoCAgIAwIgIgAUEEaq2ENwMoIAEgAiABrYQ3AyAgASABQSBqNgIQIAFBCGpB8IPAABAkAAtoAgF/AX4jAEEwayIDJAAgAyABNgIEIAMgADYCACADQQI2AgwgA0G4g8AANgIIIANCAjcCFCADQoCAgIAwIgQgA62ENwMoIAMgBCADQQRqrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtoAgF/AX4jAEEwayIDJAAgAyAANgIAIAMgATYCBCADQQI2AgwgA0HUhsAANgIIIANCAjcCFCADQoCAgIAwIgQgA0EEaq2ENwMoIAMgBCADrYQ3AyAgAyADQSBqNgIQIANBCGogAhAkAAtiAQF/AkACQCABBEAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpJDQEgAkEAIAMgAUEnaksbDQIgABAFCw8LQfmdwABBLkGonsAAECAAC0G4nsAAQS5B6J7AABAgAAtbAQJ/AkAgAEEEaygCACICQXhxIgNBBEEIIAJBA3EiAhsgAWpPBEAgAkEAIAMgAUEnaksbDQEgABAFDwtB+Z3AAEEuQaiewAAQIAALQbiewABBLkHonsAAECAAC1gBAX8CfyACKAIEBEACQCACKAIIIgNFBEAMAQsgAigCACADQQEgARAHDAILC0HJosAALQAAGiABEAALIQIgACABNgIIIAAgAkEBIAIbNgIEIAAgAkU2AgALSAACQCABaUEBR0GAgICAeCABayAASXINACAABEBByaLAAC0AABoCfyABQQlPBEAgASAAEAoMAQsgABAACyIBRQ0BCyABDwsAC0EBAX8gAiAAKAIAIAAoAggiA2tLBEAgACADIAIQEyAAKAIIIQMLIAAoAgQgA2ogASACEA0aIAAgAiADajYCCEEAC0EBAX8jAEEgayIDJAAgA0EANgIQIANBATYCBCADQgQ3AgggAyABNgIcIAMgADYCGCADIANBGGo2AgAgAyACECQACzgAAkAgAkGAgMQARg0AIAAgAiABKAIQEQAARQ0AQQEPCyADRQRAQQAPCyAAIAMgBCABKAIMEQEACzwBAX9BASECAkAgACgCACABEBENACABKAIUQciCwABBAiABKAIYKAIMEQEADQAgACgCBCABEBEhAgsgAgstAAJAIANpQQFHQYCAgIB4IANrIAFJckUEQCAAIAEgAyACEAciAA0BCwALIAAL6gECAn8BfiMAQRBrIgIkACACQQE7AQwgAiABNgIIIAIgADYCBCMAQRBrIgEkACACQQRqIgApAgAhBCABIAA2AgwgASAENwIEIwBBEGsiACQAIAFBBGoiASgCACICKAIMIQMCQAJAAkACQCACKAIEDgIAAQILIAMNAUEBIQJBACEDDAILIAMNACACKAIAIgIoAgQhAyACKAIAIQIMAQsgAEGAgICAeDYCACAAIAE2AgwgAEEGIAEoAggiAC0ACCAALQAJEBcACyAAIAM2AgQgACACNgIAIABBByABKAIIIgAtAAggAC0A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AgAgBkEDdGoiACgCACAAKAIEIAIoAiQoAgwRAQBFDQELQQEMAQtBAAsgAkEwaiQACwsAIAAoAgAgARAPCwwAIAAgASkCADcDAAsJACAAQQA2AgALC/weAgBBgIDAAAtBRXJyb3IAAAAIAAAADAAAAAQAAAAJAAAACgAAAAsAAABzaGEzLXdhc20vc3JjL2xpYi5ycyAAEAAUAAAASQAAADMAQcyAwAALqR4BAAAADAAAAGEgRGlzcGxheSBpbXBsZW1lbnRhdGlvbiByZXR1cm5lZCBhbiBlcnJvciB1bmV4cGVjdGVkbHkvVXNlcnMvcnoucGFuLy5ydXN0dXAvdG9vbGNoYWlucy9zdGFibGUtYWFyY2g2NC1hcHBsZS1kYXJ3aW4vbGliL3J1c3RsaWIvc3JjL3J1c3QvbGlicmFyeS9hbGxvYy9zcmMvc3RyaW5nLnJziwAQAG0AAAB7CgAADgAAAGNhcGFjaXR5IG92ZXJmbG93AAAACAEQABEAAABhbGxvYy9zcmMvcmF3X3ZlYy5ycyQBEAAUAAAAGAAAAAUAAAAuLjAxMjM0NTY3ODlhYmNkZWZjYWxsZWQgYE9wdGlvbjo6dW53cmFwKClgIG9uIGEgYE5vbmVgIHZhbHVlaW5kZXggb3V0IG9mIGJvdW5kczogdGhlIGxlbiBpcyAgYnV0IHRoZSBpbmRleCBpcyAAhQEQACAAAAClARAAEgAAADogAAABAAAAAAAAAMgBEAACAAAAY29yZS9zcmMvZm10L251bS5ycwDcARAAEwAAAGYAAAAXAAAAMHgwMDAxMDIwMzA0MDUwNjA3MDgwOTEwMTExMjEzMTQxNTE2MTcxODE5MjAyMTIyMjMyNDI1MjYyNzI4MjkzMDMxMzIzMzM0MzUzNjM3MzgzOTQwNDE0MjQzNDQ0NTQ2NDc0ODQ5NTA1MTUyNTM1NDU1NTY1NzU4NTk2MDYxNjI2MzY0NjU2NjY3Njg2OTcwNzE3MjczNzQ3NTc2Nzc3ODc5ODA4MTgyODM4NDg1ODY4Nzg4ODk5MDkxOTI5Mzk0OTU5Njk3OTg5OXJhbmdlIHN0YXJ0IGluZGV4ICBvdXQgb2YgcmFuZ2UgZm9yIHNsaWNlIG9mIGxlbmd0aCAAAMoCEAASAAAA3AIQACIAAAByYW5nZSBlbmQgaW5kZXggEAMQABAAAADcAhAAIgAAAHNsaWNlIGluZGV4IHN0YXJ0cyBhdCAgYnV0IGVuZHMgYXQgADADEAAWAAAARgMQAA0AAABbLi4uXWJlZ2luIDw9IGVuZCAoIDw9ICkgd2hlbiBzbGljaW5nIGBgaQMQAA4AAAB3AxAABAAAAHsDEAAQAAAAiwMQAAEAAABieXRlIGluZGV4ICBpcyBub3QgYSBjaGFyIGJvdW5kYXJ5OyBpdCBpcyBpbnNpZGUgIChieXRlcyApIG9mIGAArAMQAAsAAAC3AxAAJgAAAN0DEAAIAAAA5QMQAAYAAACLAxAAAQAAACBpcyBvdXQgb2YgYm91bmRzIG9mIGAAAKwDEAALAAAAFAQQABYAAACLAxAAAQAAAGNvcmUvc3JjL3N0ci9tb2QucnMARAQQABMAAADxAAAALAAAAGNvcmUvc3JjL3VuaWNvZGUvcHJpbnRhYmxlLnJzAAAAaAQQAB0AAAAaAAAANgAAAGgEEAAdAAAACgAAACsAAAAABgEBAwEEAgUHBwIICAkCCgULAg4EEAERAhIFExwUARUCFwIZDRwFHQgfASQBagRrAq8DsQK8As8C0QLUDNUJ1gLXAtoB4AXhAucE6ALuIPAE+AL6BPsBDCc7Pk5Pj56en3uLk5aisrqGsQYHCTY9Plbz0NEEFBg2N1ZXf6qur7014BKHiY6eBA0OERIpMTQ6RUZJSk5PZGWKjI2PtsHDxMbL1ly2txscBwgKCxQXNjk6qKnY2Qk3kJGoBwo7PmZpj5IRb1+/7u9aYvT8/1NUmpsuLycoVZ2goaOkp6iturzEBgsMFR06P0VRpqfMzaAHGRoiJT4/5+zv/8XGBCAjJSYoMzg6SEpMUFNVVlhaXF5gY2Vma3N4fX+KpKqvsMDQrq9ub93ek14iewUDBC0DZgMBLy6Agh0DMQ8cBCQJHgUrBUQEDiqAqgYkBCQEKAg0C04DNAyBNwkWCggYO0U5A2MICTAWBSEDGwUBQDgESwUvBAoHCQdAICcEDAk2AzoFGgcEDAdQSTczDTMHLggKBiYDHQgCgNBSEAM3LAgqFhomHBQXCU4EJAlEDRkHCgZICCcJdQtCPioGOwUKBlEGAQUQAwULWQgCHWIeSAgKgKZeIkULCgYNEzoGCgYUHCwEF4C5PGRTDEgJCkZFG0gIUw1JBwqAtiIOCgZGCh0DR0k3Aw4ICgY5BwqBNhkHOwMdVQEPMg2Dm2Z1C4DEikxjDYQwEBYKj5sFgkeauTqGxoI5ByoEXAYmCkYKKAUTgbA6gMZbZUsEOQcRQAULAg6X+AiE1ikKoueBMw8BHQYOBAiBjIkEawUNAwkHEI9ggPoGgbRMRwl0PID2CnMIcBVGehQMFAxXCRmAh4FHA4VCDxWEUB8GBoDVKwU+IQFwLQMaBAKBQB8ROgUBgdAqgNYrBAGB4ID3KUwECgQCgxFETD2AwjwGAQRVBRs0AoEOLARkDFYKgK44HQ0sBAkHAg4GgJqD2AQRAw0DdwRfBgwEAQ8MBDgICgYoCCwEAj6BVAwdAwoFOAccBgkHgPqEBgABAwUFBgYCBwYIBwkRChwLGQwaDRAODA8EEAMSEhMJFgEXBBgBGQMaBxsBHAIfFiADKwMtCy4BMAQxAjIBpwSpAqoEqwj6AvsF/QL+A/8JrXh5i42iMFdYi4yQHN0OD0tM+/wuLz9cXV/ihI2OkZKpsbq7xcbJyt7k5f8ABBESKTE0Nzo7PUlKXYSOkqmxtLq7xsrOz+TlAAQNDhESKTE0OjtFRklKXmRlhJGbncnOzw0RKTo7RUlXW1xeX2RljZGptLq7xcnf5OXwDRFFSWRlgISyvL6/1dfw8YOFi6Smvr/Fx8/a20iYvc3Gzs9JTk9XWV5fiY6Psba3v8HGx9cRFhdbXPb3/v+AbXHe3w4fbm8cHV99fq6vTbu8FhceH0ZHTk9YWlxefn+1xdTV3PDx9XJzj3R1liYuL6evt7/Hz9ffmgBAl5gwjx/Oz9LUzv9OT1pbBwgPECcv7u9ubzc9P0JFkJFTZ3XIydDR2Nnn/v8AIF8igt8EgkQIGwQGEYGsDoCrBR8IgRwDGQgBBC8ENAQHAwEHBgcRClAPEgdVBwMEHAoJAwgDBwMCAwMDDAQFAwsGAQ4VBU4HGwdXBwIGFwxQBEMDLQMBBBEGDww6BB0lXyBtBGolgMgFgrADGgaC/QNZBxYJGAkUDBQMagYKBhoGWQcrBUYKLAQMBAEDMQssBBoGCwOArAYKBi8xgPQIPAMPAz4FOAgrBYL/ERgILxEtAyEPIQ+AjASCmhYLFYiUBS8FOwcCDhgJgL4idAyA1hqBEAWA4QnyngM3CYFcFIC4CIDdFTsDCgY4CEYIDAZ0Cx4DWgRZCYCDGBwKFglMBICKBqukDBcEMaEEgdomBwwFBYCmEIH1BwEgKgZMBICNBIC+AxsDDw1jb3JlL3NyYy91bmljb2RlL3VuaWNvZGVfZGF0YS5ycwAAAFEKEAAgAAAATgAAACgAAABRChAAIAAAAFoAAAAWAAAAAAMAAIMEIACRBWAAXROgABIXIB8MIGAf7ywgKyowoCtvpmAsAqjgLB774C0A/iA2nv9gNv0B4TYBCiE3JA3hN6sOYTkvGOE5MBzhSvMe4U5ANKFSHmHhU/BqYVRPb+FUnbxhVQDPYVZl0aFWANohVwDgoViu4iFa7OThW9DoYVwgAO5c8AF/XQBwAAcALQEBAQIBAgEBSAswFRABZQcCBgICAQQjAR4bWws6CQkBGAQBCQEDAQUrAzsJKhgBIDcBAQEECAQBAwcKAh0BOgEBAQIECAEJAQoCGgECAjkBBAIEAgIDAwEeAgMBCwI5AQQFAQIEARQCFgYBAToBAQIBBAgBBwMKAh4BOwEBAQwBCQEoAQMBNwEBAwUDAQQHAgsCHQE6AQICAQEDAwEEBwILAhwCOQIBAQIECAEJAQoCHQFIAQQBAgMBAQgBUQECBwwIYgECCQsHSQIbAQEBAQE3DgEFAQIFCwEkCQFmBAEGAQICAhkCBAMQBA0BAgIGAQ8BAAMABBwDHQIeAkACAQcIAQILCQEtAwEBdQIiAXYDBAIJAQYD2wICAToBAQcBAQEBAggGCgIBMB8xBDAKBAMmCQwCIAQCBjgBAQIDAQEFOAgCApgDAQ0BBwQBBgEDAsZAAAHDIQADjQFgIAAGaQIABAEKIAJQAgABAwEEARkCBQGXAhoSDQEmCBkLAQEsAzABAgQCAgIBJAFDBgICAgIMAQgBLwEzAQEDAgIFAgEBKgIIAe4BAgEEAQABABAQEAACAAHiAZUFAAMBAgUEKAMEAaUCAARBBQACTwRGCzEEewE2DykBAgIKAzEEAgIHAT0DJAUBCD4BDAI0CQEBCAQCAV8DAgQGAQIBnQEDCBUCOQIBAQEBDAEJAQ4HAwVDAQIGAQECAQEDBAMBAQ4CVQgCAwEBFwFRAQIGAQECAQECAQLrAQIEBgIBAhsCVQgCAQECagEBAQIIZQEBAQIEAQUACQEC9QEKBAQBkAQCAgQBIAooBgIECAEJBgIDLg0BAgAHAQYBAVIWAgcBAgECegYDAQECAQcBAUgCAwEBAQACCwI0BQUDFwEAAQYPAAwDAwAFOwcAAT8EUQELAgACAC4CFwAFAwYICAIHHgSUAwA3BDIIAQ4BFgUBDwAHARECBwECAQVkAaAHAAE9BAAE/gIAB20HAGCA8AAAAAAAAAEAAAAAAAAAgoAAAAAAAACKgAAAAAAAgACAAIAAAACAi4AAAAAAAAABAACAAAAAAIGAAIAAAACACYAAAAAAAICKAAAAAAAAAIgAAAAAAAAACYAAgAAAAAAKAACAAAAAAIuAAIAAAAAAiwAAAAAAAICJgAAAAAAAgAOAAAAAAACAAoAAAAAAAICAAAAAAAAAgAqAAAAAAAAACgAAgAAAAICBgACAAAAAgICAAAAAAACAAQAAgAAAAAAIgACAAAAAgC9ydXN0L2RlcHMvZGxtYWxsb2MtMC4yLjYvc3JjL2RsbWFsbG9jLnJzYXNzZXJ0aW9uIGZhaWxlZDogcHNpemUgPj0gc2l6ZSArIG1pbl9vdmVyaGVhZADQDhAAKQAAAKgEAAAJAAAAYXNzZXJ0aW9uIGZhaWxlZDogcHNpemUgPD0gc2l6ZSArIG1heF9vdmVyaGVhZAAA0A4QACkAAACuBAAADQA7CXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AgZ3YWxydXMGMC4yMy4yDHdhc20tYmluZGdlbgYwLjIuOTc=";var Ul="DeepSeekHashV1",$n=null,Hl=new TextEncoder;async function Ol(){if($n)return $n;let e=Uint8Array.from(atob(Rr),n=>n.charCodeAt(0)),{instance:t}=await WebAssembly.instantiate(e,{});return $n=t.exports,$n}function Nr(e,t){let n=Hl.encode(t),o=e.__wbindgen_export_0(n.length,1);return new Uint8Array(e.memory.buffer).set(n,o),{ptr:o,len:n.length}}function Pl(e,t,n,o){let s=e.__wbindgen_add_to_stack_pointer(-16),r=Nr(e,t),i=Nr(e,n);try{e.wasm_solve(s,r.ptr,r.len,i.ptr,i.len,o);let a=new DataView(e.memory.buffer),d=a.getInt32(s,!0),l=a.getFloat64(s+8,!0);if(d!==1||!Number.isSafeInteger(l)||l<0)throw new Error(`No PoW solution found before difficulty ${o}`);return l}finally{e.__wbindgen_add_to_stack_pointer(16)}}async function Gl(e,t){let n=Yl(e),o=await fetch("/api/v0/chat/create_pow_challenge",{method:"POST",headers:n,body:JSON.stringify({target_path:t}),credentials:"include"}),s=await o.text();if(!o.ok)throw new Error(`PoW challenge failed: ${o.status} ${s.slice(0,200)}`);let r=JSON.parse(s),i=r?.data?.biz_data?.challenge??r?.data?.challenge??r?.challenge??r;if(!i?.challenge)throw new Error(`Invalid PoW challenge response: ${s.slice(0,300)}`);return{algorithm:String(i.algorithm),challenge:String(i.challenge),salt:String(i.salt),difficulty:Number(i.difficulty),signature:String(i.signature),expire_at:Number(i.expire_at??i.expireAt??0),expire_after:Number(i.expire_after??i.expireAfter??0),received_at:Date.now()}}function Yl(e){let t={};for(let[n,o]of Object.entries(e))n.toLowerCase()!=="content-type"&&(t[n]=o);return t["Content-Type"]="application/json",t}function Mr(e,t=Date.now()){if(Number.isFinite(e.expire_at)&&e.expire_at>0){let n=e.expire_at<1e12?e.expire_at*1e3:e.expire_at;if(t>=n)return!0}return!!(Number.isFinite(e.expire_after)&&(e.expire_after??0)>0&&t>=e.received_at+e.expire_after*1e3)}function $l(e){let t=new TextEncoder().encode(e),n="";for(let o=0;o<t.length;o++)n+=String.fromCharCode(t[o]);return btoa(n)}async function Lr(e,t="/api/v0/chat/completion"){for(let n=0;n<2;n++){let o=await Gl(e,t);if(o.algorithm!==Ul)throw new Error(`Unsupported PoW algorithm: ${o.algorithm}`);if(Mr(o)){if(n===0)continue;throw new Error("pow-expired")}let s=await Ol(),r=`${o.salt}_${o.expire_at}_`,i=Pl(s,o.challenge.toLowerCase(),r,o.difficulty);if(Mr(o)){if(n===0)continue;throw new Error("pow-expired")}let a={algorithm:o.algorithm,challenge:o.challenge,salt:o.salt,answer:i,signature:o.signature};return{"X-DS-PoW-Response":$l(JSON.stringify({...a,target_path:t}))}}throw new Error("pow-expired")}var Ho="ds-studio-step-flow-css",Oo=(e,t="0 0 24 24")=>`url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${t}" fill="currentColor">${e}</svg>`)}")`,_r=Oo('<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62-.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>'),Fr=Oo('<path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/>'),zn=Oo('<path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>');function zl(){if(document.getElementById(Ho))return;let e=document.createElement("style");e.id=Ho,e.textContent=`
    .ds-sf-container { position: fixed; bottom: 160px; left: 50%; transform: translateX(-50%); width: min(768px, 92vw); max-height: 240px; margin: 0; padding: 8px 14px; border-radius: 10px; background: #eef0ff; color: #1f2329; z-index: 2147483647; box-shadow: 0 2px 12px rgba(51,112,255,.12); overflow: hidden; display: flex; flex-direction: column; }
    /* v1.7\uFF1A\u6B65\u9AA4\u6D41\u4E3B\u4F53\u53EF\u6EDA\u52A8\uFF0C\u5BB9\u5668 max-height \u9650\u5236\u4E0D\u65E0\u9650\u589E\u9AD8\u6321\u4F4F\u5BF9\u8BDD\u5185\u5BB9 */
    .ds-sf-stream { flex: 1; min-height: 0; overflow-y: auto; }
    .ds-sf-status-line { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px; line-height: 1.5; color: #646a73; }
    .ds-sf-status-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #8f959e; }
    .ds-sf-container[data-phase="running"] .ds-sf-status-dot { background: #3370ff; animation: ds-sf-pulse 1.1s ease-in-out infinite; }
    .ds-sf-container[data-phase="complete"] .ds-sf-status-dot { background: #34a853; }
    .ds-sf-container[data-phase="error"] .ds-sf-status-dot { background: #e5484d; }
    @keyframes ds-sf-pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
    .ds-sf-status-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ds-sf-container[data-phase="error"] .ds-sf-status-text { color: #e5484d; }
    .ds-sf-stop-btn { flex: none; padding: 2px 9px; font-size: 12px; border: 1px solid #e5484d; border-radius: 6px; background: transparent; color: #e5484d; cursor: pointer; }
    .ds-sf-stop-btn:hover { background: #fef0f0; }

    /* \u63A8\u7406\u7B14\u8BB0\uFF08\u6298\u53E0\uFF09 */
    .ds-sf-reasoning-note { margin: 4px 0; }
    .ds-sf-reasoning-note-toggle { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px; color: #646a73; background: none; border: none; cursor: pointer; width: 100%; text-align: left; }
    .ds-sf-reasoning-note-icon { flex: none; width: 14px; height: 14px; background: currentColor; opacity: .6; mask-image: ${zn}; mask-size: contain; -webkit-mask-image: ${zn}; -webkit-mask-size: contain; transition: transform .15s; }
    .ds-sf-reasoning-note-toggle[aria-expanded="true"] .ds-sf-reasoning-note-icon { transform: rotate(90deg); }
    .ds-sf-reasoning-note-title { flex: 1; }
    .ds-sf-reasoning-note-body { padding: 4px 0 4px 20px; font-size: 13px; line-height: 1.6; color: #646a73; white-space: pre-wrap; word-break: break-word; }

    /* \u6B65\u9AA4\u53D9\u8FF0\u6587\u672C */
    .ds-sf-step { margin: 4px 0; }
    .ds-sf-step-body { font-size: 14px; line-height: 1.7; color: #1f2329; word-break: break-word; }
    .ds-sf-step-body:empty { display: none; }

    /* \u5DE5\u5177\u5206\u7EC4 */
    .ds-sf-tool-group { margin: 4px 0; }
    .ds-sf-tool-group-toggle { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px; color: #646a73; background: none; border: none; cursor: pointer; width: 100%; text-align: left; }
    .ds-sf-tool-group-icon { flex: none; width: 14px; height: 14px; background: currentColor; mask-image: ${_r}; mask-size: contain; -webkit-mask-image: ${_r}; -webkit-mask-size: contain; }
    .ds-sf-tool-group-title { flex: 1; }
    .ds-sf-tool-group-chevron { flex: none; width: 14px; height: 14px; background: currentColor; opacity: .6; mask-image: ${Fr}; mask-size: contain; -webkit-mask-image: ${Fr}; -webkit-mask-size: contain; transition: transform .15s; }
    .ds-sf-tool-group[data-collapsed="true"] .ds-sf-tool-group-chevron { transform: rotate(-90deg); }
    .ds-sf-tool-group-items { padding-left: 20px; }
    .ds-sf-tool-group[data-collapsed="true"] .ds-sf-tool-group-items { display: none; }

    /* \u5DE5\u5177\u6761\u76EE */
    .ds-sf-tool-item { margin: 2px 0; }
    .ds-sf-tool-toggle { display: flex; align-items: center; gap: 6px; padding: 1px 0; font-size: 13px; color: #1f2329; background: none; border: none; cursor: pointer; width: 100%; text-align: left; }
    .ds-sf-tool-state-icon { flex: none; width: 12px; height: 12px; border-radius: 50%; background: #8f959e; }
    .ds-sf-tool-item[data-tool-status="pending"] .ds-sf-tool-state-icon { background: #3370ff; animation: ds-sf-pulse 1.1s ease-in-out infinite; }
    .ds-sf-tool-item[data-tool-status="ok"] .ds-sf-tool-state-icon { background: #34a853; }
    .ds-sf-tool-item[data-tool-status="err"] .ds-sf-tool-state-icon { background: #e5484d; }
    .ds-sf-tool-name { flex: none; font-weight: 500; }
    .ds-sf-tool-param { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #8f959e; }
    .ds-sf-tool-state { flex: none; font-size: 12px; color: #8f959e; }
    .ds-sf-tool-item[data-tool-status="ok"] .ds-sf-tool-state { color: #34a853; }
    .ds-sf-tool-item[data-tool-status="err"] .ds-sf-tool-state { color: #e5484d; }
    .ds-sf-tool-chevron { flex: none; width: 12px; height: 12px; background: currentColor; opacity: .4; mask-image: ${zn}; mask-size: contain; -webkit-mask-image: ${zn}; -webkit-mask-size: contain; transition: transform .15s; }
    .ds-sf-tool-toggle[aria-expanded="true"] .ds-sf-tool-chevron { transform: rotate(90deg); }
    .ds-sf-tool-summary { padding: 4px 0 4px 24px; font-size: 12px; line-height: 1.5; color: #646a73; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }
  `,document.head.appendChild(e)}function Kl(e){if(!e)return null;let t=Object.keys(e);if(t.length===0)return null;let n=t[0],o=String(e[n]).slice(0,40);return`${n}=${o}`}function Ur(e){zl();let t=document.createElement("div");t.className="ds-sf-container",t.setAttribute("data-phase","starting");let n=document.createElement("div");n.className="ds-sf-status-line";let o=document.createElement("span");o.className="ds-sf-status-dot";let s=document.createElement("span");if(s.className="ds-sf-status-text",s.setAttribute("role","status"),s.setAttribute("aria-live","polite"),s.textContent="\u6B63\u5728\u542F\u52A8\u2026",n.appendChild(o),n.appendChild(s),e){let S=document.createElement("button");S.type="button",S.className="ds-sf-stop-btn",S.textContent="\u505C\u6B62",S.addEventListener("click",h=>{h.stopPropagation(),e()}),n.appendChild(S)}let r=document.createElement("div");r.className="ds-sf-stream",t.appendChild(n),t.appendChild(r);let i={currentToolGroup:null,pendingRows:[],narrationMap:new Map,reasoningMap:new Map,stepCount:0,toolCount:0,startTime:Date.now()};function a(S,h,R,T){if(t.setAttribute("data-phase",S),S==="running"){let B=h??i.stepCount,z=R??i.toolCount,M=T??Math.round((Date.now()-i.startTime)/1e3);s.textContent=`deepseek++ \u6267\u884C\u4E2D \xB7 \u7B2C${B+1}\u6B65 \xB7 \u5DF2\u8C03\u7528${z}\u6B21\u5DE5\u5177 \xB7 ${M}s`}else S==="complete"?s.textContent=`\u5B8C\u6210 \xB7 ${i.stepCount}\u6B65 \xB7 ${i.toolCount}\u6B21\u5DE5\u5177 \xB7 ${Math.round((Date.now()-i.startTime)/1e3)}s`:S==="error"?s.textContent=`\u51FA\u9519 \xB7 ${i.stepCount}\u6B65 \xB7 ${i.toolCount}\u6B21\u5DE5\u5177`:S==="paused"?s.textContent=`\u6682\u505C \xB7 ${i.stepCount}\u6B65 \xB7 ${i.toolCount}\u6B21\u5DE5\u5177`:s.textContent="\u6B63\u5728\u542F\u52A8\u2026"}function d(){}function l(S){let h=document.createElement("div");h.className="ds-sf-tool-group",h.setAttribute("data-step-index",String(S)),h.setAttribute("data-collapsed","false");let R=document.createElement("button");R.type="button",R.className="ds-sf-tool-group-toggle",R.setAttribute("aria-expanded","true"),R.addEventListener("click",()=>{h.setAttribute("data-user-toggled","true");let N=h.getAttribute("data-collapsed")==="true";h.setAttribute("data-collapsed",N?"false":"true")});let T=document.createElement("span");T.className="ds-sf-tool-group-icon";let B=document.createElement("span");B.className="ds-sf-tool-group-title";let z=document.createElement("span");z.className="ds-sf-tool-group-chevron",R.appendChild(T),R.appendChild(B),R.appendChild(z);let M=document.createElement("div");return M.className="ds-sf-tool-group-items",h.appendChild(R),h.appendChild(M),h}function A(S){let h=S.querySelector(".ds-sf-tool-group-title");if(!h)return;let R=S.querySelectorAll(".ds-sf-tool-item").length;h.textContent=`\u5DF2\u8C03\u7528${R}\u6B21\u5DE5\u5177`}function u(S,h,R){let T=document.createElement("div");T.className="ds-sf-tool-item",T.setAttribute("data-tool-status","pending");let B=document.createElement("button");B.type="button",B.className="ds-sf-tool-toggle",B.setAttribute("aria-expanded","false");let z=document.createElement("span");z.className="ds-sf-tool-state-icon";let M=document.createElement("span");M.className="ds-sf-tool-name",M.textContent=h;let N=document.createElement("span");N.className="ds-sf-tool-param";let I=Kl(R);N.textContent=I?`\xB7 ${I}`:"";let P=document.createElement("span");P.className="ds-sf-tool-state",P.textContent="";let L=document.createElement("span");L.className="ds-sf-tool-chevron",B.appendChild(z),B.appendChild(M),B.appendChild(N),B.appendChild(P),B.appendChild(L);let K=document.createElement("div");K.className="ds-sf-tool-summary",K.hidden=!0,B.addEventListener("click",()=>{let k=B.getAttribute("aria-expanded")==="true";B.setAttribute("aria-expanded",k?"false":"true"),K.hidden=k}),T.appendChild(B),T.appendChild(K);let f=i.currentToolGroup,U=f?.getAttribute("data-step-index");return(!f||f.parentElement!==r||U!==String(S))&&(f=l(S),r.appendChild(f),i.currentToolGroup=f),f.querySelector(".ds-sf-tool-group-items")?.appendChild(T),A(f),i.pendingRows.push(T),i.toolCount++,i.toolCount}function x(S,h,R){let T=i.pendingRows.shift();if(!T)return;T.setAttribute("data-tool-status",h?"ok":"err");let B=T.querySelector(".ds-sf-tool-state");B&&(B.textContent=h?"OK":"Error");let z=T.querySelector(".ds-sf-tool-summary");z&&R&&(z.textContent=R.length>4e3?R.slice(0,4e3)+`
...[\u622A\u65AD]`:R)}function m(S,h){let R=i.reasoningMap.get(S);if(R){let I=R.querySelector(".ds-sf-reasoning-note-body");I&&h!=null&&I.textContent!==h&&(I.textContent=h,void 0);return}let T=document.createElement("div");T.className="ds-sf-reasoning-note";let B=document.createElement("button");B.type="button",B.className="ds-sf-reasoning-note-toggle",B.setAttribute("aria-expanded","false");let z=document.createElement("span");z.className="ds-sf-reasoning-note-icon";let M=document.createElement("span");M.className="ds-sf-reasoning-note-title",M.textContent=`\u5DF2\u601D\u8003 \xB7 \u7B2C${S+1}\u6B65`,B.appendChild(z),B.appendChild(M);let N=document.createElement("div");N.className="ds-sf-reasoning-note-body",N.hidden=!0,N.textContent=h??"\u8BE5\u6B65\u9AA4\u7684\u601D\u8003\u8FC7\u7A0B\u672A\u4FDD\u7559",B.addEventListener("click",()=>{let I=B.getAttribute("aria-expanded")==="true";B.setAttribute("aria-expanded",I?"false":"true"),N.hidden=I}),T.appendChild(B),T.appendChild(N),r.appendChild(T),i.reasoningMap.set(S,T)}function C(S,h){let R=i.narrationMap.get(S);if(!R){R=document.createElement("div"),R.className="ds-sf-step",R.setAttribute("data-step-index",String(S));let B=document.createElement("div");B.className="ds-sf-step-body",R.appendChild(B),r.appendChild(R),i.narrationMap.set(S,R),i.stepCount=Math.max(i.stepCount,S+1)}let T=R.querySelector(".ds-sf-step-body");T&&T.textContent!==h&&(T.textContent=h,void 0)}function b(S,h,R){i.stepCount=S,i.toolCount=h,r.querySelectorAll(".ds-sf-tool-group").forEach(T=>{T.getAttribute("data-user-toggled")!=="true"&&T.setAttribute("data-collapsed","true")}),i.currentToolGroup=null,a("complete")}function _(){t.remove(),document.getElementById(Ho)?.remove()}return{container:t,setPhase:a,addToolEntry:u,resolveToolEntry:x,addReasoningNote:m,updateNarration:C,finish:b,destroy:_}}var ql=new Set(["javascript","js","typescript","ts","python","py"]);function jl(e){return ql.has(e.toLowerCase())}function Jl(e){let t=e.toLowerCase();return t==="python"||t==="py"?"python":t==="typescript"||t==="ts"?"typescript":"javascript"}function Wl(e,t,n,o){if(!jl(n)||e.querySelector(".ds-code-run-btn"))return;let s=document.createElement("button");s.className="ds-code-run-btn",s.textContent="\u8FD0\u884C",s.style.cssText="position:absolute;top:4px;right:8px;padding:2px 8px;font-size:12px;background:#3370ff;color:#fff;border:none;border-radius:4px;cursor:pointer;",s.addEventListener("click",async()=>{s.textContent="\u8FD0\u884C\u4E2D...",s.disabled=!0;try{let r=await o(t,Jl(n)),i=document.createElement("div");i.style.cssText="margin-top:8px;padding:8px;background:#f6f8fa;border-radius:4px;font-size:12px;white-space:pre-wrap;",r.ok?(i.textContent=r.stdout||"OK",r.stderr&&(i.textContent+=`
[stderr]
${r.stderr}`)):(i.textContent=`\u9519\u8BEF: ${r.error??r.stderr??"\u672A\u77E5\u9519\u8BEF"}`,i.style.color="#e5484d"),e.parentElement?.appendChild(i)}catch{s.textContent="\u5931\u8D25",s.disabled=!1;return}s.textContent="\u5DF2\u8FD0\u884C"}),e.style.position="relative",e.appendChild(s)}function Hr(e,t){e.querySelectorAll("pre").forEach(o=>{let s=o.querySelector("code");if(!s)return;let r=s.className.replace(/^language-/,"");Wl(o,s.textContent??"",r,t)})}var Kn="studio.execution.v2.index",Or="studio.execution.v2.session.";function Pr(e){if(!e||typeof e!="object")return!1;let t=e;return t.version!==2||!Array.isArray(t.sessions)?!1:t.sessions.every(n=>!!n&&typeof n=="object"&&typeof n.key=="string"&&typeof n.updatedAt=="number"&&typeof n.title=="string"&&(n.routeKey===void 0||typeof n.routeKey=="string"))}function Gr(e){if(!e||typeof e!="object")return!1;let t=e;return t.version===2&&typeof t.key=="string"&&typeof t.createdAt=="number"&&typeof t.updatedAt=="number"&&Array.isArray(t.events)&&(t.routeKey===void 0||typeof t.routeKey=="string")}function Xl(e){return`route:${e.split("?")[0].split("#")[0].replace(/\/{2,}/g,"/").replace(/\/+$/,"")||"/"}`}function Po(e){return`chat:${String(e).trim()}`}function Zl(e){let t=2166136261,n=16777619;for(let o=0;o<e.length;o++){let s=e.charCodeAt(o);t=Math.imul(t^s,16777619)>>>0,n=Math.imul(n+s,268435515)>>>0}return(t>>>0).toString(16).padStart(8,"0")+(n>>>0).toString(16).padStart(8,"0")}function Bt(e){return e.startsWith(Or)?e:`${Or}${Zl(e)}`}function tn(e){let t=e.match(/^\/(?:a\/)?chat\/s\/([^/?#]+)/);return t?.[1]?Po(t[1]):Xl(e)}function Ut(e,t=Date.now(),n){return{version:2,key:e,routeKey:n,createdAt:t,updatedAt:t,events:[]}}function Yr(e){try{return new TextEncoder().encode(e).byteLength}catch{return e.length}}function $r(e,t){let o=new TextEncoder().encode(e);return o.byteLength<=t?e:new TextDecoder().decode(o.slice(0,t))}function Go(e,t=16384){let n;try{n=JSON.stringify(e??null)}catch{n=String(e)}return n.length<=t?e&&typeof e=="object"&&!Array.isArray(e)?e:{value:e}:{truncated:!0,originalBytes:Yr(n),preview:$r(n,t)}}function zr(e,t=65536){let n=Yr(e);return n<=t?{text:e}:{text:$r(e,t),truncationMarker:`

> \u56DE\u7B54\u8FC7\u957F\uFF0C\u5DF2\u622A\u65AD\uFF08\u539F\u59CB ${n} \u5B57\u8282\uFF0C\u4EC5\u4FDD\u7559\u524D ${t} \u5B57\u8282\u9884\u89C8\uFF09\u3002`}}function qn(e,t,n=500){e.events.push(t),e.events.length>n&&e.events.splice(0,e.events.length-n),e.updatedAt=t.at}function Kr(e){let t=e.events.find(n=>n.type==="user-message");return t&&t.type==="user-message"?t.text.replace(/\s+/g," ").trim().slice(0,80)||"\u672A\u547D\u540D\u4F1A\u8BDD":e.routeKey??e.key}function qr(e=2e3){let t=Math.max(1,Math.floor(e)),n=[];return{record(o){let s={...o,timestamp:o.timestamp??Date.now()};n.push(s),n.length>t&&(n=n.slice(n.length-t))},snapshot(){return n.slice()},clear(){n=[]},size(){return n.length}}}function jr(e){return`${(e/1e3).toFixed(1)}s`}function Vl(e){return!Number.isFinite(e)||e<0?"0B":e<1024?`${Math.round(e)}B`:`${(e/1024).toFixed(1)}KB`}function ec(e){let t=[],n=new Map;for(let o of e){let s=n.get(o.turnId);s||(s={turnId:o.turnId,events:[],firstTs:o.timestamp,lastTs:o.timestamp,ended:!1,finished:!1,stopReason:null},n.set(o.turnId,s),t.push(o.turnId)),s.events.push(o),o.timestamp<s.firstTs&&(s.firstTs=o.timestamp),o.timestamp>s.lastTs&&(s.lastTs=o.timestamp),o.t==="turn.end"&&(s.ended=!0,s.finished=o.finished,s.stopReason=o.stopReason)}return t.map(o=>n.get(o))}function tc(e){return e.ended&&e.finished?"DONE":e.ended&&!e.finished?"TRUNCATED":"OPEN"}function nc(e){let t={text:0,think:0,tool:0};for(let n of e.events)n.t==="sse.frame"&&(t[n.kind]+=Math.max(0,Math.floor(n.count)));return t}function oc(e){let t=[],n=nc(e),o=!1;for(let s of e.events)switch(s.t){case"request.sent":{let r=s.powMs!==void 0?`  pow=${s.powMs}ms`:"";t.push(`request.sent    ${Vl(s.bytes)}${r}`);break}case"sse.frame":{if(!o){let r=[`text\xD7${n.text}`,`think\xD7${n.think}`,`tool\xD7${n.tool}`].join(" ");t.push(`sse(chars): ${r}`),o=!0}break}case"tool.parsed":t.push(`tool.parsed     ${s.name}  ${s.status}`);break;case"tool.exec":{let r=s.durationMs===void 0?"":`  ${jr(s.durationMs)}`;t.push(`tool.exec       ${s.name}${r}  ${s.ok?"ok":"FAIL"}`);break}case"continuation.decision":t.push(`continuation.decision: ${s.reason} -> triggered=${String(s.triggered)}`);break;case"turn.end":t.push(`turn.end stopReason=${s.stopReason} finished=${String(s.finished)}`);break;default:break}return t}function Jr(e){if(e.length===0)return"";let t=ec(e),n=[];return t.forEach((o,s)=>{let r=tc(o),i=jr(o.lastTs-o.firstTs),a=r==="TRUNCATED"?"  <-- \u65AD\u5728\u8FD9\u91CC":"";n.push(`turn ${s+1} (${i})  ${r}${a}`);let d=oc(o);d.forEach((l,A)=>{let u=A===d.length-1?"\u2514\u2500":"\u251C\u2500";n.push(`  ${u} ${l}`)})}),n.join(`
`)}function sc(e,t,n){let o=t/n,s=n-t,r="ok";return o>.8?r="critical":o>=.5&&(r="warn"),{level:r,remaining:s,estimated:t}}var rc=64e3;function ic(e){let t=0;for(let n of e){if(!n||typeof n!="object")continue;let o=n.content;if(typeof o=="string")t+=o.length;else if(Array.isArray(o)){for(let s of o)if(s&&typeof s=="object"){let r=s.text;typeof r=="string"&&(t+=r.length)}}}return t}function Wr(e,t=rc){return sc(e.length,ic(e),t)}function Xr(e){return e.level==="critical"?`\u4E0A\u4E0B\u6587\u5DF2\u63A5\u8FD1\u4E0A\u9650\uFF08\u7EA6 ${Math.round(e.estimated/1e3)}k / ${Math.round(e.remaining/1e3)}k \u5269\u4F59\uFF09\uFF0C\u5EFA\u8BAE\u5F00\u65B0\u4F1A\u8BDD`:e.level==="warn"?`\u4E0A\u4E0B\u6587\u5DF2\u8FC7\u534A\uFF08\u7EA6 ${Math.round(e.estimated/1e3)}k \u5B57\u7B26\uFF09`:""}var ac=/<(?:local_file_(?:read|write|stat)|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>[\s\S]*?<\/(?:local_file_(?:read|write|stat)|shell_exec|python_exec|memory_save|mcp_(?:list|call|test|save))>/g;function Zr(e){return e.replace(ac,"")}function lc(){return Jr(de.snapshot())}function Vr(){globalThis.__studioTraceReport=lc}var Wn=[],Xn=[],Zn=[],Re=null,et=0,Ht=0,zo=0,Et="",jn=qr(),Ko=null;function ei(e){Ko=e}var de={record(e){if(jn.record(e),e.t==="turn.end"&&Ko)try{Ko(JSON.stringify({...e,ts:Date.now()}))}catch{}},snapshot:()=>jn.snapshot(),clear:()=>jn.clear(),size:()=>jn.size()};function qo(e){try{return new TextEncoder().encode(e).byteLength}catch{return e.length}}var ft=!1,on=new Map;function at(e){let t=on.get(e);if(!t)for(t={sent:0,scheduled:0},on.set(e,t);on.size>32;){let n=on.keys().next().value;if(n===void 0)break;on.delete(n)}return t}var bn=2,Ot=!1,nn=!1,vt=0,cc=vt;function ti(e){let t=++cc;return e.activeStreamId=t,e.streamSawDone=!1,e.streamTruncatedTag=!1,e.streamBytes=0,t}function Pt(e,t){return!!e&&t!==vt&&e.activeStreamId===t}var dc="__dsAborted",X="",xn=0;function ni(e){return`\u3010\u5DE5\u5177\u6267\u884C\u7ED3\u679C\u3011
${e.map(n=>{let o=`[tool-result:${n.invocationName}]`;if(!n.ok)return`${o}
<error>${n.error??"unknown"}</error>`;if(n.result&&typeof n.result=="object"&&"stdout"in n.result){let r=n.result,i=typeof r.stdout=="string"?r.stdout:"",a=typeof r.stderr=="string"?r.stderr:"",d=r.exitCode??"",l=[];return i.trim()&&l.push(i.trimEnd()),a.trim()&&l.push(`<stderr>
${a.trimEnd()}
</stderr>`),d!==""&&d!==0&&l.push(`<exit-code>${d}</exit-code>`),`${o}
${l.join(`

`)||"(empty output)"}`}let s=typeof n.result=="string"?n.result:JSON.stringify(n.result??null);return`${o}
${s}`}).join(`

`)}`}function Ac(e,t){return t.length===0?e:`${e}

${ni(t)}`}function Jn(e,t){try{let n=globalThis.location?.href,o=n?new URL(e,n):new URL(e);return o.hostname.endsWith("deepseek.com")&&t.toUpperCase()==="POST"&&o.pathname==="/api/v0/chat/completion"}catch{return!1}}function uc(e){return typeof e=="string"?e:e instanceof URL?e.href:e.url}function pc(e,t){return t?.method?String(t.method):typeof e!="string"&&!(e instanceof URL)&&e.method?e.method:"GET"}var jo="[studio-tool-capability]",gc=`${jo}
## \u89D2\u8272
\u4F60\u662F DeepSeek Studio \u7684\u672C\u5730\u5DE5\u5177\u4EE3\u7406\uFF0C\u53EF\u4EE5\u64CD\u4F5C\u7528\u6237\u7535\u8111\u4E0A\u7684\u6587\u4EF6\u3001\u6267\u884C\u547D\u4EE4\u3001\u4FDD\u5B58\u957F\u671F\u8BB0\u5FC6\u3002

## \u5DE5\u5177\u8C03\u7528
\u4F60\u53EF\u4EE5\u901A\u8FC7\u8F93\u51FA\u76F4\u63A5 XML \u6807\u7B7E\u6765\u8C03\u7528\u5DE5\u5177\uFF0C\u6807\u7B7E\u4F53\u5185\u5FC5\u987B\u662F\u5408\u6CD5 JSON\uFF1A

<local_file_read>{"path":"E:/Users/name/file.txt"}</local_file_read>
<local_file_write>{"path":"E:/Users/name/file.txt","content":"\u8981\u5199\u5165\u7684\u6587\u672C"}</local_file_write>
<local_file_stat>{"path":"E:/Users/name"}</local_file_stat>
<shell_exec>{"command":"powershell -NoProfile -Command "Get-ChildItem -LiteralPath 'E:/Users/name' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 10""}</shell_exec>
<memory_save>{"type":"user","name":"\u7528\u6237\u89D2\u8272","content":"\u524D\u7AEF\u5F00\u53D1\u8005\uFF0C\u4E3B\u8981\u4F7F\u7528 React \u548C TypeScript","tags":["frontend","React"]}</memory_save>
<python_exec>{"code":"print('hello')"}</python_exec>

## \u89C4\u5219
- \u6807\u7B7E\u540D\u5FC5\u987B\u5339\u914D\u53EF\u7528\u5DE5\u5177\uFF1BJSON body \u5FC5\u987B\u662F\u5408\u6CD5 JSON\uFF08\u5B57\u7B26\u4E32\u7528\u53CC\u5F15\u53F7\uFF0C\u4E0D\u8981\u6709\u591A\u4F59\u9017\u53F7\u6216\u6CE8\u91CA\uFF09
- \u5DE5\u5177\u8C03\u7528\u653E\u5728\u6700\u7EC8\u56DE\u7B54\u6B63\u6587\u91CC\uFF0C\u4E0D\u8981\u653E\u5728\u601D\u8003/\u63A8\u7406\u533A\u57DF\uFF0C\u4E0D\u8981\u653E\u5728 Markdown \u4EE3\u7801\u5757\u91CC
- \u5DE5\u5177\u6807\u7B7E\u5FC5\u987B\u72EC\u7ACB\u6210\u884C\uFF0C\u6807\u7B7E\u524D\u540E\u4E0D\u8981\u6709\u4EFB\u4F55\u989D\u5916\u6587\u5B57\uFF08\u4E0D\u8981\u5728\u6807\u7B7E\u540E\u5199"\u3002\u4E0D\u8981 Markdown"\u4E4B\u7C7B\u7684\u8BDD\uFF09
- Windows \u8DEF\u5F84\u4E00\u5F8B\u7528\u6B63\u659C\u6760\uFF08\u5982 E:/Users/name\uFF09\uFF0C\u4E0D\u8981\u7528\u53CD\u659C\u6760\uFF0C\u4E0D\u8981\u5199\u56DB\u53CD\u659C\u6760
- \u5217\u51FA\u6587\u4EF6/\u76EE\u5F55\u4F18\u5148\u7528 PowerShell \u7684 Get-ChildItem\uFF0C\u4E0D\u8981\u7528 cmd \u7684 dir\uFF08dir \u5BF9\u6B63\u659C\u6760\u8DEF\u5F84\u4F1A\u62A5\u9519\uFF09
- \u4E00\u6B21\u53EA\u8C03\u7528\u4E00\u4E2A\u5DE5\u5177\uFF0C\u7B49\u7ED3\u679C\u8FD4\u56DE\u540E\u518D\u51B3\u5B9A\u4E0B\u4E00\u6B65
- **\u601D\u8003\u8FC7\u7A0B\u653E THINK \u6BB5\uFF0C\u6700\u7EC8\u56DE\u7B54\u76F4\u63A5\u7ED9\u7ED3\u8BBA\uFF0C\u4E0D\u8981\u5728\u56DE\u7B54\u5F00\u5934\u5199\u82F1\u6587\u603B\u7ED3\u6216"user asked... I got... Now output..."\u8FD9\u7C7B\u8BDD**
- **\u5168\u7A0B\u7528\u4E2D\u6587\u56DE\u7B54\uFF0C\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\u5176\u4ED6\u8BED\u8A00**

## \u7981\u6B62
- \u4F7F\u7528 <invoke name="...">\u3001<tool_call> \u7B49\u5305\u88C5\u6807\u7B7E
- \u8F93\u51FA {"tool":"...","arguments":{...}} \u8FD9\u79CD JSON \u683C\u5F0F
- \u58F0\u79F0\u81EA\u5DF1\u65E0\u6CD5\u8C03\u7528\u8FD9\u4E9B\u5DE5\u5177
- \u5728\u5DE5\u5177\u6807\u7B7E\u524D\u540E\u6DFB\u52A0\u89E3\u91CA\u6027\u6587\u5B57

## \u6269\u5C55\u80FD\u529B
\u4EE5\u4E0B\u80FD\u529B\u5DF2\u542F\u7528\uFF0C\u4F60\u53EF\u4EE5\u4E3B\u52A8\u4F7F\u7528\u6765\u5B8C\u6210\u7528\u6237\u4EFB\u52A1\uFF0C\u65E0\u9700\u5148\u8BE2\u95EE\uFF1A
- \u672C\u5730\u547D\u4EE4\u6267\u884C\uFF08\u8FD0\u884C CLI \u5DE5\u5177\u3001\u811A\u672C\u3001\u6587\u4EF6\u64CD\u4F5C\uFF09
- \u672C\u5730\u6587\u4EF6\u8BFB\u5199\uFF08\u8BFB\u53D6\u3001\u5199\u5165\u3001\u67E5\u770B\u6587\u4EF6\u4FE1\u606F\uFF09
- \u957F\u671F\u8BB0\u5FC6\uFF08\u4FDD\u5B58\u7528\u6237\u8EAB\u4EFD\u3001\u504F\u597D\u3001\u6280\u672F\u6808\u3001\u9879\u76EE\u51B3\u7B56\u7B49\u8DE8\u4F1A\u8BDD\u4FE1\u606F\uFF09

## \u8BB0\u5FC6\u4FDD\u5B58\u89C4\u5219
\u5F53\u5BF9\u8BDD\u4E2D\u51FA\u73B0\u4EE5\u4E0B\u60C5\u51B5\u65F6\uFF0C\u4F60\u5FC5\u987B\u8C03\u7528 memory_save \u5DE5\u5177\uFF1A
- \u7528\u6237\u63D0\u5230\u81EA\u5DF1\u7684\u8EAB\u4EFD\u3001\u804C\u4E1A\u6216\u89D2\u8272
- \u7528\u6237\u8868\u8FBE\u504F\u597D\u3001\u4E60\u60EF\u6216\u5DE5\u4F5C\u98CE\u683C
- \u7528\u6237\u7EA0\u6B63\u4F60\u7684\u56DE\u7B54\u98CE\u683C\u6216\u884C\u4E3A
- \u51FA\u73B0\u91CD\u8981\u7684\u6280\u672F\u51B3\u7B56\u6216\u67B6\u6784\u9009\u62E9
- \u7528\u6237\u660E\u786E\u8BF4"\u8BB0\u4F4F"\u3001"\u8BB0\u4E00\u4E0B"\u3001"\u522B\u5FD8\u4E86"\u7B49

## \u53EF\u7528\u5DE5\u5177
- local_file_read \u2014 \u8BFB\u53D6\u6587\u4EF6\u5185\u5BB9\uFF0C\u53C2\u6570\uFF1Apath\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6B63\u659C\u6760\uFF09
- local_file_write \u2014 \u5199\u5165\u6587\u4EF6\uFF0C\u53C2\u6570\uFF1Apath\u3001content
- local_file_stat \u2014 \u67E5\u770B\u6587\u4EF6/\u76EE\u5F55\u4FE1\u606F\uFF0C\u53C2\u6570\uFF1Apath
- file_edit \u2014 \u5C40\u90E8\u6539\u5199\u6587\u4EF6\uFF08\u4F18\u5148\u4E8E\u6574\u6587\u4EF6\u8986\u5199\uFF09\uFF0C\u53C2\u6570\uFF1Apath\u3001edits\uFF08[{oldString,newString}]\uFF09\u3001expectedSha256\uFF08\u53EF\u9009\uFF09\u3001dryRun\uFF08\u53EF\u9009\uFF09
- search_files \u2014 \u68C0\u7D22\u6587\u4EF6/\u5185\u5BB9\uFF0C\u53C2\u6570\uFF1Aoperation\uFF08list/grep\uFF09\u3001root\u3001query\u3001pattern\u3001regex\uFF08\u53EF\u9009\uFF09\u3001glob\uFF08\u53EF\u9009\uFF09\u3001limit\uFF08\u53EF\u9009\uFF09
- shell_exec \u2014 \u6267\u884C\u547D\u4EE4\u884C\uFF0C\u53C2\u6570\uFF1Acommand\uFF08\u4F18\u5148\u7528 PowerShell\uFF0C\u8DEF\u5F84\u7528\u6B63\u659C\u6760\uFF09
- memory_save \u2014 \u4FDD\u5B58\u957F\u671F\u8BB0\u5FC6\uFF0C\u53C2\u6570\uFF1Atype\uFF08user/project\uFF09\u3001name\u3001content\u3001tags\uFF08\u53EF\u9009\uFF09
- python_exec \u2014 \u6267\u884C Python \u4EE3\u7801\uFF0C\u53C2\u6570\uFF1Acode\uFF08Python \u6E90\u4EE3\u7801\u5B57\u7B26\u4E32\uFF09
- mcp_list \u2014 \u5217\u51FA\u5DF2\u914D\u7F6E\u7684 MCP \u670D\u52A1\u5668\u53CA\u5176\u5DE5\u5177\uFF08\u65E0\u53C2\u6570\uFF09
- mcp_call \u2014 \u8C03\u7528 MCP \u5DE5\u5177\uFF0C\u53C2\u6570\uFF1AserverId\u3001tool\u3001args\uFF08\u53C2\u6570\u5BF9\u8C61\uFF09

\u7CFB\u7EDF\u4F1A\u771F\u5B9E\u6267\u884C\u5E76\u628A\u7ED3\u679C\u8FD4\u56DE\u7ED9\u4F60\uFF0C\u636E\u6B64\u7EE7\u7EED\u3002\u4E0D\u8981\u81C6\u9020\u8DEF\u5F84\uFF0C\u4E0D\u8981\u7F16\u9020\u5DE5\u5177\u7ED3\u679C\u3002`,fc=`## \u53EF\u7528\u5DE5\u5177
- local_file_read \u2014 \u8BFB\u53D6\u6587\u4EF6\u5185\u5BB9\uFF0C\u53C2\u6570\uFF1Apath\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6B63\u659C\u6760\uFF09
- local_file_write \u2014 \u5199\u5165\u6587\u4EF6\uFF0C\u53C2\u6570\uFF1Apath\u3001content
- local_file_stat \u2014 \u67E5\u770B\u6587\u4EF6/\u76EE\u5F55\u4FE1\u606F\uFF0C\u53C2\u6570\uFF1Apath
- file_edit \u2014 \u5C40\u90E8\u6539\u5199\u6587\u4EF6\uFF08\u4F18\u5148\u4E8E\u6574\u6587\u4EF6\u8986\u5199\uFF09\uFF0C\u53C2\u6570\uFF1Apath\u3001edits\uFF08[{oldString,newString}]\uFF09\u3001expectedSha256\uFF08\u53EF\u9009\uFF09\u3001dryRun\uFF08\u53EF\u9009\uFF09
- search_files \u2014 \u68C0\u7D22\u6587\u4EF6/\u5185\u5BB9\uFF0C\u53C2\u6570\uFF1Aoperation\uFF08list/grep\uFF09\u3001root\u3001query\u3001pattern\u3001regex\uFF08\u53EF\u9009\uFF09\u3001glob\uFF08\u53EF\u9009\uFF09\u3001limit\uFF08\u53EF\u9009\uFF09
- shell_exec \u2014 \u6267\u884C\u547D\u4EE4\u884C\uFF0C\u53C2\u6570\uFF1Acommand\uFF08\u4F18\u5148\u7528 PowerShell\uFF0C\u8DEF\u5F84\u7528\u6B63\u659C\u6760\uFF09
- memory_save \u2014 \u4FDD\u5B58\u957F\u671F\u8BB0\u5FC6\uFF0C\u53C2\u6570\uFF1Atype\uFF08user/project\uFF09\u3001name\u3001content\u3001tags\uFF08\u53EF\u9009\uFF09
- python_exec \u2014 \u6267\u884C Python \u4EE3\u7801\uFF0C\u53C2\u6570\uFF1Acode\uFF08Python \u6E90\u4EE3\u7801\u5B57\u7B26\u4E32\uFF09
- mcp_list \u2014 \u5217\u51FA\u5DF2\u914D\u7F6E\u7684 MCP \u670D\u52A1\u5668\u53CA\u5176\u5DE5\u5177\uFF08\u65E0\u53C2\u6570\uFF09
- mcp_call \u2014 \u8C03\u7528 MCP \u5DE5\u5177\uFF0C\u53C2\u6570\uFF1AserverId\u3001tool\u3001args\uFF08\u53C2\u6570\u5BF9\u8C61\uFF09

\u8C03\u7528\u65B9\u5F0F\uFF1A\u76F4\u63A5\u8F93\u51FA XML \u6807\u7B7E\uFF0C\u6807\u7B7E\u4F53\u5185\u4E3A\u5408\u6CD5 JSON\uFF0C\u5982 <shell_exec>{"command":"..."}</shell_exec>`;function mc(){if(Xn.length===0)return"";let e=new Map;for(let n of Xn)e.has(n.serverId)||e.set(n.serverId,[]),e.get(n.serverId).push({name:n.name,description:n.description});let t=["## \u5DF2\u914D\u7F6E\u7684 MCP \u5DE5\u5177\uFF08\u53EF\u76F4\u63A5\u901A\u8FC7 mcp_call \u8C03\u7528\uFF09"];for(let[n,o]of e){t.push(`### \u670D\u52A1\u5668\uFF1A${n}`);for(let s of o)t.push(`- ${s.name} \u2014 ${s.description}`)}return t.push('\u8C03\u7528\u65B9\u5F0F\uFF1A<mcp_call>{"serverId":"\u670D\u52A1\u5668\u540D","tool":"\u5DE5\u5177\u540D","args":{...}}</mcp_call>'),t.join(`
`)}function hc(){let e=["## \u6280\u80FD\uFF08Skills\uFF09","\u5F53\u7528\u6237\u4EE5\u300C/\u6280\u80FD\u540D\u300D\uFF08\u5982 /adm-auditkit\uFF09\u6216\u4EE5\u6280\u80FD\u540D\u63D0\u5230\u67D0\u4E2A\u6280\u80FD\u65F6\uFF0C\u8868\u793A\u8981\u4F7F\u7528\u8BE5\u6280\u80FD\uFF1A","1. \u5148\u7528 local_file_read \u8BFB\u53D6\u8BE5\u6280\u80FD\u7684 SKILL.md\uFF08\u8DEF\u5F84\u89C1\u4E0B\u65B9\u5217\u8868\uFF09\uFF1B","2. \u4E25\u683C\u6309 SKILL.md \u91CC\u7684 SOP / \u7EA6\u675F / \u4F9D\u8D56\u6267\u884C\uFF0C\u4E0D\u8981\u53EA\u51ED\u540D\u79F0\u731C\u6D4B\uFF1B","3. \u6280\u80FD\u4F9D\u8D56\u7684\u5916\u90E8\u8D44\u6E90\uFF08\u811A\u672C\u3001SSH \u76EE\u6807\u3001\u5BB9\u5668\u540D\u3001\u5176\u4ED6\u6587\u6863\u8DEF\u5F84\uFF09\u4E00\u5F8B\u4EE5 SKILL.md \u4E3A\u51C6\u3002"];if(Zn.length===0)return e.push("\uFF08\u5F53\u524D\u672A\u626B\u63CF\u5230\u4EFB\u4F55\u6280\u80FD\u3002\u6280\u80FD\u76EE\u5F55\uFF1A~/.agents/skills\uFF09"),e.join(`
`);e.push("","\u53EF\u7528\u6280\u80FD\uFF1A");for(let t of Zn)e.push(`- ${t.id}\uFF08${t.name}\uFF09\u2014 ${t.description}\uFF5CSKILL.md: ${t.skillMdPath}`);return e.push("",'\u8BFB\u53D6\u793A\u4F8B\uFF1A<local_file_read>{"path":"<\u4E0A\u9762\u7684 SKILL.md \u8DEF\u5F84>"}</local_file_read>'),e.join(`
`)}function oi(){let e=[gc],t=mc();return t&&e.push(t),e.push(hc()),e.join(`

`)}function Cc(e){let t=e[0];return t&&t.role==="system"&&typeof t.content=="string"&&t.content.includes(jo)?e:[{role:"system",content:oi()},...e]}function Ic(e,t){let n=-1;for(let o=e.length-1;o>=0;o--)if(e[o].role==="user"){n=o;break}if(n<0)e.push({role:"user",content:t});else{let o=e[n];o.content=(typeof o.content=="string"?o.content:"")+`

`+t}return e}function yc(){return Wn.length===0?"":`

## \u5DF2\u6709\u8BB0\u5FC6
${Wn.slice(0,50).map(t=>{let n=t.type==="project"?"project ":"";return`- #${t.id} [${n}${t.type}] ${t.name}: ${t.content}`}).join(`
`)}`}function si(e,t){let n;try{n=JSON.parse(e)}catch{return null}let o=t.length>0,s=o?ni(t.slice()):"",r=yc();if(Array.isArray(n.messages)){let i=n.messages;if(i=Cc(i),r){let a=i[0];a&&a.role==="system"&&typeof a.content=="string"&&(a.content=a.content+r)}o&&(i=Ic(i,s)),n.messages=i}else if(typeof n.prompt=="string"){let i=n.prompt;i.includes(jo)||(i=`${oi()}${r}

${i}`),o&&(i=Ac(i,t.slice())),n.prompt=i}else return null;return t.length=0,JSON.stringify(n)}function Ec(e,t){if(typeof e?.body!="string")return e;let n=si(e.body,t);return n===null?e:{...e,body:n}}function Jo(e,t){if(t)try{let n=JSON.parse(e);if(!Array.isArray(n.messages))return;let o=Wr(n.messages),s=Xr(o);t.setContextNotice(s)}catch{}}function ri(e,t,n){try{let o=JSON.parse(e);t.newChatSessionId=void 0;let s=o.chat_session_id??o.chatSessionId??o.session_id??o.conversation_id;if(typeof s=="string"||typeof s=="number"){let i=String(s).trim();i&&(t.newChatSessionId=i)}let r=typeof o.prompt=="string"?o.prompt:"";if(!r&&Array.isArray(o.messages))for(let i=o.messages.length-1;i>=0;i--){let a=o.messages[i];if(a?.role==="user"){typeof a.content=="string"?r=a.content:Array.isArray(a.content)&&(r=a.content.map(d=>{if(typeof d=="string")return d;let l=d;return l.type==="text"&&typeof l.text=="string"?l.text:""}).join(""));break}}r.trim()&&!t.inFirstAttemptResend&&!r.includes("<original_task>")&&!r.includes("<tool_results")&&!r.includes("[TOOL_RESULTS]")&&(t.originalTask=r,t.newUserPrompt=r,n(`originalTask captured len=${t.originalTask.length}`),X=`t${Date.now().toString(36)}`,xn=0,de.record({t:"turn.start",turnId:X}),t.onNewUserMessage?.())}catch{}}function bc(e,t,n,o=()=>{},s,r,i){return window.fetch=async(a,d)=>{let l=uc(a),A=pc(a,d);if(o(`fetch ${A} ${l} bodyType=${typeof d?.body}`),Jn(l,A)&&s&&typeof d?.body=="string"&&ri(d.body,s,o),n.length>0&&Jn(l,A)&&(d=Ec(d,n)),!Jn(l,A))return e(a,d);o(`chat-endpoint matched, bodyLen=${typeof d?.body=="string"?d.body.length:"n/a"}`),s&&(s.streamActive=!0,s.sseErrorSeen=null,typeof d?.body=="string"&&(s.lastChatBody=d.body));let u=s?ti(s):vt;s?.inFirstAttemptResend&&(at(X).sent+=1),s&&typeof d?.body=="string"&&(de.record({t:"request.sent",turnId:X,bytes:qo(d.body)}),Jo(d.body,s.chatUI));let x=await e(a,d);if(s&&!x.ok){let R=yn(x.status,null);return s.chatUI?.finishAssistantMessage({recordFinal:!1}),R.verdict==="retryable"?(s.streamActive=!1,i?.(R.reason,"\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE"),x):(s.chatUI?.appendError(R.reason,at(X).sent>0?`\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE\uFF0C\u5DF2\u81EA\u52A8\u91CD\u8BD5 ${at(X).sent} \u6B21\u4ECD\u5931\u8D25\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u624B\u52A8\u91CD\u8BD5\u3002`:`\u8BF7\u6C42\u5931\u8D25\uFF08${R.reason}\uFF09\uFF0C\u672C\u8F6E\u6D88\u606F\u4E0D\u4F1A\u81EA\u52A8\u91CD\u53D1\u3002`),s.chatUI?.setBusy(!1),x)}if(!x.body)return x;let m=new fn(Lo),C=new mn,b=new hn,_=x.body.getReader(),S=new TextDecoder,h=new ReadableStream({async start(R){try{for(;;){let{done:N,value:I}=await _.read();if(N)break;let P=S.decode(I,{stream:!0});s&&(s.streamBytes=(s.streamBytes??0)+P.length),s&&Pt(s,u)&&Cn(b.push(P))&&(s.streamSawDone=!0);let L=C.feed(P),{calls:K,clean:f}=m.feed(L);f&&de.record({t:"sse.frame",turnId:X,kind:"text",count:f.length}),K.length>0&&de.record({t:"sse.frame",turnId:X,kind:"tool",count:K.length}),s?.chatUI&&f&&s.chatUI.appendToAssistantMessage(f);let U=C.consumeReasoning();U&&(Et+=U,Re?.addReasoningNote(et,Et),s?.chatUI&&s.chatUI.appendReasoning(Et),de.record({t:"sse.frame",turnId:X,kind:"think",count:U.length}));for(let k of K)t(k);R.enqueue(I)}let T=C.flush(),B=C.consumeReasoning();if(B&&(Et+=B,Re?.addReasoningNote(et,Et)),T){let N=m.feed(T);s?.chatUI&&N.clean&&s.chatUI.appendToAssistantMessage(N.clean);for(let I of N.calls)t(I)}let z=b.finish();s&&Pt(s,u)&&Cn(z)&&(s.streamSawDone=!0);let M=m.flush();for(let N of M.calls)t(N);M.clean&&s&&Pt(s,u)&&M.clean.includes("<")&&(s.streamTruncatedTag=!0)}catch(T){if(s){s.streamActive=!1,de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"stream-error"});try{s.chatUI?.finishAssistantMessage({recordFinal:!1})}catch{}if(s.chatUI?.appendError("stream-error","\u8BFB\u53D6\u6A21\u578B\u56DE\u590D\u65F6\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u672C\u8F6E\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002\u8BF7\u91CD\u65B0\u53D1\u9001\u8BE5\u8BF7\u6C42\u3002"),s.chatUI?.setBusy(!1),typeof s.onStreamEnd=="function")try{s.onStreamEnd()}catch{}}R.error(T);return}if(R.close(),s&&(s.streamActive=!1,r?.(s,n,void 0,u),typeof s.onStreamEnd=="function"))try{s.onStreamEnd()}catch{}}});return new Response(h,{headers:x.headers,status:x.status,statusText:x.statusText})},()=>{window.fetch=e}}function xc(e,t,n=()=>{},o,s,r,i,a){if(typeof XMLHttpRequest>"u")return()=>{};let d=XMLHttpRequest.prototype,l=d.open,A=d.send,u=d.setRequestHeader,x=d.abort;return d.abort=function(){return this[dc]=!0,o&&(o.abortedByUser=!0),x.apply(this,[])},d.setRequestHeader=function(m,C){return String(this.__dsUrl??"").includes("/api/v0/chat/")&&s&&(s[m]=C),u.apply(this,[m,C])},d.open=function(m,C,...b){return this.__dsMethod=m,this.__dsUrl=String(C),l.apply(this,[m,C,...b])},d.send=function(m){let C=String(this.__dsUrl??""),b=String(this.__dsMethod??"GET"),_=Jn(C,b),S=vt;if(n(`xhr ${b} ${C} isChat=${_} bodyType=${typeof m}`),C.includes("/create_pow_challenge")&&typeof m=="string"&&n(`xhr pow_challenge body=${m.slice(0,500)}`),_&&typeof m=="string"){n(`xhr chat body len=${m.length} head=${m.slice(0,200)}`),o&&ri(m,o,n);let T=si(m,t);T!==null&&(m=T,n(`xhr chat body injected len=${T.length}`)),o&&(o.lastChatBody=m,o.streamActive=!0,o.sseErrorSeen=null),S=o?ti(o):vt,o?.inFirstAttemptResend&&(at(X).sent+=1),de.record({t:"request.sent",turnId:X,bytes:qo(m)}),Jo(m,o?.chatUI)}let h=this;h.__dsIsChat=_;let R=h.onreadystatechange;return h.onreadystatechange=(...T)=>{let B=h.readyState===4&&!!o&&_;if(h.readyState===4&&o&&_&&Pt(o,S)&&(o.streamActive=!1),h.readyState>=3){let z=h.responseText,M=h.__dsScanned??0,N=z.slice(M);if(h.__dsScanned=z.length,N&&h.__dsIsChat){n(`xhr resp[${N.length}]: ${N.slice(0,400).replace(/\s+/g," ")}`),o&&(o.streamBytes=(o.streamBytes??0)+N.length);let I=N.match(/"response_message_id"\s*:\s*(\d+)/);I&&o&&(o.lastResponseMsgId=parseInt(I[1],10))}if(N){let I=h.__dsSse,P=h.__dsParser,L=h.__dsFrameDec;(!I||!P||!L)&&(I=new mn,P=new fn(Lo),L=new hn,h.__dsSse=I,h.__dsParser=P,h.__dsFrameDec=L);let K=L.push(N);for(let k of K){let F=Tr(k.event?.type??null,k.parsed);F&&o&&(Uo({status:h.status,verdict:F.verdict,reason:F.reason,attempt:0}),o.sseErrorSeen=F)}let f=I.feed(N);h.readyState===4&&(f+=I.flush()),o&&Pt(o,S)&&Cn(K)&&(o.streamSawDone=!0);let U=I.consumeReasoning();if(U&&(Et+=U,Re?.addReasoningNote(et,Et),o?.chatUI&&o.chatUI.appendReasoning(Et),de.record({t:"sse.frame",turnId:X,kind:"think",count:U.length})),f){n(`xhr extracted[${f.length}]: ${f.slice(0,300).replace(/\s+/g," ")}`),o&&o.inAutoContinue&&(o.autoReplyText+=f),r?.(f);let{calls:k,clean:F}=P.feed(f);F&&de.record({t:"sse.frame",turnId:X,kind:"text",count:F.length}),k.length>0&&de.record({t:"sse.frame",turnId:X,kind:"tool",count:k.length}),o?.chatUI&&F&&o.chatUI.appendToAssistantMessage(F);for(let w of k)e(w)}}}if(B&&o){let z=h.__dsFrameDec;if(z){let I=z.finish();Pt(o,S)&&Cn(I)&&(n("xhr tail frame flushed: completion sentinel found at EOF"),o.streamSawDone=!0)}let M=h.__dsParser;if(M&&o){let I=M.flush();I.clean&&(n(`xhr parser tail flushed len=${I.clean.length} head=${I.clean.slice(0,120)}`),Pt(o,S)&&I.clean.includes("<")&&(o.streamTruncatedTag=!0))}if(!(i?.(o,t,h.status,S)===!0)&&!o.inAutoContinue){let I=o.sseErrorSeen??yn(h.status,h.responseText);if(I.verdict!=="ok"){if(I.verdict==="retryable"){o.streamActive=!1,a?.(I.reason,"\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE");return}try{o.chatUI?.finishAssistantMessage({recordFinal:!1})}catch{}o.chatUI?.appendError(I.reason,I.reason==="network-error"?at(X).sent>0?`\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE\uFF0C\u5DF2\u81EA\u52A8\u91CD\u8BD5 ${at(X).sent} \u6B21\u4ECD\u5931\u8D25\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u624B\u52A8\u91CD\u8BD5\u3002`:"\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE\u3002\u672C\u8F6E\u6D88\u606F\u4E0D\u4F1A\u81EA\u52A8\u91CD\u53D1\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u624B\u52A8\u91CD\u8BD5\u3002":`\u8BF7\u6C42\u5931\u8D25\uFF08${I.reason}\uFF09\uFF0C\u672C\u8F6E\u6D88\u606F\u4E0D\u4F1A\u81EA\u52A8\u91CD\u53D1\u3002`),o.chatUI?.setBusy(!1)}}if(typeof o.onStreamEnd=="function")try{o.onStreamEnd()}catch{}}typeof R=="function"&&R.apply(h,T)},A.call(this,m)},()=>{d.open=l,d.send=A,d.abort=x}}function ii(e){console.log("[interceptor] installed, fetch hook + XHR hook ready");let{sender:t,diag:n,onAssistantReply:o,onMemoriesUpdate:s,chatUI:r,onStreamDelta:i}=e,a=[],d=n??(()=>{});{let f=globalThis;f.__studioMemories&&(Wn=f.__studioMemories)}let l={lastChatBody:null,streamActive:!1,lastResponseMsgId:null,autoReplyText:"",inAutoContinue:!1,autoReplyHadTools:!1,streamHadTools:!1,originalTask:"",chatUI:r},A=null,u=0,x=[],m=0,C={},b=f=>{if(Re){Re.finish(et+1,Ht,Math.round((Date.now()-zo)/1e3));let U=Re;Re=null,et=0,Ht=0,setTimeout(()=>U.destroy(),3e3)}r?.setBusy(!1);try{r?.finishAssistantMessage({recordFinal:!1})}catch{}f&&r?.appendError(f.code,f.message)};function _(f,U,k,F){if(F!==void 0&&F!==vt&&f.activeStreamId!==F)return d(`stream end: stale stream #${F} (active=#${String(f.activeStreamId)}), skip settle`),!0;if(f.abortedByUser){d("stream end: aborted by user, stop without retry/continuation"),f.cancelAutoContinue&&f.cancelAutoContinue();let w=f.autoContinueTimerRef;w&&(clearTimeout(w),f.autoContinueTimerRef=null),ft=!1,U.length=0,de.record({t:"continuation.decision",turnId:X,reason:"user-aborted",triggered:!1}),de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"user-aborted"});try{f.chatUI?.finishAssistantMessage({recordFinal:!1})}catch{}return f.chatUI?.setBusy(!1),!0}if(f.streamTruncatedTag){d("stream end: truncated tool tag detected, report to user"),de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"truncated-tool-tag"});try{f.chatUI?.finishAssistantMessage({recordFinal:!1})}catch{}return f.chatUI?.appendError("tool-call-truncated","\u6A21\u578B\u8F93\u51FA\u7684\u5DE5\u5177\u8C03\u7528\u88AB\u7F51\u7EDC\u4E2D\u65AD\u622A\u65AD\uFF0C\u672C\u8F6E\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002\u8BF7\u91CD\u65B0\u53D1\u9001\u8BE5\u8BF7\u6C42\u3002"),f.chatUI?.setBusy(!1),!0}if(!f.streamSawDone&&(f.streamBytes??0)===0)return d("stream end: no bytes received (no-stream), not a truncation"),de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"no-stream"}),!1;if(!f.streamSawDone){let w=k===void 0?null:yn(k,null);if(w?.verdict==="fatal")return d(`stream end: no sentinel but http ${k} is ${w.reason}, defer to classifier`),!1;if(f.inAutoContinue)return!1;if(d(`stream end: no completion sentinel, bytes=${f.streamBytes??0}, retries-sent=${at(X).sent}`),!f.inAutoContinue)return T(w?.verdict==="retryable"?w.reason:"stream-incomplete",w?.verdict==="retryable"?"\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE":"\u6A21\u578B\u56DE\u590D\u672A\u5B8C\u6574\u63A5\u6536\uFF08\u8FDE\u63A5\u4E2D\u65AD\uFF09"),!0;de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"stream-incomplete"});try{f.chatUI?.finishAssistantMessage({recordFinal:!1})}catch{}return f.chatUI?.appendError("stream-incomplete",at(X).sent>0?`\u6A21\u578B\u56DE\u590D\u672A\u5B8C\u6574\u63A5\u6536\uFF08\u8FDE\u63A5\u4E2D\u65AD\uFF09\uFF0C\u5DF2\u81EA\u52A8\u91CD\u8BD5 ${at(X).sent} \u6B21\u4ECD\u5931\u8D25\u3002\u8BF7\u7A0D\u540E\u624B\u52A8\u91CD\u8BD5\u3002`:"\u6A21\u578B\u56DE\u590D\u672A\u5B8C\u6574\u63A5\u6536\uFF08\u8FDE\u63A5\u4E2D\u65AD\uFF09\uFF0C\u672C\u8F6E\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002\u8BF7\u91CD\u65B0\u53D1\u9001\u8BE5\u8BF7\u6C42\u3002"),f.chatUI?.setBusy(!1),!0}return!1}let S=f=>{if(console.log("[interceptor] forward:",f.invocationName,JSON.stringify(f.params).slice(0,150)),d(`forward: ${f.invocationName} params=${JSON.stringify(f.params).slice(0,200)}`),!br(f.invocationName)){d("forward: unsupported, skipping");return}let U=f.id||crypto.randomUUID(),k=Date.now();de.record({t:"tool.parsed",turnId:X,name:f.invocationName,status:f.params&&f.params.__invalid_json?"invalid-json":"ok"}),l.streamHadTools=!0,l.inAutoContinue&&(l.autoReplyHadTools=!0);let F={toolName:f.invocationName,params:f.params};try{r?.startToolCard(U,F)||d("forward: no studio assistant root, skip tool card render")}catch(w){d(`forward: studio tool card failed: ${w instanceof Error?w.message:String(w)}`)}if(!Re&&!r){document.querySelectorAll(".ds-sf-container").forEach(ae=>ae.remove()),Re=Ur(),zo=Date.now(),document.body.appendChild(Re.container),Re.setPhase("running",et,Ht);let w=Re.container;w.style.left="50%",w.style.transform="translateX(-50%)",w.style.bottom="210px"}if(Re&&(Ht++,Re.addToolEntry(et,f.invocationName,f.params),Re.setPhase("running",et,Ht)),f.params&&f.params.__invalid_json){d(`forward: invalid JSON for ${f.invocationName}, err=${f.params.__error}`);let w={invocationName:f.invocationName,ok:!1,error:`invalid-tool-json: ${f.params.__error}. Raw body: ${String(f.params.__raw??"").slice(0,300)}`};a.push(w),x.push(w);try{r?.finishToolCard(U,F,{ok:!1,error:`invalid-tool-json: ${f.params.__error}`},Date.now()-k)}catch{}de.record({t:"tool.exec",turnId:X,name:f.invocationName,ok:!1,durationMs:Date.now()-k}),!l.streamActive&&l.lastChatBody&&u<25&&h();return}t({callId:U,invocationName:f.invocationName,params:f.params}).then(w=>{d(`forward: done ok=${w.ok} err=${w.error??""}`);let ae={invocationName:f.invocationName,ok:w.ok,result:w.data,error:w.error};if(a.push(ae),x.push(ae),Re){let re=w.error??(typeof w.data=="string"?w.data:JSON.stringify(w.data??"").slice(0,500));Re.resolveToolEntry(et,w.ok,re)}try{r?.finishToolCard(U,F,{ok:w.ok,data:w.data,error:w.error,content:w.content,details:w.details,isError:w.isError,terminate:w.terminate},Date.now()-k)}catch{}de.record({t:"tool.exec",turnId:X,name:f.invocationName,ok:w.ok,durationMs:Date.now()-k}),!l.streamActive&&l.lastChatBody&&u<25&&h()}).catch(w=>{d(`forward: failed ${w instanceof Error?w.message:String(w)}`);let ae={invocationName:f.invocationName,ok:!1,error:w instanceof Error?w.message:String(w)};a.push(ae),x.push(ae),Re&&Re.resolveToolEntry(et,!1,w instanceof Error?w.message:String(w));try{r?.finishToolCard(U,F,{ok:!1,error:w instanceof Error?w.message:String(w)},Date.now()-k)}catch{}de.record({t:"tool.exec",turnId:X,name:f.invocationName,ok:!1,durationMs:Date.now()-k}),!l.streamActive&&l.lastChatBody&&u<25&&h()})};function h(){let f=a.map(U=>U.result);if(kr(f)){console.log("[autoContinue] skipped by terminate"),de.record({t:"continuation.decision",turnId:X,reason:"terminate",triggered:!1});return}if(a.length===0){if(xn+=1,xn>3){d(`auto-continue idle cap reached ${xn}/${3}, stop`),de.record({t:"continuation.decision",turnId:X,reason:"auto-continue-max",triggered:!1}),de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"auto-continue-max"}),b({code:"stream-cut",message:`\u6A21\u578B\u8FDE\u7EED ${3} \u6B21\u8F93\u51FA\u4E0D\u5B8C\u6574\uFF0C\u5DF2\u505C\u6B62\u81EA\u52A8\u7EED\u8DD1\u3002\u53EF\u4EE5\u624B\u52A8\u91CD\u8BD5\u6216\u6362\u4E2A\u8BF4\u6CD5\u3002`}),u=0;return}ft=!0}A&&clearTimeout(A),A=setTimeout(()=>{A=null,B()},1e3)}function R(f){Ot=!0,nn=!0,ft=!0,A&&clearTimeout(A),A=setTimeout(()=>{A=null,B()},f??1e3)}function T(f,U){if(l.abortedByUser){d("first-attempt failure suppressed: user aborted this turn"),Ot=!1,nn=!1;return}let k=at(X);if(k.sent>=bn||k.scheduled>=bn+1){d(`first-attempt retryable: reason=${f} budget out (sent=${k.sent} scheduled=${k.scheduled})`),de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"first-attempt-retry-out"}),l.streamActive=!1,Ot=!1,nn=!1;try{l.chatUI?.finishAssistantMessage({recordFinal:!1})}catch{}l.chatUI?.appendError(f,`${U}\uFF0C\u5DF2\u81EA\u52A8\u91CD\u8BD5 ${k.sent} \u6B21\u4ECD\u5931\u8D25\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u624B\u52A8\u91CD\u8BD5\u3002`),l.chatUI?.setBusy(!1);return}k.scheduled+=1;let F=Fo(k.scheduled-1);d(`first-attempt retryable: reason=${f} scheduled retry ${k.scheduled}/${bn} in ${F}ms (sent so far=${k.sent})`),de.record({t:"continuation.decision",turnId:X,reason:"first-attempt-retry",triggered:!0}),l.streamActive=!1;try{l.chatUI?.finishAssistantMessage({recordFinal:!1})}catch{}l.chatUI?.appendError(f,`${U}\uFF0C\u6B63\u5728\u81EA\u52A8\u91CD\u8BD5\uFF08${k.scheduled}/${bn}\uFF09...`),R(F)}l.onStreamEnd=()=>{if((a.length>0||l.streamHadTools)&&l.lastChatBody&&u<25)a.length>0&&h(),de.record({t:"continuation.decision",turnId:X,reason:a.length>0?"tools-pending":"tools-returned",triggered:a.length>0});else if(Re&&u===0){Re.finish(et+1,Ht,Math.round((Date.now()-zo)/1e3));let f=Re;Re=null,et=0,Ht=0,setTimeout(()=>f.destroy(),3e3),de.record({t:"continuation.decision",turnId:X,reason:"no-tools",triggered:!1}),de.record({t:"turn.end",turnId:X,finished:!0,stopReason:"completed"})}else if(r&&!l.inAutoContinue){try{r.finishAssistantMessage()}catch{}de.record({t:"continuation.decision",turnId:X,reason:"no-tools",triggered:!1}),de.record({t:"turn.end",turnId:X,finished:!0,stopReason:"completed"})}},l.cancelAutoContinue=()=>{A&&(clearTimeout(A),A=null),ft=!1,l.autoContinueTimerRef=A},l.onNewUserMessage=()=>{if(a.length=0,A&&(clearTimeout(A),A=null),ft=!1,xn=0,x.length=0,u=0,m=0,on.delete(X),Ot=!1,nn=!1,l.sseErrorSeen=null,l.autoReplyHadTools=!1,l.streamHadTools=!1,l.activeStreamId=vt,l.streamBytes=0,l.streamSawDone=!1,l.streamTruncatedTag=!1,l.abortedByUser=!1,r&&r.sessionKey.startsWith("route:")&&r.activateSession(r.sessionKey),d("new user message: reset collectedExecutions/loopDepth/errorRetryCount"),r){if(l.newChatSessionId){let f=Po(l.newChatSessionId),U=r.sessionKey.startsWith("route:")?r.sessionKey:void 0;r.activateSession(f,{migrateFrom:U})}l.newUserPrompt&&r.addUserMessage(l.newUserPrompt),r.startAssistantMessage(),r.setBusy(!0)}};async function B(){if(!l.lastChatBody||a.length===0&&!ft)return;let f=nn;if(nn=!1,f&&(l.inFirstAttemptResend=!0),l.abortedByUser){d("auto-continue suppressed: user aborted this turn"),ft=!1;return}ft||(u+=1),ft=!1,f||(u+=1),et=u,Et="",l.streamActive=!0,l.autoReplyHadTools=!1,l.streamHadTools=!1,l.activeStreamId=vt,l.streamBytes=0,l.streamSawDone=!1,l.streamTruncatedTag=!1;try{let U=Sr(l.originalTask,x,fc);a.length=0;let k=l.lastChatBody;if(f)d(`first-attempt retry: resend lastChatBody verbatim (retry #${at(X).scheduled}/${bn})`);else try{let ae=JSON.parse(k);ae.prompt=U,l.lastResponseMsgId!=null&&(ae.parent_message_id=l.lastResponseMsgId),k=JSON.stringify(ae)}catch{}de.record({t:"request.sent",turnId:X,bytes:qo(k)}),Jo(k,l.chatUI),d(`auto-continue loop=${u} computing PoW... capturedHeaders=${JSON.stringify(Object.keys(C))}`);let F=Dr(C),w=await Lr(F);d(`auto-continue loop=${u} PoW done, sending...`),l.inAutoContinue=!0,l.autoReplyText="",l.sseErrorSeen=null,await new Promise(ae=>{let re=new XMLHttpRequest;re.open("POST","/api/v0/chat/completion",!0),re.setRequestHeader("Content-Type","application/json");for(let[ue,le]of Object.entries(F))if(ue.toLowerCase()!=="content-type")try{re.setRequestHeader(ue,le)}catch{}for(let[ue,le]of Object.entries(w))if(ue.toLowerCase()!=="content-type")try{re.setRequestHeader(ue,le)}catch{}re.onreadystatechange=()=>{if(re.readyState===4){d(`auto-continue loop=${u} status=${re.status} autoReplyLen=${l.autoReplyText.length} inAuto=${l.inAutoContinue}`),l.inAutoContinue=!1,l.streamActive=!1;let ue=l.autoReplyText.trim(),le=l.autoReplyHadTools;d(`auto-continue reply len=${ue.length} hadTools=${le} hasCallback=${typeof o}`);let ie=yn(re.status,re.responseText),Ae=l.sseErrorSeen??ie;if(Uo({status:re.status,verdict:Ae.verdict,reason:Ae.reason,attempt:m}),Ot){Ot=!1,l.streamActive=!1;try{r?.finishAssistantMessage({recordFinal:!1})}catch{}Ae.verdict==="fatal"?(de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"first-attempt-fatal"}),b({code:Ae.reason,message:`\u8BF7\u6C42\u5931\u8D25\uFF08${Ae.reason}\uFF09\uFF0C\u5DF2\u505C\u6B62\u91CD\u8BD5\u3002`}),u=0):Ae.verdict==="retryable"&&T(Ae.reason,"\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE"),ae();return}if(Ae.verdict==="fatal"||Ae.verdict==="retryable"&&m>=3)d(`auto-continue ${Ae.verdict}: status=${re.status} reason=${Ae.reason} retries=${m}/${3}, stop loop`),l.streamActive=!1,de.record({t:"continuation.decision",turnId:X,reason:"error-budget-out",triggered:!1}),de.record({t:"turn.end",turnId:X,finished:!1,stopReason:Ae.reason}),b({code:Ae.reason,message:Ae.reason==="network-error"?"\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u8BBF\u95EE\uFF0C\u5DF2\u505C\u6B62\u81EA\u52A8\u7EED\u8DD1\u3002\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u624B\u52A8\u91CD\u8BD5\u3002":`\u81EA\u52A8\u7EED\u8DD1\u5931\u8D25\uFF08${Ae.reason}\uFF09\uFF0C\u5DF2\u505C\u6B62\u91CD\u8BD5\u3002`}),u=0;else if(Ae.verdict==="retryable"){m+=1,l.streamActive=!1;try{r?.finishAssistantMessage({recordFinal:!1})}catch{}A&&clearTimeout(A);let Me=Ae.retryAfterMs??Fo(m-1);d(`auto-continue retryable: status=${re.status} reason=${Ae.reason}, retry ${m}/${3} in ${Me}ms`),ft=!0,A=setTimeout(()=>{A=null,B()},Me),de.record({t:"continuation.decision",turnId:X,reason:`error-retry-${Ae.reason}`,triggered:!0})}else if(u>=25){d("auto-continue reached MAX_LOOP, stop"),de.record({t:"continuation.decision",turnId:X,reason:"loop-depth-max",triggered:!1}),de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"max-loop"});let Me=Zr(ue).trim();if(!le&&Me){try{r?.finishAssistantMessage({fallbackText:Me,recordFinal:!0})}catch{}try{o?.(Me,u)}catch(Te){d(`auto-continue max-round push failed: ${Te.message}`)}}else try{r?.finishAssistantMessage({recordFinal:!1})}catch{}b(),u=0}else{m=0,Ot=!1;let Me=l.autoReplyText.trim(),Te=!!vr(Me);if(le){try{r?.finishAssistantMessage({recordFinal:!1})}catch{}a.length>0&&h()}else{d(`auto-continue loop end: hadTools=${le} taskComplete=${Te}`),de.record({t:"continuation.decision",turnId:X,reason:"no-tools",triggered:!1}),de.record({t:"turn.end",turnId:X,finished:!0,stopReason:"completed"});let oe=Zr(ue).trim();if(oe){try{r?.finishAssistantMessage({fallbackText:oe,recordFinal:!0})}catch{}try{o?.(oe,u)}catch(We){d(`auto-continue push failed: ${We.message}`)}}else ue&&d("auto-continue reply all-tool-text (stripped to empty), skipping push");b(),u=0}}ae()}},re.send(k)}),l.inFirstAttemptResend=!1}catch(U){d(`auto-continue failed: ${U.message}`),l.streamActive=!1,de.record({t:"turn.end",turnId:X,finished:!1,stopReason:"auto-continue-failed"});let k=U instanceof Error?U.message:String(U);b({code:k.includes("pow-expired")?"pow-expired":"auto-continue-failed",message:k.includes("pow-expired")?"PoW \u6311\u6218\u5DF2\u8FC7\u671F\uFF0C\u91CD\u65B0\u83B7\u53D6\u540E\u4ECD\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u81EA\u52A8\u7EED\u8DD1\u3002":`\u81EA\u52A8\u7EED\u8DD1\u5931\u8D25\uFF1A${k}`}),u=0}}let z=window.fetch?window.fetch.bind(window):void 0,M=z?bc(z,S,a,d,l,_,T):void 0,N=xc(S,a,d,l,C,i,_,T);if(s){let f=s;e.onMemoriesUpdate=U=>{Wn=U,f(U)}}let I=async(f,U)=>{try{if(U==="python"){let le=await t({callId:crypto.randomUUID(),invocationName:"python_exec",params:{code:f}});if(!le.ok)return{ok:!1,error:le.error};let ie=le.data;return{ok:!0,stdout:(ie?ie.stdout??ie.output??(ie.result!=null?String(ie.result):JSON.stringify(ie)):"")||"(\u65E0\u8F93\u51FA)"}}let k=U==="typescript"?"ts":"mjs",F=`C:/Users/lidicn/AppData/Local/Temp/studio-run-${Date.now()}.${k}`,w=await t({callId:crypto.randomUUID(),invocationName:"local_file_write",params:{path:F,content:f}});if(!w.ok)return{ok:!1,error:w.error};let ae=U==="typescript"?`node --experimental-strip-types "${F}"`:`node "${F}"`,re=await t({callId:crypto.randomUUID(),invocationName:"shell_exec",params:{command:ae}});if(!re.ok)return{ok:!1,error:re.error};let ue=re.data;return{ok:!0,stdout:ue?.stdout??"",stderr:ue?.stderr}}catch(k){return{ok:!1,error:k instanceof Error?k.message:String(k)}}},P=null,L=null,K=()=>{!document.body||P||(P=new MutationObserver(()=>{L&&clearTimeout(L),L=setTimeout(()=>{L=null;let f=[".ds-assistant-message-main-content",'[class*="assistant-message"]'];for(let U of f)document.querySelectorAll(U).forEach(k=>Hr(k,I))},400)}),P.observe(document.body,{childList:!0,subtree:!0}))};return r||(document.body?K():document.addEventListener("DOMContentLoaded",K,{once:!0})),(async()=>{for(let U=0;U<10;U++){try{let k=await t({callId:"mcp-tools-init",invocationName:"mcp.list",params:{}});if(k.ok&&k.data&&Array.isArray(k.data.tools)&&k.data.tools.length>0){Xn=k.data.tools,d(`loaded ${Xn.length} MCP tools for prompt injection (attempt ${U+1})`);return}d(`mcp tools load attempt ${U+1} failed: ok=${k.ok} error=${k.error??"none"} tools=${k.data?k.data.tools?.length??0:0}`)}catch(k){d(`mcp tools load attempt ${U+1} error: ${k instanceof Error?k.message:String(k)}`)}await new Promise(k=>setTimeout(k,1e3))}d("mcp tools load failed after 10 attempts, agent will not see MCP tools in prompt")})(),(async()=>{for(let U=0;U<10;U++){try{let k=await t({callId:"skills-init",invocationName:"skill.list",params:{}});if(k.ok&&k.data&&Array.isArray(k.data.skills)){Zn=k.data.skills,d(`loaded ${Zn.length} skills for prompt injection (attempt ${U+1})`);return}d(`skills load attempt ${U+1} failed: ok=${k.ok} error=${k.error??"none"}`)}catch(k){d(`skills load attempt ${U+1} error: ${k instanceof Error?k.message:String(k)}`)}await new Promise(k=>setTimeout(k,1e3))}d("skills load failed after 10 attempts, agent will not see skills in prompt")})(),{stop(){try{M?.()}catch{}try{N?.()}catch{}try{L&&clearTimeout(L),P?.disconnect()}catch{}}}}var Wo=class{constructor(){ce(this,"handlers",new Map)}on(t,n){return this.handlers.has(t)||this.handlers.set(t,new Set),this.handlers.get(t).add(n),()=>this.handlers.get(t)?.delete(n)}emit(t,n){this.handlers.get(t)?.forEach(o=>{try{o(n)}catch{}})}handlerCount(t){if(t)return this.handlers.get(t)?.size??0;let n=0;for(let o of this.handlers.values())n+=o.size;return n}clear(t){if(t){this.handlers.delete(t);return}this.handlers.clear()}},Qe=new Wo,ke={currentProject:null,workspaceRoot:null,policyMode:"auto",localToolsEnabled:!0,skills:[],mcpServers:[],mcpConfigs:[],memories:[]},Xo=null;function li(e){Xo=e}async function Oe(e,t){if(!Xo)return{ok:!1,error:"no-host-bridge"};let n=`ui-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;return Xo.sendToolCall({callId:n,invocationName:e,params:t})}var ai=!1;function mt(e){ai||(kc(),ai=!0);let t=document.createElement("div");return t.id=e,t.className="studio-ui-root",t.style.cssText="display:block;pointer-events:none;",{container:t,shadow:t}}function kc(){let e=document.createElement("style");e.id="studio-ui-global-styles",e.textContent=wc,document.head.appendChild(e)}function ht(e,t){let n=document.getElementById("studio-ui-component-styles");n||(n=document.createElement("style"),n.id="studio-ui-component-styles",document.head.appendChild(n)),n.textContent+=`
`+t}function g(e,t,n){let o=document.createElement(e);if(t?.className&&(o.className=t.className),t?.text&&(o.textContent=t.text),t?.html&&(o.innerHTML=t.html),t?.attrs)for(let[s,r]of Object.entries(t.attrs))o.setAttribute(s,r);if(t?.style&&Object.assign(o.style,t.style),n)for(let s of n)o.appendChild(s);return o}function Ee(e,t=16){let n=document.createElementNS("http://www.w3.org/2000/svg","svg");n.setAttribute("width",String(t)),n.setAttribute("height",String(t)),n.setAttribute("viewBox","0 0 24 24"),n.setAttribute("fill","none"),n.setAttribute("stroke","currentColor"),n.setAttribute("stroke-width","2"),n.setAttribute("stroke-linecap","round"),n.setAttribute("stroke-linejoin","round");let o=document.createElementNS("http://www.w3.org/2000/svg","path");return o.setAttribute("d",e),n.appendChild(o),n}var he={settings:"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",folder:"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",plus:"M5 12h14 M12 5v14",search:"m21 21-4.3-4.3 M19 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",chevronRight:"m9 18 6-6-6-6",chevronDown:"m6 9 6 6 6-6",x:"M18 6 6 18 M6 6l12 12",check:"M20 6 9 17l-5-5",play:"M6 3v18l15-9z",pause:"M6 4h4v16H6z M14 4h4v16h-4z",trash:"M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",edit:"M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z",refresh:"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16 M3 21v-5h5",cpu:"M4 4h16v16H4z M9 9h6v6H9z M9 1v3 M15 1v3 M9 20v3 M15 20v3 M1 9h3 M1 15h3 M20 9h3 M20 15h3",zap:"M13 2 3 14h9l-1 8 10-12h-9l1-8z",message:"M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",clock:"M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2",puzzle:"M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z",book:"M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20",file:"M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z M14 2v6h6",terminal:"m4 17 6-6-6-6 M12 19h8",brain:"M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z M12 5v13 M15 13a4.5 4.5 0 0 1-3-4 M9 13a4.5 4.5 0 0 0 3-4"},wc=`
  :host {
    all: initial;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 14px;
    color: #1a1a2e;
  }
  * { box-sizing: border-box; }
  .studio-ui-root > * { pointer-events: auto; }
  .studio-sidebar, .studio-right-sidebar, .studio-input-bar,
  .studio-modal-overlay, .studio-skills-overlay, .studio-right-toggle {
    pointer-events: auto;
  }
  .studio-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    background: #fff;
    color: #333;
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
    user-select: none;
  }
  .studio-btn:hover { background: #f5f5f5; border-color: #ccc; }
  .studio-btn.primary { background: #4D6BFE; color: #fff; border-color: #4D6BFE; }
  .studio-btn.primary:hover { background: #3a58e8; }
  .studio-btn.danger { color: #e53935; border-color: #ffcdd2; }
  .studio-btn.danger:hover { background: #ffebee; }
  .studio-btn.sm { padding: 4px 8px; font-size: 12px; }
  .studio-input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }
  .studio-input:focus { border-color: #4D6BFE; }
  .studio-modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0,0,0,0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2147483645;
  }
  .studio-modal {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    max-width: 90vw;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .studio-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid #f0f0f0;
  }
  .studio-modal-title { font-size: 16px; font-weight: 600; margin: 0; }
  .studio-modal-body { padding: 20px; overflow-y: auto; flex: 1; }
  .studio-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid #f0f0f0;
  }
  .studio-close-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 4px;
    color: #666;
  }
  .studio-close-btn:hover { background: #f0f0f0; }
  .studio-tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid #f0f0f0;
    margin-bottom: 16px;
  }
  .studio-tab {
    padding: 8px 16px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 13px;
    color: #666;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .studio-tab.active { color: #4D6BFE; border-bottom-color: #4D6BFE; font-weight: 500; }
  .studio-form-group { margin-bottom: 16px; }
  .studio-form-label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: #333; }
  .studio-form-hint { font-size: 12px; color: #999; margin-top: 4px; }
  .studio-list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .studio-list-item:hover { background: #f5f7ff; }
  .studio-list-item.active { background: #eef1ff; }
  .studio-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
  }
  .studio-badge.success { background: #e8f5e9; color: #2e7d32; }
  .studio-badge.warning { background: #fff3e0; color: #e65100; }
  .studio-badge.error { background: #ffebee; color: #c62828; }
  .studio-badge.info { background: #e3f2fd; color: #1565c0; }
  .studio-switch {
    position: relative;
    width: 36px;
    height: 20px;
    background: #ccc;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .studio-switch.on { background: #4D6BFE; }
  .studio-switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.2s;
  }
  .studio-switch.on::after { transform: translateX(16px); }
`;function ts(){return{async:!1,breaks:!1,extensions:null,gfm:!0,hooks:null,pedantic:!1,renderer:null,silent:!1,tokenizer:null,walkTokens:null}}var Kt=ts();function Ii(e){Kt=e}var Yt={exec:()=>null};function sn(e){let t=[];return n=>{let o=Math.max(0,Math.min(3,n-1)),s=t[o];return s||(s=e(o),t[o]=s),s}}function se(e,t=""){let n=typeof e=="string"?e:e.source,o={replace:(s,r)=>{let i=typeof r=="string"?r:r.source;return i=i.replace(Pe.caret,"$1"),n=n.replace(s,i),o},getRegex:()=>new RegExp(n,t)};return o}var Bc=((e="")=>{try{return!!new RegExp("(?<=1)(?<!1)"+e)}catch{return!1}})(),Pe={codeRemoveIndent:/^(?: {0,3}\t| {1,4})/gm,outputLinkReplace:/\\([\[\]])/g,indentCodeCompensation:/^(\s+)(?:```)/,beginningSpace:/^\s+/,endingHash:/#$/,startingSpaceChar:/^ /,endingSpaceChar:/ $/,endingSpaceTabChar:/[ \t]$/,nonSpaceChar:/[^ ]/,newLineCharGlobal:/\n/g,tabCharGlobal:/\t/g,leadingSpaceTab:/^[ \t]+/,multipleSpaceGlobal:/\s+/g,blankLine:/^[ \t]*$/,doubleBlankLine:/\n[ \t]*\n[ \t]*$/,blockquoteStart:/^ {0,3}>/,blockquoteSetextReplace:/\n {0,3}((?:=+|-+) *)(?=\n|$)/g,blockquoteSetextReplace2:/^ {0,3}>[ \t]?/gm,listReplaceNesting:/^ {1,4}(?=( {4})*[^ ])/g,listIsTask:/^\[[ xX]\] +\S/,listReplaceTask:/^\[[ xX]\] +/,listTaskCheckbox:/\[[ xX]\]/,anyLine:/\n.*\n/,hrefBrackets:/^<(.*)>$/,tableDelimiter:/[:|]/,tableAlignChars:/^\||\| *$/g,tableRowBlankLine:/\n[ \t]*$/,tableAlignRight:/^ *-+: *$/,tableAlignCenter:/^ *:-+: *$/,tableAlignLeft:/^ *:-+ *$/,startATag:/^<a /i,endATag:/^<\/a>/i,startPreScriptTag:/^<(pre|code|kbd|script)(\s|>)/i,endPreScriptTag:/^<\/(pre|code|kbd|script)(\s|>)/i,startAngleBracket:/^</,endAngleBracket:/>$/,pedanticHrefTitle:/^([^'"]*[^\s])\s+(['"])(.*)\2/,unicodeAlphaNumeric:/[\p{L}\p{N}]/u,numericCharacterReference:/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,numericCharacterReferenceOrAmpersand:/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,escapeTest:/[&<>"']/,escapeReplace:/[&<>"']/g,escapeTestNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,escapeReplaceNoEncode:/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,caret:/(^|[^\[])\^/g,percentDecode:/%25/g,findPipe:/\|/g,splitPipe:/ \|/,slashPipe:/\\\|/g,carriageReturn:/\r\n|\r/g,spaceLine:/^ +$/gm,notSpaceStart:/^\S*/,endingNewline:/\n$/,listItemRegex:e=>new RegExp(`^( {0,3}${e})((?:[	 ][^\\n]*)?(?:\\n|$))`),nextBulletRegex:sn(e=>new RegExp(`^ {0,${e}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)),hrRegex:sn(e=>new RegExp(`^ {0,${e}}((?:-[ 	]*){3,}|(?:_[ 	]*){3,}|(?:\\*[ 	]*){3,})(?:\\n+|$)`)),fencesBeginRegex:sn(e=>new RegExp(`^ {0,${e}}(?:\`\`\`|~~~)`)),headingBeginRegex:sn(e=>new RegExp(`^ {0,${e}}#`)),htmlBeginRegex:sn(e=>new RegExp(`^ {0,${e}}(?:</?(?:${vn})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,"i")),blockquoteBeginRegex:sn(e=>new RegExp(`^ {0,${e}}>`))},vc=/^(?:[ \t]*(?:\n|$))+/,Qc=/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,Sc=/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/,Bn=/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,Tc=/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,ns=/ {0,3}(?:[*+-]|\d{1,9}[.)])/,yi=/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/,Ei=se(yi).replace(/bull/g,ns).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}(?:\s|$)/).replace(/hr/g,/ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/\|table/g,"").getRegex(),Dc=se(yi).replace(/bull/g,ns).replace(/blockCode/g,/(?: {4}| {0,3}\t)/).replace(/fences/g,/ {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g,/ {0,3}>/).replace(/heading/g,/ {0,3}#{1,6}(?:\s|$)/).replace(/hr/g,/ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/).replace(/html/g,/ {0,3}<[^\n>]+>\n/).replace(/table/g,/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),os=/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/,Rc=/^[^\n]+/,ss=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/,Nc=se(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label",ss).replace("title",/(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex(),Mc=se(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g,ns).getRegex(),vn="address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul",rs=/<!--(?:-?>|[\s\S]*?(?:-->|$))/,Lc=se("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))","i").replace("comment",rs).replace("tag",vn).replace("attribute",/ +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),bi=e=>se(os).replace("hr",Bn).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("|table","").replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list",e).replace("html"," {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag",vn).getRegex(),_c=bi(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/),Fc=bi(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/),Uc=se(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph",Fc).getRegex(),is={blockquote:Uc,code:Qc,def:Nc,fences:Sc,heading:Tc,hr:Bn,html:Lc,lheading:Ei,list:Mc,newline:vc,paragraph:_c,table:Yt,text:Rc},ci=se("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr",Bn).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("blockquote"," {0,3}>").replace("code","(?: {4}| {0,3}	)[^\\n]").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list"," {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html"," {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag",vn).getRegex(),Hc={...is,lheading:Dc,table:ci,paragraph:se(os).replace("hr",Bn).replace("heading"," {0,3}#{1,6}(?:\\s|$)").replace("|lheading","").replace("table",ci).replace("blockquote"," {0,3}>").replace("fences"," {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)").replace("list"," {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html"," {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)").replace("tag",vn).getRegex()},Oc={...is,html:se(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment",rs).replace(/tag/g,"(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(),def:/^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/,heading:/^(#{1,6})(.*)(?:\n+|$)/,fences:Yt,lheading:/^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/,paragraph:se(os).replace("hr",Bn).replace("heading",` *#{1,6} *[^
]`).replace("lheading",Ei).replace("|table","").replace("blockquote"," {0,3}>").replace("|fences","").replace("|list","").replace("|html","").replace("|tag","").getRegex()},Pc=/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,Gc=/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,xi=/^( {2,}|\\)\n(?!\s*$)[ \t]*/,Yc=/^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,Ct=/[\p{P}\p{S}]/u,rn=/[\s\p{P}\p{S}]/u,Qn=/[^\s\p{P}\p{S}]/u,$c=se(/^((?![*_])punctSpace)/,"u").replace(/punctSpace/g,rn).getRegex(),zc=/[\p{Pi}\p{Ps}"']/u,ki=/(?!~)[\p{P}\p{S}]/u,Kc=/(?!~)[\s\p{P}\p{S}]/u,qc=/(?:[^\s\p{P}\p{S}]|~)/u,jc=se(/link|precode-code|html/,"g").replace("link",/\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-",Bc?"(?<!`)()":"(^^|[^`])").replace("code",/(?<b>`+)[^`]+\k<b>(?!`)/).replace("html",/<(?! )[^<>]*?>/).getRegex(),wi=/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,Jc=se(wi,"u").replace(/punct/g,Ct).getRegex(),Wc=se(wi,"u").replace(/punct/g,ki).getRegex(),Xc=/^(?:\*+(?:((?!\*)(?!openQuote)punct)|([^\s*]))?)|^_+(?:((?!_)(?!openQuote)punct)|([^\s_]))?/,Zc=se(Xc,"u").replace(/openQuote/g,zc).replace(/punct/g,Ct).getRegex(),Bi="^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",Vc=se(Bi,"gu").replace(/notPunctSpace/g,Qn).replace(/punctSpace/g,rn).replace(/punct/g,Ct).getRegex(),ed=se(Bi,"gu").replace(/notPunctSpace/g,qc).replace(/punctSpace/g,Kc).replace(/punct/g,ki).getRegex(),td="^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)",nd=se(td,"gu").replace(/notPunctSpace/g,Qn).replace(/punctSpace/g,rn).replace(/punct/g,Ct).getRegex(),od=se("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)","gu").replace(/notPunctSpace/g,Qn).replace(/punctSpace/g,rn).replace(/punct/g,Ct).getRegex(),sd="^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)",rd=se(sd,"gu").replace(/notPunctSpace/g,Qn).replace(/punctSpace/g,rn).replace(/punct/g,Ct).getRegex(),id=se(/^~~?(?:((?!~)punct)|[^\s~])/,"u").replace(/punct/g,Ct).getRegex(),ad="^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",ld=se(ad,"gu").replace(/notPunctSpace/g,Qn).replace(/punctSpace/g,rn).replace(/punct/g,Ct).getRegex(),cd=se(/\\(punct)/,"gu").replace(/punct/g,Ct).getRegex(),dd=se(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,"gu").replace(/punct/g,Ct).getRegex(),Ad=se(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme",/[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email",/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex(),ud=se(rs).replace("(?:-->|$)","-->").getRegex(),pd=se("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment",ud).replace("attribute",/\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex(),vi=/\[(?:\\[\s\S]|[^\[\]\\])*\]/,to=se(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets",vi).getRegex(),gd=se(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/).replace("label",to).replace("href",/<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/).replace("title",/"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex(),fd=se(/^!?\[(label)\]\[(ref)\]/).replace("label",to).replace("ref",ss).getRegex(),md=se(/^!?\[(ref)\](?:\[\])?/).replace("ref",ss).getRegex(),di=/(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/,hd=se(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets",vi).getRegex(),Cd=se("reflink|nolink(?!\\()","g").replace("reflink",se(/^!?\[(label)\]\[(ref)\]/).replace("label",hd).replace("ref",di).getRegex()).replace("nolink",se(/^!?\[(ref)\](?:\[\])?/).replace("ref",di).getRegex()).getRegex(),Ai=/[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,Id=/[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,yd=se(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g,Id).getRegex(),as={_backpedal:Yt,anyPunctuation:cd,anyPunctuationOutsideCode:dd,autolink:Ad,blockSkip:jc,br:xi,code:Gc,del:Yt,delLDelim:Yt,delRDelim:Yt,emStrongLDelim:Jc,emStrongRDelimAst:Vc,emStrongRDelimUnd:od,escape:Pc,link:gd,nolink:md,punctuation:$c,reflink:fd,reflinkSearch:Cd,tag:pd,text:Yc,url:Yt},Ed={...as,emStrongLDelim:Zc,emStrongRDelimAst:nd,emStrongRDelimUnd:rd,link:se(/^!?\[(label)\]\((.*?)\)/).replace("label",to).getRegex(),reflink:se(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label",to).getRegex()},Vo={...as,emStrongRDelimAst:ed,emStrongLDelim:Wc,delLDelim:id,delRDelim:ld,url:se(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("emailProtocol",yd).replace("protocol",Ai).replace("email",/[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).getRegex(),_backpedal:/(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,del:/^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,text:se(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/).replace("protocol",Ai).replace(/emailProtocol/g,/(?:mailto|xmpp):/).getRegex()},bd={...Vo,br:se(xi).replace("{2,}","*").getRegex(),text:se(Vo.text).replace("\\b_","\\b_| {2,}\\n").replace(/\{2,\}/g,"*").getRegex()},Vn={normal:is,gfm:Hc,pedantic:Oc},kn={normal:as,gfm:Vo,breaks:bd,pedantic:Ed},xd={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"},ui=e=>xd[e];function tt(e,t){if(t){if(Pe.escapeTest.test(e))return e.replace(Pe.escapeReplace,ui)}else if(Pe.escapeTestNoEncode.test(e))return e.replace(Pe.escapeReplaceNoEncode,ui);return e}function kd(e){return Pe.numericCharacterReference.test(e)?e.replace(Pe.numericCharacterReferenceOrAmpersand,(t,n,o)=>{if(n===void 0&&o===void 0)return"&amp;";let s=n===void 0?Number.parseInt(o,16):Number.parseInt(n,10);return s===0||s>1114111||s>=55296&&s<=57343?"\uFFFD":s===38?"&amp;":String.fromCodePoint(s)}):e}function pi(e){try{e=encodeURI(e).replace(Pe.percentDecode,"%")}catch{return null}return e}function gi(e,t){let n=e.replace(Pe.findPipe,(r,i,a)=>{let d=!1,l=i;for(;--l>=0&&a[l]==="\\";)d=!d;return d?"|":" |"}),o=n.split(Pe.splitPipe),s=0;if(o[0].trim()||o.shift(),o.length>0&&!o.at(-1)?.trim()&&o.pop(),t)if(o.length>t)o.splice(t);else for(;o.length<t;)o.push("");for(;s<o.length;s++)o[s]=o[s].trim().replace(Pe.slashPipe,"|");return o}function Qt(e,t,n){let o=e.length;if(o===0)return"";let s=0;for(;s<o;){let r=e.charAt(o-s-1);if(r===t&&!n)s++;else if(r!==t&&n)s++;else break}return e.slice(0,o-s)}function fi(e){let t=e.split(`
`),n=t.length-1;for(;n>=0&&Pe.blankLine.test(t[n]);)n--;return t.length-n<=2?e:t.slice(0,n+1).join(`
`)}function no(e){return e.trim().toLowerCase().toUpperCase().toLowerCase()}function mi(e,t){if(e.indexOf(t[0])===-1&&e.indexOf(t[1])===-1)return-1;let n=0;for(let o=0;o<e.length;o++)if(e[o]==="\\")o++;else if(e[o]===t[0])n++;else if(e[o]===t[1]&&(n--,n<0))return o;return n>0?-2:-1}function Zo(e,t=0){let n=t,o="";for(let s of e)if(s==="	"){let r=4-n%4;o+=" ".repeat(r),n+=r}else o+=s,n++;return o}function hi(e,t,n,o,s){let r=t.href,i=t.title||null,a=e[1].replace(s.other.outputLinkReplace,"$1"),d=e[0].charAt(0)==="!",l=o.state.inLink,A=o.state.linkEmitted,u=o.state.inRawBlock;o.state.inLink=!0,o.state.linkEmitted=!1;let x=o.inlineTokens(a),m=o.state.linkEmitted;if(o.state.linkEmitted=A,o.state.inLink=l,!d){if(m){o.state.inRawBlock=u;return}o.state.linkEmitted=!0}return{type:d?"image":"link",raw:n,href:r,title:i,text:a,tokens:x}}function wd(e,t,n){let o=e.match(n.other.indentCodeCompensation);if(o===null)return t;let s=o[1];return t.split(`
`).map(r=>{let i=r.match(n.other.beginningSpace);if(i===null)return r;let[a]=i;return r.slice(Math.min(a.length,s.length))}).join(`
`)}function Ci(e,t,n,o){if(!t.includes("<"))return!1;for(let s=0;s<t.length;s++){if(t[s]==="\\"){s++;continue}if(t[s]==="`"){let a=o.inline.code.exec(t.slice(s));if(a){s+=a[0].length-1;continue}}if(t[s]!=="<")continue;let r=e.slice(n+s),i=o.inline.tag.exec(r)||o.inline.autolink.exec(r);if(i){if(i[0].length>t.length-s)return!0;s+=i[0].length-1}}return!1}var oo=class{constructor(e){ce(this,"options");ce(this,"rules");ce(this,"lexer");this.options=e||Kt}space(e){let t=this.rules.block.newline.exec(e);if(t&&t[0].length>0)return{type:"space",raw:t[0]}}code(e){let t=this.rules.block.code.exec(e);if(t){let n=this.options.pedantic?t[0]:fi(t[0]),o=n.replace(this.rules.other.codeRemoveIndent,"");return{type:"code",raw:n,codeBlockStyle:"indented",text:o}}}fences(e){let t=this.rules.block.fences.exec(e);if(t){let n=t[0],o=wd(n,t[3]||"",this.rules);return{type:"code",raw:n,lang:t[2]?t[2].trim().replace(this.rules.inline.anyPunctuation,"$1"):t[2],text:o}}}heading(e){let t=this.rules.block.heading.exec(e);if(t){let n=t[2].trim();if(this.rules.other.endingHash.test(n)){let o=Qt(n,"#");(this.options.pedantic||!o||this.rules.other.endingSpaceTabChar.test(o))&&(n=o.trim())}return{type:"heading",raw:Qt(t[0],`
`),depth:t[1].length,text:n,tokens:this.lexer.inline(n)}}}hr(e){let t=this.rules.block.hr.exec(e);if(t)return{type:"hr",raw:Qt(t[0],`
`)}}blockquote(e){let t=this.rules.block.blockquote.exec(e);if(t){let n=Qt(t[0],`
`).split(`
`),o="",s="",r=[];for(;n.length>0;){let i=!1,a=[],d;for(d=0;d<n.length;d++)if(this.rules.other.blockquoteStart.test(n[d]))a.push(n[d]),i=!0;else if(!i)a.push(n[d]);else break;n=n.slice(d);let l=a.join(`
`),A=l.replace(this.rules.other.blockquoteSetextReplace,`
    $1`).replace(this.rules.other.blockquoteSetextReplace2,"");o=o?`${o}
${l}`:l,s=s?`${s}
${A}`:A;let u=this.lexer.state.top;if(this.lexer.state.top=!0,this.lexer.blockTokens(A,r,!0),this.lexer.state.top=u,n.length===0)break;let x=r.at(-1);if(x?.type==="code"||x?.type==="heading"||x?.type==="hr"||x?.type==="html")break;if(x?.type==="blockquote"){let m=x,C=n.join(`
`),b=m.raw+`
`+C.replace(this.rules.other.blockquoteSetextReplace2,""),_=this.blockquote(b);r[r.length-1]=_;let S=b.substring(_.raw.length).replace(/^\n/,""),h=S?S.split(`
`).length:0,R=h?n.slice(0,-h):n;R.length>0&&(o=`${o}
${R.join(`
`)}`),s=s.substring(0,s.length-m.text.length)+_.text;break}else if(x?.type==="list"){let m=x,C=m.raw+`
`+n.join(`
`),b=this.list(C);r[r.length-1]=b,o=o.substring(0,o.length-x.raw.length)+b.raw,s=s.substring(0,s.length-m.raw.length)+b.raw,n=C.substring(r.at(-1).raw.length).split(`
`);continue}}return{type:"blockquote",raw:o,tokens:r,text:s}}}list(e){let t=this.rules.block.list.exec(e);if(t){let n=e,o=()=>n.length-e.length,s=t[1].trim(),r=s.length>1,i={type:"list",raw:"",ordered:r,start:r?+s.slice(0,-1):"",loose:!1,items:[]};s=r?`\\d{1,9}\\${s.slice(-1)}`:`\\${s}`,this.options.pedantic&&(s=r?s:"[*+-]");let a=this.rules.other.listItemRegex(s),d=!1;for(;e;){let A=!1,u="";if(!(t=a.exec(e))||this.rules.block.hr.test(e))break;let x=o();e=e.substring(t[0].length);let m=t[2].split(`
`,1)[0],C=t[1].length,b=this.options.pedantic?Zo(m,C):m.replace(this.rules.other.leadingSpaceTab,T=>Zo(T,C)),_=e.split(`
`,1)[0],S=!b.trim(),h=0;if(this.options.pedantic?(h=2,u=b.trimStart()):S?h=C+1:(h=b.search(this.rules.other.nonSpaceChar),h=h>4?1:h,u=b.slice(h),h+=C),S&&this.rules.other.blankLine.test(_)&&(e=e.substring(_.length+1),A=!0),!A){let T=this.rules.other.nextBulletRegex(h),B=this.rules.other.hrRegex(h),z=this.rules.other.fencesBeginRegex(h),M=this.rules.other.headingBeginRegex(h),N=this.rules.other.htmlBeginRegex(h),I=this.rules.other.blockquoteBeginRegex(h);for(;e;){let P=e.split(`
`,1)[0],L;if(_=P,this.options.pedantic?(_=_.replace(this.rules.other.listReplaceNesting,"  "),L=_):L=_.replace(this.rules.other.leadingSpaceTab,K=>Zo(K)),z.test(_)||M.test(_)||N.test(_)||I.test(_)||T.test(_)||B.test(_))break;if(L.search(this.rules.other.nonSpaceChar)>=h||!_.trim())u+=`
`+L.slice(h);else{if(S||b.replace(this.rules.other.tabCharGlobal,"    ").search(this.rules.other.nonSpaceChar)>=4||z.test(b)||M.test(b)||B.test(b))break;u+=`
`+_}S=!_.trim(),e=e.substring(P.length+1),b=L.slice(h)}}let R=n.slice(x,o());i.loose||(d?i.loose=!0:this.rules.other.doubleBlankLine.test(R)&&(d=!0)),i.items.push({type:"list_item",raw:R,task:!!this.options.gfm&&this.rules.other.listIsTask.test(u),loose:!1,text:u,tokens:[]})}let l=i.items.at(-1);if(l)l.raw=l.raw.trimEnd(),l.text=l.text.trimEnd();else return;i.raw=n.slice(0,o()).trimEnd();for(let A of i.items)if(this.lexer.state.top=!1,A.tokens=this.lexer.blockTokens(A.text,[]),!i.loose){let u=A.tokens.filter(m=>m.type==="space"),x=u.length>0&&u.some(m=>this.rules.other.anyLine.test(m.raw));i.loose=x}for(let A of i.items){let u=A.tokens[0];if(A.task&&(u?.type==="text"||u?.type==="paragraph")){A.text=A.text.replace(this.rules.other.listReplaceTask,""),u.raw=u.raw.replace(this.rules.other.listReplaceTask,""),u.text=u.text.replace(this.rules.other.listReplaceTask,"");for(let m=this.lexer.inlineQueue.length-1;m>=0;m--)if(this.rules.other.listIsTask.test(this.lexer.inlineQueue[m].src)){this.lexer.inlineQueue[m].src=this.lexer.inlineQueue[m].src.replace(this.rules.other.listReplaceTask,"");break}let x=this.rules.other.listTaskCheckbox.exec(A.raw);if(x){let m={type:"checkbox",raw:x[0]+" ",checked:x[0]!=="[ ]"};A.checked=m.checked,i.loose?A.tokens[0]&&["paragraph","text"].includes(A.tokens[0].type)&&"tokens"in A.tokens[0]&&A.tokens[0].tokens?(A.tokens[0].raw=m.raw+A.tokens[0].raw,A.tokens[0].text=m.raw+A.tokens[0].text,A.tokens[0].tokens.unshift(m)):A.tokens.unshift({type:"paragraph",raw:m.raw,text:m.raw,tokens:[m]}):A.tokens.unshift(m)}}else A.task&&(A.task=!1)}if(i.loose)for(let A of i.items){A.loose=!0;for(let u of A.tokens)u.type==="text"&&(u.type="paragraph")}return i}}html(e){let t=this.rules.block.html.exec(e);if(t){let n=fi(t[0]);return{type:"html",block:!0,raw:n,pre:t[1]==="pre"||t[1]==="script"||t[1]==="style",text:n}}}def(e){let t=this.rules.block.def.exec(e);if(t){if(!this.rules.other.startAngleBracket.test(t[2])&&mi(t[2],"()")!==-1)return;let n=no(t[1]).replace(this.rules.other.multipleSpaceGlobal," "),o=t[2]?t[2].replace(this.rules.other.hrefBrackets,"$1").replace(this.rules.inline.anyPunctuation,"$1"):"",s=t[3]?t[3].substring(1,t[3].length-1).replace(this.rules.inline.anyPunctuation,"$1"):t[3];return{type:"def",tag:n,raw:Qt(t[0],`
`),href:o,title:s}}}table(e){let t=this.rules.block.table.exec(e);if(!t||!this.rules.other.tableDelimiter.test(t[2]))return;let n=gi(t[1]),o=t[2].replace(this.rules.other.tableAlignChars,"").split("|"),s=t[3]?.trim()?t[3].replace(this.rules.other.tableRowBlankLine,"").split(`
`):[],r={type:"table",raw:Qt(t[0],`
`),header:[],align:[],rows:[]};if(n.length===o.length){for(let i of o)this.rules.other.tableAlignRight.test(i)?r.align.push("right"):this.rules.other.tableAlignCenter.test(i)?r.align.push("center"):this.rules.other.tableAlignLeft.test(i)?r.align.push("left"):r.align.push(null);for(let i=0;i<n.length;i++)r.header.push({text:n[i],tokens:this.lexer.inline(n[i]),header:!0,align:r.align[i]});for(let i of s)r.rows.push(gi(i,r.header.length).map((a,d)=>({text:a,tokens:this.lexer.inline(a),header:!1,align:r.align[d]})));return r}}lheading(e){let t=this.rules.block.lheading.exec(e);if(t){let n=t[1].trim();return{type:"heading",raw:Qt(t[0],`
`),depth:t[2].charAt(0)==="="?1:2,text:n,tokens:this.lexer.inline(n)}}}paragraph(e){let t=this.rules.block.paragraph.exec(e);if(t){let n=t[1].charAt(t[1].length-1)===`
`?t[1].slice(0,-1):t[1];return{type:"paragraph",raw:t[0],text:n,tokens:this.lexer.inline(n)}}}text(e){let t=this.rules.block.text.exec(e);if(t)return{type:"text",raw:t[0],text:t[0],tokens:this.lexer.inline(t[0])}}escape(e){let t=this.rules.inline.escape.exec(e);if(t)return{type:"escape",raw:t[0],text:t[1]}}tag(e){let t=this.rules.inline.tag.exec(e);if(t)return!this.lexer.state.inLink&&this.rules.other.startATag.test(t[0])?this.lexer.state.inLink=!0:this.lexer.state.inLink&&this.rules.other.endATag.test(t[0])&&(this.lexer.state.inLink=!1),!this.lexer.state.inRawBlock&&this.rules.other.startPreScriptTag.test(t[0])?this.lexer.state.inRawBlock=!0:this.lexer.state.inRawBlock&&this.rules.other.endPreScriptTag.test(t[0])&&(this.lexer.state.inRawBlock=!1),{type:"html",raw:t[0],inLink:this.lexer.state.inLink,inRawBlock:this.lexer.state.inRawBlock,block:!1,text:t[0]}}link(e){if(this.lexer.state.linkParenPossible===!1)return;let t=this.rules.inline.link.exec(e);if(t){let n=t[0].charAt(0)==="!"?2:1;if(!this.options.pedantic&&Ci(e,t[1],n,this.rules))return;let o=t[2].trim();if(!this.options.pedantic&&this.rules.other.startAngleBracket.test(o)){if(!this.rules.other.endAngleBracket.test(o))return;let i=Qt(o.slice(0,-1),"\\");if((o.length-i.length)%2===0)return}else{let i=mi(t[2],"()");if(i===-2)return;if(i>-1){let a=(t[0].indexOf("!")===0?5:4)+t[1].length+i;t[2]=t[2].substring(0,i),t[0]=t[0].substring(0,a).trim(),t[3]=""}}let s=t[2],r="";if(this.options.pedantic){let i=this.rules.other.pedanticHrefTitle.exec(s);i&&(s=i[1],r=i[3])}else r=t[3]?t[3].slice(1,-1):"";return s=s.trim(),this.rules.other.startAngleBracket.test(s)&&(this.options.pedantic&&!this.rules.other.endAngleBracket.test(o)?s=s.slice(1):s=s.slice(1,-1)),hi(t,{href:s&&s.replace(this.rules.inline.anyPunctuation,"$1"),title:r&&r.replace(this.rules.inline.anyPunctuation,"$1")},t[0],this.lexer,this.rules)}}reflink(e,t){let n;if((n=this.rules.inline.reflink.exec(e))||(n=this.rules.inline.nolink.exec(e))){let o=n[0].charAt(0)==="!"?2:1;if(!this.options.pedantic&&Ci(e,n[1],o,this.rules))return;let s=(n[2]||n[1]).replace(this.rules.other.multipleSpaceGlobal," "),r=t[no(s)];if(!r){let i=n[0].charAt(0);return{type:"text",raw:i,text:i}}return hi(n,r,n[0],this.lexer,this.rules)}}emStrong(e,t,n=""){let o=this.rules.inline.emStrongLDelim.exec(e);if(!(!o||!o[1]&&!o[2]&&!o[3]&&!o[4]||o[4]&&n.match(this.rules.other.unicodeAlphaNumeric))&&(!(o[1]||o[3])||!n||this.rules.inline.punctuation.exec(n))){let s=[...o[0]].length-1,r,i,a=s,d=0,l=o[0][0],A=n===l,u=l==="*"?this.rules.inline.emStrongRDelimAst:this.rules.inline.emStrongRDelimUnd;for(u.lastIndex=0,t=t.slice(-1*e.length+s);(o=u.exec(t))!==null;){if(r=o[1]||o[2]||o[3]||o[4]||o[5]||o[6],!r)continue;if(i=[...r].length,o[3]||o[4]){a+=i;continue}else if(o[5]||o[6]){if(s%3&&!((s+i)%3)){d+=i;continue}if(A)break}if(a-=i,a>0)continue;i=Math.min(i,i+a+d);let x=[...o[0]][0].length,m=e.slice(0,s+o.index+x+i);if(Math.min(s,i)%2){let b=m.slice(1,-1);return{type:"em",raw:m,text:b,tokens:this.lexer.inlineTokens(b)}}let C=m.slice(2,-2);return{type:"strong",raw:m,text:C,tokens:this.lexer.inlineTokens(C)}}}}codespan(e){let t=this.rules.inline.code.exec(e);if(t){let n=t[2].replace(this.rules.other.newLineCharGlobal," "),o=this.rules.other.nonSpaceChar.test(n),s=this.rules.other.startingSpaceChar.test(n)&&this.rules.other.endingSpaceChar.test(n);return o&&s&&(n=n.substring(1,n.length-1)),{type:"codespan",raw:t[0],text:n}}}br(e){let t=this.rules.inline.br.exec(e);if(t)return{type:"br",raw:t[0]}}del(e,t,n=""){let o=this.rules.inline.delLDelim.exec(e);if(o&&(!o[1]||!n||this.rules.inline.punctuation.exec(n))){let s=[...o[0]].length-1,r,i,a=s,d=this.rules.inline.delRDelim;for(d.lastIndex=0,t=t.slice(-1*e.length+s);(o=d.exec(t))!==null;){if(r=o[1]||o[2]||o[3]||o[4]||o[5]||o[6],!r||(i=[...r].length,i!==s))continue;if(o[3]||o[4]){a+=i;continue}if(a-=i,a>0)continue;i=Math.min(i,i+a);let l=[...o[0]][0].length,A=e.slice(0,s+o.index+l+i),u=A.slice(s,-s);return{type:"del",raw:A,text:u,tokens:this.lexer.inlineTokens(u)}}}}autolink(e){let t=this.rules.inline.autolink.exec(e);if(t){let n,o;return t[2]==="@"?(n=t[1],o="mailto:"+n):(n=t[1],o=n),{type:"link",raw:t[0],text:n,href:o,autolink:!0,tokens:[{type:"text",raw:n,text:n}]}}}url(e){let t;if(t=this.rules.inline.url.exec(e)){let n,o;if(t[2]==="@")n=t[0],o="mailto:"+n;else{let s;do s=t[0],t[0]=this.rules.inline._backpedal.exec(t[0])?.[0]??"";while(s!==t[0]);n=t[0],t[1]==="www."?o="http://"+t[0]:o=t[0]}return{type:"link",raw:t[0],text:n,href:o,autolink:!0,tokens:[{type:"text",raw:n,text:n}]}}}inlineText(e){let t=this.rules.inline.text.exec(e);if(t){let n=this.lexer.state.inRawBlock;return{type:"text",raw:t[0],text:n?t[0]:kd(t[0]),escaped:n}}}},ro,Qi,$t,lt=($t=class{constructor(t){Ks(this,ro);ce(this,"tokens");ce(this,"options");ce(this,"state");ce(this,"inlineQueue");ce(this,"tokenizer");this.tokens=[],this.tokens.links=Object.create(null),this.options=t||Kt,this.options.tokenizer=this.options.tokenizer||new oo,this.tokenizer=this.options.tokenizer,this.tokenizer.options=this.options,this.tokenizer.lexer=this,this.inlineQueue=[],this.state={inLink:!1,inRawBlock:!1,linkEmitted:!1,linkParenPossible:!0,top:!0};let n={other:Pe,block:Vn.normal,inline:kn.normal};this.options.pedantic?(n.block=Vn.pedantic,n.inline=kn.pedantic):this.options.gfm&&(n.block=Vn.gfm,this.options.breaks?n.inline=kn.breaks:n.inline=kn.gfm),this.tokenizer.rules=n}static get rules(){return{block:Vn,inline:kn}}static lex(t,n){return new $t(n).lex(t)}static lexInline(t,n){return new $t(n).inlineTokens(t)}lex(t){t=t.replace(Pe.carriageReturn,`
`),this.blockTokens(t,this.tokens);for(let n=0;n<this.inlineQueue.length;n++){let o=this.inlineQueue[n];this.inlineTokens(o.src,o.tokens)}return this.inlineQueue=[],this.tokens}blockTokens(t,n=[],o=!1){this.tokenizer.lexer=this,this.options.pedantic&&(t=t.replace(Pe.tabCharGlobal,"    ").replace(Pe.spaceLine,""));let s=1/0;for(;t;){if(t.length<s)s=t.length;else{this.infiniteLoopError(t.charCodeAt(0));break}let r;if(this.options.extensions?.block?.some(a=>(r=a.call({lexer:this},t,n))?(t=t.substring(r.raw.length),n.push(r),!0):!1))continue;if(r=this.tokenizer.space(t)){t=t.substring(r.raw.length);let a=n.at(-1);r.raw.length===1&&a!==void 0?a.raw+=`
`:n.push(r);continue}if(r=this.tokenizer.code(t)){t=t.substring(r.raw.length);let a=n.at(-1);a?.type==="paragraph"||a?.type==="text"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+r.raw,a.text+=`
`+r.text,this.inlineQueue.at(-1).src=a.text):n.push(r);continue}if(r=this.tokenizer.fences(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.heading(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.hr(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.blockquote(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.list(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.html(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.def(t)){t=t.substring(r.raw.length);let a=n.at(-1);a?.type==="paragraph"||a?.type==="text"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+r.raw,a.text+=`
`+r.raw,this.inlineQueue.at(-1).src=a.text):this.tokens.links[r.tag]||(this.tokens.links[r.tag]={href:r.href,title:r.title},n.push(r));continue}if(r=this.tokenizer.table(t)){t=t.substring(r.raw.length),n.push(r);continue}if(r=this.tokenizer.lheading(t)){t=t.substring(r.raw.length),n.push(r);continue}let i=t;if(this.options.extensions?.startBlock){let a=1/0,d=t.slice(1),l;this.options.extensions.startBlock.forEach(A=>{l=A.call({lexer:this},d),typeof l=="number"&&l>=0&&(a=Math.min(a,l))}),a<1/0&&a>=0&&(i=t.substring(0,a+1))}if(this.state.top&&(r=this.tokenizer.paragraph(i))){let a=n.at(-1);o&&a?.type==="paragraph"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+r.raw,a.text+=`
`+r.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=a.text):n.push(r),o=i.length!==t.length,t=t.substring(r.raw.length);continue}if(r=this.tokenizer.text(t)){t=t.substring(r.raw.length);let a=n.at(-1);a?.type==="text"?(a.raw+=(a.raw.endsWith(`
`)?"":`
`)+r.raw,a.text+=`
`+r.text,this.inlineQueue.pop(),this.inlineQueue.at(-1).src=a.text):n.push(r);continue}if(t){this.infiniteLoopError(t.charCodeAt(0));break}}return this.state.top=!0,n}inline(t,n=[]){return this.inlineQueue.push({src:t,tokens:n}),n}linkInText(t){if(!t.includes("["))return!1;let n=this.tokenizer.rules.inline.link;for(let o of t.matchAll(this.tokenizer.rules.inline.blockSkip))if(n.test(o[0])&&t.charAt(o.index-1)!=="!")return!0;for(let o of t.matchAll(this.tokenizer.rules.inline.reflinkSearch)){let s=o[0],r=s.lastIndexOf("[");if(!(s.charAt(0)==="!"||!Object.hasOwn(this.tokens.links,no(s.slice(r+1,-1))))&&!(r>1&&this.linkInText(s.slice(1,r-1))))return!0}return!1}inlineTokens(t,n=[]){this.tokenizer.lexer=this;let o=this.state.linkParenPossible;this.state.linkParenPossible=o&&t.includes(")");try{return qs(this,ro,Qi).call(this,t,n)}finally{this.state.linkParenPossible=o}}infiniteLoopError(t){let n="Infinite loop on byte: "+t;if(this.options.silent)console.error(n);else throw new Error(n)}},ro=new WeakSet,Qi=function(t,n){let o=t;if(this.tokens.links&&t.includes("[")){let a=this.tokenizer.rules.inline.reflinkSearch,d=l=>{let A=l.lastIndexOf("[");if(!Object.hasOwn(this.tokens.links,no(l.slice(A+1,-1))))return l;if(A>1&&l.charAt(0)!=="!"){let u=l.slice(1,A-1);if(this.linkInText(u))return"["+u.replace(a,d)+"]["+"a".repeat(l.length-A-2)+"]"}return"["+"a".repeat(l.length-2)+"]"};o=o.replace(a,d)}o=o.replace(this.tokenizer.rules.inline.anyPunctuationOutsideCode,(a,d,l)=>l?"+".repeat(a.length):d?d+a.slice(d.length,-d.length).replace(/`/g,"+")+d:a),o=o.replace(this.tokenizer.rules.inline.blockSkip,(a,d,l)=>{let A=l?l.length:0;return a.slice(0,A)+"["+"a".repeat(a.length-A-2)+"]"}),o=this.options.hooks?.emStrongMask?.call({lexer:this},o)??o;let s=!1,r="",i=1/0;for(;t;){if(t.length<i)i=t.length;else{this.infiniteLoopError(t.charCodeAt(0));break}s||(r=""),s=!1;let a;if(this.options.extensions?.inline?.some(l=>(a=l.call({lexer:this},t,n))?(t=t.substring(a.raw.length),n.push(a),!0):!1))continue;if(a=this.tokenizer.escape(t)){t=t.substring(a.raw.length),n.push(a);continue}if(a=this.tokenizer.tag(t)){t=t.substring(a.raw.length),n.push(a);continue}if(a=this.tokenizer.link(t)){t=t.substring(a.raw.length),n.push(a);continue}if(a=this.tokenizer.reflink(t,this.tokens.links)){t=t.substring(a.raw.length);let l=n.at(-1);a.type==="text"&&l?.type==="text"?(l.raw+=a.raw,l.text+=a.text):n.push(a);continue}if(a=this.tokenizer.emStrong(t,o,r)){t=t.substring(a.raw.length),n.push(a);continue}if(a=this.tokenizer.codespan(t)){t=t.substring(a.raw.length),n.push(a);continue}if(a=this.tokenizer.br(t)){t=t.substring(a.raw.length),n.push(a);continue}if(a=this.tokenizer.del(t,o,r)){t=t.substring(a.raw.length),n.push(a);continue}if(a=this.tokenizer.autolink(t)){t=t.substring(a.raw.length),n.push(a);continue}if(!this.state.inLink&&(a=this.tokenizer.url(t))){t=t.substring(a.raw.length),n.push(a);continue}let d=t;if(this.options.extensions?.startInline){let l=1/0,A=t.slice(1),u;this.options.extensions.startInline.forEach(x=>{u=x.call({lexer:this},A),typeof u=="number"&&u>=0&&(l=Math.min(l,u))}),l<1/0&&l>=0&&(d=t.substring(0,l+1))}if(a=this.tokenizer.inlineText(d)){t=t.substring(a.raw.length),a.raw.slice(-1)!=="_"&&(r=a.raw.slice(-1)),s=!0;let l=n.at(-1);l?.type==="text"?(l.raw+=a.raw,l.text+=a.text):n.push(a);continue}if(t){this.infiniteLoopError(t.charCodeAt(0));break}}return n},$t),so=class{constructor(e){ce(this,"options");ce(this,"parser");this.options=e||Kt}space(e){return""}code({text:e,lang:t,escaped:n}){let o=(t||"").match(Pe.notSpaceStart)?.[0],s=e?e.replace(Pe.endingNewline,"")+`
`:"";return o?'<pre><code class="language-'+tt(o)+'">'+(n?s:tt(s,!0))+`</code></pre>
`:"<pre><code>"+(n?s:tt(s,!0))+`</code></pre>
`}blockquote({tokens:e}){return`<blockquote>
${this.parser.parse(e)}</blockquote>
`}html({text:e}){return e}def(e){return""}heading({tokens:e,depth:t}){return`<h${t}>${this.parser.parseInline(e)}</h${t}>
`}hr(e){return`<hr>
`}list(e){let t=e.ordered,n=e.start,o="";for(let i=0;i<e.items.length;i++){let a=e.items[i];o+=this.listitem(a)}let s=t?"ol":"ul",r=t&&n!==1?' start="'+n+'"':"";return"<"+s+r+`>
`+o+"</"+s+`>
`}listitem(e){return`<li>${this.parser.parse(e.tokens)}</li>
`}checkbox({checked:e}){return"<input "+(e?'checked="" ':"")+'disabled="" type="checkbox"> '}paragraph({tokens:e}){return`<p>${this.parser.parseInline(e)}</p>
`}table(e){let t="",n="";for(let s=0;s<e.header.length;s++)n+=this.tablecell(e.header[s]);t+=this.tablerow({text:n});let o="";for(let s=0;s<e.rows.length;s++){let r=e.rows[s];n="";for(let i=0;i<r.length;i++)n+=this.tablecell(r[i]);o+=this.tablerow({text:n})}return o&&(o=`<tbody>${o}</tbody>`),`<table>
<thead>
`+t+`</thead>
`+o+`</table>
`}tablerow({text:e}){return`<tr>
${e}</tr>
`}tablecell(e){let t=this.parser.parseInline(e.tokens),n=e.header?"th":"td";return(e.align?`<${n} align="${e.align}">`:`<${n}>`)+t+`</${n}>
`}strong({tokens:e}){return`<strong>${this.parser.parseInline(e)}</strong>`}em({tokens:e}){return`<em>${this.parser.parseInline(e)}</em>`}codespan({text:e}){return`<code>${tt(e,!0)}</code>`}br(e){return"<br>"}del({tokens:e}){return`<del>${this.parser.parseInline(e)}</del>`}link({href:e,title:t,text:n,tokens:o,autolink:s}){let r=s?tt(n,!0):this.parser.parseInline(o),i=pi(e);if(i===null)return r;e=tt(i,s);let a='<a href="'+e+'"';return t&&(a+=' title="'+tt(t)+'"'),a+=">"+r+"</a>",a}image({href:e,title:t,text:n,tokens:o}){o&&(n=this.parser.parseInline(o,this.parser.textRenderer));let s=pi(e);if(s===null)return tt(n);e=s;let r=`<img src="${tt(e)}" alt="${tt(n)}"`;return t&&(r+=` title="${tt(t)}"`),r+=">",r}text(e){return"tokens"in e&&e.tokens?this.parser.parseInline(e.tokens):"escaped"in e&&e.escaped?e.text:tt(e.text)}},ls=class{strong({text:e}){return e}em({text:e}){return e}codespan({text:e}){return e}del({text:e}){return e}html({text:e}){return e}text({text:e}){return e}link({text:e}){return""+e}image({text:e}){return""+e}br(){return""}checkbox({raw:e}){return e}},ct=class es{constructor(t){ce(this,"options");ce(this,"renderer");ce(this,"textRenderer");this.options=t||Kt,this.options.renderer=this.options.renderer||new so,this.renderer=this.options.renderer,this.renderer.options=this.options,this.renderer.parser=this,this.textRenderer=new ls}static parse(t,n){return new es(n).parse(t)}static parseInline(t,n){return new es(n).parseInline(t)}parse(t){this.renderer.parser=this;let n="";for(let o=0;o<t.length;o++){let s=t[o];if(this.options.extensions?.renderers?.[s.type]){let i=s,a=this.options.extensions.renderers[i.type].call({parser:this},i);if(a!==!1||!["space","hr","heading","code","table","blockquote","list","checkbox","html","def","paragraph","text"].includes(i.type)){n+=a||"";continue}}let r=s;switch(r.type){case"space":{n+=this.renderer.space(r);break}case"hr":{n+=this.renderer.hr(r);break}case"heading":{n+=this.renderer.heading(r);break}case"code":{n+=this.renderer.code(r);break}case"table":{n+=this.renderer.table(r);break}case"blockquote":{n+=this.renderer.blockquote(r);break}case"list":{n+=this.renderer.list(r);break}case"checkbox":{n+=this.renderer.checkbox(r);break}case"html":{n+=this.renderer.html(r);break}case"def":{n+=this.renderer.def(r);break}case"paragraph":{n+=this.renderer.paragraph(r);break}case"text":{n+=this.renderer.text(r);break}default:{let i='Token with "'+r.type+'" type was not found.';if(this.options.silent)return console.error(i),"";throw new Error(i)}}}return n}parseInline(t,n=this.renderer){this.renderer.parser=this;let o="";for(let s=0;s<t.length;s++){let r=t[s];if(this.options.extensions?.renderers?.[r.type]){let a=this.options.extensions.renderers[r.type].call({parser:this},r);if(a!==!1||!["escape","html","link","image","checkbox","strong","em","codespan","br","del","text"].includes(r.type)){o+=a||"";continue}}let i=r;switch(i.type){case"escape":{o+=n.text(i);break}case"html":{o+=n.html(i);break}case"link":{o+=n.link(i);break}case"image":{o+=n.image(i);break}case"checkbox":{o+=n.checkbox(i);break}case"strong":{o+=n.strong(i);break}case"em":{o+=n.em(i);break}case"codespan":{o+=n.codespan(i);break}case"br":{o+=n.br(i);break}case"del":{o+=n.del(i);break}case"text":{o+=n.text(i);break}default:{let a='Token with "'+i.type+'" type was not found.';if(this.options.silent)return console.error(a),"";throw new Error(a)}}}return o}},eo,wn=(eo=class{constructor(e){ce(this,"options");ce(this,"block");this.options=e||Kt}preprocess(e){return e}postprocess(e){return e}processAllTokens(e){return e}emStrongMask(e){return e}provideLexer(e=this.block){return e?lt.lex:lt.lexInline}provideParser(e=this.block){return e?ct.parse:ct.parseInline}},ce(eo,"passThroughHooks",new Set(["preprocess","postprocess","processAllTokens","emStrongMask"])),ce(eo,"passThroughHooksRespectAsync",new Set(["preprocess","postprocess","processAllTokens"])),eo);function Gt(e,t){if(Array.isArray(t))for(let n=0;n<t.length;n++)e.push(t[n]);else e.push(t)}var Bd=class{constructor(...e){ce(this,"defaults",ts());ce(this,"options",this.setOptions);ce(this,"parse",this.parseMarkdown(!0));ce(this,"parseInline",this.parseMarkdown(!1));ce(this,"Parser",ct);ce(this,"Renderer",so);ce(this,"TextRenderer",ls);ce(this,"Lexer",lt);ce(this,"Tokenizer",oo);ce(this,"Hooks",wn);this.use(...e)}walkTokens(e,t){let n=[];for(let o of e)switch(Gt(n,t.call(this,o)),o.type){case"table":{let s=o;for(let r of s.header)Gt(n,this.walkTokens(r.tokens,t));for(let r of s.rows)for(let i of r)Gt(n,this.walkTokens(i.tokens,t));break}case"list":{let s=o;Gt(n,this.walkTokens(s.items,t));break}default:{let s=o;this.defaults.extensions?.childTokens?.[s.type]?this.defaults.extensions.childTokens[s.type].forEach(r=>{let i=s[r].flat(1/0);Gt(n,this.walkTokens(i,t))}):s.tokens&&Gt(n,this.walkTokens(s.tokens,t))}}return n}use(...e){let t=this.defaults.extensions||{renderers:{},childTokens:{}};return e.forEach(n=>{let o={...n};if(o.async=this.defaults.async||o.async||!1,n.extensions&&(n.extensions.forEach(s=>{if(!s.name)throw new Error("extension name required");if("renderer"in s){let r=t.renderers[s.name];r?t.renderers[s.name]=function(...i){let a=s.renderer.apply(this,i);return a===!1&&(a=r.apply(this,i)),a}:t.renderers[s.name]=s.renderer}if("tokenizer"in s){if(!s.level||s.level!=="block"&&s.level!=="inline")throw new Error("extension level must be 'block' or 'inline'");let r=t[s.level];r?r.unshift(s.tokenizer):t[s.level]=[s.tokenizer],s.start&&(s.level==="block"?t.startBlock?t.startBlock.push(s.start):t.startBlock=[s.start]:s.level==="inline"&&(t.startInline?t.startInline.push(s.start):t.startInline=[s.start]))}"childTokens"in s&&s.childTokens&&(t.childTokens[s.name]=s.childTokens)}),o.extensions=t),n.renderer){let s=this.defaults.renderer||new so(this.defaults);for(let r in n.renderer){if(!(r in s))throw new Error(`renderer '${r}' does not exist`);if(["options","parser"].includes(r))continue;let i=r,a=n.renderer[i],d=s[i];s[i]=(...l)=>{let A=a.apply(s,l);return A===!1&&(A=d.apply(s,l)),A||""}}o.renderer=s}if(n.tokenizer){let s=this.defaults.tokenizer||new oo(this.defaults);for(let r in n.tokenizer){if(!(r in s))throw new Error(`tokenizer '${r}' does not exist`);if(["options","rules","lexer"].includes(r))continue;let i=r,a=n.tokenizer[i],d=s[i];s[i]=(...l)=>{let A=a.apply(s,l);return A===!1&&(A=d.apply(s,l)),A}}o.tokenizer=s}if(n.hooks){let s=this.defaults.hooks||new wn;for(let r in n.hooks){if(!(r in s))throw new Error(`hook '${r}' does not exist`);if(["options","block"].includes(r))continue;let i=r,a=n.hooks[i],d=s[i];wn.passThroughHooks.has(r)?s[i]=l=>{if(this.defaults.async&&wn.passThroughHooksRespectAsync.has(r))return(async()=>{let u=await a.call(s,l);return d.call(s,u)})();let A=a.call(s,l);return d.call(s,A)}:s[i]=(...l)=>{if(this.defaults.async)return(async()=>{let u=await a.apply(s,l);return u===!1&&(u=await d.apply(s,l)),u})();let A=a.apply(s,l);return A===!1&&(A=d.apply(s,l)),A}}o.hooks=s}if(n.walkTokens){let s=this.defaults.walkTokens,r=n.walkTokens;o.walkTokens=function(i){let a=[];return a.push(r.call(this,i)),s&&Gt(a,s.call(this,i)),a}}this.defaults={...this.defaults,...o}}),this}setOptions(e){return this.defaults={...this.defaults,...e},this}lexer(e,t){return lt.lex(e,t??this.defaults)}parser(e,t){return ct.parse(e,t??this.defaults)}parseMarkdown(e){return(t,n)=>{let o={...n},s={...this.defaults,...o},r=this.onError(!!s.silent,!!s.async);if(this.defaults.async===!0&&o.async===!1)return r(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));if(typeof t>"u"||t===null)return r(new Error("marked(): input parameter is undefined or null"));if(typeof t!="string")return r(new Error("marked(): input parameter is of type "+Object.prototype.toString.call(t)+", string expected"));if(s.hooks&&(s.hooks.options=s,s.hooks.block=e),s.async)return(async()=>{let i=s.hooks?await s.hooks.preprocess(t):t,a=await(s.hooks?await s.hooks.provideLexer(e):e?lt.lex:lt.lexInline)(i,s),d=s.hooks?await s.hooks.processAllTokens(a):a;s.walkTokens&&await Promise.all(this.walkTokens(d,s.walkTokens));let l=await(s.hooks?await s.hooks.provideParser(e):e?ct.parse:ct.parseInline)(d,s);return s.hooks?await s.hooks.postprocess(l):l})().catch(r);try{s.hooks&&(t=s.hooks.preprocess(t));let i=(s.hooks?s.hooks.provideLexer(e):e?lt.lex:lt.lexInline)(t,s);s.hooks&&(i=s.hooks.processAllTokens(i)),s.walkTokens&&this.walkTokens(i,s.walkTokens);let a=(s.hooks?s.hooks.provideParser(e):e?ct.parse:ct.parseInline)(i,s);return s.hooks&&(a=s.hooks.postprocess(a)),a}catch(i){return r(i)}}}onError(e,t){return n=>{if(n.message+=`
Please report this to https://github.com/markedjs/marked.`,e){let o="<p>An error occurred:</p><pre>"+tt(n.message+"",!0)+"</pre>";return t?Promise.resolve(o):o}if(t)return Promise.reject(n);throw n}}},zt=new Bd;function xe(e,t){return zt.parse(e,t)}xe.options=xe.setOptions=function(e){return zt.setOptions(e),xe.defaults=zt.defaults,Ii(xe.defaults),xe};xe.getDefaults=ts;xe.defaults=Kt;function vd(...e){return zt.use(...e),xe.defaults=zt.defaults,Ii(xe.defaults),xe}xe.use=vd;xe.walkTokens=function(e,t){return zt.walkTokens(e,t)};xe.parseInline=zt.parseInline;xe.Parser=ct;xe.parser=ct.parse;xe.Renderer=so;xe.TextRenderer=ls;xe.Lexer=lt;xe.lexer=lt.lex;xe.Tokenizer=oo;xe.Hooks=wn;xe.parse=xe;var gp=xe.options,fp=xe.setOptions,mp=xe.walkTokens,hp=xe.parseInline;var Cp=ct.parse,Ip=lt.lex;function Qd(e,t){this.v=e,this.k=t}function Si(e,t){(t==null||t>e.length)&&(t=e.length);for(var n=0,o=Array(t);n<t;n++)o[n]=e[n];return o}function Sd(e){if(Array.isArray(e))return e}function Td(e,t){var n=e==null?null:typeof Symbol<"u"&&e[Symbol.iterator]||e["@@iterator"];if(n!=null){var o,s,r,i,a=[],d=!0,l=!1;try{if(r=(n=n.call(e)).next,t===0){if(Object(n)!==n)return;d=!1}else for(;!(d=(o=r.call(n)).done)&&(a.push(o.value),a.length!==t);d=!0);}catch(A){l=!0,s=A}finally{try{if(!d&&n.return!=null&&(i=n.return(),Object(i)!==i))return}finally{if(l)throw s}}return a}}function Dd(){throw new TypeError(`Invalid attempt to destructure non-iterable instance.
In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function Rd(e,t){return Sd(e)||Td(e,t)||Nd(e,t)||Dd()}function Nd(e,t){if(e){if(typeof e=="string")return Si(e,t);var n={}.toString.call(e).slice(8,-1);return n==="Object"&&e.constructor&&(n=e.constructor.name),n==="Map"||n==="Set"?Array.from(e):n==="Arguments"||/^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)?Si(e,t):void 0}}function io(e){var t,n;function o(r,i){try{var a=e[r](i),d=a.value,l=d instanceof Qd;Promise.resolve(l?d.v:d).then(function(A){if(l){var u=r==="return"&&d.k?r:"next";if(!d.k||A.done)return o(u,A);A=e[u](A).value}s(!!a.done,A)},function(A){o("throw",A)})}catch(A){s(2,A)}}function s(r,i){r===2?t.reject(i):t.resolve({value:i,done:r}),(t=t.next)?o(t.key,t.arg):n=null}this._invoke=function(r,i){return new Promise(function(a,d){var l={key:r,arg:i,resolve:a,reject:d,next:null};n?n=n.next=l:(t=n=l,o(r,i))})},typeof e.return!="function"&&(this.return=void 0)}io.prototype[typeof Symbol=="function"&&Symbol.asyncIterator||"@@asyncIterator"]=function(){return this},io.prototype.next=function(e){return this._invoke("next",e)},io.prototype.throw=function(e){return this._invoke("throw",e)},io.prototype.return=function(e){return this._invoke("return",e)};var $i=Object.entries,Ti=Object.setPrototypeOf,Md=Object.isFrozen,zi=Object.getPrototypeOf,Ki=Object.getOwnPropertyDescriptor,Ge=Object.freeze,Ke=Object.seal,an=Object.create,qi=typeof Reflect<"u"&&Reflect,Cs=qi.apply,Is=qi.construct;Ge||(Ge=function(t){return t});Ke||(Ke=function(t){return t});Cs||(Cs=function(t,n){for(var o=arguments.length,s=new Array(o>2?o-2:0),r=2;r<o;r++)s[r-2]=arguments[r];return t.apply(n,s)});Is||(Is=function(t){for(var n=arguments.length,o=new Array(n>1?n-1:0),s=1;s<n;s++)o[s-1]=arguments[s];return new t(...o)});var bt=Se(Array.prototype.forEach);Array.prototype.indexOf;var Ld=Se(Array.prototype.lastIndexOf),Di=Se(Array.prototype.pop),Sn=Se(Array.prototype.push),_d=Se(Array.prototype.slice),Fd=Se(Array.prototype.splice),ln=Array.isArray,cs=ji(Set),ds=Se(Set.prototype.add),Tn=Se(Set.prototype.has),qt=Se(String.prototype.toLowerCase),As=Se(String.prototype.toString),Ri=Se(String.prototype.match),Dn=Se(String.prototype.replace),Ni=Se(String.prototype.indexOf),Ud=Se(String.prototype.trim),Hd=Se(Number.prototype.toString),Od=Se(Boolean.prototype.toString),Mi=typeof BigInt>"u"?null:Se(BigInt.prototype.toString),Li=typeof Symbol>"u"?null:Se(Symbol.prototype.toString),Ve=Se(Object.prototype.hasOwnProperty),Rn=Se(Object.prototype.toString),ze=Se(RegExp.prototype.test),xt=ji(TypeError);function Se(e){return function(t){t instanceof RegExp&&(t.lastIndex=0);for(var n=arguments.length,o=new Array(n>1?n-1:0),s=1;s<n;s++)o[s-1]=arguments[s];return Cs(e,t,o)}}function ji(e){return function(){for(var t=arguments.length,n=new Array(t),o=0;o<t;o++)n[o]=arguments[o];return Is(e,n)}}function Ce(e,t){let n=arguments.length>2&&arguments[2]!==void 0?arguments[2]:qt;if(Ti&&Ti(e,null),!ln(t))return e;let o=t.length;for(;o--;){let s=t[o];if(typeof s=="string"){let r=n(s);r!==s&&(Md(t)||(t[o]=r),s=r)}e[s]=!0}return e}function Pd(e){for(let t=0;t<e.length;t++)Ve(e,t)||(e[t]=null);return e}function nt(e){let t=an(null);for(let o of $i(e)){var n=Rd(o,2);let s=n[0],r=n[1];Ve(e,s)&&(ln(r)?t[s]=Pd(r):r&&typeof r=="object"&&r.constructor===Object?t[s]=nt(r):t[s]=r)}return t}function Gd(e){switch(typeof e){case"string":return e;case"number":return Hd(e);case"boolean":return Od(e);case"bigint":return Mi?Mi(e):"0";case"symbol":return Li?Li(e):"Symbol()";case"undefined":return Rn(e);case"function":case"object":{if(e===null)return Rn(e);let t=e,n=st(t,"toString");if(typeof n=="function"){let o=n(t);return typeof o=="string"?o:Rn(o)}return Rn(e)}default:return Rn(e)}}function st(e,t){for(;e!==null;){let o=Ki(e,t);if(o){if(o.get)return Se(o.get);if(typeof o.value=="function")return Se(o.value)}e=zi(e)}function n(){return null}return n}function Yd(e,t){for(;e!==null;){let n=Ki(e,t);if(n)return n.get?Se(n.get):null;e=zi(e)}return null}function $d(e){try{return ze(e,""),!0}catch{return!1}}var _i=Ge(["a","abbr","acronym","address","area","article","aside","audio","b","bdi","bdo","big","blink","blockquote","body","br","button","canvas","caption","center","cite","code","col","colgroup","content","data","datalist","dd","decorator","del","details","dfn","dialog","dir","div","dl","dt","element","em","fieldset","figcaption","figure","font","footer","form","h1","h2","h3","h4","h5","h6","head","header","hgroup","hr","html","i","img","input","ins","kbd","label","legend","li","main","map","mark","marquee","menu","menuitem","meter","nav","nobr","ol","optgroup","option","output","p","picture","pre","progress","q","rp","rt","ruby","s","samp","search","section","select","shadow","slot","small","source","spacer","span","strike","strong","style","sub","summary","sup","table","tbody","td","template","textarea","tfoot","th","thead","time","tr","track","tt","u","ul","var","video","wbr"]),us=Ge(["svg","a","altglyph","altglyphdef","altglyphitem","animatecolor","animatemotion","animatetransform","circle","clippath","defs","desc","ellipse","enterkeyhint","exportparts","filter","font","g","glyph","glyphref","hkern","image","inputmode","line","lineargradient","marker","mask","metadata","mpath","part","path","pattern","polygon","polyline","radialgradient","rect","stop","style","switch","symbol","text","textpath","title","tref","tspan","view","vkern"]),ps=Ge(["feBlend","feColorMatrix","feComponentTransfer","feComposite","feConvolveMatrix","feDiffuseLighting","feDisplacementMap","feDistantLight","feDropShadow","feFlood","feFuncA","feFuncB","feFuncG","feFuncR","feGaussianBlur","feImage","feMerge","feMergeNode","feMorphology","feOffset","fePointLight","feSpecularLighting","feSpotLight","feTile","feTurbulence"]),zd=Ge(["animate","color-profile","cursor","discard","font-face","font-face-format","font-face-name","font-face-src","font-face-uri","foreignobject","hatch","hatchpath","mesh","meshgradient","meshpatch","meshrow","missing-glyph","script","set","solidcolor","unknown","use"]),gs=Ge(["math","menclose","merror","mfenced","mfrac","mglyph","mi","mlabeledtr","mmultiscripts","mn","mo","mover","mpadded","mphantom","mroot","mrow","ms","mspace","msqrt","mstyle","msub","msup","msubsup","mtable","mtd","mtext","mtr","munder","munderover","mprescripts"]),Kd=Ge(["maction","maligngroup","malignmark","mlongdiv","mscarries","mscarry","msgroup","mstack","msline","msrow","semantics","annotation","annotation-xml","mprescripts","none"]),Fi=Ge(["#text"]),Ui=Ge(["accept","action","align","alt","autocapitalize","autocomplete","autopictureinpicture","autoplay","background","bgcolor","border","capture","cellpadding","cellspacing","checked","cite","class","clear","color","cols","colspan","command","commandfor","controls","controlslist","coords","crossorigin","datetime","decoding","default","dir","disabled","disablepictureinpicture","disableremoteplayback","download","draggable","enctype","enterkeyhint","exportparts","face","for","headers","height","hidden","high","href","hreflang","id","inert","inputmode","integrity","ismap","kind","label","lang","list","loading","loop","low","max","maxlength","media","method","min","minlength","multiple","muted","name","nonce","noshade","novalidate","nowrap","open","optimum","part","pattern","placeholder","playsinline","popover","popovertarget","popovertargetaction","poster","preload","pubdate","radiogroup","readonly","rel","required","rev","reversed","role","rows","rowspan","spellcheck","scope","selected","shape","size","sizes","slot","span","srclang","start","src","srcset","step","style","summary","tabindex","title","translate","type","usemap","valign","value","width","wrap","xmlns"]),fs=Ge(["accent-height","accumulate","additive","alignment-baseline","amplitude","ascent","attributename","attributetype","azimuth","basefrequency","baseline-shift","begin","bias","by","class","clip","clippathunits","clip-path","clip-rule","color","color-interpolation","color-interpolation-filters","color-profile","color-rendering","cx","cy","d","dx","dy","diffuseconstant","direction","display","divisor","dominant-baseline","dur","edgemode","elevation","end","exponent","fill","fill-opacity","fill-rule","filter","filterunits","flood-color","flood-opacity","font-family","font-size","font-size-adjust","font-stretch","font-style","font-variant","font-weight","fx","fy","g1","g2","glyph-name","glyphref","gradientunits","gradienttransform","height","href","id","image-rendering","in","in2","intercept","k","k1","k2","k3","k4","kerning","keypoints","keysplines","keytimes","lang","lengthadjust","letter-spacing","kernelmatrix","kernelunitlength","lighting-color","local","marker-end","marker-mid","marker-start","markerheight","markerunits","markerwidth","maskcontentunits","maskunits","max","mask","mask-type","media","method","mode","min","name","numoctaves","offset","operator","opacity","order","orient","orientation","origin","overflow","paint-order","path","pathlength","patterncontentunits","patterntransform","patternunits","pointer-events","points","preservealpha","preserveaspectratio","primitiveunits","r","rx","ry","radius","refx","refy","repeatcount","repeatdur","restart","result","rotate","scale","seed","shape-rendering","slope","specularconstant","specularexponent","spreadmethod","startoffset","stddeviation","stitchtiles","stop-color","stop-opacity","stroke-dasharray","stroke-dashoffset","stroke-linecap","stroke-linejoin","stroke-miterlimit","stroke-opacity","stroke","stroke-width","style","surfacescale","systemlanguage","tabindex","tablevalues","targetx","targety","transform","transform-origin","text-anchor","text-decoration","text-orientation","text-rendering","textlength","type","u1","u2","unicode","values","vector-effect","viewbox","visibility","version","vert-adv-y","vert-origin-x","vert-origin-y","width","word-spacing","wrap","writing-mode","xchannelselector","ychannelselector","x","x1","x2","xmlns","y","y1","y2","z","zoomandpan"]),Hi=Ge(["accent","accentunder","align","bevelled","close","columnalign","columnlines","columnspacing","columnspan","denomalign","depth","dir","display","displaystyle","encoding","fence","frame","height","href","id","largeop","length","linethickness","lquote","lspace","mathbackground","mathcolor","mathsize","mathvariant","maxsize","minsize","movablelimits","notation","numalign","open","rowalign","rowlines","rowspacing","rowspan","rspace","rquote","scriptlevel","scriptminsize","scriptsizemultiplier","selection","separator","separators","stretchy","subscriptshift","supscriptshift","symmetric","voffset","width","xmlns"]),ao=Ge(["xlink:href","xml:id","xlink:title","xml:space","xmlns:xlink"]),qd=Ke(/{{[\w\W]*|^[\w\W]*}}/g),jd=Ke(/<%[\w\W]*|^[\w\W]*%>/g),Jd=Ke(/\${[\w\W]*/g),Wd=Ke(/^data-[\-\w.\u00B7-\uFFFF]+$/),Xd=Ke(/^aria-[\-\w]+$/),Oi=Ke(/^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i),Zd=Ke(/^(?:\w+script|data):/i),Vd=Ke(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g),eA=Ke(/^html$/i),tA=Ke(/^[a-z][.\w]*(-[.\w]+)+$/i),ms=Ke(/<[/\w!]/g),Pi=Ke(/<[/\w]/g),nA=Ke(/<\/no(script|embed|frames)/i),Gi=Ke(/\/>/i),Ue={element:1,attribute:2,text:3,cdataSection:4,entityReference:5,entityNode:6,processingInstruction:7,comment:8,document:9,documentType:10,documentFragment:11,notation:12},oA=Ge(Ce({},["style","script","xmp","iframe","noembed","noframes","plaintext","noscript"])),sA=function(){return typeof window>"u"?null:window},rA=function(t,n){if(typeof t!="object"||typeof t.createPolicy!="function")return null;let o=null,s="data-tt-policy-suffix";n&&n.hasAttribute(s)&&(o=n.getAttribute(s));let r="dompurify"+(o?"#"+o:"");try{return t.createPolicy(r,{createHTML(i){return i},createScriptURL(i){return i}})}catch{return console.warn("TrustedTypes policy "+r+" could not be created."),null}},Yi=function(){return{afterSanitizeAttributes:[],afterSanitizeElements:[],afterSanitizeShadowDOM:[],beforeSanitizeAttributes:[],beforeSanitizeElements:[],beforeSanitizeShadowDOM:[],uponSanitizeAttribute:[],uponSanitizeElement:[],uponSanitizeShadowNode:[]}},St=function(t,n,o,s){return Ve(t,n)&&ln(t[n])?Ce(s.base?nt(s.base):{},t[n],s.transform):o},hs=function(t,n,o){let s=Ve(t,n)?t[n]:void 0;return s&&typeof s=="object"?nt(s):o()};function Ji(){let e=arguments.length>0&&arguments[0]!==void 0?arguments[0]:sA(),t=Q=>Ji(Q);if(t.version="3.4.17",t.removed=[],!e||!e.document||e.document.nodeType!==Ue.document||!e.Element)return t.isSupported=!1,t;let n=e.document,o=n,s=o.currentScript;e.DocumentFragment;let r=e.HTMLTemplateElement,i=e.Node,a=e.Element,d=e.NodeFilter;e.NamedNodeMap===void 0&&(e.NamedNodeMap||e.MozNamedAttrMap),e.HTMLFormElement;let l=e.DOMParser,A=e.trustedTypes,u=a.prototype,x=st(u,"cloneNode"),m=st(u,"remove"),C=st(u,"removeAttributeNode"),b=st(u,"nextSibling"),_=st(u,"childNodes"),S=st(u,"parentNode"),h=st(u,"shadowRoot"),R=st(u,"attributes"),T=i&&i.prototype?st(i.prototype,"nodeType"):null,B=i&&i.prototype?st(i.prototype,"nodeName"):null,z=i&&i.prototype?st(i.prototype,"ownerDocument"):null,M=function(c){return T?T(c):c.nodeType},N=function(c){return B?B(c):c.nodeName},I=Yd(u,"namespaceURI"),P=function(c){return I?I(c):c.namespaceURI};if(typeof r=="function"){let Q=n.createElement("template");Q.content&&Q.content.ownerDocument&&(n=Q.content.ownerDocument)}let L,K="",f,U=!1,k=0,F=function(){if(k>0)throw xt('A configured TRUSTED_TYPES_POLICY callback (createHTML or createScriptURL) must not call DOMPurify.sanitize, as that causes infinite recursion. Do not pass a policy whose callbacks wrap DOMPurify as TRUSTED_TYPES_POLICY; see the "DOMPurify and Trusted Types" section of the README.')},w=function(c){F(),k++;try{return L.createHTML(c)}finally{k--}},ae=function(c){F(),k++;try{return L.createScriptURL(c)}finally{k--}},re=function(){return U||(f=rA(A,s),U=!0),f},ue=n,le=ue.implementation,ie=ue.createNodeIterator,Ae=ue.createDocumentFragment,Me=ue.getElementsByTagName,Te=o.importNode,oe=Yi();t.isSupported=typeof $i=="function"&&typeof S=="function"&&le&&le.createHTMLDocument!==void 0;let We=qd,Ye=jd,q=Jd,W=Wd,Ie=Xd,be=Zd,ge=Vd,fe=tA,Be=Oi,H=null,Z=Ce({},[..._i,...us,...ps,...gs,...Fi]),V=null,ot=Ce({},[...Ui,...fs,...Hi,...ao]),v=Object.seal(an(null,{tagNameCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},attributeNameCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},allowCustomizedBuiltInElements:{writable:!0,configurable:!1,enumerable:!0,value:!1}})),$=null,te=null,me=Object.seal(an(null,{tagCheck:{writable:!0,configurable:!1,enumerable:!0,value:null},attributeCheck:{writable:!0,configurable:!1,enumerable:!0,value:null}})),we=!0,Ne=!0,De=!1,ve=!0,_e=!1,dt=!0,It=!1,At=!1,Dt=null,Rt=null,Nt=!1,je=!1,Mt=!1,Lt=!1,_n=!0,D=!1,O="user-content-",Y=!0,ne=!1,G=null,J={},ye=null,Fe=Ce({},["annotation-xml","audio","colgroup","desc","foreignobject","head","iframe","math","mi","mn","mo","ms","mtext","noembed","noframes","noscript","plaintext","script","selectedcontent","style","svg","template","thead","title","video","xmp"]),$e=null,ut=Ce({},["audio","video","img","source","image","track"]),dn=null,An=Ce({},["alt","class","for","id","label","name","pattern","placeholder","role","summary","title","value","style","xmlns"]),_t="http://www.w3.org/1998/Math/MathML",Fn="http://www.w3.org/2000/svg",pt="http://www.w3.org/1999/xhtml",Jt=pt,Co=!1,Io=null,Qa=Ce({},[_t,Fn,pt],As),Ss=Ge(["mi","mo","mn","ms","mtext"]),yo=Ce({},Ss),Ts=Ge(["annotation-xml"]),Eo=Ce({},Ts),Sa=Ce({},["title","style","font","a","script"]),un=null,Ta=["application/xhtml+xml","text/html"],Da="text/html",Le=null,Wt=null,Ra=n.createElement("form"),Ds=function(c){return c instanceof RegExp||c instanceof Function},bo=function(){let c=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};if(Wt&&Wt===c)return;(!c||typeof c!="object")&&(c={}),c=nt(c),un=Ta.indexOf(c.PARSER_MEDIA_TYPE)===-1?Da:c.PARSER_MEDIA_TYPE,Le=un==="application/xhtml+xml"?As:qt,H=St(c,"ALLOWED_TAGS",Z,{transform:Le}),V=St(c,"ALLOWED_ATTR",ot,{transform:Le}),Io=St(c,"ALLOWED_NAMESPACES",Qa,{transform:As}),dn=St(c,"ADD_URI_SAFE_ATTR",An,{transform:Le,base:An}),$e=St(c,"ADD_DATA_URI_TAGS",ut,{transform:Le,base:ut}),ye=St(c,"FORBID_CONTENTS",Fe,{transform:Le}),$=St(c,"FORBID_TAGS",nt({}),{transform:Le}),te=St(c,"FORBID_ATTR",nt({}),{transform:Le}),J=Ve(c,"USE_PROFILES")?c.USE_PROFILES&&typeof c.USE_PROFILES=="object"?nt(c.USE_PROFILES):c.USE_PROFILES:!1,we=c.ALLOW_ARIA_ATTR!==!1,Ne=c.ALLOW_DATA_ATTR!==!1,De=c.ALLOW_UNKNOWN_PROTOCOLS||!1,ve=c.ALLOW_SELF_CLOSE_IN_ATTR!==!1,_e=c.SAFE_FOR_TEMPLATES||!1,dt=c.SAFE_FOR_XML!==!1,It=c.WHOLE_DOCUMENT||!1,je=c.RETURN_DOM||!1,Mt=c.RETURN_DOM_FRAGMENT||!1,Lt=c.RETURN_TRUSTED_TYPE||!1,Nt=c.FORCE_BODY||!1,_n=c.SANITIZE_DOM!==!1,D=c.SANITIZE_NAMED_PROPS||!1,Y=c.KEEP_CONTENT!==!1,ne=c.IN_PLACE||!1,Be=$d(c.ALLOWED_URI_REGEXP)?c.ALLOWED_URI_REGEXP:Oi,Jt=typeof c.NAMESPACE=="string"?c.NAMESPACE:pt,yo=hs(c,"MATHML_TEXT_INTEGRATION_POINTS",()=>Ce({},Ss)),Eo=hs(c,"HTML_INTEGRATION_POINTS",()=>Ce({},Ts));let p=hs(c,"CUSTOM_ELEMENT_HANDLING",()=>an(null));if(v=an(null),Ve(p,"tagNameCheck")&&Ds(p.tagNameCheck)&&(v.tagNameCheck=p.tagNameCheck),Ve(p,"attributeNameCheck")&&Ds(p.attributeNameCheck)&&(v.attributeNameCheck=p.attributeNameCheck),Ve(p,"allowCustomizedBuiltInElements")&&typeof p.allowCustomizedBuiltInElements=="boolean"&&(v.allowCustomizedBuiltInElements=p.allowCustomizedBuiltInElements),Ke(v),_e&&(Ne=!1),Mt&&(je=!0),J&&(H=Ce({},Fi),V=an(null),J.html===!0&&(Ce(H,_i),Ce(V,Ui)),J.svg===!0&&(Ce(H,us),Ce(V,fs),Ce(V,ao)),J.svgFilters===!0&&(Ce(H,ps),Ce(V,fs),Ce(V,ao)),J.mathMl===!0&&(Ce(H,gs),Ce(V,Hi),Ce(V,ao))),me.tagCheck=null,me.attributeCheck=null,Ve(c,"ADD_TAGS")&&(typeof c.ADD_TAGS=="function"?me.tagCheck=c.ADD_TAGS:ln(c.ADD_TAGS)&&(H===Z&&(H=nt(H)),Ce(H,c.ADD_TAGS,Le))),Ve(c,"ADD_ATTR")&&(typeof c.ADD_ATTR=="function"?me.attributeCheck=c.ADD_ATTR:ln(c.ADD_ATTR)&&(V===ot&&(V=nt(V)),Ce(V,c.ADD_ATTR,Le))),Ve(c,"ADD_FORBID_CONTENTS")&&ln(c.ADD_FORBID_CONTENTS)&&(ye===Fe&&(ye=nt(ye)),Ce(ye,c.ADD_FORBID_CONTENTS,Le)),Y&&(H["#text"]=!0),It&&Ce(H,["html","head","body"]),H.table&&(Ce(H,["tbody"]),delete $.tbody),c.TRUSTED_TYPES_POLICY){if(typeof c.TRUSTED_TYPES_POLICY.createHTML!="function")throw xt('TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.');if(typeof c.TRUSTED_TYPES_POLICY.createScriptURL!="function")throw xt('TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.');let y=L;L=c.TRUSTED_TYPES_POLICY;try{K=w("")}catch(E){throw L=y,E}}else c.TRUSTED_TYPES_POLICY===null?(L=void 0,K=""):(L===void 0&&(L=re()),L&&typeof K=="string"&&(K=w("")));Ge&&Ge(c),Wt=c},Rs=Ce({},[...us,...ps,...zd]),Ns=Ce({},[...gs,...Kd]),Na=function(c,p,y){return p.namespaceURI===pt?c==="svg":p.namespaceURI===_t?c==="svg"&&(y==="annotation-xml"||yo[y]):!!Rs[c]},Ma=function(c,p,y){return p.namespaceURI===pt?c==="math":p.namespaceURI===Fn?c==="math"&&Eo[y]:!!Ns[c]},La=function(c,p,y){return p.namespaceURI===Fn&&!Eo[y]||p.namespaceURI===_t&&!yo[y]?!1:!Ns[c]&&(Sa[c]||!Rs[c])},_a=function(c){let p=P(c),y=qt(N(c)),E=S(c),j,ee;return E&&M(E)===Ue.element?(j={namespaceURI:P(E)},ee=qt(N(E))):(j={namespaceURI:Jt},ee="template"),Io[p]?p===Fn?Na(y,j,ee):p===_t?Ma(y,j,ee):p===pt?La(y,j,ee):!!(un==="application/xhtml+xml"&&Io[p]):!1},kt=function(c){Sn(t.removed,{element:c});try{S(c).removeChild(c)}catch{if(m(c),!S(c))throw xt("a node selected for removal could not be detached from its tree and cannot be safely returned; refusing to sanitize in place")}},Ms=function(c,p,y){try{C(c,p)}catch{try{c.removeAttribute(y)}catch{}}},xo=function(c){wo(c);let p=_(c);p&&bt(_d(p),E=>{try{m(E)}catch{}});let y=M(c)===Ue.element?R(c):null;if(y)for(let E=y.length-1;E>=0;--E){let j=y[E],ee=j&&j.name;typeof ee=="string"&&Ms(c,j,ee)}},Xt=function(c,p,y){if(!y)try{y=p.getAttributeNode(c)}catch{y=null}Sn(t.removed,{attribute:y||null,from:p});try{y?C(p,y):p.removeAttribute(c)}catch{try{p.removeAttribute(c)}catch{}}if(c==="is")if(je||Mt)try{kt(p)}catch{}else try{p.setAttribute(c,"")}catch{}},Ls=function(c){let p=R(c);if(p)for(let y=p.length-1;y>=0;--y){let E=p[y],j=E&&E.name;typeof j!="string"||V[Le(j)]||Ms(c,E,j)}},ko=function(c,p){let y=arguments.length>2&&arguments[2]!==void 0?arguments[2]:!1,E=[c];for(;E.length>0;){let j=E.pop();if(p(j)===!1)continue;if(y&&M(j)===Ue.element){let pe=h(j);wt(pe)&&E.push(pe)}let ee=_(j);if(ee)for(let pe=ee.length-1;pe>=0;--pe)E.push(ee[pe])}},wo=function(c){ko(c,p=>{M(p)===Ue.element&&Ls(p)})},Bo=function(c){let p=[];return ko(c,y=>{p.push(y)},!0),p},Fa=function(c,p){let y=cs();bt(Bo(c),E=>{M(E)===Ue.element&&ds(y,E)}),bt(p,E=>{M(E)===Ue.element&&!Tn(y,E)&&Ls(E)})},_s=function(c,p){let y=!1;return bt(t.removed,E=>{E.element&&(y=y||E.element===c,wo(E.element))}),Fa(c,p),y},Ua=8,Ha=function(c,p){let y=G,E=null,j=()=>(E||(E=cs(),bt(p,ee=>{ds(E,ee)})),E);for(let ee=0;;ee++){let pe=Bo(c),He=[c],gt=!1;if(bt(pe,Je=>{M(Je)===Ue.documentFragment?Sn(He,Je):!gt&&!Tn(y,Je)&&(gt=Tn(j(),Je))}),!gt)return;if(ee>=Ua)throw xt("the tree kept changing during in-place sanitization; refusing to return it");bt(He,(Je,Xe)=>{Oa(Je,Xe>0,c,j())})}},Oa=function(c,p,y,E){let j=vo(c),ee;for(;ee=j.nextNode();)!Tn(E,ee)||Tn(G,ee)||(p&&rt(oe.uponSanitizeShadowNode,ee,null),So(ee,y),To(ee,y),wt(ee.content)&&gn(ee.content))},Pa=function(c){G&&ds(G,c)},Fs=function(c,p){return dt?c==="patchsrc"?!0:c==="for"&&p!=="label"&&p!=="output":!1},Ga=function(c){dt&&ko(c,p=>{let y=M(p);if(y===Ue.processingInstruction||y===Ue.comment&&ze(Pi,p.data)){try{m(p)}catch{}return!1}if(y===Ue.element){let E=p,j=Le(N(p));try{E.hasAttribute&&E.hasAttribute("patchsrc")&&E.removeAttribute("patchsrc"),E.hasAttribute&&E.hasAttribute("for")&&Fs("for",j)&&E.removeAttribute("for")}catch{}}return!0})},Us=function(c){let p=null,y=null;if(Nt)c="<remove></remove>"+c;else{let ee=Ri(c,/^[\r\n\t ]+/);y=ee&&ee[0]}un==="application/xhtml+xml"&&Jt===pt&&(c='<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>'+c+"</body></html>");let E=L?w(c):c;if(Jt===pt)try{p=new l().parseFromString(E,un)}catch{}if(!p||!p.documentElement){p=le.createDocument(Jt,"template",null);try{p.documentElement.innerHTML=Co?K:E}catch{}}let j=p.body||p.documentElement;return c&&y&&j.insertBefore(n.createTextNode(y),j.childNodes[0]||null),Jt===pt?Me.call(p,It?"html":"body")[0]:It?p.documentElement:j},vo=function(c){let p=z?z(c):c.ownerDocument;return ie.call(p||c,c,d.SHOW_ELEMENT|d.SHOW_COMMENT|d.SHOW_TEXT|d.SHOW_PROCESSING_INSTRUCTION|d.SHOW_CDATA_SECTION,null)},Un=function(c){return c=Dn(c,We," "),c=Dn(c,Ye," "),c=Dn(c,q," "),c},Qo=function(c){var p;Hs(c);let y=(p=c.querySelectorAll)===null||p===void 0?void 0:p.call(c,"template");y&&bt(y,E=>{wt(E.content)&&Qo(E.content)})},Hs=function(c){c.normalize();let p=z?z(c):c.ownerDocument,y=ie.call(p||c,c,d.SHOW_TEXT|d.SHOW_COMMENT|d.SHOW_CDATA_SECTION|d.SHOW_PROCESSING_INSTRUCTION,null),E=y.nextNode();for(;E;)E.data=Un(E.data),E=y.nextNode()},Hn=function(c){let p=B?B(c):null;return typeof p!="string"||Le(p)!=="form"?!1:typeof c.nodeName!="string"||typeof c.textContent!="string"||typeof c.removeChild!="function"||c.attributes!==R(c)||typeof c.removeAttribute!="function"||typeof c.removeAttributeNode!="function"||typeof c.getAttributeNode!="function"||typeof c.setAttribute!="function"||typeof c.namespaceURI!="string"||typeof c.insertBefore!="function"||typeof c.hasChildNodes!="function"||c.nodeType!==T(c)||c.childNodes!==_(c)},wt=function(c){if(!T||typeof c!="object"||c===null)return!1;try{return T(c)===Ue.documentFragment}catch{return!1}},pn=function(c){if(!T||typeof c!="object"||c===null)return!1;try{return typeof T(c)=="number"}catch{return!1}};function rt(Q,c,p){Q.length!==0&&bt(Q,y=>{y.call(t,c,p,Wt)})}let Ya=function(c,p){return!!(dt&&c.hasChildNodes()&&!pn(c.firstElementChild)&&ze(ms,c.textContent)&&ze(ms,c.innerHTML)||dt&&oA[p]&&M(c)===Ue.element&&P(c)===pt&&(pn(c.firstElementChild)||typeof c.textContent=="string"&&ze(ms,c.textContent))||c.nodeType===Ue.processingInstruction||dt&&c.nodeType===Ue.comment&&ze(Pi,c.data))},On=function(c,p){if(c instanceof RegExp)return ze(c,p);if(c instanceof Function){for(var y=arguments.length,E=new Array(y>2?y-2:0),j=2;j<y;j++)E[j-2]=arguments[j];return!!c(p,...E)}return!1},$a=function(c,p,y){if(!$[p]&&Gs(p)&&On(v.tagNameCheck,p))return!1;if(Y&&!ye[p]&&!ye[qt(p)]){let E=S(c),j=_(c);if(j&&E){let ee=j.length;for(let pe=ee-1;pe>=0;--pe){let He=c===y?x(j[pe],!0):j[pe];E.insertBefore(He,b(c))}}}return kt(c),!0},Os=function(c,p,y,E){return c.length===0?p:p===y||p===E?nt(p):p},Zt=function(c,p){return c===p||S(c)!==null?!1:(ne&&wo(c),!0)},So=function(c,p){if(Pa(c),rt(oe.beforeSanitizeElements,c,null),Zt(c,p))return!0;if(Hn(c))return kt(c),!0;let y=Le(N(c));if(H=Os(oe.uponSanitizeElement,H,Z,Dt),rt(oe.uponSanitizeElement,c,{tagName:y,allowedTags:H}),Zt(c,p))return!0;if(Ya(c,y))return kt(c),!0;if($[y]||!(me.tagCheck instanceof Function&&me.tagCheck(y))&&!H[y]){let E=$a(c,y,p);return E===!1&&(rt(oe.afterSanitizeElements,c,null),Zt(c,p))?!0:E}if(M(c)===Ue.element&&!_a(c)||(y==="noscript"||y==="noembed"||y==="noframes")&&ze(nA,c.innerHTML))return kt(c),!0;if(_e&&c.nodeType===Ue.text){let E=Un(c.textContent);c.textContent!==E&&(Sn(t.removed,{element:c.cloneNode()}),c.textContent=E)}return rt(oe.afterSanitizeElements,c,null),Zt(c,p)},Ps=function(c,p,y){if(te[p]||Fs(p,c)||_n&&(p==="id"||p==="name")&&(y in n||y in Ra))return!1;let E=V[p]||me.attributeCheck instanceof Function&&me.attributeCheck(p,c);return Ne&&ze(W,p)||we&&ze(Ie,p)?!0:E?dn[p]||ze(Be,Dn(y,ge,""))||(p==="src"||p==="xlink:href"||p==="href")&&c!=="script"&&Ni(y,"data:")===0&&$e[c]||De&&!ze(be,Dn(y,ge,""))?!0:!y:Gs(c)&&On(v.tagNameCheck,c)&&On(v.attributeNameCheck,p,c)||p==="is"&&v.allowCustomizedBuiltInElements&&On(v.tagNameCheck,y)},za=Ce({},["annotation-xml","color-profile","font-face","font-face-format","font-face-name","font-face-src","font-face-uri","missing-glyph"]),Gs=function(c){return!za[qt(c)]&&ze(fe,c)},Ka=function(c,p,y,E){if(L&&typeof A=="object"&&typeof A.getAttributeType=="function"&&!y)switch(A.getAttributeType(c,p)){case"TrustedHTML":return w(E);case"TrustedScriptURL":return ae(E)}return E},qa=function(c,p,y,E){try{return y?c.setAttributeNS(y,p,E):c.setAttribute(p,E),Hn(c)?(kt(c),!1):!0}catch{return Xt(p,c),!1}},Ys=function(c,p){return dt&&ze(/((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i,p)?!0:qt(c)==="attributename"&&Ri(p,"href")!==null},To=function(c,p){if(rt(oe.beforeSanitizeAttributes,c,null),Zt(c,p))return;let y=c.attributes;if(!y||Hn(c))return;V=Os(oe.uponSanitizeAttribute,V,ot,Rt);let E={attrName:"",attrValue:"",keepAttr:!0,allowedAttributes:V,forceKeepAttr:void 0},j=y.length,ee=Le(c.nodeName);for(;j--;){let pe=y[j],He=pe.name,gt=pe.namespaceURI,Je=pe.value,Xe=Le(He),Vt=Je,Ze=He==="value"?Vt:Ud(Vt),$s=!1;if(E.attrName=Xe,E.attrValue=Ze,E.keepAttr=!0,E.forceKeepAttr=void 0,rt(oe.uponSanitizeAttribute,c,E),Ze=E.attrValue,D&&(Xe==="id"||Xe==="name")&&Ni(Ze,O)!==0&&(Xt(He,c,pe),Ze=O+Ze,$s=!0),Ys(He,Ze)){Xt(He,c,pe);continue}if(!E.forceKeepAttr){if(!E.keepAttr){Xt(He,c,pe);continue}if(!ve&&ze(Gi,Ze)){Xt(He,c,pe);continue}if(_e&&(Ze=Un(Ze)),!Ps(ee,Xe,Ze)){Xt(He,c,pe);continue}Ze=Ka(ee,Xe,gt,Ze),Ze!==Vt&&qa(c,He,gt,Ze)&&$s&&Di(t.removed)}}rt(oe.afterSanitizeAttributes,c,null),Zt(c,p)},gn=function(c){let p=null,y=vo(c);for(rt(oe.beforeSanitizeShadowDOM,c,null);p=y.nextNode();)if(rt(oe.uponSanitizeShadowNode,p,null),So(p,c),To(p,c),wt(p.content)&&gn(p.content),M(p)===Ue.element){let E=h(p);wt(E)&&(Do(E),gn(E))}_e&&Hs(c),rt(oe.afterSanitizeShadowDOM,c,null)},Do=function(c){let p=[{node:c,shadow:null}];for(;p.length>0;){let y=p.pop();if(y.shadow){gn(y.shadow);continue}let E=y.node,j=M(E)===Ue.element,ee=_(E);if(ee)for(let pe=ee.length-1;pe>=0;--pe)p.push({node:ee[pe],shadow:null});if(j){let pe=B?B(E):null;if(typeof pe=="string"&&Le(pe)==="template"){let He=E.content;wt(He)&&p.push({node:He,shadow:null})}}if(j){let pe=h(E);wt(pe)&&p.push({node:null,shadow:pe},{node:pe,shadow:null})}}};return t.sanitize=function(Q){let c=arguments.length>1&&arguments[1]!==void 0?arguments[1]:{},p=null,y=null,E=null,j=null;if(Co=!Q,Co&&(Q="<!-->"),typeof Q!="string"&&!pn(Q)&&(Q=Gd(Q),typeof Q!="string"))throw xt("dirty is not a string, aborting");if(!t.isSupported)return Q;At?(H=Dt,V=Rt):bo(c),(oe.uponSanitizeElement.length>0||oe.uponSanitizeAttribute.length>0)&&(H=nt(H)),oe.uponSanitizeAttribute.length>0&&(V=nt(V)),t.removed=[];let ee=ne&&typeof Q!="string"&&pn(Q),pe=[],He=G;if(ee){Ga(Q);let Xe=N(Q);if(typeof Xe=="string"){let Vt=Le(Xe);if(!H[Vt]||$[Vt])throw xo(Q),xt("root node is forbidden and cannot be sanitized in-place")}if(Hn(Q))throw xo(Q),xt("root node is clobbered and cannot be sanitized in-place");pe=Bo(Q),G=cs()}else if(pn(Q))p=Us("<!---->"),y=p.ownerDocument.importNode(Q,!0),y.nodeType===Ue.element&&y.nodeName==="BODY"||y.nodeName==="HTML"?p=y:p.appendChild(y),Do(p);else{if(!je&&!_e&&!It&&Q.indexOf("<")===-1)return L&&Lt?w(Q):Q;if(p=Us(Q),!p)return je?null:Lt?K:""}p&&Nt&&kt(p.firstChild);let gt=ee?Q:p;try{ee&&Do(Q);let Xe=vo(gt);for(;E=Xe.nextNode();)So(E,gt),To(E,gt),wt(E.content)&&gn(E.content);ee&&Ha(Q,pe)}catch(Xe){throw ee&&(xo(Q),_s(Q,pe)),Xe}finally{G=He}if(ee){if(_s(Q,pe))throw xt("a node selected for removal could not be safely returned; refusing to sanitize in place");return _e&&Qo(Q),Q}if(je){if(_e&&Qo(p),Mt)for(j=Ae.call(p.ownerDocument);p.firstChild;)j.appendChild(p.firstChild);else j=p;return(V.shadowroot||V.shadowrootmode)&&(j=Te.call(o,j,!0)),j}let Je=It?p.outerHTML:p.innerHTML;return It&&H["!doctype"]&&p.ownerDocument&&p.ownerDocument.doctype&&p.ownerDocument.doctype.name&&ze(eA,p.ownerDocument.doctype.name)&&(Je="<!DOCTYPE "+p.ownerDocument.doctype.name+`>
`+Je),_e&&(Je=Un(Je)),L&&Lt?w(Je):Je},t.setConfig=function(){let Q=arguments.length>0&&arguments[0]!==void 0?arguments[0]:{};bo(Q),At=!0,Dt=H,Rt=V},t.clearConfig=function(){Wt=null,At=!1,Dt=null,Rt=null,L=f,K=""},t.isValidAttribute=function(Q,c,p){Wt||bo({});let y=Le(Q),E=Le(c);return typeof p=="string"&&(Ys(c,p)||!ve&&ze(Gi,p))?!1:Ps(y,E,p)},t.addHook=function(Q,c){typeof c=="function"&&Ve(oe,Q)&&Sn(oe[Q],c)},t.removeHook=function(Q,c){if(Ve(oe,Q)){if(c!==void 0){let p=Ld(oe[Q],c);return p===-1?void 0:Fd(oe[Q],p,1)[0]}return Di(oe[Q])}},t.removeHooks=function(Q){Ve(oe,Q)&&(oe[Q]=[])},t.removeAllHooks=function(){oe=Yi()},t}var lo=Ji();xe.setOptions({gfm:!0,breaks:!0});var Wi=!1;function iA(){Wi||typeof lo.addHook=="function"&&(Wi=!0,lo.addHook("afterSanitizeAttributes",e=>{if(e.tagName==="A"){let t=e.getAttribute("href");t&&/^\s*(javascript|data|vbscript):/i.test(t)&&(e.removeAttribute("href"),e.removeAttribute("target"),e.removeAttribute("rel"))}}))}function jt(e){try{iA();let t=String(e??"");if(!t)return"";let n=xe.parse(t,{async:!1});return lo.sanitize(n,{ALLOWED_TAGS:["p","br","strong","em","u","del","code","pre","blockquote","ul","ol","li","h1","h2","h3","h4","h5","h6","a","img","table","thead","tbody","tr","th","td","hr","span","div","input","details","summary"],ALLOWED_ATTR:["href","src","alt","title","class","id","type","checked","disabled","target","rel"],ALLOW_DATA_ATTR:!1})}catch{return aA(e)}}function aA(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}var Xi={"frontend-expert":{bg:"#22c55e",border:"#22c55e"},"backend-expert":{bg:"#f59e0b",border:"#f59e0b"},"audit-expert":{bg:"#8b5cf6",border:"#8b5cf6"},main:{bg:"#4D6BFE",border:"#4D6BFE"}},Zi={bg:"#6b7280",border:"#6b7280"};function Vi(e){let{container:t,shadow:n}=mt("studio-chat-room-root");ht(n,lA);let o=g("button",{className:"studio-chat-fab",attrs:{title:"\u804A\u5929\u5BA4"}},[Ee(he.message,20)]),s=g("div",{className:"studio-chat-overlay"}),r=g("div",{className:"studio-chat-panel"}),i=g("div",{className:"studio-chat-header"}),a=g("div",{className:"studio-chat-header-left"}),d=g("div",{className:"studio-chat-room-name",text:e.roomName}),l=g("div",{className:"studio-chat-members"}),A=g("span",{className:"studio-chat-conn-dot"}),u=g("span",{className:"studio-chat-conn-text",text:"\u8FDE\u63A5\u4E2D\u2026"}),x=g("div",{className:"studio-chat-conn"},[A,u]),m=g("span",{className:"studio-chat-meeting-chip idle",text:"\u25CB \u672A\u5F00\u59CB"});a.appendChild(d),a.appendChild(l),a.appendChild(m),a.appendChild(x);let C=g("button",{className:"studio-chat-close",attrs:{title:"\u5173\u95ED"}},[Ee(he.x,18)]);i.appendChild(a),i.appendChild(C);let b=g("div",{className:"studio-chat-messages"}),_=g("div",{className:"studio-chat-welcome"}),S=document.createElement("div");S.className="studio-chat-welcome-title",S.textContent=`\u804A\u5929\u5BA4 \xB7 ${e.roomName??""}`,_.appendChild(S);let h=document.createElement("div");h.className="studio-chat-welcome-sub",h.textContent="\u5728\u4E0B\u65B9\u8F93\u5165\u6D88\u606F\uFF0C\u7528 @all \u6216 @\u6210\u5458\u540D \u6307\u5B9A\u56DE\u590D\u8005",_.appendChild(h),b.appendChild(_);let R=g("div",{className:"studio-chat-composer"}),T=document.createElement("textarea");T.className="studio-chat-input",T.rows=2,T.placeholder=`@all \u6216 @${e.members[0]??"\u6210\u5458"} \u2026\uFF08Enter \u53D1\u9001\uFF0CShift+Enter \u6362\u884C\uFF09`;let B=g("button",{className:"studio-chat-send",text:"\u53D1\u9001"});R.appendChild(T),R.appendChild(B),r.appendChild(i),r.appendChild(b),r.appendChild(R),n.appendChild(o),n.appendChild(s),n.appendChild(r);let z=["main",...e.members];for(let v of z){let $=Xi[v]??Zi,te=g("button",{className:"studio-chat-member-chip",text:"@"+v});te.style.borderLeftColor=$.border,te.addEventListener("click",()=>{let me=T.value.endsWith(" ")||T.value===""?`@${v} `:` @${v} `;T.value+=me,T.focus()}),l.appendChild(te)}let M=null,N=!1,I=!1,P=0,L=null,K=500,f=new Set;function U(){let v=`${e.wsUrl}?token=${encodeURIComponent(e.token)}`;try{M=new WebSocket(v)}catch($){console.error("[chat-room] WS construct failed",$),k();return}M.onopen=()=>{K=500,N=!0,A.className="studio-chat-conn-dot ok",u.textContent="\u5DF2\u8FDE\u63A5"},M.onclose=$=>{N=!1,M=null,A.className="studio-chat-conn-dot bad",u.textContent=$.code===1008?"\u9274\u6743\u5931\u8D25\uFF08\u8BF7\u91CD\u542F\u5E94\u7528\uFF09":"\u8FDE\u63A5\u65AD\u5F00\uFF0C\u91CD\u8BD5\u4E2D\u2026",$.code!==1008&&k()},M.onerror=()=>{try{M?.close()}catch{}},M.onmessage=$=>{let te;try{te=JSON.parse($.data)}catch{return}w(te)}}function k(){if(L)return;let v=K;K=Math.min(K*2,1e4),L=setTimeout(()=>{L=null,U()},v)}function F(v){if(M&&M.readyState===WebSocket.OPEN)try{M.send(JSON.stringify(v))}catch($){console.error("[chat-room] send failed",$)}}function w(v){let $=v.type;if($!=="state"){if($==="ack"){v.ok!==!0&&typeof v.error=="string"&&We(`\u64CD\u4F5C\u5931\u8D25\uFF1A${v.error}`);return}if($==="event"){let te=v.event;if(!te)return;ae(te)}if($==="chat-room-event"){let te=v.event;if(!te)return;re(te)}}}function ae(v){if(v.roomId!==void 0&&v.roomId!==e.roomId)return;let $=v.botId??"main";switch(v.type){case"user":f.add($);break;case"status":(e.members.includes($)||$==="main")&&f.add($);break;case"assistant":f.delete($);break;case"done":f.delete($),$==="main"&&I&&(I=!1,ge());break;case"tool":break;case"error":f.delete($),v.text&&oe($,v.text);break}}function re(v){if(v.roomId===e.roomId)switch(v.kind){case"chat-bot-reply":{let $=v.botId??"main";f.delete($),Me($,v.content??"");break}case"chat-summary":{v.summary&&Te(v.summary);break}case"meeting-state":{ue(v.status??"idle",v.strategy??null);break}case"round-complete":{I&&(I=!1,ge());break}case"task-progress":{Ye(v.slotId??"",v.dimension??"",v.taskStatus??"running",v.message);break}case"task-complete":{q(v.slotId??"",v.dimension??"",v.ok??!1,v.findingCount??0,v.error);break}case"report-ready":{W(v.summaryPath??"",v.subReports??[]);break}}}function ue(v,$){if(m.className=`studio-chat-meeting-chip ${v}`,v==="active"&&$){let te=$.focusTopics.length>0?`\xB7 ${$.focusTopics.join("\u3001")}`:"";m.textContent=`\u25CF \u4F1A\u8BAE\u4E2D \xB7 \u9608\u503C ${$.minRoundsBeforeAutoSummary} \u8F6E ${te}`}else v==="closed"?m.textContent="\u25CB \u5DF2\u6563\u4F1A":m.textContent="\u25CB \u672A\u5F00\u59CB"}function le(){let v=b.querySelector(".studio-chat-welcome");v&&v.remove()}function ie(){b.scrollTop=b.scrollHeight}function Ae(v){le();let $=g("div",{className:"studio-chat-msg studio-chat-msg-user",text:v});b.appendChild($),ie()}function Me(v,$){le();let te=Xi[v]??Zi,me=g("div",{className:"studio-chat-msg studio-chat-msg-bot"});me.style.borderLeftColor=te.border;let we=g("div",{className:"studio-chat-sender-row"}),Ne=g("span",{className:"studio-chat-avatar",text:v.slice(0,2)});Ne.style.background=te.bg;let De=g("span",{className:"studio-chat-sender",text:v});we.appendChild(Ne),we.appendChild(De),me.appendChild(we);let ve=g("div",{className:"studio-chat-msg-body"});ve.innerHTML=jt($),Ie(ve),me.appendChild(ve),b.appendChild(me),ie()}function Te(v){le();let $=g("div",{className:"studio-chat-msg studio-chat-msg-summary"}),te=g("div",{className:"studio-chat-summary-label",text:"\u{1F4CB} \u672C\u8F6E\u6458\u8981"});$.appendChild(te);let me=g("div",{className:"studio-chat-msg-body"});me.innerHTML=jt(v),Ie(me),$.appendChild(me),b.appendChild($),ie()}function oe(v,$){le();let te=g("div",{className:"studio-chat-msg studio-chat-msg-error"});te.textContent=`[${v}] \u9519\u8BEF\uFF1A${$}`,b.appendChild(te),ie()}function We(v){let $=g("div",{className:"studio-chat-msg studio-chat-msg-status",text:v});b.appendChild($),ie()}function Ye(v,$,te,me){le();let we=g("div",{className:"studio-chat-msg studio-chat-msg-task"});we.style.borderLeftColor="#3b82f6";let Ne=g("div",{className:"studio-chat-summary-label",text:`\u{1F52C} \u5BA1\u8BA1\u4E2D \xB7 ${$}`});we.appendChild(Ne);let De=g("div",{className:"studio-chat-msg-body"});De.textContent=`\u69FD ${v} \xB7 ${te==="running"?"\u6267\u884C\u4E2D":"\u6B65\u8FDB"}${me?" \xB7 "+me:""}`,we.appendChild(De),b.appendChild(we),ie()}function q(v,$,te,me,we){le();let Ne=g("div",{className:"studio-chat-msg studio-chat-msg-task"});Ne.style.borderLeftColor=te?"#22c55e":"#ef4444";let ve=g("div",{className:"studio-chat-summary-label",text:`${te?"\u2705":"\u274C"} \u5BA1\u8BA1\u5B8C\u6210 \xB7 ${$}`});Ne.appendChild(ve);let _e=g("div",{className:"studio-chat-msg-body"});te?_e.textContent=`\u69FD ${v} \xB7 \u53D1\u73B0 ${me} \u6761`:_e.textContent=`\u69FD ${v} \xB7 \u5931\u8D25${we?"\uFF1A"+we:""}`,Ne.appendChild(_e),b.appendChild(Ne),ie()}function W(v,$){le();let te=g("div",{className:"studio-chat-msg studio-chat-msg-report"});te.style.borderLeftColor="#6366f1";let me=g("div",{className:"studio-chat-summary-label",text:"\u{1F4CA} \u7EFC\u5408\u5BA1\u8BA1\u62A5\u544A"});te.appendChild(me);let we=g("div",{className:"studio-chat-msg-body"}),Ne=$.reduce((ve,_e)=>ve+_e.findingCount,0),De=g("div",{text:`\u5171 ${$.length} \u4E2A\u7EF4\u5EA6 \xB7 ${Ne} \u6761\u53D1\u73B0`});De.style.fontWeight="bold",De.style.marginBottom="8px",we.appendChild(De);for(let ve of $){let _e=g("div",{text:`\u2022 ${ve.dimension}\uFF08${ve.findingCount} \u6761\uFF09\uFF1A${ve.summary}`});_e.style.marginBottom="4px",we.appendChild(_e)}if(v){let ve=g("div",{text:`\u{1F4C4} \u62A5\u544A\u8DEF\u5F84\uFF1A${v}`});ve.style.marginTop="8px",ve.style.fontSize="0.85em",ve.style.color="#888",we.appendChild(ve)}te.appendChild(we),b.appendChild(te),ie()}function Ie(v){let $=v.querySelectorAll("pre");for(let te of $){if(te.querySelector(".studio-chat-code-copy"))continue;let me=te.querySelector("code");if(!me)continue;let Ne=(me.className||"").match(/language-(\w+)/);if(Ne){let ve=g("span",{className:"studio-chat-code-lang",text:Ne[1]});te.appendChild(ve)}let De=g("span",{className:"studio-chat-code-copy",text:"\u590D\u5236"});De.addEventListener("click",()=>{let ve=me.textContent||"";try{navigator.clipboard?.writeText(ve)}catch{}De.textContent="\u5DF2\u590D\u5236",setTimeout(()=>{De.textContent="\u590D\u5236"},1500)}),te.appendChild(De)}}function be(){let v=T.value.trim();if(!v||I||!N)return;T.value="",Ae(v),I=!0,f.clear(),ge();let $=`cr${++P}`;F({type:"send",roomId:e.roomId,text:v,reqId:$})}function ge(){if(B.disabled=I||!N,B.textContent=I?"\u8FDB\u884C\u4E2D\u2026":"\u53D1\u9001",T.disabled=I,I){let v=g("div",{className:"studio-chat-round-indicator",text:"\u4E13\u5BB6\u8BA8\u8BBA\u4E2D\u2026"});b.appendChild(v),ie()}else{let v=b.querySelector(".studio-chat-round-indicator");v&&v.remove()}}let fe=!1,Be=null;function H(){fe=!0,s.classList.add("visible"),r.classList.add("visible"),Be=v=>{v.key==="Escape"&&Z()},window.addEventListener("keydown",Be),!M&&!N&&U(),setTimeout(()=>T.focus(),50)}function Z(){fe=!1,s.classList.remove("visible"),r.classList.remove("visible"),Be&&(window.removeEventListener("keydown",Be),Be=null)}function V(){fe?Z():H()}o.addEventListener("click",V),s.addEventListener("click",Z),C.addEventListener("click",Z),B.addEventListener("click",be),T.addEventListener("keydown",v=>{v.key==="Enter"&&!v.shiftKey&&(v.preventDefault(),be())});function ot(){if(L&&(clearTimeout(L),L=null),Be&&(window.removeEventListener("keydown",Be),Be=null),M){try{M.close()}catch{}M=null}t.remove()}return{container:t,show:H,hide:Z,toggle:V,destroy:ot}}var lA=`
/* FAB\uFF08\u53F3\u4E0B\u89D2\uFF0C\u907F\u5F00\u5DE6\u4E0A\u89D2 sidebar FAB\uFF09 */
.studio-chat-fab {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: linear-gradient(135deg, #4D6BFE, #3a55d8);
  color: #fff;
  border: none;
  box-shadow: 0 4px 14px rgba(77,107,254,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 2147483646;
  transition: all 0.2s ease;
}
.studio-chat-fab:hover {
  transform: scale(1.08);
  box-shadow: 0 6px 20px rgba(77,107,254,0.5);
}
.studio-chat-fab svg { width: 20px; height: 20px; }

/* \u906E\u7F69 */
.studio-chat-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.3);
  z-index: 2147483644;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
}
.studio-chat-overlay.visible {
  opacity: 1;
  visibility: visible;
}

/* \u9762\u677F */
.studio-chat-panel {
  position: fixed;
  bottom: 80px;
  right: 20px;
  width: min(560px, 92vw);
  height: min(680px, 82vh);
  background: #ffffff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  display: flex;
  flex-direction: column;
  z-index: 2147483645;
  overflow: hidden;
  transform: translateX(120%) scale(0.95);
  opacity: 0;
  visibility: hidden;
  transition: transform 0.25s ease, opacity 0.25s ease, visibility 0.25s ease;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.studio-chat-panel.visible {
  transform: translateX(0) scale(1);
  opacity: 1;
  visibility: visible;
}

/* \u5934\u90E8 */
.studio-chat-header {
  flex-shrink: 0;
  padding: 12px 16px;
  background: #f8f9fc;
  border-bottom: 1px solid #e8e8ee;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.studio-chat-header-left {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.studio-chat-room-name {
  font-size: 15px;
  font-weight: 600;
  color: #1a1a2e;
}
.studio-chat-members {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.studio-chat-member-chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid #e0e0e8;
  border-left: 3px solid #ccc;
  background: #fff;
  color: #666;
  cursor: pointer;
  transition: all 0.15s ease;
}
.studio-chat-member-chip:hover {
  background: #f0f0f5;
  color: #333;
}
.studio-chat-conn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #999;
}
.studio-chat-conn-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ccc;
}
.studio-chat-conn-dot.ok { background: #22c55e; }
.studio-chat-conn-dot.bad { background: #ef4444; }
/* v0.29 \u4F1A\u8BAE\u72B6\u6001 chip */
.studio-chat-meeting-chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 500;
  background: #f3f4f6;
  color: #6b7280;
  white-space: nowrap;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.studio-chat-meeting-chip.active {
  background: #dcfce7;
  color: #15803d;
}
.studio-chat-meeting-chip.closed {
  background: #f1f5f9;
  color: #94a3b8;
}
.studio-chat-close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: #999;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.studio-chat-close:hover { background: #e8e8ee; color: #555; }

/* \u6D88\u606F\u5217\u8868 */
.studio-chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scroll-behavior: smooth;
}
.studio-chat-messages::-webkit-scrollbar { width: 7px; }
.studio-chat-messages::-webkit-scrollbar-thumb { background: #d0d0d8; border-radius: 4px; }

/* \u6B22\u8FCE\u5360\u4F4D */
.studio-chat-welcome {
  margin: auto;
  text-align: center;
  padding: 40px 20px;
  color: #aaa;
}
.studio-chat-welcome-title { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #888; }
.studio-chat-welcome-sub { font-size: 13px; line-height: 1.7; }

/* \u7528\u6237\u6D88\u606F */
.studio-chat-msg-user {
  align-self: flex-end;
  max-width: 78%;
  background: linear-gradient(135deg, #4D6BFE, #3a55d8);
  color: #fff;
  border-radius: 14px 14px 4px 14px;
  padding: 10px 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* bot \u6D88\u606F */
.studio-chat-msg-bot {
  align-self: flex-start;
  max-width: 88%;
  background: #f6f7f9;
  border: 1px solid #e8e8ee;
  border-left: 3px solid #4D6BFE;
  border-radius: 4px 14px 14px 4px;
  padding: 10px 14px;
  word-break: break-word;
}
.studio-chat-sender-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.studio-chat-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 50%;
  font-size: 10px; font-weight: 600; color: #fff;
  flex-shrink: 0;
}
.studio-chat-sender { font-size: 12px; color: #888; font-weight: 500; }

/* \u6458\u8981 */
.studio-chat-msg-summary {
  align-self: stretch;
  background: #fefce8;
  border: 1px solid #fde68a;
  border-left: 3px solid #f59e0b;
  border-radius: 8px;
  padding: 10px 14px;
  margin-top: 4px;
}
.studio-chat-summary-label {
  font-size: 12px;
  font-weight: 600;
  color: #92400e;
  margin-bottom: 6px;
}

/* \u9519\u8BEF */
.studio-chat-msg-error {
  align-self: center;
  max-width: 90%;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: #dc2626;
}

/* \u72B6\u6001\u63D0\u793A */
.studio-chat-msg-status {
  align-self: center;
  font-size: 12px;
  color: #999;
  padding: 4px 0;
}

/* \u8F6E\u6B21\u6307\u793A\u5668 */
.studio-chat-round-indicator {
  align-self: center;
  font-size: 12px;
  color: #4D6BFE;
  padding: 6px 14px;
  background: #eff4ff;
  border-radius: 12px;
  animation: studio-chat-pulse 1.5s ease-in-out infinite;
}
@keyframes studio-chat-pulse { 50% { opacity: 0.5; } }

/* \u6D88\u606F\u6B63\u6587\uFF08markdown\uFF09 */
.studio-chat-msg-body { font-size: 14px; line-height: 1.65; color: #1a1a2e; }
.studio-chat-msg-body p { margin: 0 0 8px; }
.studio-chat-msg-body p:last-child { margin-bottom: 0; }
.studio-chat-msg-body h1, .studio-chat-msg-body h2, .studio-chat-msg-body h3 {
  margin: 12px 0 6px; font-weight: 600; line-height: 1.4;
}
.studio-chat-msg-body h1 { font-size: 1.3em; }
.studio-chat-msg-body h2 { font-size: 1.2em; }
.studio-chat-msg-body h3 { font-size: 1.1em; }
.studio-chat-msg-body ul, .studio-chat-msg-body ol { margin: 6px 0 8px; padding-left: 22px; }
.studio-chat-msg-body li { margin: 2px 0; }
.studio-chat-msg-body pre {
  background: #f0f0f5; border-radius: 8px; padding: 10px 13px;
  overflow-x: auto; font-size: 13px; line-height: 1.5; margin: 8px 0; position: relative;
}
.studio-chat-msg-body code {
  background: #f0f0f5; padding: 1px 5px; border-radius: 4px;
  font-size: 0.9em; font-family: 'SF Mono', 'Consolas', monospace;
}
.studio-chat-msg-body pre code { background: none; padding: 0; }
.studio-chat-msg-body blockquote { border-left: 3px solid #4D6BFE; margin: 8px 0; padding: 4px 12px; color: #555; }
.studio-chat-msg-body a { color: #4D6BFE; text-decoration: none; }
.studio-chat-msg-body a:hover { text-decoration: underline; }
.studio-chat-msg-body table { border-collapse: collapse; margin: 8px 0; font-size: 13px; display: block; overflow-x: auto; }
.studio-chat-msg-body th, .studio-chat-msg-body td { border: 1px solid #e0e0e8; padding: 6px 10px; text-align: left; }
.studio-chat-msg-body th { background: #f0f0f5; font-weight: 600; }

/* \u4EE3\u7801\u5757\u6807\u7B7E + \u590D\u5236 */
.studio-chat-code-lang {
  position: absolute; top: 4px; right: 4px;
  font-size: 11px; color: #999; background: rgba(255,255,255,0.6);
  padding: 1px 6px; border-radius: 4px; pointer-events: none;
}
.studio-chat-code-copy {
  position: absolute; top: 4px; right: 4px;
  display: none; padding: 1px 6px; font-size: 11px;
  color: #888; background: #fff; border: 1px solid #e0e0e8; border-radius: 4px; cursor: pointer;
}
.studio-chat-msg-body pre:hover .studio-chat-code-copy { display: inline-block; }
.studio-chat-code-copy:hover { color: #4D6BFE; border-color: #4D6BFE; }

/* \u8F93\u5165\u533A */
.studio-chat-composer {
  flex-shrink: 0;
  padding: 10px 16px;
  border-top: 1px solid #e8e8ee;
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.studio-chat-input {
  flex: 1;
  border: 1px solid #d8d8e0;
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 14px;
  font-family: inherit;
  resize: none;
  max-height: 120px;
  outline: none;
  transition: border-color 0.15s ease;
  line-height: 1.5;
}
.studio-chat-input:focus { border-color: #4D6BFE; }
.studio-chat-input:disabled { background: #f5f5f8; color: #aaa; }
.studio-chat-send {
  flex-shrink: 0;
  padding: 8px 18px;
  border: none;
  border-radius: 10px;
  background: #4D6BFE;
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}
.studio-chat-send:hover:not(:disabled) { background: #3a55d8; }
.studio-chat-send:disabled { background: #c0c0cc; cursor: not-allowed; }
`;var cA={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};function qe(e){return e.replace(/[&<>"']/g,t=>cA[t]??t)}var dA={workspaceRoot:null,policyMode:"auto",loading:!1,error:null};function ea(e){return typeof e=="string"&&en.includes(e)}function co(e){let t={...dA},n=!1,o=new Set;function s(d){if(!n){t={...t,...d};for(let l of o)try{l(t)}catch{}}}async function r(){if(n)return;s({loading:!0,error:null});let d=await e.call("settings.get",{});if(n)return;if(!d.ok){s({loading:!1,error:d.error??"settings-get-failed"});return}let l=d.data??{};s({loading:!1,error:null,workspaceRoot:typeof l.workspaceRoot=="string"&&l.workspaceRoot?l.workspaceRoot:null,policyMode:ea(l.policyMode)?l.policyMode:t.policyMode})}async function i(d){if(n)return!1;s({loading:!0,error:null});let l=await e.call("workspace.set",{root:d});if(n)return!1;if(!l.ok)return s({loading:!1,error:l.error??"workspace-set-failed"}),!1;let A=l.data?.root;return typeof A=="string"&&A&&s({workspaceRoot:A}),await r(),!0}async function a(d){if(n)return!1;s({loading:!0,error:null});let l=await e.call("policy.set",{mode:d});if(n)return!1;if(!l.ok)return s({loading:!1,error:l.error??"policy-set-failed"}),!1;let A=l.data?.mode;return ea(A)&&s({policyMode:A}),await r(),!0}return{getSnapshot:()=>t,subscribe(d){return n?()=>{}:(o.add(d),()=>o.delete(d))},refresh:r,setWorkspace:i,setPolicy:a,destroy(){n=!0,o.clear()}}}var AA=`
  .studio-settings-modal { width: 760px; max-width: min(92vw, 760px); }
  .studio-settings-body { display: flex; min-height: 420px; padding: 0; }
  .studio-settings-tabs {
    width: 172px; flex: 0 0 172px; display: flex; flex-direction: column; gap: 3px;
    padding: 14px 10px; border-right: 1px solid #f0f0f0; background: #fafbfe;
  }
  .studio-settings-tab {
    width: 100%; padding: 10px 12px; border: none; border-radius: 8px;
    background: transparent; cursor: pointer; text-align: left;
    font-size: 13px; color: #666;
  }
  .studio-settings-tab:hover { background: #f0f3ff; color: #4059d6; }
  .studio-settings-tab.active { color: #4D6BFE; background: #e9eeff; font-weight: 600; }
  .studio-settings-content { flex: 1; min-width: 0; padding: 20px; overflow-y: auto; }
  .studio-tab-content { display: none; }
  .studio-tab-content.active { display: block; }
  .studio-info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f5f5f5; font-size: 13px; }
  .studio-info-label { color: #888; }
  .studio-info-value { color: #333; font-family: monospace; font-size: 12px; max-width: 60%; overflow: hidden; text-overflow: ellipsis; }
  .studio-workspace-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .studio-workspace-input { flex: 1; }
  .studio-policy-options { display: flex; flex-direction: column; gap: 8px; }
  .studio-policy-option {
    display: flex; align-items: flex-start; gap: 10px; padding: 12px;
    border: 1px solid #e8e8e8; border-radius: 8px; cursor: pointer; transition: all 0.15s;
  }
  .studio-policy-option:hover { border-color: #c5d0ff; background: #f8f9ff; }
  .studio-policy-option.selected { border-color: #4D6BFE; background: #f0f3ff; }
  .studio-policy-radio { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #ccc; margin-top: 1px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .studio-policy-option.selected .studio-policy-radio { border-color: #4D6BFE; }
  .studio-policy-option.selected .studio-policy-radio::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: #4D6BFE; }
  .studio-policy-title { font-weight: 500; font-size: 13px; color: #333; margin-bottom: 2px; }
  .studio-policy-desc { font-size: 12px; color: #888; }
  .studio-mcp-server-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px; border: 1px solid #e8e8e8; border-radius: 8px; margin-bottom: 8px;
  }
  .studio-mcp-server-info { flex: 1; min-width: 0; }
  .studio-mcp-server-name { font-weight: 500; font-size: 13px; color: #333; }
  .studio-mcp-transport {
    display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 4px;
    font-size: 10px; font-weight: 600; vertical-align: middle;
    background: #eef2ff; color: #4D6BFE; border: 1px solid #dbe3ff;
  }
  .studio-mcp-server-cmd { font-size: 11px; color: #999; font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-mcp-server-actions { display: flex; gap: 4px; }
  .studio-mcp-add-btn { width: 100%; padding: 10px; border: 1px dashed #d0d0d0; border-radius: 8px; background: transparent; cursor: pointer; color: #888; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px; }
  .studio-mcp-add-btn:hover { border-color: #4D6BFE; color: #4D6BFE; }
  .studio-memory-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px; border-bottom: 1px solid #f5f5f5; }
  .studio-memory-type { flex-shrink: 0; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .studio-memory-type.user { background: #e3f2fd; color: #1565c0; }
  .studio-memory-type.project { background: #f3e5f5; color: #7b1fa2; }
  .studio-memory-content { flex: 1; min-width: 0; }
  .studio-memory-name { font-size: 13px; font-weight: 500; color: #333; margin-bottom: 2px; }
  .studio-memory-text { font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .studio-empty-state { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
`;function ta(e={}){let{container:t,shadow:n}=mt("studio-settings-root");ht(n,AA);let o=!1,s=!e.controls,r=e.controls??co({call:(H,Z)=>Oe(H,Z)}),i=g("div",{className:"studio-modal-overlay",style:{display:"none"}}),a=g("div",{className:"studio-modal studio-settings-modal"}),d=g("div",{className:"studio-modal-header"},[g("h2",{className:"studio-modal-title",text:"Studio \u8BBE\u7F6E"})]),l=g("button",{className:"studio-close-btn"},[Ee(he.x,18)]);l.addEventListener("click",fe),d.appendChild(l),a.appendChild(d);let A=g("div",{className:"studio-modal-body studio-settings-body"}),u=g("div",{className:"studio-settings-tabs"}),x=[{id:"general",label:"\u901A\u7528 / \u8FDE\u63A5"},{id:"workspace",label:"\u5DE5\u4F5C\u533A\u4E0E\u9879\u76EE"},{id:"policy",label:"\u5BA1\u6279\u4E0E\u5B89\u5168"},{id:"skills",label:"\u6280\u80FD"},{id:"mcp",label:"MCP"},{id:"memory",label:"\u8BB0\u5FC6\u4E0E\u6267\u884C\u8BB0\u5F55"},{id:"diagnostics",label:"\u8BCA\u65AD\u4E0E\u5173\u4E8E"}],m={},C=new Map,b=g("div",{className:"studio-settings-content"});function _(H){for(let[Z,V]of C)V.classList.toggle("active",Z===H);for(let[Z,V]of Object.entries(m))V.classList.toggle("active",Z===H)}for(let H of x){let Z=g("button",{className:`studio-settings-tab${H.id==="general"?" active":""}`,text:H.label,attrs:{"data-tab-id":H.id}});Z.addEventListener("click",()=>_(H.id)),C.set(H.id,Z),u.appendChild(Z)}A.appendChild(u),A.appendChild(b);let S=g("div",{className:"studio-tab-content active"});S.dataset.tabPanel="general",S.innerHTML=`
    <div class="studio-info-row"><span class="studio-info-label">\u7248\u672C</span><span class="studio-info-value">v1.0.0</span></div>
    <div class="studio-info-row"><span class="studio-info-label">\u65E5\u5FD7\u8DEF\u5F84</span><span class="studio-info-value">E:\\NAS\\deepseek-studio\\tauri-real.log</span></div>
    <div class="studio-info-row"><span class="studio-info-label">\u914D\u7F6E\u8DEF\u5F84</span><span class="studio-info-value">~/.config/deepseek-studio/</span></div>
    <div class="studio-info-row"><span class="studio-info-label">\u5BBF\u4E3B\u7AEF\u53E3</span><span class="studio-info-value">8760</span></div>
  `,m.general=S,b.appendChild(S);let h=g("div",{className:"studio-tab-content"});h.dataset.tabPanel="workspace";let R=g("div",{className:"studio-workspace-row"}),T=g("input",{className:"studio-input studio-workspace-input",attrs:{value:ke.workspaceRoot??"",placeholder:"\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55\u8DEF\u5F84\uFF0C\u5982 E:/NAS"}}),B=g("button",{className:"studio-btn primary sm",text:"\u4FDD\u5B58"}),z=g("p",{className:"studio-form-hint",text:"\u5DE5\u4F5C\u533A\u662F\u5DE5\u5177\u64CD\u4F5C\u7684\u6839\u76EE\u5F55\u3002\u6587\u4EF6\u8BFB\u5199\u548C\u547D\u4EE4\u6267\u884C\u9ED8\u8BA4\u9650\u5236\u5728\u6B64\u76EE\u5F55\u5185\u3002"});B.addEventListener("click",async()=>{let H=T.value.trim();if(await r.setWorkspace(H)){let V=r.getSnapshot().workspaceRoot??H;T.value=V,ke.workspaceRoot=V,z.textContent="\u5DF2\u4FDD\u5B58\u5230\u914D\u7F6E\u6587\u4EF6\uFF0C\u91CD\u542F\u540E\u4ECD\u7136\u751F\u6548\u3002",B.textContent="\u5DF2\u4FDD\u5B58",setTimeout(()=>{B.textContent="\u4FDD\u5B58"},1500)}else z.textContent=`\u4FDD\u5B58\u5931\u8D25\uFF1A${r.getSnapshot().error??"\u672A\u77E5\u9519\u8BEF"}`,B.textContent="\u4FDD\u5B58\u5931\u8D25",setTimeout(()=>{B.textContent="\u4FDD\u5B58"},2e3)});let M=g("button",{className:"studio-btn sm",text:"\u9009\u62E9\u9879\u76EE"});M.addEventListener("click",()=>Qe.emit("ui:project-picker")),R.appendChild(T),R.appendChild(B),h.appendChild(R),h.appendChild(M),h.appendChild(z),m.workspace=h,b.appendChild(h);let N=g("div",{className:"studio-tab-content"});N.dataset.tabPanel="policy";let I=g("div",{className:"studio-policy-options"}),P={workspace:"\u6587\u4EF6\u8BFB\u5199\u4E0E\u547D\u4EE4\u6267\u884C\u4EC5\u9650\u5DE5\u4F5C\u533A\u6839\u76EE\u5F55\uFF0C\u8D8A\u754C\u4E00\u5F8B\u62D2\u7EDD\u3002\u6700\u6536\u655B\u3002",auto:"\u4F4E\u98CE\u9669\u64CD\u4F5C\u81EA\u52A8\u6267\u884C\uFF0C\u9AD8\u98CE\u9669\u64CD\u4F5C\u5F39\u51FA\u786E\u8BA4\u3002\u9ED8\u8BA4\u6863\u3002",full:"\u6240\u6709\u5DE5\u5177\u8C03\u7528\u81EA\u52A8\u6267\u884C\uFF0C\u65E0\u9700\u786E\u8BA4\u3002\u9002\u5408\u5B8C\u5168\u4FE1\u4EFB\u7684\u73AF\u5883\u3002"};for(let H of en){let Z=g("div",{className:`studio-policy-option${H===ke.policyMode?" selected":""}`,attrs:{"data-mode":H}});Z.innerHTML=`<div class="studio-policy-radio"></div><div><div class="studio-policy-title">${qe(it[H])}</div><div class="studio-policy-desc">${qe(P[H])}</div></div>`,Z.addEventListener("click",async()=>{let V=H;await r.setPolicy(V)?L.textContent=`\u5DF2\u4FDD\u5B58\uFF1A${it[V]}\u3002\u91CD\u542F\u540E\u4ECD\u7136\u751F\u6548\u3002`:(L.textContent=`\u4FDD\u5B58\u5931\u8D25\uFF1A${r.getSnapshot().error??"\u672A\u77E5\u9519\u8BEF"}`,W())}),I.appendChild(Z)}N.appendChild(I);let L=g("p",{className:"studio-form-hint",text:""});N.appendChild(L),m.policy=N,b.appendChild(N);let K=g("div",{className:"studio-tab-content"});K.dataset.tabPanel="mcp";let f=g("div",{className:"studio-mcp-server-list"}),U=g("p",{className:"studio-form-hint",text:""}),k=g("button",{className:"studio-mcp-add-btn"},[Ee(he.plus,16),g("span",{text:"\u6DFB\u52A0 MCP \u670D\u52A1\u5668"})]);k.addEventListener("click",()=>Qe.emit("ui:mcp-add")),K.appendChild(f),K.appendChild(U),K.appendChild(k);function F(){if(f.replaceChildren(),ke.mcpServers.length===0){f.appendChild(g("div",{className:"studio-empty-state",text:"\u6682\u65E0\u914D\u7F6E\u7684 MCP \u670D\u52A1\u5668"}));return}for(let H of ke.mcpServers){let Z=g("div",{className:"studio-mcp-server-item"}),V=ke.mcpConfigs.find(we=>we.id===H),ot=(V?.transport??"stdio").toUpperCase(),v=V?.url||V?.command||"";Z.innerHTML=`
        <div class="studio-mcp-server-info">
          <div class="studio-mcp-server-name">${qe(H)} <span class="studio-mcp-transport">${qe(ot)}</span></div>
          <div class="studio-mcp-server-cmd">${qe(v)}</div>
        </div>
        <div class="studio-mcp-server-actions"></div>
      `;let $=Z.querySelector(".studio-mcp-server-actions"),te=g("button",{className:"studio-btn sm"},[Ee(he.edit,12)]);te.addEventListener("click",()=>Qe.emit("ui:mcp-edit",H));let me=g("button",{className:"studio-btn sm danger"},[Ee(he.trash,12)]);me.addEventListener("click",async()=>{let we=await Oe("mcp.remove",{serverId:H});if(!we.ok){U.textContent=`\u5220\u9664\u5931\u8D25\uFF1A${we.error??"\u672A\u77E5\u9519\u8BEF"}`;return}U.textContent="",ke.mcpServers=ke.mcpServers.filter(Ne=>Ne!==H),F()}),$.appendChild(te),$.appendChild(me),f.appendChild(Z)}}F(),m.mcp=K,b.appendChild(K);let w=g("div",{className:"studio-tab-content"});w.dataset.tabPanel="skills";let ae=g("div",{className:"studio-workspace-row"}),re=g("input",{className:"studio-input studio-workspace-input",attrs:{placeholder:"\u6280\u80FD\u76EE\u5F55\u8DEF\u5F84\uFF08\u7559\u7A7A\u7528\u9ED8\u8BA4 ~/.agents/skills\uFF09"}}),ue=g("button",{className:"studio-btn primary sm",text:"\u626B\u63CF"});async function le(){let H=re.value.trim(),Z=await Oe("skill.list",H?{dir:H}:{});if(Z.ok&&Z.data){let V=Z.data;typeof V.dir=="string"&&V.dir&&(re.value=V.dir),ke.skills=V.skills??[],Ae()}}ue.addEventListener("click",()=>void le()),ae.appendChild(re),ae.appendChild(ue),w.appendChild(ae);let ie=g("div",{className:"studio-skills-list"});w.appendChild(ie);function Ae(){if(ie.replaceChildren(),ke.skills.length===0){ie.appendChild(g("div",{className:"studio-empty-state",text:"\u6682\u65E0\u6280\u80FD\uFF0C\u70B9\u51FB\u626B\u63CF\u6309\u94AE\u626B\u63CF\u6280\u80FD\u76EE\u5F55"}));return}for(let H of ke.skills){let Z=g("div",{className:"studio-mcp-server-item"});Z.innerHTML=`
        <div class="studio-mcp-server-info">
          <div class="studio-mcp-server-name">${qe(H.name)}</div>
          <div class="studio-mcp-server-cmd">${qe(H.description)}</div>
        </div>
      `,ie.appendChild(Z)}}Ae(),m.skills=w,b.appendChild(w);let Me=g("div",{className:"studio-tab-content"});Me.dataset.tabPanel="memory";let Te=g("div",{className:"studio-memory-list"});Me.appendChild(Te);function oe(){if(Te.replaceChildren(),ke.memories.length===0){Te.appendChild(g("div",{className:"studio-empty-state",text:"\u6682\u65E0\u4FDD\u5B58\u7684\u8BB0\u5FC6"}));return}for(let H of ke.memories){let Z=g("div",{className:"studio-memory-item"});Z.innerHTML=`
        <span class="studio-memory-type ${qe(H.type)}">${qe(H.type)}</span>
        <div class="studio-memory-content">
          <div class="studio-memory-name">${qe(H.name)}</div>
          <div class="studio-memory-text">${qe(H.content)}</div>
        </div>
      `;let V=g("button",{className:"studio-btn sm danger"},[Ee(he.trash,12)]);V.addEventListener("click",async()=>{await Oe("memory.delete",{id:H.id}),ke.memories=ke.memories.filter(ot=>ot.id!==H.id),oe()}),Z.appendChild(V),Te.appendChild(Z)}}oe(),m.memory=Me,b.appendChild(Me);let We=g("div",{className:"studio-tab-content"});We.dataset.tabPanel="diagnostics",We.innerHTML=`
    <div class="studio-info-row"><span class="studio-info-label">\u65E5\u5FD7\u8DEF\u5F84</span><span class="studio-info-value">E:\\NAS\\deepseek-studio\\tauri-real.log</span></div>
    <div class="studio-info-row"><span class="studio-info-label">\u914D\u7F6E\u8DEF\u5F84</span><span class="studio-info-value">~/.config/deepseek-studio/</span></div>
    <div class="studio-info-row"><span class="studio-info-label">\u5F52\u6863\u4F4D\u7F6E</span><span class="studio-info-value">archive/legacy/</span></div>
    <p class="studio-form-hint">\u65E7\u5916\u90E8\u96C6\u6210\u5165\u53E3\u5DF2\u5F52\u6863\uFF1B\u5B89\u5168\u6267\u884C\u5BA1\u8BA1\u548C\u804A\u5929\u5BA4\u5BA1\u8BA1\u4F1A\u8BAE\u4ECD\u4FDD\u7559\u3002</p>
  `,m.diagnostics=We,b.appendChild(We),a.appendChild(A);let Ye=g("div",{className:"studio-modal-footer"}),q=g("button",{className:"studio-btn primary",text:"\u5B8C\u6210"});q.addEventListener("click",fe),Ye.appendChild(q),a.appendChild(Ye),i.appendChild(a),n.appendChild(i);function W(){let H=r.getSnapshot();T.value=H.workspaceRoot??"",ke.workspaceRoot=H.workspaceRoot,ke.policyMode=H.policyMode,I.querySelectorAll(".studio-policy-option").forEach(Z=>{Z.classList.toggle("selected",Z.dataset.mode===H.policyMode)})}let Ie=r.subscribe(W);W();async function be(){let H=await Oe("mcp.list",{});if(H.ok&&H.data){let Z=H.data;Array.isArray(Z.servers)&&(ke.mcpServers=[...Z.servers]),Array.isArray(Z.configs)&&(ke.mcpConfigs=Z.configs),F()}}function ge(H="general"){o=!0,i.style.display="flex",_(H),z.textContent="\u5DE5\u4F5C\u533A\u662F\u5DE5\u5177\u64CD\u4F5C\u7684\u6839\u76EE\u5F55\u3002\u6587\u4EF6\u8BFB\u5199\u548C\u547D\u4EE4\u6267\u884C\u9ED8\u8BA4\u9650\u5236\u5728\u6B64\u76EE\u5F55\u5185\u3002",L.textContent="",U.textContent="",F(),r.refresh(),be(),le(),oe()}function fe(){o=!1,i.style.display="none"}let Be=Qe.on("ui:settings",()=>{o?fe():ge("general")});return{container:t,open:ge,close:fe,destroy(){Ie(),Be(),s&&r.destroy(),t.remove()}}}var uA=`
  .studio-skills-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.3);
    z-index: 2147483500; display: none;
  }
  .studio-skills-panel {
    position: fixed; top: 0; right: 0; width: 420px; height: 100vh;
    background: #fff; box-shadow: -4px 0 20px rgba(0,0,0,0.1);
    z-index: 2147483501; display: flex; flex-direction: column;
    transform: translateX(100%); transition: transform 0.25s ease;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .studio-skills-panel.open { transform: translateX(0); }
  .studio-skills-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; border-bottom: 1px solid #f0f0f0;
  }
  .studio-skills-title { font-size: 16px; font-weight: 600; color: #1a1a2e; margin: 0; }
  .studio-skills-body { flex: 1; overflow-y: auto; padding: 12px; }
  .studio-skills-search { margin-bottom: 12px; position: relative; }
  .studio-skills-search input { padding-left: 36px; }
  .studio-skills-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #aaa; }
  .studio-skill-card {
    border: 1px solid #e8e8e8; border-radius: 10px; margin-bottom: 8px;
    overflow: hidden; transition: all 0.15s;
  }
  .studio-skill-card:hover { border-color: #c5d0ff; }
  .studio-skill-card.expanded { border-color: #4D6BFE; }
  .studio-skill-header {
    display: flex; align-items: center; gap: 10px; padding: 12px; cursor: pointer;
  }
  .studio-skill-icon {
    width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, #667eea, #764ba2);
    display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0;
  }
  .studio-skill-info { flex: 1; min-width: 0; }
  .studio-skill-name { font-size: 14px; font-weight: 500; color: #333; }
  .studio-skill-desc { font-size: 12px; color: #888; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-skill-toggle { flex-shrink: 0; }
  .studio-skill-detail {
    display: none; padding: 0 12px 12px; border-top: 1px solid #f0f0f0;
  }
  .studio-skill-card.expanded .studio-skill-detail { display: block; }
  .studio-skill-detail-content {
    margin-top: 12px; padding: 12px; background: #f8f9fc; border-radius: 8px;
    font-size: 12px; color: #555; line-height: 1.6; max-height: 200px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
  }
  .studio-skill-detail-actions { display: flex; gap: 8px; margin-top: 12px; }
  .studio-skills-footer {
    padding: 12px 20px; border-top: 1px solid #f0f0f0; display: flex; gap: 8px;
  }
  .studio-skills-footer .studio-btn { flex: 1; justify-content: center; }
  .studio-empty-state { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
`;function na(){let{container:e,shadow:t}=mt("studio-skills-panel-root");ht(t,uA);let n=!1,o=null,s="",r=g("div",{className:"studio-skills-overlay"}),i=g("div",{className:"studio-skills-panel"}),a=g("div",{className:"studio-skills-header"},[g("h2",{className:"studio-skills-title",text:"\u6280\u80FD\u7BA1\u7406"})]),d=g("button",{className:"studio-close-btn"},[Ee(he.x,18)]);d.addEventListener("click",M),a.appendChild(d),i.appendChild(a);let l=g("div",{className:"studio-skills-body"}),A=g("div",{className:"studio-skills-search"}),u=g("span",{className:"studio-skills-search-icon"});u.appendChild(Ee(he.search,16));let x=g("input",{className:"studio-input",attrs:{placeholder:"\u641C\u7D22\u6280\u80FD..."}});x.addEventListener("input",N=>{s=N.target.value.toLowerCase(),B()}),A.appendChild(u),A.appendChild(x),l.appendChild(A);let m=g("div",{className:"studio-skill-list"});l.appendChild(m),i.appendChild(l);let C=g("div",{className:"studio-skills-footer"}),b=g("button",{className:"studio-btn"},[Ee(he.refresh,14),g("span",{text:"\u5237\u65B0"})]);b.addEventListener("click",R);let _=g("button",{className:"studio-btn"},[Ee(he.folder,14),g("span",{text:"\u6253\u5F00\u76EE\u5F55"})]);_.addEventListener("click",async()=>{await Oe("shell.exec",{command:`explorer "${h||"%USERPROFILE%\\.config\\deepseek-studio\\skills"}"`})}),C.appendChild(b),C.appendChild(_),i.appendChild(C),r.appendChild(i),t.appendChild(r);let S=[],h="";async function R(){try{let N=await Oe("skill.list",{});if(N.ok&&N.data){let I=N.data;typeof I.dir=="string"&&I.dir&&(h=I.dir);let P=I.skills??[];S=P.map(L=>({...L,enabled:!0})),ke.skills=P}}catch{}B()}async function T(N){let I=S.find(P=>P.id===N);if(!I)return"";if(I.content)return I.content;try{let P=await Oe("file.read",{path:I.skillMdPath});if(P.ok&&P.data)return I.content=P.data.content,I.content}catch{}return"\uFF08\u65E0\u6CD5\u52A0\u8F7D SKILL.md \u5185\u5BB9\uFF09"}function B(){m.replaceChildren();let N=S.filter(I=>!s||I.name.toLowerCase().includes(s)||I.description.toLowerCase().includes(s));if(N.length===0){m.appendChild(g("div",{className:"studio-empty-state",text:s?"\u6CA1\u6709\u5339\u914D\u7684\u6280\u80FD":"\u6682\u65E0\u6280\u80FD\uFF0C\u8BF7\u5728\u6280\u80FD\u76EE\u5F55\u4E2D\u6DFB\u52A0"}));return}for(let I of N){let P=o===I.id,L=g("div",{className:`studio-skill-card${P?" expanded":""}`}),K=g("div",{className:"studio-skill-header"}),f=g("div",{className:"studio-skill-icon"});f.appendChild(Ee(he.book,18));let U=g("div",{className:"studio-skill-info"}),k=document.createElement("div");k.className="studio-skill-name",k.textContent=I.name??"";let F=document.createElement("div");F.className="studio-skill-desc",F.textContent=I.description??"",U.appendChild(k),U.appendChild(F);let w=g("div",{className:`studio-switch${I.enabled?" on":""}`});w.addEventListener("click",ie=>{ie.stopPropagation(),I.enabled=!I.enabled,w.classList.toggle("on",I.enabled)}),K.appendChild(f),K.appendChild(U),K.appendChild(w),K.addEventListener("click",async()=>{if(o=P?null:I.id,B(),!P){await T(I.id);let ie=L.querySelector(".studio-skill-detail-content");ie&&(ie.textContent=I.content??"\u52A0\u8F7D\u4E2D...")}}),L.appendChild(K);let ae=g("div",{className:"studio-skill-detail"}),re=g("div",{className:"studio-skill-detail-content",text:P?I.content??"\u52A0\u8F7D\u4E2D...":""});ae.appendChild(re);let ue=g("div",{className:"studio-skill-detail-actions"}),le=g("button",{className:"studio-btn sm",text:"\u8BFB\u53D6\u5B8C\u6574\u5185\u5BB9"});le.addEventListener("click",async ie=>{ie.stopPropagation();let Ae=await T(I.id);re.textContent=Ae}),ue.appendChild(le),ae.appendChild(ue),L.appendChild(ae),m.appendChild(L)}}function z(){n=!0,r.style.display="block",requestAnimationFrame(()=>i.classList.add("open")),s="",x.value="",o=null,R()}function M(){n=!1,i.classList.remove("open"),setTimeout(()=>{r.style.display="none"},250)}return Qe.on("ui:skills-panel",()=>{n?M():z()}),Qe.on("ui:skills",()=>{n?M():z()}),{container:e,open:z,close:M}}var pA=`
  .studio-mcp-dialog { width: 560px; }
  .studio-mcp-form { display: flex; flex-direction: column; gap: 16px; }
  .studio-mcp-row { display: flex; gap: 12px; }
  .studio-mcp-row .studio-form-group { flex: 1; }
  .studio-kv-list { display: flex; flex-direction: column; gap: 6px; }
  .studio-kv-row { display: flex; gap: 8px; align-items: center; }
  .studio-kv-row .studio-input { flex: 1; }
  .studio-kv-remove {
    width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
    border: 1px solid #e0e0e0; border-radius: 4px; background: #fff; cursor: pointer;
    color: #999; flex-shrink: 0; transition: all 0.15s;
  }
  .studio-kv-remove:hover { color: #e53935; border-color: #ffcdd2; background: #ffebee; }
  .studio-kv-add {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px;
    border: 1px dashed #d0d0d0; border-radius: 6px; background: transparent;
    cursor: pointer; color: #888; font-size: 12px; transition: all 0.15s;
  }
  .studio-kv-add:hover { border-color: #4D6BFE; color: #4D6BFE; }
  .studio-mcp-test-result {
    padding: 10px 12px; border-radius: 6px; font-size: 12px; margin-top: 8px;
    display: none;
  }
  .studio-mcp-test-result.success { display: block; background: #e8f5e9; color: #2e7d32; }
  .studio-mcp-test-result.error { display: block; background: #ffebee; color: #c62828; }
  .studio-mcp-test-result.loading { display: block; background: #e3f2fd; color: #1565c0; }
`;function oa(){let{container:e,shadow:t}=mt("studio-mcp-dialog-root");ht(t,pA);let n=null,o="stdio",s=g("div",{className:"studio-modal-overlay",style:{display:"none"}}),r=g("div",{className:"studio-modal studio-mcp-dialog"}),i=g("div",{className:"studio-modal-header"},[g("h2",{className:"studio-modal-title",text:"\u6DFB\u52A0 MCP \u670D\u52A1\u5668"})]),a=g("button",{className:"studio-close-btn"},[Ee(he.x,18)]);a.addEventListener("click",Ye),i.appendChild(a),r.appendChild(i);let d=g("div",{className:"studio-modal-body"}),l=g("div",{className:"studio-mcp-form"}),A=g("div",{className:"studio-form-group"});A.appendChild(g("label",{className:"studio-form-label",text:"\u670D\u52A1\u5668\u540D\u79F0 *"}));let u=g("input",{className:"studio-input",attrs:{placeholder:"\u5982\uFF1Afilesystem\u3001github"}});A.appendChild(u),l.appendChild(A);let x=g("div",{className:"studio-form-group"});x.appendChild(g("label",{className:"studio-form-label",text:"\u4F20\u8F93\u7C7B\u578B"}));let m=g("select",{className:"studio-input"});for(let[q,W]of[["stdio","stdio\uFF08\u672C\u5730\u8FDB\u7A0B\uFF09"],["http","HTTP"],["sse","SSE"]]){let Ie=g("option",{attrs:{value:q},text:W});m.appendChild(Ie)}m.addEventListener("change",()=>{o=m.value,ue()}),x.appendChild(m),l.appendChild(x);let C=g("div",{style:{display:"block"}}),b=g("div",{className:"studio-form-group"});b.appendChild(g("label",{className:"studio-form-label",text:"\u542F\u52A8\u547D\u4EE4 *"}));let _=g("input",{className:"studio-input",attrs:{placeholder:"\u5982\uFF1Anpx\u3001python\u3001uvx"}});b.appendChild(_),C.appendChild(b);let S=g("div",{className:"studio-form-group"});S.appendChild(g("label",{className:"studio-form-label",text:"\u53C2\u6570"}));let h=g("div",{className:"studio-kv-list"}),R=g("button",{className:"studio-kv-add"},[Ee(he.plus,12),g("span",{text:"\u6DFB\u52A0\u53C2\u6570"})]);R.addEventListener("click",()=>ae(h,"\u53C2\u6570\u503C")),S.appendChild(h),S.appendChild(R),C.appendChild(S),l.appendChild(C);let T=g("div",{style:{display:"none"}}),B=g("div",{className:"studio-form-group"});B.appendChild(g("label",{className:"studio-form-label",text:"\u670D\u52A1\u5668 URL *"}));let z=g("input",{className:"studio-input",attrs:{placeholder:"https://mcp.example.com/mcp"}});B.appendChild(z),T.appendChild(B),l.appendChild(T);let M=g("div",{className:"studio-form-group"});M.appendChild(g("label",{className:"studio-form-label",text:"\u73AF\u5883\u53D8\u91CF"}));let N=g("div",{className:"studio-kv-list"}),I=g("button",{className:"studio-kv-add"},[Ee(he.plus,12),g("span",{text:"\u6DFB\u52A0\u73AF\u5883\u53D8\u91CF"})]);I.addEventListener("click",()=>re(N,"\u53D8\u91CF\u540D","\u53D8\u91CF\u503C")),M.appendChild(N),M.appendChild(I),l.appendChild(M);let P=g("div",{className:"studio-form-group",style:{display:"none"}});P.appendChild(g("label",{className:"studio-form-label",text:"\u81EA\u5B9A\u4E49 Headers"}));let L=g("div",{className:"studio-kv-list"}),K=g("button",{className:"studio-kv-add"},[Ee(he.plus,12),g("span",{text:"\u6DFB\u52A0 Header"})]);K.addEventListener("click",()=>re(L,"Header \u540D","Header \u503C")),P.appendChild(L),P.appendChild(K),l.appendChild(P);let f=g("div",{className:"studio-mcp-test-result"});l.appendChild(f),d.appendChild(l),r.appendChild(d);let U=g("div",{className:"studio-modal-footer"}),k=g("button",{className:"studio-btn",text:"\u6D4B\u8BD5\u8FDE\u63A5"});k.addEventListener("click",ie);let F=g("button",{className:"studio-btn",text:"\u53D6\u6D88"});F.addEventListener("click",Ye);let w=g("button",{className:"studio-btn primary",text:"\u4FDD\u5B58"});w.addEventListener("click",Ae),U.appendChild(k),U.appendChild(F),U.appendChild(w),r.appendChild(U),s.appendChild(r),s.addEventListener("click",q=>{q.target===s&&Ye()}),t.appendChild(s);function ae(q,W){let Ie=g("div",{className:"studio-kv-row"}),be=g("input",{className:"studio-input",attrs:{placeholder:W}}),ge=g("button",{className:"studio-kv-remove"},[Ee(he.x,12)]);ge.addEventListener("click",()=>Ie.remove()),Ie.appendChild(be),Ie.appendChild(ge),q.appendChild(Ie)}function re(q,W,Ie){let be=g("div",{className:"studio-kv-row"}),ge=g("input",{className:"studio-input",attrs:{placeholder:W}}),fe=g("input",{className:"studio-input",attrs:{placeholder:Ie}}),Be=g("button",{className:"studio-kv-remove"},[Ee(he.x,12)]);Be.addEventListener("click",()=>be.remove()),be.appendChild(ge),be.appendChild(fe),be.appendChild(Be),q.appendChild(be)}function ue(){let q=o==="stdio";C.style.display=q?"block":"none",T.style.display=q?"none":"block",P.style.display=q?"none":"block"}function le(){let q=u.value.trim();if(!q)return f.className="studio-mcp-test-result error",f.textContent="\u8BF7\u8F93\u5165\u670D\u52A1\u5668\u540D\u79F0",null;let W={name:q,transport:o};if(o==="stdio"){let be=_.value.trim();if(!be)return f.className="studio-mcp-test-result error",f.textContent="\u8BF7\u8F93\u5165\u542F\u52A8\u547D\u4EE4",null;W.command=be;let ge=[];h.querySelectorAll("input").forEach(fe=>{let Be=fe.value.trim();Be&&ge.push(Be)}),W.args=ge}else{let be=z.value.trim();if(!be)return f.className="studio-mcp-test-result error",f.textContent="\u8BF7\u8F93\u5165\u670D\u52A1\u5668 URL",null;W.url=be;let ge={};L.querySelectorAll(".studio-kv-row").forEach(fe=>{let Be=fe.querySelectorAll("input"),H=Be[0].value.trim(),Z=Be[1].value.trim();H&&(ge[H]=Z)}),W.headers=ge}let Ie={};return N.querySelectorAll(".studio-kv-row").forEach(be=>{let ge=be.querySelectorAll("input"),fe=ge[0].value.trim(),Be=ge[1].value.trim();fe&&(Ie[fe]=Be)}),W.env=Ie,W}async function ie(){let q=le();if(q){f.className="studio-mcp-test-result loading",f.textContent="\u6B63\u5728\u6D4B\u8BD5\u8FDE\u63A5...";try{let W=await Oe("mcp.test",{config:q});W.ok?(f.className="studio-mcp-test-result success",f.textContent="\u8FDE\u63A5\u6210\u529F\uFF01"):(f.className="studio-mcp-test-result error",f.textContent=`\u8FDE\u63A5\u5931\u8D25\uFF1A${W.error??"\u672A\u77E5\u9519\u8BEF"}`)}catch(W){f.className="studio-mcp-test-result error",f.textContent=`\u8FDE\u63A5\u5931\u8D25\uFF1A${W instanceof Error?W.message:String(W)}`}}}async function Ae(){let q=le();if(q)try{let W=await Oe("mcp.save",{serverId:n??q.name,config:q});W.ok?(ke.mcpServers.includes(q.name)||ke.mcpServers.push(q.name),Qe.emit("ui:mcp-saved",q),Ye()):(f.className="studio-mcp-test-result error",f.textContent=`\u4FDD\u5B58\u5931\u8D25\uFF1A${W.error??"\u672A\u77E5\u9519\u8BEF"}`)}catch(W){f.className="studio-mcp-test-result error",f.textContent=`\u4FDD\u5B58\u5931\u8D25\uFF1A${W instanceof Error?W.message:String(W)}`}}function Me(q){u.value=q??"",_.value="",z.value="",h.replaceChildren(),N.replaceChildren(),L.replaceChildren(),o="stdio",m.value="stdio",ue()}function Te(q){o=q.transport??"stdio",m.value=o,_.value=q.command??"",z.value=q.url??"";for(let W of q.args??[]){ae(h,"\u53C2\u6570\u503C");let Ie=h.querySelectorAll("input");Ie[Ie.length-1].value=W}for(let[W,Ie]of Object.entries(q.env??{})){re(N,"\u53D8\u91CF\u540D","\u53D8\u91CF\u503C");let be=N.querySelectorAll(".studio-kv-row"),ge=be[be.length-1].querySelectorAll("input");ge[0].value=W,ge[1].value=Ie}for(let[W,Ie]of Object.entries(q.headers??{})){re(L,"Header \u540D","Header \u503C");let be=L.querySelectorAll(".studio-kv-row"),ge=be[be.length-1].querySelectorAll("input");ge[0].value=W,ge[1].value=Ie}ue()}function oe(q){n=q??null,i.querySelector(".studio-modal-title").textContent=q?"\u7F16\u8F91 MCP \u670D\u52A1\u5668":"\u6DFB\u52A0 MCP \u670D\u52A1\u5668",s.style.display="flex",f.className="studio-mcp-test-result",f.textContent="",Me(q),q&&We(q)}async function We(q){try{let W=await Oe("mcp.get",{serverId:q});if(!W.ok||!W.data){f.className="studio-mcp-test-result error",f.textContent=`\u8BFB\u53D6\u914D\u7F6E\u5931\u8D25\uFF1A${W.error??"\u672A\u77E5\u9519\u8BEF"}`;return}let Ie=W.data.config;Ie&&Te(Ie)}catch(W){f.className="studio-mcp-test-result error",f.textContent=`\u8BFB\u53D6\u914D\u7F6E\u5931\u8D25\uFF1A${W instanceof Error?W.message:String(W)}`}}function Ye(){s.style.display="none"}return Qe.on("ui:mcp-add",()=>oe()),Qe.on("ui:mcp-edit",q=>oe(q)),{container:e,open:oe,close:Ye}}var gA=`
  .studio-picker-modal { width: 520px; }
  .studio-picker-mode-toggle {
    display: flex; justify-content: center; gap: 0; margin-bottom: 20px;
  }
  .studio-picker-mode-btn {
    padding: 8px 24px; border: 1px solid #e0e0e0; background: #fff;
    cursor: pointer; font-size: 14px; color: #666; transition: all 0.15s;
  }
  .studio-picker-mode-btn:first-child { border-radius: 8px 0 0 8px; }
  .studio-picker-mode-btn:last-child { border-radius: 0 8px 8px 0; border-left: none; }
  .studio-picker-mode-btn.active { background: #4D6BFE; color: #fff; border-color: #4D6BFE; font-weight: 500; }
  .studio-picker-search { margin-bottom: 12px; position: relative; }
  .studio-picker-search input { padding-left: 36px; }
  .studio-picker-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #aaa; }
  .studio-picker-list { max-height: 300px; overflow-y: auto; margin-bottom: 12px; }
  .studio-picker-item {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border-radius: 8px; cursor: pointer; transition: all 0.15s; margin-bottom: 4px;
  }
  .studio-picker-item:hover { background: #f5f7ff; }
  .studio-picker-item.active { background: #eef1ff; }
  .studio-picker-item-icon { flex-shrink: 0; color: #4D6BFE; }
  .studio-picker-item-info { flex: 1; min-width: 0; }
  .studio-picker-item-name { font-size: 14px; font-weight: 500; color: #333; }
  .studio-picker-item-path { font-size: 11px; color: #999; font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .studio-picker-item-check { color: #4D6BFE; flex-shrink: 0; }
  .studio-picker-actions { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #f0f0f0; padding-top: 12px; }
  .studio-picker-action-btn {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: none; background: transparent; cursor: pointer; border-radius: 8px;
    font-size: 13px; color: #555; transition: all 0.15s; text-align: left;
  }
  .studio-picker-action-btn:hover { background: #f5f7ff; color: #4D6BFE; }
  .studio-picker-empty { text-align: center; padding: 40px 20px; color: #aaa; font-size: 13px; }
  .studio-picker-hint { margin: 0 0 10px; font-size: 12px; color: #b42318; }
`;function sa(){let{container:e,shadow:t}=mt("studio-project-picker-root");ht(t,gA);let n=!1,o="",s=g("div",{className:"studio-modal-overlay",style:{display:"none"}}),r=g("div",{className:"studio-modal studio-picker-modal"}),i=g("div",{className:"studio-modal-header"},[g("h2",{className:"studio-modal-title",text:"\u9009\u62E9\u9879\u76EE"})]),a=g("button",{className:"studio-close-btn"},[Ee(he.x,18)]);a.addEventListener("click",N),i.appendChild(a),r.appendChild(i);let d=g("div",{className:"studio-modal-body"}),l=g("div",{className:"studio-picker-mode-toggle"}),A=g("button",{className:"studio-picker-mode-btn",text:"\u5BF9\u8BDD"}),u=g("button",{className:"studio-picker-mode-btn active",text:"\u5DE5\u4F5C"});A.addEventListener("click",()=>{A.classList.add("active"),u.classList.remove("active")}),u.addEventListener("click",()=>{u.classList.add("active"),A.classList.remove("active")}),l.appendChild(A),l.appendChild(u),d.appendChild(l);let x=g("div",{className:"studio-picker-search"}),m=g("span",{className:"studio-picker-search-icon"});m.appendChild(Ee(he.search,16));let C=g("input",{className:"studio-input",attrs:{placeholder:"\u641C\u7D22\u9879\u76EE..."}});C.addEventListener("input",I=>{o=I.target.value.toLowerCase(),z()}),x.appendChild(m),x.appendChild(C),d.appendChild(x);let b=g("div",{className:"studio-picker-list"});d.appendChild(b);let _=g("p",{className:"studio-picker-hint",text:""});_.hidden=!0,d.appendChild(_);let S=g("div",{className:"studio-picker-actions"}),h=g("button",{className:"studio-picker-action-btn"},[Ee(he.plus,16),g("span",{text:"\u521B\u5EFA\u65B0\u9879\u76EE"})]);h.addEventListener("click",()=>{N(),Qe.emit("ui:new-project")});let R=g("button",{className:"studio-picker-action-btn"},[Ee(he.folder,16),g("span",{text:"\u901A\u8FC7\u672C\u5730\u6587\u4EF6\u5939\u521B\u5EFA\u9879\u76EE"})]);R.addEventListener("click",async()=>{let I=await Oe("folder.pick",{});if(I.ok&&I.data){let P=I.data.path,L=P.split(/[\\/]/).filter(Boolean).pop()??"\u65B0\u9879\u76EE";await Oe("project.create",{name:L,path:P}),Qe.emit("ui:project-created",{id:L,name:L,path:P}),N()}}),S.appendChild(h),S.appendChild(R),d.appendChild(S),r.appendChild(d),s.appendChild(r),s.addEventListener("click",I=>{I.target===s&&N()}),t.appendChild(s);let T=[{id:"deepseek-studio",name:"deepseek-studio",path:"E:\\NAS\\deepseek-studio"}];async function B(){try{let I=await Oe("project.list",{});I.ok&&I.data&&(T=I.data.projects)}catch{}z()}function z(){b.replaceChildren();let I=T.filter(P=>!o||P.name.toLowerCase().includes(o)||P.path.toLowerCase().includes(o));if(I.length===0){b.appendChild(g("div",{className:"studio-picker-empty",text:o?"\u6CA1\u6709\u5339\u914D\u7684\u9879\u76EE":"\u6682\u65E0\u9879\u76EE"}));return}for(let P of I){let L=P.id===ke.currentProject,K=g("div",{className:`studio-picker-item${L?" active":""}`});if(K.innerHTML=`
        <span class="studio-picker-item-icon"></span>
        <div class="studio-picker-item-info">
          <div class="studio-picker-item-name">${qe(P.name)}</div>
          <div class="studio-picker-item-path">${qe(P.path)}</div>
        </div>
      `,K.querySelector(".studio-picker-item-icon").appendChild(Ee(he.folder,18)),L){let f=g("span",{className:"studio-picker-item-check"});f.appendChild(Ee(he.check,16)),K.appendChild(f)}K.addEventListener("click",async()=>{_.hidden=!0;let f=await Oe("workspace.set",{root:P.path});if(!f.ok){_.hidden=!1,_.textContent=`\u5207\u6362\u5DE5\u4F5C\u533A\u5931\u8D25\uFF1A${f.error??"\u672A\u77E5\u9519\u8BEF"}`;return}let U=f.data?.root??P.path;ke.currentProject=P.id,ke.workspaceRoot=U,Qe.emit("ui:project-switched",P),Qe.emit("ui:workspace-changed",U),N()}),b.appendChild(K)}}function M(){n=!0,s.style.display="flex",o="",C.value="",B()}function N(){n=!1,s.style.display="none"}return Qe.on("ui:project-picker",()=>{n?N():M()}),Qe.on("ui:new-project",()=>{n?N():M()}),{container:e,open:M,close:N}}var ra="studio-composer-actions-styles",Ao=new WeakMap,fA=e=>(e??"").replace(/\s+/g,""),mA=`
  .studio-composer-actions {
    position: fixed;
    z-index: 2147483638;
    display: none;
    align-items: center;
    gap: 4px;
    height: 30px;
    padding: 0 4px;
    color: #5d6470;
    font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    pointer-events: auto;
    white-space: nowrap;
  }
  .studio-composer-actions.is-visible { display: inline-flex; }
  .studio-composer-actions-divider {
    width: 1px;
    height: 18px;
    margin: 0 3px;
    background: rgba(120, 128, 142, 0.26);
  }
  .studio-composer-action {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    height: 28px;
    padding: 0 10px;
    border: 1px solid rgba(77, 107, 254, 0.2);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.92);
    color: #536079;
    cursor: pointer;
    font: inherit;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .studio-composer-action:hover,
  .studio-composer-action[aria-expanded="true"] {
    border-color: rgba(77, 107, 254, 0.46);
    background: #eef1ff;
    color: #4059d6;
  }
  .studio-composer-action svg { flex: 0 0 auto; }
  .studio-composer-actions.is-compact .studio-composer-action {
    width: 28px;
    padding: 0;
    justify-content: center;
  }
  .studio-composer-actions.is-compact .studio-composer-action-label { display: none; }
  .studio-composer-policy {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    min-width: 176px;
    padding: 5px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 12px 32px rgba(20, 27, 45, 0.18);
  }
  .studio-composer-policy[hidden] { display: none; }
  .studio-composer-policy-option {
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: #333b4a;
    cursor: pointer;
    text-align: left;
    font: 500 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .studio-composer-policy-option:hover { background: #f1f4ff; }
  .studio-composer-policy-option[aria-checked="true"] { color: #4059d6; background: #edf1ff; }
  .studio-composer-policy-error {
    max-width: 210px;
    padding: 7px 8px 4px;
    color: #b42318;
    font-size: 11px;
    white-space: normal;
  }
  @media (prefers-color-scheme: dark) {
    .studio-composer-actions { color: #c8ceda; }
    .studio-composer-action {
      border-color: rgba(143, 160, 255, 0.26);
      background: rgba(32, 38, 52, 0.94);
      color: #d6dbea;
    }
    .studio-composer-action:hover,
    .studio-composer-action[aria-expanded="true"] {
      background: #2d3655;
      color: #fff;
    }
    .studio-composer-policy {
      border-color: rgba(255, 255, 255, 0.12);
      background: #202633;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
    }
    .studio-composer-policy-option { color: #e4e8f2; }
    .studio-composer-policy-option:hover { background: #2c3448; }
    .studio-composer-policy-option[aria-checked="true"] { color: #b8c5ff; background: #303a5c; }
  }
`;function hA(e){if(e.getElementById(ra))return;let t=e.createElement("style");t.id=ra,t.textContent=mA,(e.head??e.documentElement).appendChild(t)}function CA(e=document){let t=Array.from(e.querySelectorAll('button,[role="button"],.ds-toggle-button,[tabindex="0"]')),n=r=>{for(let i=t.length-1;i>=0;i-=1)if(fA(t[i].textContent)===r)return t[i];return null},o=n("\u6DF1\u5EA6\u601D\u8003"),s=n("\u667A\u80FD\u641C\u7D22");return o&&s?{deepThink:o,smartSearch:s}:null}function IA(e){return e?e.replace(/[\\/]+$/,"").split(/[\\/]/).filter(Boolean).at(-1)??e:"\u5DE5\u4F5C\u533A"}function uo(e,t,n,o){let s=e.createElement("button");s.type="button",s.className="studio-composer-action",s.dataset.action=t,s.title=n,s.setAttribute("aria-label",n),s.appendChild(Ee(o,14));let r=e.createElement("span");return r.className="studio-composer-action-label",r.textContent=n,s.appendChild(r),{button:s,label:r}}function ia(e){let t=e.root??document,n=e.view??window;hA(t);let o=t.createElement("div");o.className="studio-composer-actions",o.setAttribute("role","toolbar"),o.setAttribute("aria-label","Studio \u5FEB\u6377\u64CD\u4F5C");let s=t.createElement("span");s.className="studio-composer-actions-divider",s.setAttribute("aria-hidden","true"),o.appendChild(s);let r=uo(t,"workspace","\u5DE5\u4F5C\u533A",he.folder),i=uo(t,"policy",it.auto,he.check),a=uo(t,"skills","\u6280\u80FD",he.book),d=uo(t,"settings","\u8BBE\u7F6E",he.settings);i.button.setAttribute("aria-haspopup","menu"),i.button.setAttribute("aria-expanded","false"),o.append(r.button,i.button,a.button,d.button);let l=t.createElement("div");l.className="studio-composer-policy",l.setAttribute("role","menu"),l.hidden=!0,o.appendChild(l);let A=new Map;for(let F of en){let w=t.createElement("button");w.type="button",w.className="studio-composer-policy-option",w.dataset.policy=F,w.setAttribute("role","menuitemradio"),w.textContent=it[F],w.addEventListener("click",async ae=>{ae.stopPropagation();let re=e.store.getSnapshot().policyMode;if(await e.store.setPolicy(F)){h();return}R();let le=e.store.getSnapshot().error??"\u4FDD\u5B58\u5931\u8D25",ie=l.querySelector(".studio-composer-policy-error");ie&&(ie.textContent=`\u5BA1\u6279\u6863\u4F4D\u4FDD\u5B58\u5931\u8D25\uFF1A${le}\uFF08\u4ECD\u4E3A ${it[re]}\uFF09`)}),A.set(F,w),l.appendChild(w)}let u=t.createElement("div");u.className="studio-composer-policy-error",u.hidden=!0,l.appendChild(u);let x=!0,m=!1,C=0,b=null,_=null,S=!1;function h(){l.hidden=!0,i.button.setAttribute("aria-expanded","false"),u.hidden=!0,u.textContent=""}function R(){let F=e.store.getSnapshot();r.label.textContent=IA(F.workspaceRoot),r.button.title=F.workspaceRoot??"\u9009\u62E9\u5DE5\u4F5C\u533A",i.label.textContent=it[F.policyMode],i.button.title=`\u5BA1\u6279\uFF1A${it[F.policyMode]}`,i.button.setAttribute("aria-label",i.button.title),r.button.setAttribute("aria-busy",String(F.loading)),i.button.setAttribute("aria-busy",String(F.loading));for(let[w,ae]of A)ae.setAttribute("aria-checked",String(w===F.policyMode));F.error&&(u.hidden=!1,u.textContent=`\u5BBF\u4E3B\u9519\u8BEF\uFF1A${F.error}`)}function T(F){F!==b&&(_?.disconnect(),b=F,!(!F||typeof ResizeObserver>"u")&&(_=new ResizeObserver(()=>M()),_.observe(F)))}function B(){o.classList.remove("is-visible"),h()}function z(){if(S)return;if(!x){B();return}let F=CA(t);if(T(F?.smartSearch??null),!F){B(),m||(m=!0,console.warn("[StudioUI] composer actions hidden: native \u6DF1\u5EA6\u601D\u8003/\u667A\u80FD\u641C\u7D22 anchor not found"));return}let w=F.smartSearch.getBoundingClientRect();if(!Number.isFinite(w.left)||w.width<=0&&w.height<=0){B();return}let ae=Number.isFinite(n.innerWidth)&&n.innerWidth>0?n.innerWidth:1024,re=Math.max(6,w.top+(w.height-30)/2),ue=w.right+8;o.style.left=`${Math.round(ue)}px`,o.style.top=`${Math.round(re)}px`,o.classList.add("is-visible"),o.classList.remove("is-compact");let le=o.getBoundingClientRect().width||236;ue+le>ae-12&&o.classList.add("is-compact");let Ae=o.classList.contains("is-compact")?o.getBoundingClientRect().width||132:le;ue+Ae>ae-8&&B()}function M(){C===0&&(C=n.setTimeout(()=>{C=0,z()},40))}r.button.addEventListener("click",()=>{h(),Qe.emit("ui:project-picker")}),i.button.addEventListener("click",F=>{F.stopPropagation();let w=l.hidden;l.hidden=!w,l.style.left=`${i.button.offsetLeft}px`,i.button.setAttribute("aria-expanded",String(w)),w&&e.store.refresh()}),a.button.addEventListener("click",()=>{h(),e.openSettings("skills")}),d.button.addEventListener("click",()=>{h(),e.openSettings("general")});let N=F=>{o.contains(F.target)||h()},I=F=>{F.key==="Escape"&&h()},P=F=>{let w=F.detail;typeof w?.visible=="boolean"&&(x=w.visible,x?z():B())};t.addEventListener("click",N,!0),t.addEventListener("keydown",I,!0),n.addEventListener("resize",M),n.addEventListener("scroll",M,!0),n.addEventListener("studio:visibility-changed",P);let L=new MutationObserver(()=>M());L.observe(t.body??t.documentElement,{childList:!0,subtree:!0});let K=e.store.subscribe(R),f=Qe.on("ui:workspace-changed",()=>{e.store.refresh()}),U=Qe.on("ui:project-switched",()=>{e.store.refresh()});R(),t.body?t.body.appendChild(o):t.documentElement.appendChild(o),M(),e.store.refresh();let k={container:o,reposition:z,destroy(){S=!0,L.disconnect(),_?.disconnect(),K(),f(),U(),t.removeEventListener("click",N,!0),t.removeEventListener("keydown",I,!0),n.removeEventListener("resize",M),n.removeEventListener("scroll",M,!0),n.removeEventListener("studio:visibility-changed",P),C!==0&&n.clearTimeout(C),o.remove(),Ao.get(t)===k&&Ao.delete(t)}};return Ao.get(t)?.destroy(),Ao.set(t,k),k}var yA="Studio \u8BBE\u7F6E",ys="\u7CFB\u7EDF\u8BBE\u7F6E",Es="data-studio-settings-entry",EA=40,bA=1e3,xA=[60,300,900];function Nn(e){return e.replace(/\s+/g,"").trim()}function kA(e,t,n){let o=Nn(t),s=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),r=s.nextNode();for(;r;)Nn(r.nodeValue??"")===o&&(r.nodeValue=n),r=s.nextNode()}function aa(e){let t=e.parentElement;if(!t)return!1;let n=Nn(t.textContent??"");return n.includes("\u9000\u51FA\u767B\u5F55")||n.includes("\u5E2E\u52A9\u4E0E\u53CD\u9988")}function wA(e=document){let n=Array.from(e.querySelectorAll("*")).filter(r=>Nn(r.textContent??"")===ys);if(n.length===0)return null;let o=n.filter(r=>Nn(r.parentElement?.textContent??"")!==ys),s=o.length>0?o:n;for(let r=s.length-1;r>=0;r-=1){let i=s[r];if(aa(i)||aa(i.parentElement??i))return i}return null}function po(e=document){if(document.querySelector(`[${Es}="1"]`))return!0;let t=wA(e);if(!t||!t.parentElement)return!1;let n=t.cloneNode(!0);return n.setAttribute(Es,"1"),n.setAttribute("role","menuitem"),n.removeAttribute("id"),n.removeAttribute("href"),n.removeAttribute("target"),kA(n,ys,yA),n.style.cursor="pointer",n.addEventListener("click",o=>{o.preventDefault(),o.stopPropagation(),Qe.emit("ui:settings")}),t.insertAdjacentElement("afterend",n),console.log("[StudioUI] settings entry injected next to \u7CFB\u7EDF\u8BBE\u7F6E"),!0}function BA(e){if(document.body&&document.readyState!=="loading"){e();return}if(document.body){e();return}document.addEventListener("DOMContentLoaded",()=>e(),{once:!0})}function la(e){li(e);let t=[],n=co({call:(u,x)=>e.sendToolCall({callId:`controls-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,invocationName:u,params:x})}),o=null,s=null,r=null,i=0,a=[];function d(u,x){try{let m=x();document.body.appendChild(m.container),t.push(m.container),console.log(`[StudioUI] ${u} mounted`)}catch(m){console.error(`[StudioUI] ${u} failed:`,m)}}function l(){for(let u of xA)a.push(window.setTimeout(()=>void po(),u))}function A(){try{o=ta({controls:n}),document.body.appendChild(o.container),t.push(o.container),console.log("[StudioUI] settings panel mounted")}catch(u){console.error("[StudioUI] settings panel failed:",u)}d("skills panel",na),d("mcp dialog",oa),d("project picker",sa);try{s=ia({store:n,openSettings:u=>o?.open(u)}),console.log("[StudioUI] composer actions installed")}catch(u){console.error("[StudioUI] composer actions failed:",u)}document.addEventListener("click",l,!0),r=window.setInterval(()=>{i+=1,(po()||i>=EA)&&r!==null&&(window.clearInterval(r),r=null)},bA),po()}return BA(A),{open(u="general"){o?.open(u)},destroy(){r!==null&&(window.clearInterval(r),r=null);for(let u of a)window.clearTimeout(u);a.length=0,document.removeEventListener("click",l,!0),s?.destroy(),s=null,o?.destroy(),o=null,n.destroy(),document.querySelectorAll(`[${Es}="1"]`).forEach(u=>u.remove());for(let u of t)u.remove();t.length=0}}}typeof window<"u"&&(window.__studioInjectSettingsEntry=()=>po());var vA={running:"\u6267\u884C\u4E2D",succeeded:"\u5DF2\u6267\u884C",failed:"\u5931\u8D25",denied:"\u88AB\u62D2",cancelled:"\u5DF2\u53D6\u6D88",terminated:"\u5DF2\u7EC8\u6B62"},QA=2048,ca=["cmd","command","script","shell","args","argv","query","pattern","path","file","filename","filePath","file_path","url","uri","name","title","prompt","input","text","content","message","description","retries"],SA=/(denied|forbidden|unauthori[sz]ed|permission|not\s+allowed|rejected|refus|拒绝|权限|授权|不允许|无权)/i,TA=/(cancell?ed|abort(ed)?|interrupt(ed)?|取消|中止|中断)/i;function Tt(e){return String(qe(String(e??"")))}function DA(e){return!!(e.startsWith("data:image/")||e.startsWith("https://"))}function pa(e){try{return String(e)}catch{return"[unserializable]"}}function da(e){try{return JSON.stringify(e,null,2)??""}catch{return pa(e)}}function ga(e){try{return JSON.stringify(e)??""}catch{return pa(e)}}function Bs(e){if(e===void 0||e==="")return;let t=Number(e);return Number.isFinite(t)?t:void 0}function fo(e){if(typeof e!="number"||!Number.isFinite(e)||e<0)return"";if(e<1e3)return`${Math.round(e)}ms`;let t=Math.round(e/100)/10;if(t<60)return`${t.toFixed(1)}s`;let n=Math.floor(t/60),o=Math.round(t-n*60);return o>0?`${n}m ${o}s`:`${n}m`}function bs(e){return e.trim().replace(/\s+/g," ")}function go(e,t){return e.length<=t?e:`${e.slice(0,t-1)}\u2026`}function RA(e,t=96){let n=e!==null&&typeof e=="object"?e:{};for(let o=0;o<ca.length;o+=1){let s=ca[o],r=n[s];if(typeof r=="number"||typeof r=="boolean")return go(`${s}=${String(r)}`,t);if(typeof r=="string"&&r.trim()!=="")return go(bs(r),t);if(Array.isArray(r)&&r.length>0&&r.every(i=>typeof i=="string"))return go(bs(r.join(" ")),t)}return go(bs(ga(n)),t)}function NA(e){if(typeof e!="string")return null;switch(e.trim().toLowerCase().replace(/[\s-]+/g,"_")){case"running":case"pending":case"in_progress":case"inprogress":case"started":return"running";case"success":case"succeeded":case"ok":case"completed":case"complete":case"done":return"succeeded";case"failed":case"failure":case"error":case"errored":return"failed";case"denied":case"rejected":case"forbidden":case"unauthorized":case"refused":case"permission_denied":return"denied";case"cancelled":case"canceled":case"aborted":case"interrupted":return"cancelled";case"terminated":case"terminate":return"terminated";default:return null}}function fa(e){if(!e)return"running";let t=e.details;if(t&&typeof t=="object"){let s=["status","state","outcome"];for(let r=0;r<s.length;r+=1){let i=NA(t[s[r]]);if(i)return i}}if(e.terminate===!0)return"terminated";if(!(e.isError===!0||e.ok===!1))return"succeeded";let o=`${e.error??""} ${ga(e.details??{})}`;return SA.test(o)?"denied":TA.test(o)?"cancelled":"failed"}var MA=`
  .ds-flow {
    --dsf-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
    --dsf-ink: #1b1f24;
    --dsf-muted: #697079;
    --dsf-faint: #9aa2ab;
    --dsf-rule: #e5e8ec;
    --dsf-hover: rgba(20, 26, 33, 0.045);
    --dsf-run: #2f6fdb;
    --dsf-run-tint: rgba(47, 111, 219, 0.055);
    --dsf-ok: #a6adb5;
    --dsf-fail: #c2352c;
    --dsf-fail-tint: rgba(194, 53, 44, 0.055);
    --dsf-term: #a16207;
    --dsf-cancel: #7c848d;
    margin: 10px 0 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 13px;
    line-height: 1.65;
    color: var(--dsf-ink);
  }

  .ds-flow [hidden] { display: none !important; }

  /* \u4E00\u884C\u6458\u8981\uFF1A\u6536\u8D77\u65F6\u6574\u6BB5\u8FC7\u7A0B\u53EA\u6709\u8FD9\u4E00\u884C */
  .ds-flow-summary {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 26px;
    padding: 2px 4px;
    background: none;
    border: 0;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.01em;
    color: var(--dsf-muted);
    text-align: left;
    cursor: pointer;
    user-select: none;
  }
  .ds-flow-summary:hover { color: var(--dsf-ink); }
  .ds-flow-summary:focus-visible { outline: 1px solid var(--dsf-run); outline-offset: 2px; }
  .ds-flow-summary-text {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ds-flow-summary-time {
    margin-left: auto;
    font-family: var(--dsf-mono);
    font-size: 11px;
    color: var(--dsf-faint);
    font-variant-numeric: tabular-nums;
  }

  /* \u6298\u89D2\u7BAD\u5934\uFF1ACSS \u7ED8\u5236\uFF0C\u4E0D\u4F9D\u8D56\u5B57\u5F62 */
  .ds-flow-chev {
    flex: none;
    width: 6px;
    height: 6px;
    margin-top: -1px;
    border-right: 1.4px solid currentColor;
    border-bottom: 1.4px solid currentColor;
    transform: rotate(-45deg);
    transition: transform 0.15s ease;
    opacity: 0.7;
  }
  .ds-flow[data-open='true'] > .ds-flow-summary .ds-flow-chev { transform: rotate(45deg); }

  /* \u8C03\u7528\u5217\u8868\uFF1A\u5DE6\u4FA7\u53D1\u4E1D\u7EBF\u505A\u65F6\u95F4\u7EBF\uFF0C\u5C42\u7EA7\u9760\u7F29\u8FDB\u4E0E\u7559\u767D */
  .ds-flow-list {
    margin: 2px 0 0;
    padding: 2px 0 2px 12px;
    border-left: 1px solid var(--dsf-rule);
  }
  .ds-flow-item { position: relative; }
  .ds-flow-item + .ds-flow-item { margin-top: 1px; }

  /* \u884C\u7EA7\u6761\u76EE */
  .ds-flow-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 4px 4px;
    background: none;
    border: 0;
    font-family: inherit;
    font-size: 12.5px;
    color: inherit;
    text-align: left;
    cursor: pointer;
    user-select: none;
  }
  .ds-flow-row:hover { background: var(--dsf-hover); }
  .ds-flow-row:focus-visible { outline: 1px solid var(--dsf-run); outline-offset: -1px; }

  .ds-flow-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--dsf-ok);
  }
  .ds-flow-item[data-status='running'] .ds-flow-dot {
    background: var(--dsf-run);
    animation: ds-flow-pulse 1.1s ease-in-out infinite;
  }
  .ds-flow-item[data-status='succeeded'] .ds-flow-dot { background: var(--dsf-ok); }
  .ds-flow-item[data-status='failed'] .ds-flow-dot { background: var(--dsf-fail); }
  .ds-flow-item[data-status='denied'] .ds-flow-dot {
    background: none;
    box-shadow: inset 0 0 0 1.5px var(--dsf-fail);
  }
  .ds-flow-item[data-status='cancelled'] .ds-flow-dot {
    background: none;
    box-shadow: inset 0 0 0 1.5px var(--dsf-cancel);
  }
  .ds-flow-item[data-status='terminated'] .ds-flow-dot { background: var(--dsf-term); }

  .ds-flow-tool {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--dsf-mono);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: inherit;
  }
  .ds-flow-brief {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--dsf-mono);
    font-size: 11.5px;
    color: inherit;
    opacity: 0.58;
  }
  .ds-flow-status {
    flex: none;
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--dsf-muted);
  }
  .ds-flow-status--quiet {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .ds-flow-item[data-status='running'] .ds-flow-status { color: var(--dsf-run); }
  .ds-flow-item[data-status='failed'] .ds-flow-status,
  .ds-flow-item[data-status='denied'] .ds-flow-status { color: var(--dsf-fail); }
  .ds-flow-item[data-status='cancelled'] .ds-flow-status { color: var(--dsf-cancel); }
  .ds-flow-item[data-status='terminated'] .ds-flow-status { color: var(--dsf-term); }

  .ds-flow-time {
    flex: none;
    font-family: var(--dsf-mono);
    font-size: 11px;
    color: inherit;
    opacity: 0.45;
    font-variant-numeric: tabular-nums;
  }

  .ds-flow-item[data-status='running'] .ds-flow-row { background: var(--dsf-run-tint); }
  .ds-flow-item[data-status='failed'] .ds-flow-row,
  .ds-flow-item[data-status='denied'] .ds-flow-row {
    background: var(--dsf-fail-tint);
    color: var(--dsf-fail);
  }

  /* \u5C55\u5F00\u533A\uFF1A\u65E0\u5361\u7247\u5305\u88F9\uFF0C\u6807\u7B7E + \u7F29\u8FDB + \u7B49\u5BBD\u6587\u672C */
  .ds-flow-body {
    padding: 2px 4px 10px 14px;
    animation: ds-flow-in 0.14s ease-out;
  }
  .ds-flow-line {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }
  .ds-flow-line + .ds-flow-line { margin-top: 9px; }
  .ds-flow-tag {
    padding-top: 2px;
    font-size: 10.5px;
    letter-spacing: 0.08em;
    color: var(--dsf-faint);
    user-select: none;
  }
  .ds-flow-out { min-width: 0; }
  .ds-flow-pre {
    margin: 0;
    padding: 0;
    max-height: 320px;
    overflow: auto;
    font-family: var(--dsf-mono);
    font-size: 11.5px;
    line-height: 1.65;
    color: var(--dsf-ink);
    white-space: pre-wrap;
    word-break: break-word;
    tab-size: 2;
  }
  .ds-flow-pre--muted { color: var(--dsf-muted); }
  .ds-flow-pre--error { color: var(--dsf-fail); }

  .ds-flow-clamp {
    max-height: 132px;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, #000 62%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 62%, transparent 100%);
  }
  .ds-flow-clamp .ds-flow-pre { max-height: none; overflow: visible; }
  .ds-flow-more {
    display: inline-block;
    margin: 6px 0 0;
    padding: 0;
    background: none;
    border: 0;
    font-family: inherit;
    font-size: 11px;
    color: var(--dsf-run);
    cursor: pointer;
  }
  .ds-flow-more:hover { text-decoration: underline; }

  .ds-flow-shots { display: flex; flex-direction: column; gap: 6px; }
  .ds-flow-shot {
    display: block;
    max-width: 100%;
    max-height: 360px;
    width: auto;
    height: auto;
  }

  @keyframes ds-flow-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.32; }
  }
  @keyframes ds-flow-in {
    from { opacity: 0; transform: translateY(-1px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-color-scheme: dark) {
    .ds-flow {
      --dsf-ink: #e8ebee;
      --dsf-muted: #98a0a9;
      --dsf-faint: #6d757e;
      --dsf-rule: #2b3138;
      --dsf-hover: rgba(255, 255, 255, 0.05);
      --dsf-run: #7ba4ff;
      --dsf-run-tint: rgba(123, 164, 255, 0.09);
      --dsf-ok: #5c646d;
      --dsf-fail: #f08076;
      --dsf-fail-tint: rgba(240, 128, 118, 0.1);
      --dsf-term: #d2a24c;
      --dsf-cancel: #828b95;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ds-flow,
    .ds-flow * {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
  }
`,Aa="data-ds-flow-style";function ma(){let e=document.head??document.documentElement;if(e.querySelector(`style[${Aa}]`))return;let t=document.createElement("style");t.setAttribute(Aa,"v2"),t.textContent=MA,e.appendChild(t)}var ua=0;function ha(e){return ua+=1,`${e}${ua}`}var xs=new WeakMap;function mo(e){let t=xs.get(e);t!==void 0&&(clearInterval(t),xs.delete(e))}function LA(e,t){mo(e);let n=setInterval(()=>{if(!e.isConnected){mo(e);return}let o=e.querySelector(".ds-flow-time");o&&(o.textContent=fo(Date.now()-t))},1e3);xs.set(e,n)}function _A(e){return String(xr(e))}function FA(e){let t=[],n=e.content;if(!Array.isArray(n))return t;for(let o=0;o<n.length;o+=1){let s=n[o];s&&s.type==="image_url"&&s.image_url&&typeof s.image_url.url=="string"&&DA(s.image_url.url)&&t.push(s.image_url.url)}return t}function UA(e,t,n,o,s){let r=ha("ds-flow-body-"),i=RA(e.params),a=vA[t],d=t==="succeeded",l=n??e.durationMs,A=fo(t==="running"?Date.now()-o:l),u=e.result,x=u?_A(u):"",m=u?FA(u):[],C=x.length>QA&&m.length===0,b=t==="failed"||t==="denied",_=u&&u.details&&Object.keys(u.details).length>0?da(u.details):"",S=[];if(S.push(`
      <div class="ds-flow-line">
        <span class="ds-flow-tag">\u53C2\u6570</span>
        <pre class="ds-flow-pre ds-flow-pre--muted">${Tt(da(e.params))}</pre>
      </div>`),u){let h=m.map(z=>`<img class="ds-flow-shot" src="${Tt(z)}" alt="\u5DE5\u5177\u7ED3\u679C\u56FE\u7247" />`).join(""),R=b?"ds-flow-pre ds-flow-pre--error":"ds-flow-pre",T=`${h?`<div class="ds-flow-shots">${h}</div>`:""}<pre class="${R}">${Tt(x)}</pre>`,B=C?`<div class="ds-flow-clamp">${T}</div><button type="button" class="ds-flow-more">\u5C55\u5F00\u5168\u90E8</button>`:T;S.push(`
      <div class="ds-flow-line">
        <span class="ds-flow-tag">\u8F93\u51FA</span>
        <div class="ds-flow-out">${B}</div>
      </div>`)}return _&&S.push(`
      <div class="ds-flow-line">
        <span class="ds-flow-tag">\u8BE6\u60C5</span>
        <pre class="ds-flow-pre ds-flow-pre--muted">${Tt(_)}</pre>
      </div>`),`
    <button type="button" class="ds-flow-row" aria-expanded="${s?"true":"false"}" aria-controls="${r}">
      <span class="ds-flow-dot" aria-hidden="true"></span>
      <span class="ds-flow-tool">${Tt(e.toolName)}</span>
      <span class="ds-flow-brief">${Tt(i)}</span>
      <span class="ds-flow-status${d?" ds-flow-status--quiet":""}">${Tt(a)}</span>
      <span class="ds-flow-time">${Tt(A)}</span>
      <span class="ds-flow-chev" aria-hidden="true"></span>
    </button>
    <div class="ds-flow-body" id="${r}"${s?"":" hidden"}>${S.join("")}
    </div>
  `}function HA(e){let t=e.querySelector(".ds-flow-row"),n=e.querySelector(".ds-flow-body");t&&n&&t.addEventListener("click",()=>{let s=n.hasAttribute("hidden");s?n.removeAttribute("hidden"):n.setAttribute("hidden",""),t.setAttribute("aria-expanded",s?"true":"false")});let o=e.querySelector(".ds-flow-more");o&&o.addEventListener("click",s=>{s.stopPropagation();let r=e.querySelector(".ds-flow-clamp");r&&r.classList.remove("ds-flow-clamp"),o.remove()})}function ks(e,t,n,o,s,r){let i=e.querySelectorAll(".ds-flow-row");for(let l=0;l<i.length;l+=1)mo(i[l]);e.dataset.status=n,e.dataset.toolName=t.toolName,e.dataset.startedAt=String(s);let a=o??t.durationMs;typeof a=="number"&&Number.isFinite(a)?e.dataset.durationMs=String(a):delete e.dataset.durationMs,e.innerHTML=UA(t,n,a,s,r),HA(e);let d=e.querySelector(".ds-flow-row");d&&(n==="running"?LA(d,s):mo(d))}function Ca(e,t){let n=e.querySelectorAll(".ds-flow-item"),o=String(t);for(let s=0;s<n.length;s+=1){let r=n[s];if(r.dataset.callId===o)return r}return null}function OA(e){let t=e.querySelector(".ds-flow");if(t)return t;ma(),t=document.createElement("section"),t.className="ds-flow",t.setAttribute("data-open","false"),t.innerHTML=`
    <button type="button" class="ds-flow-summary" aria-expanded="false">
      <span class="ds-flow-chev" aria-hidden="true"></span>
      <span class="ds-flow-summary-text">\u5DF2\u8C03\u7528\u5DE5\u5177</span>
      <span class="ds-flow-summary-time"></span>
    </button>
    <div class="ds-flow-list" role="list" hidden></div>
  `;let n=t.querySelector(".ds-flow-list"),o=t.querySelector(".ds-flow-summary");return n.id=ha("ds-flow-list-"),o.setAttribute("aria-controls",n.id),o.addEventListener("click",()=>{let s=n.hasAttribute("hidden");s?n.removeAttribute("hidden"):n.setAttribute("hidden",""),t.setAttribute("data-open",s?"true":"false"),o.setAttribute("aria-expanded",s?"true":"false")}),e.insertBefore(t,e.firstChild),t}function Ia(e){let t=e.querySelector(".ds-flow");if(!t)return;let n=t.querySelectorAll(".ds-flow-item"),o=0,s=0;for(let d=0;d<n.length;d+=1){let l=n[d],A=Bs(l.dataset.durationMs);A!==void 0&&(o+=A),l.dataset.status==="running"&&(s+=1)}let r=`\u5DF2\u8C03\u7528\u5DE5\u5177 \xB7 ${n.length} \u6B21${s>0?` \xB7 ${s} \u6267\u884C\u4E2D`:""}`,i=t.querySelector(".ds-flow-summary-text"),a=t.querySelector(".ds-flow-summary-time");i&&(i.textContent=r),a&&(a.textContent=o>0?fo(o):""),t.setAttribute("data-count",String(n.length))}function ho(e,t,n){ma();let s=OA(n).querySelector(".ds-flow-list"),r=fa(e.result),i=Ca(n,t);if(!i)i=document.createElement("div"),i.className="ds-flow-item",i.setAttribute("role","listitem"),i.dataset.callId=String(t),s.appendChild(i),ks(i,e,r,e.durationMs,Date.now(),!1);else{let a=Bs(i.dataset.startedAt)??Date.now(),d=i.querySelector(".ds-flow-row"),l=d?d.getAttribute("aria-expanded")==="true":!1;ks(i,e,r,e.durationMs,a,l)}return Ia(n),t}function vs(e,t,n,o,s){let r={...t,result:n,durationMs:s},i=fa(n),a=Ca(o,e);if(a){let d=Bs(a.dataset.startedAt)??Date.now(),l=a.querySelector(".ds-flow-row"),A=l?l.getAttribute("aria-expanded")==="true":!1;ks(a,r,i,s,d,A),Ia(o);return}ho(r,e,o)}var PA={consumed:"\u6388\u6743\u51ED\u8BC1\u5DF2\u88AB\u4F7F\u7528\uFF08\u4E00\u6B21\u6027\u51ED\u8BC1\u4E0D\u53EF\u91CD\u590D\u6D88\u8D39\uFF09","not-found":"\u8D44\u6E90\u6216\u6388\u6743\u4E0D\u5B58\u5728",malformed:"\u6388\u6743\u51ED\u8BC1\u683C\u5F0F\u4E0D\u6B63\u786E","bad-signature":"\u6388\u6743\u7B7E\u540D\u6821\u9A8C\u5931\u8D25",expired:"\u6388\u6743\u5DF2\u8FC7\u671F","scope-mismatch":"\u6388\u6743\u8303\u56F4\u4E0E\u672C\u6B21\u64CD\u4F5C\u4E0D\u5339\u914D","consent-unavailable":"\u5F53\u524D\u65E0\u6CD5\u5F81\u6C42\u540C\u610F\uFF08\u5BBF\u4E3B\u672A\u5C31\u7EEA\uFF09\uFF0C\u5DF2\u6309 fail-closed \u62D2\u7EDD","consent-denied":"\u7528\u6237\u62D2\u7EDD\u4E86\u672C\u6B21\u64CD\u4F5C","policy-denied":"\u5F53\u524D\u6743\u9650\u6863\u4F4D\u4E0D\u5141\u8BB8\u8BE5\u64CD\u4F5C",denied:"\u64CD\u4F5C\u88AB\u62D2\u7EDD","page-disconnected":"\u9875\u9762\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF0C\u672C\u6B21\u6267\u884C\u88AB\u7EC8\u6B62","auth-failed":"\u9274\u6743\u5931\u8D25\uFF0C\u8BF7\u91CD\u542F\u5E94\u7528",unauthorized:"\u7F3A\u5C11\u6216\u65E0\u6548\u7684\u8BBF\u95EE\u4EE4\u724C",internal:"\u5BBF\u4E3B\u5185\u90E8\u9519\u8BEF\uFF0C\u8BF7\u67E5\u770B\u65E5\u5FD7",timeout:"\u64CD\u4F5C\u8D85\u65F6",failed:"\u6267\u884C\u5931\u8D25",cancelled:"\u5DF2\u53D6\u6D88","pow-expired":"PoW \u6311\u6218\u5DF2\u8FC7\u671F\uFF0C\u91CD\u65B0\u83B7\u53D6\u540E\u4ECD\u65E0\u6CD5\u7EE7\u7EED","missing-argument":"\u7F3A\u5C11\u5FC5\u586B\u53C2\u6570","invalid-argument":"\u53C2\u6570\u683C\u5F0F\u4E0D\u6B63\u786E","outside-workspace":"\u76EE\u6807\u5728\u5DE5\u4F5C\u533A\u4E4B\u5916","workspace-unconfigured":"\u5C1A\u672A\u914D\u7F6E\u5DE5\u4F5C\u533A","io-error":"\u4E34\u65F6\u8BFB\u5199\u9519\u8BEF\uFF0C\u53EF\u7A0D\u540E\u91CD\u8BD5","limit-exceeded":"\u5E76\u53D1\u6216\u6570\u91CF\u8D85\u9650\uFF0C\u8BF7\u7B49\u5F85\u5F53\u524D\u4EFB\u52A1\u7ED3\u675F","call-error":"\u5DE5\u5177\u8C03\u7528\u51FA\u9519","call-skip":"\u8BE5\u5DE5\u5177\u8C03\u7528\u88AB\u8DF3\u8FC7"};function ya(e){if(!e)return"\u53D1\u751F\u672A\u77E5\u9519\u8BEF";let t=PA[e];return t||`\u9519\u8BEF\u7801 ${e}\uFF1A\u53D1\u751F\u672A\u5F52\u7C7B\u9519\u8BEF\uFF0C\u8BF7\u67E5\u770B\u5BBF\u4E3B\u65E5\u5FD7`}var Ea=`
/* ===== overlay \u5BB9\u5668 + \u8BBE\u8BA1\u4EE4\u724C ===== */
/* z-index \u5206\u5C42\uFF08v0.20 \u8D77\u6CBF\u7528\uFF09\uFF1A
 *   2147483647  consent \u5F39\u7A97\uFF08\u540C\u610F\u95F8\u95E8\uFF0C\u6700\u9AD8\uFF09
 *   2147483644-3646  StudioUI sidebar/\u9762\u677F\uFF08\u5DE5\u5177\u5165\u53E3\uFF0C\u53EF\u70B9\u51FB\uFF09
 *   2147483000  \u672C chat overlay\uFF08\u6D88\u606F\u6E32\u67D3\uFF0C\u53EA\u76D6 DeepSeek #root\uFF09
 * chat overlay \u4F4E\u4E8E sidebar\uFF0C\u786E\u4FDD\u6D6E\u52A8\u6309\u94AE/\u9762\u677F\u4E0D\u88AB\u906E\u6321\u3002 */
.ds-studio-chat-container {
  /* \u6D45\u8272\u4EE4\u724C */
  --ds-bg: #fbfbfa;
  --ds-surface: #ffffff;
  --ds-hover: rgba(31, 31, 38, 0.05);
  --ds-ink: #1f1f26;
  --ds-ink-2: #55555f;
  --ds-ink-3: #8b8b95;
  --ds-line: #e9e9e4;
  --ds-line-2: #d7d7d1;
  --ds-accent: #4D6BFE;
  --ds-accent-ink: #3a55d8;
  --ds-accent-soft: rgba(77, 107, 254, 0.12);
  --ds-on-accent: #ffffff;
  --ds-violet: #8b5cf6;
  --ds-ok: #22c55e;
  --ds-danger: #ef4444;
  --ds-danger-ink: #b42318;
  --ds-danger-soft: rgba(239, 68, 68, 0.06);
  --ds-warn: #8a5b00;
  --ds-warn-soft: rgba(138, 91, 0, 0.07);
  --ds-user-bg: #3f5ae0;
  --ds-user-ink: #ffffff;
  --ds-code-bg: #f4f4f1;
  --ds-think-bg: rgba(31, 31, 38, 0.035);
  --ds-shadow-soft: 0 6px 18px rgba(24, 24, 32, 0.1);
  /* chrome \u589E\u8865\u4EE4\u724C\uFF1A\u73BB\u7483\u9762 + \u6D6E\u8D77\u6295\u5F71\uFF0C\u53EA\u670D\u52A1\u9AA8\u67B6\u4EF6 */
  --ds-chrome-surface: rgba(255, 255, 255, 0.84);
  --ds-chrome-blur: saturate(180%) blur(14px);
  --ds-shadow-float: 0 12px 30px rgba(24, 24, 32, 0.14), 0 1px 2px rgba(24, 24, 32, 0.06);
  --ds-shadow-drawer: -20px 0 44px rgba(24, 24, 32, 0.10);
  color-scheme: light;

  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 280px;          /* \u9ED8\u8BA4\u503C\uFF0CmeasureComposerTop \u4F1A\u52A8\u6001\u8986\u76D6\u4E3A\u7CBE\u786E\u503C */
  z-index: 2147483000;
  background: var(--ds-bg);
  /* fab \u907F\u8BA9\uFF1A\u4FA7\u680F\u6536\u8D77\u65F6\u5DE6\u4E0A\u89D2\u662F DeepSeek \u60AC\u6D6E\u6062\u590D\u6309\u94AE\uFF08\u4FA7\u680F/\u641C\u7D22/\u65B0\u5BF9\u8BDD\uFF09\uFF0C
   * overlay \u4E0D\u900F\u660E\u4E14\u5C42\u7EA7\u66F4\u9AD8\u4F1A\u628A\u5B83\u76D6\u4F4F\u3002clip-path \u628A\u9996\u5E26\u771F\u6B63\u88C1\u6389\uFF0C
   * \u8BE5\u533A\u57DF\u65E2\u900F\u660E\u4E5F\u4E0D\u5403\u70B9\u51FB\uFF1B\u9AD8\u5EA6\u7531 JS \u5199\u5165 --sc-fab-guard\uFF0C0 \u65F6\u7B49\u4E8E\u4E0D\u88C1\u3002 */
  clip-path: inset(var(--sc-fab-guard, 0px) 0 0 0);
  display: flex;
  flex-direction: column;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 15px;
  line-height: 1.7;
  color: var(--ds-ink);
  transition: opacity 0.15s ease;
}

/* ctrl+shift+h \u5207\u6362\u9690\u85CF\u6001\uFF08\u53C2\u8003 cuckoo-code \u5207\u6362\u5F0F\u53E0\u52A0\u5E03\u5C40\uFF09\uFF1A
 * \u9690\u85CF\u65F6\u5B8C\u5168\u79FB\u51FA\u89C6\u53E3\uFF0C\u539F\u7F51\u9875\u5168\u53EF\u89C1\u3001\u53EF\u4EA4\u4E92\u3002 */
.ds-studio-chat-container.ds-studio-chat-hidden {
  display: none !important;
}

/* \u63ED\u793A\u95E8\u63A7\uFF1Aoverlay \u521D\u59CB\u4E0D\u53EF\u89C1\uFF0C\u7B49 composer \u6D4B\u91CF\u7A33\u5B9A\uFF08\u843D\u5728\u89C6\u53E3\u4E0B\u534A\u533A\uFF09\u518D\u6DE1\u5165\u3002
 * \u907F\u514D"\u5148\u77EE\u540E\u6DA8"\u7684\u95EA\u70C1\u2014\u2014\u521D\u6B21\u52A0\u8F7D SPA \u672A\u6E32\u67D3\u65F6 textarea \u6D6E\u5728\u9AD8\u4F4D\uFF0C
 * overlay \u4F1A\u5148\u6309\u9519\u8BEF\u6D4B\u91CF\u6E32\u67D3\u6210\u77EE\u9762\u677F\uFF0C\u6E32\u67D3\u5B8C\u6210\u540E\u518D\u8DF3\u9AD8\uFF0C\u89C6\u89C9\u95EA\u70C1\u3002
 * pointer-events:none \u9632\u6B62 pending \u900F\u660E\u6001\u62E6\u622A DeepSeek \u767B\u5F55\u9875/\u8F93\u5165\u6846\u70B9\u51FB\u3002 */
.ds-studio-chat-container.ds-studio-chat-pending {
  opacity: 0 !important;
  pointer-events: none !important;
}

/* ===== \u6D88\u606F\u5217\u8868\uFF08\u6EDA\u52A8\u5BB9\u5668\uFF09\uFF1A800px \u5C45\u4E2D\u5185\u5BB9\u5E26 ===== */
.ds-sc-message-list {
  flex: 1;
  overflow-y: auto;
  padding: 28px max(20px, calc(50% - 400px)) 14px;
  /* fab \u907F\u8BA9\uFF1AJS \u628A fab \u4E0B\u6CBF\u9AD8\u5EA6\u5199\u5165 --sc-fab-guard\uFF0C\u9996\u884C\u5185\u5BB9\u8BA9\u5230\u60AC\u6D6E\u6309\u94AE\u4E0B\u9762\u3002
   * \u8FD9\u662F\u51E0\u4F55\u5C3A\u5BF8\u4E0D\u662F\u4E3B\u9898\u8272\uFF0C\u7528 --sc- \u524D\u7F00\uFF0C\u4E0D\u8FDB --ds-* \u660E\u6697\u4E24\u5957\u5951\u7EA6\u3002 */
  padding-top: max(28px, var(--sc-fab-guard, 0px));
  display: flex;
  flex-direction: column;
  gap: 22px;
  scroll-behavior: smooth;
}

.ds-sc-message-list::-webkit-scrollbar { width: 10px; }
.ds-sc-message-list::-webkit-scrollbar-track { background: transparent; }
.ds-sc-message-list::-webkit-scrollbar-thumb {
  background: var(--ds-line-2);
  border: 3px solid transparent;
  border-radius: 999px;
  background-clip: padding-box;
}
.ds-sc-message-list::-webkit-scrollbar-thumb:hover {
  background: var(--ds-ink-3);
  background-clip: padding-box;
}

/* ===== \u7A7A\u72B6\u6001 ===== */
.ds-sc-empty-state {
  margin: auto; max-width: 480px; padding: 56px 24px; text-align: center; position: relative;
}
.ds-sc-empty-state::before {
  content: ""; position: absolute; top: 24px; left: 50%; transform: translateX(-50%);
  width: 120px; height: 120px; border-radius: 50%;
  background: radial-gradient(circle, var(--ds-accent-soft) 0%, rgba(0, 0, 0, 0) 70%);
  pointer-events: none; z-index: 0;
}
.ds-sc-empty-title {
  position: relative; z-index: 1; color: var(--ds-ink);
  font-size: 21px; font-weight: 650; letter-spacing: -0.022em; line-height: 1.35; margin-bottom: 10px;
}
.ds-sc-empty-body {
  position: relative; z-index: 1; color: var(--ds-ink-2);
  font-size: 13.5px; line-height: 1.85;
}
.ds-sc-empty-hint {
  position: relative; z-index: 1; margin-top: 18px; color: var(--ds-ink-3);
  font-size: 11px; line-height: 1.7; letter-spacing: 0.05em; text-transform: uppercase;
}

/* ===== \u9519\u8BEF\u63D0\u793A\uFF1A\u5B89\u9759\u884C\u5185\uFF08\u7EC6\u7EA2\u7EBF + \u5C0F\u5B57\u53F7 + \u6781\u6D45\u5E95\uFF09 ===== */
.ds-sc-error-card {
  align-self: stretch;
  border-left: 2px solid var(--ds-danger);
  background: var(--ds-danger-soft);
  padding: 8px 12px;
  color: var(--ds-ink);
}
.ds-sc-error-title {
  color: var(--ds-danger-ink);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  line-height: 1.5;
  margin-bottom: 3px;
}
.ds-sc-error-body {
  color: var(--ds-ink-2);
  font-size: 13px;
  line-height: 1.65;
}
.ds-sc-error-code {
  margin-top: 5px;
  color: var(--ds-danger-ink);
  font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
  font-size: 11px;
  line-height: 1.6;
  word-break: break-all;
}

/* ===== \u91CD\u653E\u5386\u53F2\u9519\u8BEF\u6C47\u603B\uFF1A\u6BD4\u5B9E\u65F6\u9519\u8BEF\u5361\u66F4\u5F31\u7684\u4E24\u7EA7\u7070\uFF0C\u660E\u786E\u6807\u6CE8\u975E\u672C\u8F6E ===== */
.ds-sc-replay-error-summary {
  align-self: stretch;
  border-left: 2px solid var(--ds-line-2);
  background: var(--ds-think-bg);
  padding: 6px 12px;
  color: var(--ds-ink-3);
}
.ds-sc-replay-error-summary-text {
  color: var(--ds-ink-3);
  font-size: 12px;
  line-height: 1.6;
}

/* \u622A\u65AD\u63D0\u793A\uFF1A\u540C\u6784\u7684\u5B89\u9759\u884C\uFF0C\u68D5\u7EBF\u533A\u5206 */
.ds-sc-truncation-note {
  margin-top: 10px;
  padding: 6px 10px;
  border-left: 2px solid var(--ds-warn);
  background: var(--ds-warn-soft);
  color: var(--ds-warn);
  font-size: 12px;
  line-height: 1.6;
}

/* ===== \u7528\u6237\u6D88\u606F\uFF1A\u53F3\u5BF9\u9F50\u6C14\u6CE1\uFF08\u804A\u5929\u60EF\u4F8B\uFF09 ===== */
.ds-sc-msg-user {
  align-self: flex-end;
  max-width: min(72%, 560px);
  background: var(--ds-user-bg);
  color: var(--ds-user-ink);
  border-radius: 16px 16px 5px 16px;
  padding: 9px 15px;
  font-size: 14.5px;
  line-height: 1.72;
  white-space: pre-wrap;
  word-break: break-word;
  position: relative;
}

/* ===== \u52A9\u624B\u6D88\u606F\uFF1A\u65E0\u6846\u6B63\u6587\u6587\u6863\u6D41\uFF0C\u5C42\u7EA7\u9760\u5B57\u53F7/\u884C\u9AD8/\u7559\u767D ===== */
.ds-sc-msg-assistant {
  align-self: stretch;
  position: relative;
  width: 100%;
  color: var(--ds-ink);
  line-height: 1.78;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* \u4E3B bot\uFF1A\u6B63\u6587\u5373\u53D1\u8A00\uFF0C\u9690\u85CF\u53D1\u9001\u8005\u884C */
.ds-sc-msg-main-bot {
  width: 100%;
}
.ds-sc-msg-main-bot .ds-sc-sender-row {
  display: none;
}

/* \u5B50 bot\uFF1A\u4FDD\u7559\u8EAB\u4EFD\u6807\u8BC6\uFF08\u7EC6\u5DE6\u8FB9\u7EBF + \u5C0F\u6807\u7B7E\uFF09 */
.ds-sc-msg-sub-bot {
  border-left: 2px solid var(--ds-violet);
  padding-left: 14px;
}
.ds-sc-msg-sub-bot .ds-sc-sender-row {
  margin-bottom: 3px;
}
.ds-sc-msg-sub-bot .ds-sc-avatar {
  width: 17px;
  height: 17px;
  font-size: 9px;
  background: var(--ds-violet);
}
.ds-sc-msg-sub-bot .ds-sc-sender {
  color: var(--ds-violet);
}

/* \u53D1\u9001\u8005\u884C / \u5934\u50CF / \u540D\u79F0\uFF08\u4EC5 sub-bot \u53EF\u89C1\uFF09 */
.ds-sc-sender-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
}
.ds-sc-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: 10px;
  font-weight: 650;
  flex-shrink: 0;
}
.ds-sc-sender {
  color: var(--ds-ink-3);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
}

/* \u6D88\u606F\u590D\u5236\u6309\u94AE\uFF1Ahover \u663E\u793A\uFF0C\u53F3\u4E0A\u89D2\u6D6E\u51FA */
.ds-sc-copy-btn {
  position: absolute;
  top: 0;
  right: 0;
  display: none;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--ds-line);
  border-radius: 6px;
  background: var(--ds-surface);
  color: var(--ds-ink-3);
  font-size: 11px;
  cursor: pointer;
  z-index: 2;
}
.ds-sc-copy-btn:hover {
  color: var(--ds-accent-ink);
  border-color: var(--ds-accent);
}
.ds-sc-msg-user:hover .ds-sc-copy-btn,
.ds-sc-msg-assistant:hover .ds-sc-copy-btn {
  display: flex;
}
.ds-sc-msg-user .ds-sc-copy-btn {
  top: 4px;
  right: 4px;
}
.ds-sc-msg-user .ds-sc-copy-btn:hover {
  color: var(--ds-accent-ink);
  border-color: var(--ds-accent);
}

/* ===== \u601D\u8003\u5757\uFF1A\u53EF\u6298\u53E0 + \u964D\u566A\uFF08\u7EC6\u8FB9\u7EBF\u3001\u6781\u6D45\u5E95\uFF09 ===== */
.ds-sc-think {
  margin: 0 0 14px; overflow: hidden;
  border-left: 2px solid var(--ds-line-2); background: var(--ds-think-bg);
  border-radius: 0 8px 8px 0;
}
.ds-sc-think.open { border-left-color: var(--ds-accent); }
.ds-sc-think-head {
  display: flex; align-items: center; gap: 7px; padding: 5px 12px;
  color: var(--ds-ink-3); font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase;
  line-height: 1.6; cursor: pointer; user-select: none;
  transition: color 0.12s ease, background 0.12s ease;
}
.ds-sc-think-head:hover {
  color: var(--ds-ink-2); background: var(--ds-hover);
}
.ds-sc-think-caret {
  display: inline-block; font-size: 9px;
  transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.ds-sc-think.open .ds-sc-think-caret {
  transform: rotate(90deg);
}
.ds-sc-think-body {
  display: none; padding: 2px 14px 12px;
  color: var(--ds-ink-2); font-size: 13px; line-height: 1.75; white-space: pre-wrap;
}
.ds-sc-think.open .ds-sc-think-body {
  display: block;
}

/* ===== \u6D41\u5F0F\u5149\u6807\uFF08\u53C2\u8003 cuckoo streaming-cursor\uFF09 ===== */
.ds-sc-cursor {
  display: inline-block;
  width: 2px;
  height: 1.05em;
  margin-left: 3px;
  background: var(--ds-accent);
  vertical-align: text-bottom;
  animation: ds-sc-blink 1.05s step-end infinite;
}
@keyframes ds-sc-blink {
  50% { opacity: 0; }
}

/* \u56DE\u5230\u5E95\u90E8\u6309\u94AE */
.ds-sc-scroll-btn {
  position: absolute; right: 20px; bottom: 40px;
  display: none; align-items: center; justify-content: center;
  width: 34px; height: 34px; border: 1px solid var(--ds-line); border-radius: 50%;
  background: var(--ds-chrome-surface);
  backdrop-filter: var(--ds-chrome-blur);
  -webkit-backdrop-filter: var(--ds-chrome-blur);
  box-shadow: var(--ds-shadow-float);
  color: var(--ds-ink-2); font-size: 15px; cursor: pointer; z-index: 10;
  transition: color 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
}
.ds-sc-scroll-btn.show {
  display: flex; animation: ds-sc-rise 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
.ds-sc-scroll-btn:hover {
  color: var(--ds-accent-ink); border-color: var(--ds-accent); transform: translateY(-2px);
}
.ds-sc-scroll-btn:active { transform: translateY(0); }
@keyframes ds-sc-rise {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ===== Markdown \u6392\u7248\uFF08\u6D41\u5F0F\u671F\u5171\u7528\u540C\u4E00\u5957\uFF09 ===== */
.ds-sc-markdown,
.ds-sc-streaming {
  white-space: normal;
  font-size: 15px;
  line-height: 1.78;
}

.ds-sc-markdown p,
.ds-sc-streaming p {
  margin: 0 0 0.9em;
}
.ds-sc-markdown p:last-child,
.ds-sc-streaming p:last-child {
  margin-bottom: 0;
}

.ds-sc-markdown h1,
.ds-sc-markdown h2,
.ds-sc-markdown h3,
.ds-sc-streaming h1,
.ds-sc-streaming h2,
.ds-sc-streaming h3 {
  margin: 1.5em 0 0.55em;
  font-weight: 650;
  line-height: 1.32;
  letter-spacing: -0.012em;
  color: var(--ds-ink);
}
.ds-sc-markdown h1:first-child,
.ds-sc-markdown h2:first-child,
.ds-sc-markdown h3:first-child,
.ds-sc-streaming h1:first-child,
.ds-sc-streaming h2:first-child,
.ds-sc-streaming h3:first-child {
  margin-top: 0;
}
.ds-sc-markdown h1,
.ds-sc-streaming h1 {
  font-size: 1.52em;
}
.ds-sc-markdown h2,
.ds-sc-streaming h2 {
  font-size: 1.28em;
}
.ds-sc-markdown h3,
.ds-sc-streaming h3 {
  font-size: 1.1em;
}

.ds-sc-markdown ul,
.ds-sc-markdown ol,
.ds-sc-streaming ul,
.ds-sc-streaming ol {
  margin: 0 0 1em;
  padding-left: 1.45em;
}
.ds-sc-markdown li,
.ds-sc-streaming li {
  margin: 0.32em 0;
}
.ds-sc-markdown li::marker,
.ds-sc-streaming li::marker {
  color: var(--ds-ink-3);
}

.ds-sc-markdown pre,
.ds-sc-streaming pre {
  position: relative;
  background: var(--ds-code-bg);
  border: 1px solid var(--ds-line);
  border-radius: 8px;
  padding: 11px 14px;
  margin: 0.95em 0;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.62;
}
.ds-sc-markdown code,
.ds-sc-streaming code {
  background: var(--ds-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.88em;
  font-family: 'SF Mono', 'Consolas', 'Monaco', 'Menlo', monospace;
}
.ds-sc-markdown pre code,
.ds-sc-streaming pre code {
  background: none;
  padding: 0;
  font-size: 13px;
}

.ds-sc-markdown blockquote,
.ds-sc-streaming blockquote {
  border-left: 2px solid var(--ds-line-2);
  margin: 0.95em 0;
  padding: 2px 0 2px 14px;
  color: var(--ds-ink-2);
}

.ds-sc-markdown a,
.ds-sc-streaming a {
  color: var(--ds-accent-ink);
  text-decoration: underline;
  text-decoration-color: var(--ds-accent-soft);
  text-underline-offset: 2px;
}
.ds-sc-markdown a:hover,
.ds-sc-streaming a:hover {
  text-decoration-color: currentColor;
}

.ds-sc-markdown hr,
.ds-sc-streaming hr {
  border: none;
  border-top: 1px solid var(--ds-line);
  margin: 1.5em 0;
}

.ds-sc-markdown table,
.ds-sc-streaming table {
  border-collapse: collapse;
  margin: 0.95em 0;
  font-size: 13.5px;
  display: block;
  max-width: 100%;
  overflow-x: auto;
}
.ds-sc-markdown th,
.ds-sc-markdown td,
.ds-sc-streaming th,
.ds-sc-streaming td {
  border: 1px solid var(--ds-line);
  padding: 7px 12px;
  text-align: left;
}
.ds-sc-markdown th,
.ds-sc-streaming th {
  background: var(--ds-code-bg);
  color: var(--ds-ink);
  font-weight: 650;
}

/* \u4EFB\u52A1\u5217\u8868\uFF08GFM checkbox\uFF09 */
.ds-sc-markdown input[type="checkbox"],
.ds-sc-streaming input[type="checkbox"] {
  margin-right: 6px;
  accent-color: var(--ds-accent);
}

/* \u4EE3\u7801\u5757\uFF1A\u8BED\u8A00\u6807\u7B7E + \u590D\u5236\u6309\u94AE */
.ds-sc-markdown pre,
.ds-sc-streaming pre {
  padding: 30px 14px 12px;
  border: 1px solid var(--ds-line); border-radius: 10px;
  background: var(--ds-code-bg);
}
.ds-sc-code-lang {
  position: absolute; top: 8px; left: 10px;
  padding: 1px 7px; border: 1px solid var(--ds-line); border-radius: 5px;
  background: var(--ds-surface); color: var(--ds-ink-3);
  font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
  font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; pointer-events: none;
}
.ds-sc-code-copy {
  position: absolute; top: 6px; right: 8px; display: none;
  padding: 2px 8px; border: 1px solid var(--ds-line); border-radius: 6px;
  background: var(--ds-surface); color: var(--ds-ink-2);
  font-size: 11px; cursor: pointer; z-index: 1;
}
.ds-sc-markdown pre:hover .ds-sc-code-copy,
.ds-sc-streaming pre:hover .ds-sc-code-copy {
  display: inline-flex;
}
.ds-sc-code-copy:hover {
  color: var(--ds-accent-ink); border-color: var(--ds-accent); background: var(--ds-accent-soft);
}

/* \u601D\u8003\u524D\u7F00\uFF1A\u5B89\u9759\u53EF\u70B9\u51FB\u884C */
.ds-sc-thinking-preface {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 3px 0;
  color: var(--ds-ink-3);
  font-size: 11.5px;
  cursor: pointer;
}
.ds-sc-thinking-preface:hover {
  color: var(--ds-accent-ink);
}

/* \u5DE5\u5177\u6267\u884C\u6761\u76EE\u7531\u72EC\u7ACB\u6A21\u5757\u6E32\u67D3\uFF08\u81EA\u5E26\u6837\u5F0F\uFF09\uFF1B\u8FD9\u91CC\u53EA\u7559\u51FA\u6BB5\u843D\u7EA7\u95F4\u8DDD */
.ds-sc-msg-assistant .dsx-tools-root {
  margin: 2px 0 14px;
}

/* ===== \u6267\u884C Inspector\uFF1A\u62BD\u5C49 + \u7EC6\u7EBF\u5206\u9694 ===== */
.ds-sc-inspector {
  position: absolute; top: 0; right: 0; bottom: 0;
  width: 336px; max-width: 82%;
  display: flex; flex-direction: column;
  background: var(--ds-surface); border-left: 1px solid var(--ds-line);
  box-shadow: var(--ds-shadow-drawer);
  transform: translateX(100%);
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 20;
}
.ds-sc-inspector.open {
  transform: translateX(0);
}
.ds-sc-inspector-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 12px; border-bottom: 1px solid var(--ds-line);
  color: var(--ds-ink-3); font-size: 10.5px; font-weight: 650;
  letter-spacing: 0.11em; text-transform: uppercase;
}
.ds-sc-inspector-list {
  flex: 1; overflow-y: auto; padding: 10px 12px 14px;
}
.ds-sc-inspector-list::-webkit-scrollbar { width: 8px; }
.ds-sc-inspector-list::-webkit-scrollbar-thumb {
  background: var(--ds-line-2);
  border-radius: 999px;
}
.ds-sc-inspector-item {
  border: 1px solid var(--ds-line); border-left: 3px solid var(--ds-line-2);
  border-radius: 8px; padding: 8px 10px; margin-bottom: 8px;
  background: var(--ds-surface); transition: background 0.12s ease;
}
.ds-sc-inspector-item:hover { background: var(--ds-hover); }
.ds-sc-inspector-item[data-phase="running"] { border-left-color: var(--ds-accent); }
.ds-sc-inspector-item[data-phase="succeeded"] {
  border-left-color: var(--ds-ok);
}
.ds-sc-inspector-item[data-phase="failed"],
.ds-sc-inspector-item[data-phase="denied"],
.ds-sc-inspector-item[data-phase="error"] {
  border-left-color: var(--ds-danger);
}
.ds-sc-inspector-tool {
  color: var(--ds-ink); font-size: 12px; font-weight: 650;
  font-family: 'SF Mono', 'Consolas', 'Menlo', monospace;
}
.ds-sc-inspector-meta { margin-top: 3px; color: var(--ds-ink-3); font-size: 11px; line-height: 1.6; font-variant-numeric: tabular-nums; }
.ds-sc-inspector-error { margin-top: 4px; color: var(--ds-danger-ink); font-size: 11px; line-height: 1.6; word-break: break-word; }
.ds-sc-inspector-close {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border: 1px solid var(--ds-line); border-radius: 7px;
  background: transparent; color: var(--ds-ink-2);
  font-size: 11px; line-height: 1.5; white-space: nowrap; cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.ds-sc-inspector-close:hover {
  color: var(--ds-ink); border-color: var(--ds-line-2); background: var(--ds-hover);
}
.ds-sc-inspector-item[data-phase="succeeded"] {
  border-left-color: var(--ds-ok);
}
.ds-sc-inspector-item[data-phase="failed"],
.ds-sc-inspector-item[data-phase="denied"],
.ds-sc-inspector-item[data-phase="error"] {
  border-left-color: var(--ds-danger);
}
.ds-sc-inspector-tool {
  color: var(--ds-ink);
  font-size: 12px;
  font-weight: 650;
}
.ds-sc-inspector-meta {
  margin-top: 3px;
  color: var(--ds-ink-3);
  font-size: 11px;
  line-height: 1.6;
}
.ds-sc-inspector-error {
  margin-top: 3px;
  color: var(--ds-danger-ink);
  font-size: 11px;
  line-height: 1.6;
}
/* ===== \u5E95\u90E8\u72B6\u6001\u680F\uFF1Asession rail ===== */
.ds-sc-status-bar {
  flex-shrink: 0; display: flex; align-items: center; gap: 9px; height: 34px;
  padding: 0 14px;
  border-top: 1px solid var(--ds-line);
  background: var(--ds-chrome-surface);
  backdrop-filter: var(--ds-chrome-blur);
  -webkit-backdrop-filter: var(--ds-chrome-blur);
  color: var(--ds-ink-3); font-size: 11px;
}
.ds-sc-status-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--ds-line-2); box-shadow: 0 0 0 3px var(--ds-hover);
}
.ds-sc-status-dot.busy {
  background: var(--ds-accent); box-shadow: 0 0 0 3px var(--ds-accent-soft);
  animation: ds-sc-pulse 1.6s ease-in-out infinite;
}
.ds-sc-status-dot.done {
  background: var(--ds-ok); box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.16);
}
.ds-sc-status-dot.error {
  background: var(--ds-danger); box-shadow: 0 0 0 3px var(--ds-danger-soft);
}
.ds-sc-status-text {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--ds-ink-2); font-variant-numeric: tabular-nums;
}
.ds-sc-persistence {
  margin-left: auto; white-space: nowrap; font-variant-numeric: tabular-nums;
  color: var(--ds-ink-3); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase;
}
.ds-sc-context-notice {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  display: none;
  color: var(--ds-warn); font-size: 10.5px;
}
.ds-sc-context-notice.visible { display: inline-block; }
.ds-sc-clear-btn,
.ds-sc-inspector-toggle {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border: 1px solid var(--ds-line); border-radius: 7px;
  background: transparent; color: var(--ds-ink-2);
  font-size: 11px; line-height: 1.5; white-space: nowrap; cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.ds-sc-clear-btn:hover {
  color: var(--ds-danger-ink);
  border-color: var(--ds-danger);
  background: var(--ds-danger-soft);
}
.ds-sc-inspector-toggle:hover,
.ds-sc-inspector-toggle[aria-expanded="true"] {
  color: var(--ds-accent-ink); border-color: var(--ds-accent); background: var(--ds-accent-soft);
}
.ds-sc-clear-btn:focus-visible,
.ds-sc-inspector-toggle:focus-visible,
.ds-sc-inspector-close:focus-visible,
.ds-sc-scroll-btn:focus-visible,
.ds-sc-code-copy:focus-visible,
.ds-sc-copy-btn:focus-visible,
.ds-sc-think-head:focus-visible { outline: 2px solid var(--ds-accent); outline-offset: 2px; }
@keyframes ds-sc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* ===== \u6DF1\u8272\u6A21\u5F0F\uFF1A\u53EA\u8986\u76D6\u4EE4\u724C\u8868 ===== */
@media (prefers-color-scheme: dark) {
  .ds-studio-chat-container {
    --ds-bg: #131316;
    --ds-surface: #1b1b20;
    --ds-hover: rgba(255, 255, 255, 0.07);
    --ds-ink: #e9e9ed;
    --ds-ink-2: #b6b6c0;
    --ds-ink-3: #8a8a95;
    --ds-line: #2b2b32;
    --ds-line-2: #3b3b45;
    --ds-accent: #5D7BFF;
    --ds-accent-ink: #93a9ff;
    --ds-accent-soft: rgba(122, 148, 255, 0.16);
    --ds-on-accent: #ffffff;
    --ds-violet: #a68cff;
    --ds-ok: #22c55e;
    --ds-danger: #ef4444;
    --ds-danger-ink: #ff9d94;
    --ds-danger-soft: rgba(239, 68, 68, 0.1);
    --ds-warn: #e0b262;
    --ds-warn-soft: rgba(224, 178, 98, 0.1);
    --ds-user-bg: #3f52c9;
    --ds-user-ink: #f3f4ff;
    --ds-code-bg: #202027;
    --ds-think-bg: rgba(255, 255, 255, 0.04);
    --ds-shadow-soft: 0 6px 18px rgba(0, 0, 0, 0.45);
    --ds-chrome-surface: rgba(27, 27, 32, 0.86);
    --ds-chrome-blur: saturate(180%) blur(14px);
    --ds-shadow-float: 0 12px 30px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.35);
    --ds-shadow-drawer: -20px 0 44px rgba(0, 0, 0, 0.42);
    color-scheme: dark;
  }
}
`;var Mn=!1;function GA(){if(Mn)return;let e=document.createElement("style");e.id="ds-studio-chat-styles",e.textContent=Ea;let t=document.head??document.documentElement;if(t)t.appendChild(e),Mn=!0;else{let n=()=>{if(Mn)return;let s=document.documentElement;s&&(s.appendChild(e),Mn=!0)};document.addEventListener("DOMContentLoaded",n,{once:!0});let o=new MutationObserver(()=>{document.documentElement&&(n(),o.disconnect())});o.observe(document,{childList:!0,subtree:!0})}}function YA(){let e=null,t=document.querySelectorAll("textarea");for(let o of t){if(o.offsetWidth===0||o.offsetHeight===0)continue;let s=o.getBoundingClientRect();if(s.width>50&&s.height>10){e=o;break}}if(!e){let o=document.querySelectorAll('[contenteditable="true"]');for(let s of o){let r=s;if(r.offsetWidth===0||r.offsetHeight===0)continue;let i=r.getBoundingClientRect();if(i.width>50&&i.height>10){e=s;break}}}if(!e)return null;let n=e;for(let o=0;o<10&&n;o++){let s=n.getBoundingClientRect();if(s.height>120&&s.height<400)return Math.round(s.top);n=n.parentElement}return Math.round(e.getBoundingClientRect().top)}function $A(){let e=window.innerHeight,t=window.innerWidth,n=0,o=document.body?document.body.querySelectorAll(":scope > *"):[];for(let s of o){let r=typeof s.className=="string"?s.className:"";if(r.includes("studio-")||r.includes("ds-studio")||r.includes("ds-sc")||s.closest(".ds-studio-chat-container"))continue;let i=s.getBoundingClientRect();i.width===0||i.height===0||i.left<=20&&i.height>e*.5&&i.width<=t*.25&&i.right>n&&(n=i.right)}if(n===0){let s=document.querySelector("#root");if(s){let r=s.querySelectorAll("*"),i=0;for(let a of r){if(i++>2e3)break;let d=typeof a.className=="string"?a.className:"";if(d.includes("studio-")||d.includes("ds-studio")||d.includes("ds-sc"))continue;let l=a.getBoundingClientRect();l.width===0||l.height===0||l.left<=20&&l.height>e*.5&&l.width<=t*.25&&l.width>0&&l.right>n&&(n=l.right)}}}return Math.round(n)}var zA=["#root > div > div.c3ecdb44 > div.dc04ec1d.a02af2e6 > div.ca6d4be1._5a20a69","#root div.ca6d4be1._5a20a69","div.ca6d4be1._5a20a69"];function KA(){for(let n of zA){let o;try{o=document.querySelectorAll(n)}catch{continue}let s=0;for(let r of o){if(r.closest(".ds-studio-chat-container"))continue;let i=r.getBoundingClientRect();i.width===0||i.height===0||i.bottom>s&&(s=i.bottom)}if(s>0)return Math.round(s)}let e=0,t=[document.body,document.querySelector("#root")];for(let n of t){if(!n)continue;let o=n.querySelectorAll("*");for(let s of o){let r=typeof s.className=="string"?s.className:"";if(r.includes("studio-")||r.includes("ds-studio")||r.includes("ds-sc")||s.closest(".ds-studio-chat-container"))continue;let i=s.getBoundingClientRect();i.width===0||i.height===0||i.top>20||i.left>20||i.height>64||i.width>window.innerWidth*.4||s.querySelector('button, [role="button"], svg')&&i.bottom>e&&(e=i.bottom)}}return Math.round(e)}function qA(e){let t=YA();if(t===null||t<=0)return;let n=window.innerHeight;e.classList.contains("ds-studio-chat-pending")&&(t>n*.4?(e.classList.remove("ds-studio-chat-pending"),console.log("[studio-chat-ui] composer settled at",t,"px, reveal overlay")):console.log("[studio-chat-ui] composer at",t,"px (< vh*0.4=",Math.round(n*.4),"), stay pending"));let o=n-t+8,s=Math.max(120,Math.min(o,n-120));e.style.bottom=s+"px";let r=$A(),i=r>0?r+8:0;e.style.left=i+"px";let a=i>0?0:KA();e.style.setProperty("--sc-fab-guard",`${a}px`),console.log("[studio-chat-ui] overlay layout: bottom=",s,"px (composerTop=",t,"), left=",i,"px (sidebarRight=",r,", fabGuard=",a,")")}function ba(e={}){GA();let t=document.createElement("div");t.className="ds-studio-chat-container ds-studio-chat-pending",console.log("[studio-chat-ui] createStudioChatUI start, injecting styles=",!Mn);let n=document.createElement("div");n.className="ds-sc-message-list",t.appendChild(n);let o=document.createElement("aside");o.className="ds-sc-inspector",o.setAttribute("aria-hidden","true");let s=document.createElement("div");s.className="ds-sc-inspector-head";let r=document.createElement("span");r.textContent="\u6267\u884C Inspector";let i=document.createElement("button");i.type="button",i.className="ds-sc-inspector-close",i.textContent="\u5173\u95ED",s.appendChild(r),s.appendChild(i);let a=document.createElement("div");a.className="ds-sc-inspector-list",o.appendChild(s),o.appendChild(a),t.appendChild(o);let d=document.createElement("div");d.className="ds-sc-status-bar";let l=document.createElement("span");l.className="ds-sc-status-dot";let A=document.createElement("span");A.className="ds-sc-status-text",A.textContent="\u5C31\u7EEA",d.appendChild(l),d.appendChild(A);let u=document.createElement("span");u.className="ds-sc-context-notice",d.appendChild(u);let x=document.createElement("span");x.className="ds-sc-persistence",x.textContent=e.persistence?.connected?"\u672C\u673A\u5DF2\u8FDE\u63A5":"\u5185\u5B58\u6A21\u5F0F",d.appendChild(x);let m=document.createElement("button");m.type="button",m.className="ds-sc-inspector-toggle",m.textContent="\u6267\u884C\u9762\u677F",m.setAttribute("aria-expanded","false"),d.appendChild(m);let C=document.createElement("button");C.type="button",C.className="ds-sc-clear-btn",C.textContent="\u6E05\u7A7A\u8BB0\u5F55",C.addEventListener("click",()=>{dt()}),d.appendChild(C),t.appendChild(d);let b=document.createElement("div");b.className="ds-sc-scroll-btn",b.textContent="\u2193",b.title="\u56DE\u5230\u5E95\u90E8",t.appendChild(b);let _=!0,S=!1;function h(){return n.scrollHeight-n.scrollTop-n.clientHeight<90}function R(){!_&&!h()?b.classList.add("show"):b.classList.remove("show")}function T(D=!1){(D||_)&&(S=!0,n.scrollTop=n.scrollHeight,_=!0,requestAnimationFrame(()=>{S=!1})),R()}n.addEventListener("scroll",()=>{S||(_=h()),R()}),b.addEventListener("click",()=>{_=!0,T(!0)});let B=null,z="",M="",N=!1,I=e.initialSessionKey??tn(location.pathname),P=Ut(I),L=crypto.randomUUID(),K=0,f=e.persistence?.connected?"persistent":"memory",U=!0,k=new Map,F=new Map,w=new Map,ae=0,re=!1;function ue(D){re=D,o.classList.toggle("open",D),o.setAttribute("aria-hidden",String(!D)),m.setAttribute("aria-expanded",String(D))}m.addEventListener("click",()=>ue(!re)),i.addEventListener("click",()=>ue(!1));function le(D="\u6682\u65E0\u5DE5\u5177\u6267\u884C\u8BB0\u5F55"){let O=document.createElement("div");O.className="ds-sc-inspector-meta",O.dataset.inspectorEmpty="true",O.textContent=D,a.appendChild(O)}function ie(){w.clear(),ae=0,a.replaceChildren(),le()}function Ae(D,O,Y,ne,G){a.querySelector('[data-inspector-empty="true"]')?.remove();let J=w.get(D);J||(J=document.createElement("div"),J.className="ds-sc-inspector-item",J.dataset.inspectorKey=D,w.set(D,J),a.appendChild(J)),J.dataset.phase=Y,J.replaceChildren();let ye=document.createElement("div");ye.className="ds-sc-inspector-tool",ye.textContent=O,J.appendChild(ye);let Fe=document.createElement("div");Fe.className="ds-sc-inspector-meta";let $e=Y==="started"?"\u8FD0\u884C\u4E2D\u2026":Y==="succeeded"?"\u6210\u529F":Y==="denied"?"\u5DF2\u62D2\u7EDD":Y==="cancelled"?"\u5DF2\u53D6\u6D88":Y==="error"?"\u9519\u8BEF":"\u5931\u8D25";if(Fe.textContent=ne===void 0?$e:`${$e} \xB7 ${ne}ms`,J.appendChild(Fe),G){let ut=document.createElement("div");ut.className="ds-sc-inspector-error",ut.textContent=G,J.appendChild(ut)}a.scrollTop=a.scrollHeight}function Me(D,O){Ae(`error:${++ae}`,"\u7CFB\u7EDF\u9519\u8BEF","error",void 0,`${O} (${D})`)}ie();function Te(){x.textContent=f==="persistent"?"\u672C\u673A\u5DF2\u4FDD\u5B58":"\u5185\u5B58\u6A21\u5F0F"}Te();function oe(D){if(D.type==="system-error"&&!We(D.turnId)){console.warn("[studio-chat-ui] drop orphan system-error, no user-message in turn:",D.code);return}qn(P,D,500);let O=e.persistence;if(!O||!O.connected){f="memory",Te();return}f="persistent",Te(),O.saveEvent(I,D).then(()=>{f="persistent",Te()}).catch(()=>{f="memory",Te()})}function We(D){return P.events.some(O=>O.type==="user-message"&&O.turnId===D)}function Ye(){n.replaceChildren(),B=null,z="",M="",N=!1,k.clear(),F.clear(),ie(),fe&&(clearTimeout(fe),fe=null)}function q(D="\u5728\u4E0B\u65B9\u8F93\u5165\u6846\u53D1\u9001\u6D88\u606F\uFF0C\u5DE5\u5177\u8C03\u7528\u4E0E\u6700\u7EC8\u7ED3\u8BBA\u5C06\u663E\u793A\u5728\u6B64\u5904"){let O=document.createElement("div");O.className="ds-sc-empty-state",O.dataset.studioEmptyState="true";let Y=document.createElement("div");Y.className="ds-sc-empty-title",Y.textContent="DeepSeek Studio";let ne=document.createElement("div");ne.className="ds-sc-empty-body",ne.textContent=D;let G=document.createElement("div");G.className="ds-sc-empty-hint",G.textContent="Ctrl+Shift+H \u5207\u6362\u663E\u793A/\u9690\u85CF",O.appendChild(Y),O.appendChild(ne),O.appendChild(G),n.appendChild(O)}q();function W(D){let O=document.createElement("span");O.className="ds-sc-copy-btn",O.textContent="\u590D\u5236",O.addEventListener("click",()=>{let Y=D.innerText.replace(/​/g,"");try{navigator.clipboard?.writeText(Y)}catch{}O.textContent="\u5DF2\u590D\u5236",setTimeout(()=>{O.textContent="\u590D\u5236"},1500)}),D.appendChild(O)}function Ie(D){let O=D.querySelectorAll("pre");for(let Y of O){if(Y.querySelector(".ds-sc-code-lang")||Y.querySelector(".ds-sc-code-copy"))continue;let ne=Y.querySelector("code");if(!ne)continue;let J=(ne.className||"").match(/language-(\w+)/),ye=J?J[1]:"";if(ye){let $e=document.createElement("span");$e.className="ds-sc-code-lang",$e.textContent=ye,Y.appendChild($e)}let Fe=document.createElement("span");Fe.className="ds-sc-code-copy",Fe.textContent="\u590D\u5236",Fe.addEventListener("click",()=>{let $e=ne.textContent||"";try{navigator.clipboard?.writeText($e)}catch{}Fe.textContent="\u5DF2\u590D\u5236",setTimeout(()=>{Fe.textContent="\u590D\u5236"},1500)}),Y.appendChild(Fe)}}function be(D){n.querySelector('[data-studio-empty-state="true"]')?.remove();let O=document.createElement("div");O.className="ds-sc-msg-user",O.textContent=D,W(O),n.appendChild(O),L=crypto.randomUUID(),oe({type:"user-message",at:Date.now(),turnId:L,text:D}),T(!0)}function ge(D){n.querySelector('[data-studio-empty-state="true"]')?.remove();let O=document.createElement("div"),Y=D?.type??"main-bot";O.className=`ds-sc-msg-assistant ds-sc-msg-${Y}`;let ne=document.createElement("div");ne.className="ds-sc-sender-row";let G=document.createElement("span");G.className="ds-sc-avatar";let J=D?.name??"\u52A9\u624B";G.textContent=J.slice(0,2);let ye=document.createElement("span");ye.className="ds-sc-sender",ye.textContent=J,ne.appendChild(G),ne.appendChild(ye),O.appendChild(ne);let Fe=document.createElement("div");Fe.className="ds-sc-think",Fe.style.display="none";let $e=document.createElement("div");$e.className="ds-sc-think-head";let ut=document.createElement("span");ut.className="ds-sc-think-caret",ut.textContent="\u25B6";let dn=document.createElement("span");dn.textContent="\u601D\u8003\u4E2D\u2026",$e.appendChild(ut),$e.appendChild(dn);let An=document.createElement("div");An.className="ds-sc-think-body",Fe.appendChild($e),Fe.appendChild(An),$e.addEventListener("click",()=>{Fe.classList.toggle("open"),N=!0}),O.appendChild(Fe);let _t=document.createElement("div");_t.className="ds-sc-streaming",O.appendChild(_t),W(O),n.appendChild(O),B=O,z="",M="",N=!1,U=!0,fe&&(clearTimeout(fe),fe=null),T(!0)}let fe=null;function Be(){fe||(fe=setTimeout(()=>{fe=null,H()},80))}function H(){if(!B)return;let D=B.querySelector(".ds-sc-streaming");D&&(z&&(D.innerHTML=jt(z)+'<span class="ds-sc-cursor"></span>',Ie(D)),T())}function Z(D){if(B||ge(),z+=D,!N&&M){let O=B.querySelector(".ds-sc-think");O&&O.classList.remove("open")}Be()}function V(D){B||ge(),M=D;let O=B.querySelector(".ds-sc-think");if(!O)return;O.style.display="";let Y=O.querySelector(".ds-sc-think-body"),ne=O.querySelector(".ds-sc-think-head > span:last-child");Y&&(Y.textContent=D),!z&&!N&&O.classList.add("open"),ne&&(ne.textContent="\u5DF2\u601D\u8003\uFF08"+D.length+" \u5B57\uFF09"),T()}function ot(D){if(!B)return;fe&&(clearTimeout(fe),fe=null);let O=B.querySelector(".ds-sc-streaming"),Y=(D?.fallbackText??z).trim();if(O&&Y){let ne=jt(Y),G=document.createElement("div");G.className="ds-sc-markdown",G.innerHTML=ne,Ie(G),O.replaceWith(G)}if(U&&D?.recordFinal!==!1&&Y){let ne=zr(Y);if(oe({type:"final-answer",at:Date.now(),turnId:L,text:ne.text,truncationMarker:ne.truncationMarker}),ne.truncationMarker){let G=document.createElement("div");G.className="ds-sc-truncation-note",G.textContent=ne.truncationMarker.replace(/^[\s>]+/,""),B.appendChild(G)}}U=!1,B=null,z="",M="",N=!1,T()}function v(D){l.className=D?"ds-sc-status-dot busy":"ds-sc-status-dot done",A.textContent=D?"\u6267\u884C\u4E2D\u2026":"\u5B8C\u6210"}function $(D){let O=D.trim();u.textContent=O,u.classList.toggle("visible",O.length>0)}function te(D,O){return B||ge(),B?(Ae(D,O.toolName,"started"),ho(O,D,B),k.set(D,B),F.set(D,L),oe({type:"tool-start",at:Date.now(),turnId:L,callId:D,toolName:O.toolName,params:Go(O.params)}),T(),!0):!1}function me(D,O,Y,ne){let G=k.get(D)??B;if(!G||!Y)return!1;if(!G.isConnected)return k.delete(D),F.delete(D),!1;vs(D,O,Y,G,ne),Ae(D,O.toolName,Y.ok===!0&&Y.isError!==!0?"succeeded":"failed",ne,Y.ok===!0&&Y.isError!==!0?void 0:Y.error);let J=F.get(D)??L;return k.delete(D),F.delete(D),oe({type:"tool-result",at:Date.now(),turnId:J,callId:D,toolName:O.toolName,ok:Y.ok===!0&&Y.isError!==!0,durationMs:ne,result:Go({data:Y.data,content:Y.content,details:Y.details,isError:Y.isError,terminate:Y.terminate}),error:Y.error}),T(),!0}function we(D,O){n.querySelector('[data-studio-empty-state="true"]')?.remove();let Y=document.createElement("div");Y.className="ds-sc-error-card";let ne=document.createElement("div");ne.className="ds-sc-error-title",ne.textContent="\u6267\u884C\u672A\u5B8C\u6210";let G=document.createElement("div");G.className="ds-sc-error-body",G.textContent=O||ya(D);let J=document.createElement("div");J.className="ds-sc-error-code",J.textContent=D,Y.appendChild(ne),Y.appendChild(G),Y.appendChild(J),n.appendChild(Y),Me(D,G.textContent??D),oe({type:"system-error",at:Date.now(),turnId:L,code:D,message:G.textContent??D}),T(!0)}function Ne(D){let O=[...D.values()].reduce((J,ye)=>J+ye,0);if(O===0)return;let Y=[...D.entries()].sort((J,ye)=>ye[1]-J[1]).map(([J,ye])=>`${J} x${ye}`).join("\u3001"),ne=document.createElement("div");ne.className="ds-sc-replay-error-summary";let G=document.createElement("span");G.className="ds-sc-replay-error-summary-text",G.textContent=`\u5386\u53F2\u8BB0\u5F55\u4E2D\u6709 ${O} \u6761\u6267\u884C\u672A\u5B8C\u6210\uFF08${Y}\uFF09\uFF0C\u975E\u672C\u8F6E\u4EA7\u751F`,ne.appendChild(G),n.appendChild(ne)}let De=new Map;function ve(D){Ye(),P=D,L=crypto.randomUUID();let O=D.events.slice(-500),Y=null,ne=new Map;De.clear();for(let G of O)if(G.type==="user-message"){let J=document.createElement("div");J.className="ds-sc-msg-user",J.textContent=G.text,W(J),n.appendChild(J),Y=null}else if(G.type==="tool-start"){if(Ae(G.callId,G.toolName,"started"),Y||(ge({name:"\u6267\u884C\u8BB0\u5F55",type:"main-bot"}),Y=B),Y){let J=G.params;ne.set(G.callId,{toolName:G.toolName,params:J}),ho({toolName:G.toolName,params:J},G.callId,Y)}}else if(G.type==="tool-result"){Ae(G.callId,G.toolName,G.ok?"succeeded":"failed",G.durationMs,G.ok?void 0:G.error);let J=Y??B;if(J){let ye=ne.get(G.callId);vs(G.callId,{toolName:ye?.toolName??G.toolName,params:ye?.params??{}},{ok:G.ok,data:G.result,error:G.error,isError:!G.ok},J,G.durationMs)}}else if(G.type==="final-answer"){let J=document.createElement("div");J.className="ds-sc-msg-assistant ds-sc-msg-main-bot";let ye=document.createElement("div");ye.className="ds-sc-markdown",ye.innerHTML=jt(G.text+(G.truncationMarker??"")),Ie(ye),J.appendChild(ye),n.appendChild(J),Y=null}else G.type==="system-error"&&De.set(G.code,(De.get(G.code)??0)+1);B=null,z="",M="",De.size>0&&Ne(De),O.length===0&&q("\u6682\u65E0 Studio \u6267\u884C\u8BB0\u5F55\u3002\u5386\u53F2\u4F1A\u8BDD\u82E5\u672A\u88AB\u5B9E\u65F6\u6355\u83B7\uFF0C\u4E0D\u4F1A\u4ECE\u539F\u751F\u9875\u9762\u53CD\u63A8\u4F2A\u9020\u3002"),v(!1),T(!0)}async function _e(D,O){let Y=D.trim()||tn(location.pathname),ne=++K,G=I;if($(""),O?.migrateFrom){I=Y,P={...P,key:Y,updatedAt:Date.now()},e.persistence&&e.persistence.renameSession(O.migrateFrom,Y);return}if(I=Y,Y===G&&P.events.length>0){if(e.persistence?.connected){try{await e.persistence.saveSession(P),f="persistent"}catch{f="memory"}Te()}return}if(Y.startsWith("route:")){if(B!==null)return;I=Y,Ye(),P=Ut(Y),L=crypto.randomUUID(),q(),f=e.persistence?.connected?"persistent":"memory",Te();return}let J=e.persistence?await e.persistence.loadSession(Y):null;ne===K&&(J?(ve(J),f=e.persistence?.connected?"persistent":"memory"):(Ye(),P=Ut(Y),L=crypto.randomUUID(),q(),f=e.persistence?.connected?"persistent":"memory"),Te())}async function dt(){$("");try{await e.persistence?.clearAll(),P=Ut(I),L=crypto.randomUUID(),Ye(),q("\u6267\u884C\u8BB0\u5F55\u5DF2\u6E05\u7A7A")}catch{we("storage-unavailable","\u6E05\u7A7A\u672C\u673A\u8BB0\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u5BBF\u4E3B\u8FDE\u63A5\u540E\u91CD\u8BD5\u3002")}}function It(){Mt.disconnect(),fe&&(clearTimeout(fe),fe=null);for(let D of _n)clearTimeout(D);window.removeEventListener("resize",je),window.removeEventListener("scroll",je,{capture:!0}),window.removeEventListener("keydown",Rt),t.remove(),B=null,z="",M="",N=!1}let At=!0;function Dt(){return At=!At,At?t.classList.remove("ds-studio-chat-hidden"):t.classList.add("ds-studio-chat-hidden"),window.dispatchEvent(new CustomEvent("studio:visibility-changed",{detail:{visible:At}})),console.log("[studio-chat-ui] overlay",At?"shown":"hidden"),At}function Rt(D){D.ctrlKey&&D.shiftKey&&(D.key==="h"||D.key==="H"||D.code==="KeyH")&&(D.preventDefault(),Dt())}window.addEventListener("keydown",Rt);let Nt=!1;function je(){Nt||(Nt=!0,requestAnimationFrame(()=>{Nt=!1,qA(t)}))}let Mt=new MutationObserver(()=>{je()});function Lt(){try{document.body&&Mt.observe(document.body,{childList:!0,subtree:!0})}catch{}}je(),document.body?Lt():document.addEventListener("DOMContentLoaded",Lt,{once:!0});let _n=[setTimeout(je,500),setTimeout(je,1500),setTimeout(je,3e3)];return window.addEventListener("resize",je),window.addEventListener("scroll",je,{passive:!0,capture:!0}),{container:t,addUserMessage:be,startAssistantMessage:ge,appendToAssistantMessage:Z,appendReasoning:V,finishAssistantMessage:ot,setBusy:v,startToolCard:te,finishToolCard:me,appendError:we,setContextNotice:$,activateSession:_e,get sessionKey(){return I},clearHistory:dt,get persistenceState(){return f},toggle:Dt,destroy:It}}function jA(e){let t=new Set(e.filter(n=>n.type==="user-message").map(n=>n.turnId));return e.filter(n=>!(n.type==="system-error"&&!t.has(n.turnId)))}function ka(e){let t=new Map,n=Promise.resolve();function o(l,A){e.reportError?.(l,A)}async function s(){let l=await e.kv.kvGet(Kn);return Pr(l)?{version:2,sessions:l.sessions.filter(A=>A&&typeof A.key=="string").sort((A,u)=>u.updatedAt-A.updatedAt).slice(0,50)}:{version:2,sessions:[]}}async function r(l){let A=t.get(l);if(A)return A;let u=await e.kv.kvGet(Bt(l));if(!Gr(u))return null;let x=jA(u.events),m={...u,events:x.slice(-500)};return x.length!==u.events.length&&await e.kv.kvSet(Bt(l),m),t.set(l,m),m}async function i(l){return await n,r(l)}async function a(l){await e.kv.kvSet(Bt(l.key),l);let A=await s(),u={key:l.key,routeKey:l.routeKey,updatedAt:l.updatedAt,title:Kr(l)},x=A.sessions.filter(C=>C.key!==l.key);x.unshift(u),x.sort((C,b)=>b.updatedAt-C.updatedAt);let m=x.splice(50);await e.kv.kvSet(Kn,{version:2,sessions:x});for(let C of m)await e.kv.kvRemove(Bt(C.key))}function d(l,A="studio execution persistence failed"){let u=n.then(l);return n=u.then(()=>{},x=>{o(A,x)}),u}return{async loadSession(l){try{return await i(l)}catch(A){return o("studio execution load failed",A),null}},async saveEvent(l,A){return d(async()=>{let u=await r(l)??Ut(l);return qn(u,A),t.set(l,u),await a(u),u})},async saveSession(l){try{let A={...l,events:l.events.slice(-500)};t.set(A.key,A),await d(()=>a(A),"studio execution session flush failed")}catch(A){throw o("studio execution session flush failed",A),A}},async renameSession(l,A){if(l!==A)try{await d(async()=>{let u=t.get(l)??await r(l);if(!u)return;let x={...u,key:A,updatedAt:Date.now()};t.set(A,x),t.delete(l),await a(x),await e.kv.kvRemove(Bt(l))},"studio execution rename failed")}catch(u){o("studio execution rename failed",u)}},async clearAll(){try{await d(async()=>{let l=await s();for(let A of l.sessions)await e.kv.kvRemove(Bt(A.key));for(let A of t.keys())await e.kv.kvRemove(Bt(A));t.clear(),await e.kv.kvRemove(Kn)},"studio execution clear failed")}catch(l){throw o("studio execution clear failed",l),l}},onConnected(l){return e.onConnected(l)},get connected(){return e.isConnected()}}}var JA=["bridge","host","authority","sessionId"];var cn="__deepseekStudio";function WA(){return(globalThis.window??globalThis)[cn]}function wa(){try{let t=globalThis.window??globalThis,n=t[cn];if(!n)return!1;let o=Object.getOwnPropertyDescriptor(t,cn);return o&&o.configurable===!1||Object.defineProperty(t,cn,{value:n,writable:!1,configurable:!1,enumerable:!0}),!0}catch{return!1}}function Ba(e){let t=e.read??WA,n=e.members??JA,o=e.intervalMs??5e3,s=e.setIntervalFn??((m,C)=>setInterval(m,C)),r=e.clearIntervalFn??(m=>clearInterval(m)),i=t(),a=new Map;if(i&&typeof i=="object")for(let m of n)a.set(m,i[m]);let d=!1;try{let m=globalThis.window??globalThis,C=Object.getOwnPropertyDescriptor(m,cn);d=!!C&&C.configurable===!1&&C.writable===!1}catch{}let l=!1,A=!1;function u(){let m=t();if(m==null)return{reason:"removed"};if(m!==i)return{reason:"replaced"};let C=m;for(let b of n){if(!(b in C))return{reason:"member-missing",detail:b};if(C[b]!==a.get(b))return{reason:"member-replaced",detail:b}}if(d)try{let b=globalThis.window??globalThis,_=Object.getOwnPropertyDescriptor(b,cn);if(_&&(_.configurable!==!1||_.writable!==!1))return{reason:"descriptor-downgraded"}}catch{}return null}let x=s(()=>{if(A||l)return;let m=u();m&&(l=!0,e.onViolation(m))},o);return{check(){let m=u();return m&&!l&&(l=!0,e.onViolation(m)),m},stop(){A=!0,r(x)}}}var va="ws://127.0.0.1:8760/studio";function XA(e,t){let n=globalThis.__TAURI_INTERNALS__;if(!n?.invoke){console.warn("[StudioUI] bot windows skipped: not running under Tauri");return}let o=e.show.bind(e),s=!1,r=()=>{if(!s){s=!0;for(let i of t)try{n.invoke?.("open_bot_window",{botId:i})}catch(a){console.warn(`[StudioUI] open_bot_window failed for ${i}`,a)}}};e.show=()=>{o(),r()},globalThis.__studioOpenRoomBots=r}function ZA(){return[sr(),dr(),Ar(),pr()]}function VA(e){let t=new Set,n=[];for(let o of e)t.has(o.id)||(t.add(o.id),n.push(o));return n}function eu(e={}){let t=globalThis.location?.origin??"https://chat.deepseek.com",n=e.sessionId??crypto.randomUUID(),o=e.botId??globalThis.__studioBotId??"main",s=VA([...ZA(),...e.capabilities??[]]),r=s,i=globalThis.__studioHostToken,a=e.hostUrl??(i?`${va}?token=${encodeURIComponent(i)}`:va),d=yr({url:a,capabilities:r,reportError:e.reportError,botId:o}),l=Xs({origin:t,sessionId:n,reportError:e.reportError});nr({capabilities:s,originWhitelist:e.originWhitelist,lifecycleFactory:e.lifecycleFactory,strictInstallOrder:!1}),typeof globalThis.document<"u"&&d.connect();let A=o!=="main",u;if(typeof globalThis.document<"u"){if(!A){let C=globalThis;C.__studioOpenWorkbench=()=>{try{globalThis.__TAURI_INTERNALS__?.invoke?.("open_workbench")}catch{console.warn("[StudioUI] open_workbench unavailable (not running under Tauri)")}},C.__studioFocusMain=()=>{try{globalThis.__TAURI_INTERNALS__?.invoke?.("focus_main_window")}catch{console.warn("[StudioUI] focus_main_window unavailable (not running under Tauri)")}}}let m=location.pathname.includes("/login")||location.pathname.includes("/signin");if(!A&&!m){if(typeof document.createElement=="function")try{let C=ka({kv:{kvGet:h=>d.kvGet(h),kvSet:(h,R)=>d.kvSet(h,R),kvRemove:h=>d.kvRemove(h)},onConnected:h=>d.onConnected(h),isConnected:()=>d.connected,reportError:(h,R)=>e.reportError?.(h,R)}),b=tn(location.pathname);u=ba({persistence:C,initialSessionKey:b});let _=()=>{let h=document.body??document.documentElement;h&&!u?.container.isConnected&&h.appendChild(u.container)};document.body?_():document.addEventListener("DOMContentLoaded",_,{once:!0}),u.activateSession(b),C.onConnected(()=>{u?.activateSession(u.sessionKey)}),Pn({reinjectOnRouteChange:!1,onRouteChange:h=>{u?.activateSession(tn(h))}}).start()}catch(C){e.reportError?.("failed to mount studio chat UI",C)}try{let C=globalThis.__studioChatConfig;if(C&&C.token&&C.roomId){let b=Vi(C);XA(b,C.members),document.body.appendChild(b.container),console.log("[StudioUI] chat room installed:",C.roomName)}else console.warn("[StudioUI] chat room skipped: no __studioChatConfig (config.json missing chatRooms?)")}catch(C){e.reportError?.("failed to mount chat room",C)}try{la({sendToolCall:C=>d.sendToolCall(C),log:C=>d.log(`[settings-ui] ${C}`)})}catch(C){e.reportError?.("failed to mount studio settings entry",C)}}try{ei(C=>d.trace(C)),ii({sender:C=>d.sendToolCall(C),diag:C=>d.log(`[interceptor] ${C}`),onAssistantReply:(C,b)=>d.assistantReply(C,b),onStreamDelta:C=>d.streamDelta(C),onMemoriesUpdate:C=>{globalThis.__studioMemories=C},chatUI:u})}catch(C){e.reportError?.("failed to install main-world interceptor",C)}try{Vr()}catch(C){e.reportError?.("failed to install trace report handle",C)}}let x=globalThis.window??globalThis;return x.__deepseekStudio={origin:t,sessionId:n,bridge:l,authority:"resident-host",host:d},e.freezeStudio===!0&&wa(),typeof globalThis.document<"u"&&Ba({intervalMs:e.integrityIntervalMs,onViolation:m=>{e.reportError?.(`integrity violation: ${m.reason}${m.detail?` (${m.detail})`:""}`),d.reportIntegrity(m)}}),{bridge:l,origin:t,sessionId:n,host:d}}if(typeof globalThis.document<"u"&&typeof globalThis.WebSocket<"u"&&!globalThis.window?.__deepseekStudio)try{eu()}catch(e){console.error("[installStudio] auto-init failed",e)}})();
/*! Bundled license information:

dompurify/dist/purify.es.mjs:
  (*! @license DOMPurify 3.4.17 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.4.17/LICENSE *)
  (*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE *)
*/
