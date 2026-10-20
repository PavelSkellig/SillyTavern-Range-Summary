import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryEngine, serializeRange, splitText, summaryForCopy } from '../index.js';

const KEY = 'manual_range_summary';

test('copy returns complete literal summary body without the generated range header', () => {
    const body = '  **Хронология**\n02.07.1996 — 14:10\n{{char}} 🙂\n\n';
    const message = { mes: 'Сводка · сообщения #1–#2 (включительно)\n\n' + body,
        extra: { [KEY]: { kind: 'summary', start: 1, end: 2 } } };
    assert.equal(summaryForCopy(message), body);
    message.mes = 'Edited summary without service header\n';
    assert.equal(summaryForCopy(message), 'Edited summary without service header\n');
});

test('copy cannot silently copy an ordinary message as a summary', () => {
    assert.throws(() => summaryForCopy({ mes: 'roleplay' }), /сводк/i);
});
function fixture() {
    let context = {
        chatId: 'chat-A', characterId: 0, groupId: null,
        chatMetadata: {},
        chat: ['zero', 'one {{char}}', 'two', 'three'].map((mes, i) => ({
            name: i % 2 ? 'User' : 'Character', is_user: !!(i % 2),
            mes, send_date: `date-${i}`, is_system: false, extra: {},
        })),
    };
    let disk = structuredClone(context);
    const requests = [];
    let failSave = false, failGenerate = false, hideCalls = 0;
    const host = {
        context: () => context,
        count: async text => Array.from(text).length,
        limits: () => ({ context: 4096, output: 512 }),
        generate: async (prompt, text) => {
            if (failGenerate) throw Error('generation failed');
            requests.push({ prompt, text });
            return 'SUMMARY';
        },
        save: async () => { if (!failSave) disk = structuredClone(context); },
        read: async () => ({ messages: disk.chat, metadata: disk.chatMetadata }),
        hide: async (a, b, unhide) => {
            hideCalls++;
            for (let i = a; i <= b; i++) context.chat[i].is_system = !unhide;
        },
        render: () => {},
        uuid: (() => { let i = 0; return () => `id-${++i}`; })(),
    };
    const engine = new SummaryEngine(host);
    engine.select('start', 1); engine.select('end', 2);
    return { engine, host, requests, get c() { return context; },
        switchChat() { context = { ...context, chatId: 'chat-B', chatMetadata: {}, chat: [] }; },
        failSave() { failSave = true; }, failGenerate() { failGenerate = true; },
        get hideCalls() { return hideCalls; } };
}

test('selected range is inclusive, literal, and excludes neighbours', () => {
    const f = fixture();
    const text = serializeRange(f.c.chat, 1, 2);
    assert.ok(text.includes('one {{char}}'));
    assert.ok(text.includes('two'));
    assert.ok(!text.includes('zero'));
    assert.ok(!text.includes('three'));
});

test('splits a huge Unicode message without dropping or duplicating characters', async () => {
    const original = '🙂abc\n'.repeat(500);
    const parts = await splitText(original, 97, async t => Array.from(t).length);
    assert.ok(parts.length > 1);
    assert.equal(parts.join(''), original);
    for (const p of parts) {
        assert.ok(Array.from(p).length <= 97);
        assert.ok(!/[\uD800-\uDBFF]$/.test(p));
    }
});

test('one summary is saved excluded, then only the prefix is hidden', async () => {
    const f = fixture();
    const prompt = '  MY {{char}} PROMPT\n\n';
    await f.engine.summarize(prompt);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].prompt, prompt);
    assert.deepEqual(f.c.chat.slice(0, 4).map(m => m.mes), ['zero', 'one {{char}}', 'two', 'three']);
    assert.deepEqual(f.c.chat.map(m => m.is_system), [true, true, true, false, true]);
    assert.equal(f.c.chat[4].name, 'Сводка');
    assert.equal(f.c.chat[4].extra.type, 'comment');
    assert.ok(f.c.chat[4].mes.includes('SUMMARY'));
    await f.engine.summarize(prompt);
    assert.equal(f.requests.length, 1);
    assert.equal(f.c.chat.length, 5);
});

test('generation failure never hides sources', async () => {
    const f = fixture(); f.failGenerate();
    await assert.rejects(f.engine.summarize('prompt'), /generation failed/);
    assert.equal(f.hideCalls, 0);
    assert.equal(f.c.chat.length, 4);
});

test('a swallowed save failure is detected before hiding', async () => {
    const f = fixture(); f.failSave();
    await assert.rejects(f.engine.summarize('prompt'), /сохран/i);
    assert.equal(f.hideCalls, 0);
    assert.ok(f.c.chat.slice(0, 4).every(m => !m.is_system));
    assert.equal(f.c.chat[4].is_system, true);
});

test('switching chats during generation cannot write into the destination', async () => {
    const f = fixture();
    f.host.generate = async () => { f.switchChat(); return 'SUMMARY'; };
    await assert.rejects(f.engine.summarize('prompt'), /чат/i);
    assert.equal(f.c.chat.length, 0);
    assert.equal(f.hideCalls, 0);
});

