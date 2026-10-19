/* Optional browser integration test. Usage:
 * node tests/browser-smoke.cjs <absolute-path-to-playwright-module>
 * Uses an installed Edge; never downloads a browser or calls a real model.
 */
const { chromium } = require(process.argv[2] || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
let disk;
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;font:16px sans-serif;background:var(--bg,#222);color:var(--SmartThemeBodyColor,#eee)}
#chat,#extensions_settings2{max-width:600px;margin:auto;padding:8px;box-sizing:border-box}
.mes{padding:8px;margin:4px 0;border:1px solid #888}.mes_buttons{display:flex;flex-wrap:nowrap;justify-content:flex-end;gap:3px}.native-action{flex:none;width:24px}
.menu_button,.text_pole{border:1px solid #888;border-radius:5px;background:var(--bg,#222);color:inherit}
.menu_button{padding:4px}.text_pole{font:inherit}.inline-drawer-content{display:block}
</style><link rel="stylesheet" href="/style.css"><div id="extensions_settings2"></div><div id="chat"></div>
<script>
const handlers = new Map();
const events = ['CHAT_CHANGED','GENERATION_STOPPED','CHAT_COMPLETION_PROMPT_READY','GENERATE_AFTER_COMBINE_PROMPTS','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','MORE_MESSAGES_LOADED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED'];
const eventSource = {
 on(k,f){if(!handlers.has(k))handlers.set(k,[]);handlers.get(k).push(f)},
 removeListener(k,f){handlers.set(k,(handlers.get(k)||[]).filter(x=>x!==f))},
 async emit(k,p){for(const f of [...(handlers.get(k)||[])])await f(p)}
};
window.requests=[];window.saves=0;window.generating=false;
const key='manual_range_summary';
const c=window.testContext={
 chatId:'mobile',characterId:0,groupId:null,characters:[{name:'Character',avatar:'avatar.png'}],
 chat:['old outside','selected {{char}}','selected end','new outside'].map((mes,i)=>({name:i%2?'User':'Character',is_user:!!(i%2),is_system:false,mes,send_date:'date'+i,extra:{}})),
 chatMetadata:{},extensionSettings:JSON.parse(localStorage.getItem('settings')||'{}'),
 mainApi:'openai',maxContext:16000,chatCompletionSettings:{openai_max_context:16000,openai_max_tokens:2000},
 eventSource,eventTypes:Object.fromEntries(events.map(k=>[k,k])),
 uuidv4:()=>crypto.randomUUID(),getRequestHeaders:()=>({'Content-Type':'application/json'}),
 getTokenCountAsync:async t=>Math.ceil(t.length/3),
 saveSettingsDebounced(){localStorage.setItem('settings',JSON.stringify(c.extensionSettings))},
 async saveChat(){await fetch('/test/save',{method:'POST',body:JSON.stringify([{chat_metadata:c.chatMetadata},...c.chat])});window.saves++},
 async saveMetadata(){await c.saveChat()},
 deactivateSendButtons(){document.body.dataset.generating='true'},
 activateSendButtons(){window.generating=false;delete document.body.dataset.generating},
 swipe:{refresh(){}},
 addOneMessage(m){const el=document.createElement('div');el.className='mes';el.setAttribute('mesid',c.chat.indexOf(m));el.setAttribute('is_system',String(m.is_system));const text=document.createElement('div');text.className='mes_text';text.textContent=m.mes;el.append(text);const actions=document.createElement('div');actions.className='mes_buttons';el.append(actions);document.querySelector('#chat').append(el)},
 async generateRawData({prompt}){const payload={chat:prompt};await eventSource.emit('CHAT_COMPLETION_PROMPT_READY',payload);requests.push(payload.chat);await new Promise(r=>setTimeout(r,80));return {choices:[{message:{content:'Detailed summary {{char}}'},finish_reason:'stop'}]}}
};
for(const m of c.chat)c.addOneMessage(m);
for(const panel of document.querySelectorAll('.mes_buttons'))for(let i=0;i<6;i++){const icon=document.createElement('span');icon.className='native-action';icon.textContent='⋮';panel.append(icon)}
window.SillyTavern={getContext:()=>c};window.toastr={error:console.error,warning:console.warn};
</script><script type="module" src="/index.js"></script>`;
const server = http.createServer(async (req, res) => {
    const body = await new Promise(resolve => { let s = ''; req.on('data', x => s += x); req.on('end', () => resolve(s)); });
    if (req.url === '/test/save') { disk = JSON.parse(body); res.end('{}'); return; }
    if (req.url === '/api/chats/get') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(disk)); return; }
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
    if (req.url === '/script.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(`export const amount_gen=512;export const isGenerating=()=>window.generating;export const setSendButtonState=v=>window.generating=v;export const extractMessageFromData=r=>r.choices[0].message.content;`); return;
    }
    if (req.url === '/scripts/chats.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(`export async function hideChatMessageRange(a,b,unhide){for(let i=a;i<=b;i++)window.testContext.chat[i].is_system=!unhide;await window.testContext.saveChat()}`); return;
    }
    if (['/index.js', '/style.css'].includes(req.url)) {
        res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(fs.readFileSync(path.join(root, req.url.slice(1)))); return;
    }
    res.writeHead(404).end();
});
(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    try {
        for (const width of [320, 390, 1280]) {
            const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage();
            const errors = []; page.on('pageerror', e => errors.push(e.message));
            await page.goto('http://127.0.0.1:' + server.address().port);
            await page.waitForSelector('.mrs-buttons');
            assert.equal(await page.locator('.mrs-buttons button').count(), 12);
            await page.fill('#mrs-prompt', '  Rules {{char}}\n');
            await page.locator('.mes[mesid="1"] [data-mrs-action="start"]').click();
            await page.locator('.mes[mesid="2"] [data-mrs-action="end"]').click();
            await page.locator('.mes[mesid="2"] [data-mrs-action="summary"]').click();
            await page.waitForFunction(() => window.testContext.chat.length === 5 && !window.generating);
            assert.deepEqual(await page.evaluate(() => testContext.chat.map(m => m.is_system)), [true, true, true, false, true]);
            assert.equal(await page.evaluate(() => requests[0][0].content), '  Rules {{char}}\n');
            assert.ok((await page.evaluate(() => requests[0][1].content)).includes('selected {{char}}'));
            assert.ok(!(await page.evaluate(() => requests[0][1].content)).includes('old outside'));
            assert.equal(await page.locator('.mrs-buttons button').count(), 15);
            await page.locator('.mes[mesid="2"] [data-mrs-action="summary"]').click();
            await page.waitForFunction(() => !window.generating);
            assert.equal(await page.evaluate(() => requests.length), 1);
            await page.click('#mrs-restore');
            await page.waitForFunction(() => !window.generating);
            assert.deepEqual(await page.evaluate(() => testContext.chat.map(m => m.is_system)), [false, false, false, false, true]);
            await page.locator('.mes[mesid="2"] [data-mrs-action="summary"]').click();
            await page.waitForFunction(() => !window.generating);
            assert.deepEqual(await page.evaluate(() => testContext.chat.map(m => m.is_system)), [true, true, true, false, true]);
            assert.equal(await page.evaluate(() => requests.length), 1);
            for (const light of [false, true]) {
                await page.evaluate(light => {
                    document.body.style.setProperty('--bg', light ? '#fff' : '#222');
                    document.body.style.setProperty('--SmartThemeBodyColor', light ? '#111' : '#eee');
                }, light);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
            }
            const buttons = await page.locator('.mrs-buttons button').evaluateAll(nodes => nodes.map(n => ({ w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height })));
            assert.ok(buttons.every(r => r.w >= 54 && r.h >= (width < 500 ? 44 : 36)));
            for (const row of await page.locator('.mrs-buttons').all()) {
                const tops = await row.locator('button').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
                assert.ok(tops.every(top => Math.abs(top - tops[0]) < 1), 'three buttons should fit on a single row');
            }
            await page.evaluate(() => {
                const m={name:'late',mes:'lazy loaded',extra:{},is_user:false,is_system:false};testContext.chat.push(m);testContext.addOneMessage(m);
            });
            await page.waitForFunction(() => document.querySelectorAll('.mrs-buttons').length === 6);
            await page.reload();
            await page.waitForSelector('#mrs-prompt');
            assert.equal(await page.inputValue('#mrs-prompt'), '  Rules {{char}}\n');
            assert.deepEqual(errors, []);
            console.log('PASS browser UI ' + width + 'px: flow, literal prompt, restore, duplicate guard, lazy messages, themes, touch targets, settings reload');
            await context.close();
        }
    } finally { await browser.close(); }
})().then(() => server.close()).catch(error => { console.error(error); server.close(); process.exitCode = 1; });
