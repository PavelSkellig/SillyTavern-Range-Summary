import test from 'node:test';
import assert from 'node:assert/strict';
import { createHost, KEY } from '../index.js';

function setup(api = 'openai') {
    const listeners = new Map();
    let received;
    const c = {
        chatId: 'a', characterId: 0, groupId: null,
        characters: [{ name: 'Character', avatar: 'avatar.png' }], chat: [], chatMetadata: {},
        mainApi: api, maxContext: 8192,
        chatCompletionSettings: { openai_max_context: 16000, openai_max_tokens: 2000 },
        getTokenCountAsync: async x => x.length, saveChat: async () => {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        uuidv4: () => 'unique-nonce',
        eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'cc', GENERATE_AFTER_COMBINE_PROMPTS: 'tc' },
        eventSource: {
            on: (name, handler) => listeners.set(name, handler),
            removeListener: name => listeners.delete(name),
        },
        generateRawData: async ({ prompt }) => {
            // Simulate ST's macro substitution BEFORE the documented event.
            const event = api === 'openai' ? { chat: prompt } : { prompt: 'User: ' + prompt[0].content };
            listeners.get(api === 'openai' ? 'cc' : 'tc')(event);
            received = structuredClone(event);
            return { choices: [{ message: { content: 'summary {{char}}' }, finish_reason: 'stop' }] };
        },
    };
    const core = { amount_gen: 512, extractMessageFromData: r => r.choices[0].message.content };
    const host = createHost(() => c, core, { hideChatMessageRange: async () => {} });
    return { host, c, listeners, get received() { return received; } };
}

test('CC request contains literal prompt and only selected source, without roleplay context', async () => {
    const f = setup();
    assert.equal(await f.host.generate('  rules {{char}}\n', 'source {{user}}'), 'summary {{char}}');
    assert.deepEqual(f.received.chat, [
        { role: 'system', content: '  rules {{char}}\n' },
        { role: 'user', content: 'source {{user}}' },
    ]);
    assert.equal(f.listeners.size, 0);
    assert.deepEqual(f.host.limits(), { context: 16000, output: 2000 });
});

test('TC request restores literal strings after macro formatting and removes character prefix', async () => {
    const f = setup('textgenerationwebui');
    await f.host.generate('rules {{char}}', 'source {{user}}');
    assert.equal(f.received.prompt, 'rules {{char}}\n\nsource {{user}}');
    assert.equal(f.listeners.size, 0);
    assert.deepEqual(f.host.limits(), { context: 8192, output: 512 });
});

test('truncated model output fails rather than becoming a completed summary', async () => {
    const f = setup();
    f.c.generateRawData = async ({ prompt }) => {
        f.listeners.get('cc')({ chat: prompt });
        return { choices: [{ message: { content: 'half' }, finish_reason: 'length' }] };
    };
    await assert.rejects(f.host.generate('prompt', 'source'), /обрезан/i);
    assert.equal(f.listeners.size, 0);
});

test('request failure always removes the temporary literal-text event hook', async () => {
    const f = setup();
    f.c.generateRawData = async () => { throw Error('network'); };
    await assert.rejects(f.host.generate('p', 's'), /network/);
    assert.equal(f.listeners.size, 0);
});

test('server reread uses the correct group endpoint and strips only the header', async () => {
    const f = setup(); f.c.groupId = 'group-1';
    let url, body;
    const host = createHost(() => f.c, {}, {}, async (u, options) => {
        url = u; body = JSON.parse(options.body);
        return { ok: true, json: async () => [{ chat_metadata: { [KEY]: { start: 'x' } } }, { mes: 'first' }] };
    });
    const saved = await host.read();
    assert.equal(url, '/api/chats/group/get');
    assert.deepEqual(body, { id: 'a' });
    assert.deepEqual(saved.messages, [{ mes: 'first' }]);
    assert.equal(saved.metadata[KEY].start, 'x');
});