test('editing selected messages during generation aborts commit', async () => {
    const f = fixture();
    f.host.generate = async () => { f.c.chat[1].mes = 'edited'; return 'SUMMARY'; };
    await assert.rejects(f.engine.summarize('prompt'), /истори/i);
    assert.equal(f.c.chat.length, 4);
    assert.equal(f.hideCalls, 0);
});

test('concurrent button events cannot generate duplicate summaries', async () => {
    const f = fixture();
    const first = f.engine.summarize('prompt');
    await assert.rejects(f.engine.summarize('prompt'), /выполняется/i);
    await first;
    assert.equal(f.requests.length, 1);
});

test('restore affects only sources hidden by this extension; summary stays excluded', async () => {
    const f = fixture(); f.c.chat[0].is_system = true;
    await f.engine.summarize('prompt');
    await f.engine.restore();
    assert.deepEqual(f.c.chat.map(m => m.is_system), [true, false, false, false, true]);
});

test('anchors track message insertions and reject a deleted endpoint', () => {
    const f = fixture();
    f.c.chat.unshift({ mes: 'inserted', extra: {} });
    assert.deepEqual(f.engine.range(), { start: 2, end: 3 });
    f.c.chat.splice(2, 1);
    assert.throws(() => f.engine.range(), /начал/i);
});

test('invalid and empty prompts never create a request', async () => {
    const f = fixture();
    await assert.rejects(f.engine.summarize('  '), /промпт/i);
    f.engine.select('start', 3);
    await assert.rejects(f.engine.summarize('prompt'), /конец/i);
    assert.equal(f.requests.length, 0);
});

test('long history covers every source character and joins parts in chronological order', async () => {
    const f = fixture();
    f.c.chat[1].mes = 'first🙂\n'.repeat(500);
    f.c.chat[2].mes = 'second\n'.repeat(500);
    const original = serializeRange(f.c.chat, 1, 2);
    f.host.limits = () => ({ context: 1800, output: 400 });
    f.host.generate = async (prompt, text) => {
        f.requests.push({ prompt, text }); return `PART-${f.requests.length}`;
    };
    await f.engine.summarize('literal rules');
    assert.ok(f.requests.length > 2);
    assert.equal(f.requests.map(r => r.text).join(''), original);
    const summary = f.c.chat.at(-1).mes;
    let offset = 0;
    for (let i = 1; i <= f.requests.length; i++) {
        offset = summary.indexOf(`PART-${i}`, offset);
        assert.ok(offset >= 0); offset += `PART-${i}`.length;
    }
});

test('failed rendering can be retried without regeneration, but must render before hiding', async () => {
    const f = fixture(); let renderFails = true;
    f.host.render = () => { if (renderFails) throw Error('render failed'); };
    await assert.rejects(f.engine.summarize('prompt'), /render failed/);
    assert.equal(f.hideCalls, 0);
    await assert.rejects(f.engine.summarize('prompt'), /render failed/);
    assert.equal(f.hideCalls, 0);
    renderFails = false;
    await f.engine.summarize('prompt');
    assert.equal(f.requests.length, 1);
    assert.equal(f.c.chat.length, 5);
});

test('restoring a thousand owned sources batches native operations by contiguous range', async () => {
    const f = fixture();
    f.c.chat = Array.from({ length: 1000 }, (_, i) => ({ mes: `m${i}`, is_system: true, extra: { [KEY]: { hiddenBy: 'old-op' } } }));
    await f.engine.restore();
    assert.ok(f.c.chat.every(m => m.is_system === false));
    assert.equal(f.hideCalls, 1);
});

test('failed hide persistence rolls back local flags and permits retry using saved summary', async () => {
    const f = fixture(); const save = f.host.save; let failHideSave = true;
    f.host.save = async () => {
        if (failHideSave && f.c.chat[0].is_system) return;
        await save();
    };
    await assert.rejects(f.engine.summarize('prompt'), /сохран/i);
    assert.deepEqual(f.c.chat.map(m => m.is_system), [false, false, false, false, true]);
    failHideSave = false;
    await f.engine.summarize('prompt');
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.c.chat.map(m => m.is_system), [true, true, true, false, true]);
});

test('reusing a summary after restoring sources hides them again without another model call', async () => {
    const f = fixture();
    await f.engine.summarize('prompt');
    await f.engine.restore();
    await f.engine.summarize('prompt');
    assert.equal(f.requests.length, 1);
    assert.equal(f.c.chat.length, 5);
    assert.deepEqual(f.c.chat.map(m => m.is_system), [true, true, true, false, true]);
});

test('a changed connection configuration aborts before writing the summary', async () => {
    const f = fixture(); let model = 'large';
    f.host.configuration = () => model;
    f.host.generate = async () => { model = 'small'; return 'SUMMARY'; };
    await assert.rejects(f.engine.summarize('prompt'), /подключени/i);
    assert.equal(f.c.chat.length, 4);
    assert.equal(f.hideCalls, 0);
});

test('copied endpoint IDs require an unambiguous new selection', () => {
    const f = fixture();
    f.c.chat.unshift(structuredClone(f.c.chat[1]));
    assert.throws(() => f.engine.range(), /начал/i);
    f.engine.select('start', 2);
    assert.deepEqual(f.engine.range(), { start: 2, end: 3 });
});
