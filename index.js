// Browser entry point and dependency-free, testable transaction logic.
export const KEY = 'manual_range_summary';
const data = message => (message.extra ??= {})[KEY] ??= {};
const isSummary = message => message.extra?.[KEY]?.kind === 'summary';
const stamp = message => JSON.stringify([
    message.name, message.is_user, message.mes, message.send_date,
    message.extra?.[KEY]?.id,
]);
const chatKey = c => JSON.stringify([c.groupId ?? null, c.characterId ?? null, c.chatId]);

// Original 24px SVG artwork approved for Range Summary. Embedded to avoid asset requests.
const ACTION_ICON_PATHS = {
    start: [
        { d: 'M5.5 20V4.5' },
        { d: 'M5.5 5c4-3 8 3 12 0v9c-4 3-8-3-12 0Z', fill: 'currentColor', 'fill-opacity': '.12' },
        { d: 'M11.5 19h7m-2.5-2.5 2.5 2.5-2.5 2.5' },
    ],
    end: [
        { d: 'M5.5 20V4.5' },
        { d: 'M5.5 5c4-3 8 3 12 0v9c-4 3-8-3-12 0Z', fill: 'currentColor', 'fill-opacity': '.12' },
        { d: 'M9.5 4.7v9m4-7.4v9M5.5 9.5c4-3 8 3 12 0', 'stroke-width': '1.25' },
        { d: 'M5.5 5c1.4-1.05 2.7-1 4-.3v4.5c-1.3-.7-2.6-.75-4 .3Zm8 1.3c1.3.7 2.6.75 4-.3v4.5c-1.4 1.05-2.7 1-4 .3ZM9.5 9.2c1.3.7 2.7 1.4 4 1.6v4.5c-1.3-.2-2.7-.9-4-1.6Z', fill: 'currentColor', stroke: 'none', 'fill-opacity': '.65' },
        { d: 'M12 20h6.5m0-2v4' },
    ],
    summary: [
        { d: 'M13 3.5H6.5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V12', fill: 'currentColor', 'fill-opacity': '.1' },
        { d: 'M8.5 10.5h3m-3 4h7m-7 3.5h5' },
        { d: 'm18.5 2 .9 3.1L22.5 6l-3.1.9-.9 3.1-.9-3.1-3.1-.9 3.1-.9Z', fill: 'currentColor', 'fill-opacity': '.18' },
    ],
};

function actionIcon(doc, action) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    const attrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': 'true', focusable: 'false', class: 'mrs-icon' };
    for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
    for (const attrs of ACTION_ICON_PATHS[action]) {
        const path = doc.createElementNS(ns, 'path');
        for (const [key, value] of Object.entries(attrs)) path.setAttribute(key, value);
        svg.append(path);
    }
    return svg;
}

export function serializeRange(chat, start, end) {
    return chat.slice(start, end + 1).map((m, offset) =>
        `[Сообщение #${start + offset}; роль: ${m.is_user ? 'пользователь' : 'персонаж/служебное'}; имя: ${JSON.stringify(m.name ?? '')}; метка отправки: ${JSON.stringify(m.send_date ?? '')}]\n${m.mes ?? ''}\n\n`,
    ).join('');
}

/** Splits by measured tokens, preferring line boundaries. Every code point survives. */
export async function splitText(text, budget, count) {
    if (!Number.isFinite(budget) || budget < 1) throw Error('Промпт не оставляет места для истории в контексте.');
    const chars = Array.from(text), parts = [];
    for (let offset = 0; offset < chars.length;) {
        let lo = 1, hi = Math.min(chars.length - offset, Math.max(1024, budget * 8)), fit = 0;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const tokens = Number(await count(chars.slice(offset, offset + mid).join('')));
            if (!Number.isFinite(tokens) || tokens < 0) throw Error('Не удалось посчитать токены.');
            if (tokens <= budget) { fit = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (!fit) throw Error('Недостаточно контекста даже для одного символа истории.');
        let part = chars.slice(offset, offset + fit).join('');
        const newline = part.lastIndexOf('\n');
        if (offset + fit < chars.length && newline > part.length / 2) {
            const candidate = part.slice(0, newline + 1);
            if (await count(candidate) <= budget) { part = candidate; fit = Array.from(part).length; }
        }
        parts.push(part);
        offset += fit;
    }
    return parts;
}

// 128-bit non-cryptographic fingerprint: only deduplication, never authentication.
function fingerprint(text) {
    const state = [2166136261, 2246822519, 3266489917, 668265263];
    for (let i = 0; i < text.length; i++) {
        for (let j = 0; j < 4; j++) state[j] = Math.imul(state[j] ^ text.charCodeAt(i), 16777619 + j * 2) >>> 0;
    }
    return state.map(n => n.toString(16).padStart(8, '0')).join('');
}

export class SummaryEngine {
    constructor(host) { this.host = host; this.busy = false; this.epoch = 0; }
    invalidate() { this.epoch++; }
    select(edge, index) {
        if (this.busy) throw Error('Операция уже выполняется.');
        if (!['start', 'end'].includes(edge)) throw Error('Некорректная граница.');
        const c = this.host.context(), m = c.chat[index];
        if (!Number.isInteger(index) || !m) throw Error('Сообщение не найдено.');
        const id = data(m).id;
        if (!id || c.chat.filter(item => item.extra?.[KEY]?.id === id).length !== 1) data(m).id = this.host.uuid();
        (c.chatMetadata[KEY] ??= {})[edge] = data(m).id;
    }
    range() {
        const c = this.host.context(), s = c.chatMetadata[KEY] ?? {};
        const start = c.chat.findIndex(m => s.start && m.extra?.[KEY]?.id === s.start);
        const end = c.chat.findIndex(m => s.end && m.extra?.[KEY]?.id === s.end);
        if (start < 0 || c.chat.filter(m => s.start && m.extra?.[KEY]?.id === s.start).length !== 1) throw Error('Выберите начало диапазона заново.');
        if (end < 0 || c.chat.filter(m => s.end && m.extra?.[KEY]?.id === s.end).length !== 1) throw Error('Выберите конец диапазона заново.');
        if (start > end) throw Error('Начало должно находиться не позже конца. Выберите конец заново.');
        return { start, end };
    }
    guardFor(c, prefix) {
        const key = chatKey(c), meta = c.chatMetadata, epoch = this.epoch;
        const configuration = this.host.configuration?.();
        const stamps = prefix.map(stamp);
        return () => {
            const now = this.host.context();
            if (this.epoch !== epoch || chatKey(now) !== key || now.chatMetadata !== meta) throw Error('Чат изменился. Операция остановлена.');
            if (this.host.configuration?.() !== configuration) throw Error('Настройки подключения изменились. Операция остановлена; повторите с текущей моделью.');
            if (prefix.some((m, i) => now.chat[i] !== m || stamp(now.chat[i]) !== stamps[i])) throw Error('История изменилась во время операции. Повторите выбор диапазона.');
        };
    }
    async persist(guard, verify) {
        guard();
        await this.host.save();
        guard();
        const saved = await this.host.read();
        guard();
        if (!verify(saved)) throw Error('Не удалось подтвердить сохранение чата на сервере. Проверьте соединение; повторное нажатие использует уже созданную сводку.');
    }
    async summarize(prompt) {
        if (this.busy) throw Error('Операция уже выполняется.');
        this.busy = true;
        try {
            if (typeof prompt !== 'string' || !prompt.trim()) throw Error('Вставьте свой промпт для сводки в настройки.');
            const c = this.host.context(), { start, end } = this.range();
            const prefix = c.chat.slice(0, end + 1), guard = this.guardFor(c, prefix);
            const source = serializeRange(c.chat, start, end);
            const op = fingerprint(JSON.stringify([prompt, start, end, source]));
            let summary = c.chat.find(m => isSummary(m) && data(m).operation === op);
            if (!summary) {
                const limits = this.host.limits();
                const promptTokens = Number(await this.host.count(prompt));
                guard();
                const available = Math.floor((limits.context - limits.output - 256 - promptTokens) * 0.85);
                if (!Number.isFinite(available) || available < 32) throw Error('Промпт и резерв ответа не помещаются в контекст. Проверьте лимиты модели в SillyTavern.');
                const chunks = await splitText(source, available, text => this.host.count(text));
                const outputs = [];
                for (let i = 0; i < chunks.length; i++) {
                    guard();
                    this.host.progress?.(`Создание сводки: часть ${i + 1} из ${chunks.length}…`);
                    const output = await this.host.generate(prompt, chunks[i]);
                    guard();
                    if (typeof output !== 'string' || !output.trim()) throw Error('Модель вернула пустую сводку. Исходники остаются активны.');
                    outputs.push(output);
                }
                guard();
                summary = {
                    name: 'Сводка', is_user: false, is_system: true,
                    send_date: new Date().toISOString(),
                    mes: `Сводка · сообщения #${start}–#${end} (включительно)\n\n` + outputs.join('\n\n---\n\n'),
                    extra: { type: 'comment', [KEY]: { kind: 'summary', operation: op, start, end, parts: chunks.length, phase: 'ready' } },
                };
                c.chat.push(summary);
            }
            guard();
            summary.is_system = true;
            // A rendering failure must not hide sources, including on retry.
            if (data(summary).phase !== 'complete') this.host.render(summary);
            const savedSummary = saved => saved.messages.some(m => m.extra?.[KEY]?.operation === op && m.mes === summary.mes && m.is_system === true);
            const savedPrefix = saved => prefix.every((m, i) => saved.messages[i] && stamp(saved.messages[i]) === stamp(m));
            await this.persist(guard, saved => savedSummary(saved) && savedPrefix(saved));
            guard();
            if (data(summary).phase === 'complete' && prefix.every(m => m.is_system === true)) return summary;
            // Save ownership only for messages that were active. Never unhide existing comments.
            const changed = prefix.filter(m => !m.is_system && !isSummary(m));
            const previous = changed.map(m => ({ m, hidden: m.is_system, owned: data(m).hiddenBy }));
            for (const m of changed) data(m).hiddenBy = op;
            data(summary).phase = 'complete';
            try {
                await this.host.hide(0, end, false);
                guard();
                await this.persist(guard, saved => savedSummary(saved) && savedPrefix(saved) && saved.messages.slice(0, end + 1).every(m => m.is_system === true) && saved.messages.find(m => m.extra?.[KEY]?.operation === op)?.extra?.[KEY]?.phase === 'complete');
            } catch (error) {
                // Restore only our original objects, never objects belonging to a newly opened chat.
                for (const { m, hidden, owned } of previous) {
                    m.is_system = hidden;
                    if (owned === undefined) delete data(m).hiddenBy; else data(m).hiddenBy = owned;
                }
                data(summary).phase = 'ready';
                try { guard(); await this.host.save(); } catch { /* current chat may have changed */ }
                this.host.refresh?.();
                throw error;
            }
            this.host.refresh?.();
            return summary;
        } finally { this.busy = false; }
    }
    async restore() {
        if (this.busy) throw Error('Операция уже выполняется.');
        this.busy = true;
        try {
            const c = this.host.context(), guard = this.guardFor(c, c.chat.slice());
            const owned = c.chat.map((m, i) => ({ m, i, marker: m.extra?.[KEY]?.hiddenBy, hidden: m.is_system }))
                .filter(x => x.marker && !isSummary(x.m));
            try {
                const ranges = [];
                for (const { i } of owned) {
                    const last = ranges.at(-1);
                    if (last && last.end + 1 === i) last.end = i;
                    else ranges.push({ start: i, end: i });
                }
                for (const { start, end } of ranges) {
                    guard();
                    await this.host.hide(start, end, true);
                    guard();
                }
                for (const { m } of owned) delete data(m).hiddenBy;
                await this.persist(guard, saved => owned.every(({ m, i }) => saved.messages[i] && stamp(saved.messages[i]) === stamp(m) && saved.messages[i].is_system === false && !saved.messages[i].extra?.[KEY]?.hiddenBy));
            } catch (error) {
                for (const { m, marker, hidden } of owned) { m.is_system = hidden; data(m).hiddenBy = marker; }
                try { guard(); await this.host.save(); } catch { /* chat changed */ }
                throw error;
            } finally { this.host.refresh?.(); }
            return owned.length;
        } finally { this.busy = false; }
    }
}

/** Adapter uses verified release APIs. Imports are injected so the core stays testable. */
export function createHost(context, core, chats, fetcher = globalThis.fetch) {
    return {
        context,
        uuid: () => context().uuidv4(),
        count: text => context().getTokenCountAsync(text),
        configuration() {
            const c = context();
            const connection = Object.fromEntries(Object.entries(c.chatCompletionSettings ?? {})
                .filter(([key]) => /model|source|url|proxy|max_context|max_tokens/.test(key)));
            return JSON.stringify([c.mainApi, c.maxContext, core.amount_gen, connection,
                c.textCompletionSettings?.type, c.textCompletionSettings?.server_urls]);
        },
        limits() {
            const c = context(), cc = c.mainApi === 'openai';
            const limits = {
                context: Number(cc ? c.chatCompletionSettings.openai_max_context : c.maxContext),
                output: Number(cc ? c.chatCompletionSettings.openai_max_tokens : core.amount_gen),
            };
            if (!Number.isFinite(limits.context) || !Number.isFinite(limits.output) || limits.output <= 0) throw Error('Не удалось прочитать лимиты контекста и ответа из SillyTavern.');
            return limits;
        },
        async generate(prompt, source) {
            const c = context(), api = c.mainApi;
            if (!['openai', 'textgenerationwebui', 'kobold', 'koboldhorde', 'novel'].includes(api)) throw Error(`API ${api} не поддерживает проверенную отдельную генерацию.`);
            const marker = `MRS_LITERAL_${c.uuidv4()}`;
            const event = api === 'openai' ? c.eventTypes.CHAT_COMPLETION_PROMPT_READY : c.eventTypes.GENERATE_AFTER_COMBINE_PROMPTS;
            if (!event) throw Error('Эта версия SillyTavern не поддерживает нужное событие генерации.');
            let applied = false;
            const replace = payload => {
                // Only our nonce-bearing request. Never rewrite somebody else's background request.
                if (api === 'openai') {
                    if (!payload.chat?.some(m => m.content?.includes(marker))) return;
                    payload.chat = [{ role: 'system', content: prompt }, { role: 'user', content: source }];
                } else {
                    if (!payload.prompt?.includes(marker)) return;
                    payload.prompt = `${prompt}\n\n${source}`;
                }
                applied = true;
            };
            c.eventSource.on(event, replace);
            try {
                const response = await c.generateRawData({
                    api, prompt: [{ role: 'user', content: marker }],
                    systemPrompt: '', instructOverride: true, quietToLoud: true,
                });
                if (!applied) throw Error('SillyTavern не применил буквальный промпт. Исходники остаются активны.');
                const reason = response?.choices?.[0]?.finish_reason ?? response?.stop_reason ?? response?.candidates?.[0]?.finishReason;
                if (['length', 'max_tokens', 'MAX_TOKENS', 'max_output_tokens'].includes(reason)) throw Error('Ответ модели обрезан лимитом. Увеличьте длину ответа в SillyTavern и повторите. Исходники остаются активны.');
                if (['content_filter', 'safety', 'SAFETY', 'refusal'].includes(reason)) throw Error('Модель остановила ответ фильтром. Исходники остаются активны.');
                return core.extractMessageFromData(response, api);
            } finally { c.eventSource.removeListener(event, replace); }
        },
        save: () => context().saveChat(),
        async read() {
            const c = context(), group = c.groupId != null;
            const character = c.characters[c.characterId];
            const url = group ? '/api/chats/group/get' : '/api/chats/get';
            const body = group ? { id: c.chatId } : { ch_name: character?.name, file_name: c.chatId, avatar_url: character?.avatar };
            const response = await fetcher(url, { method: 'POST', headers: c.getRequestHeaders(), cache: 'no-store', body: JSON.stringify(body) });
            if (!response.ok) throw Error('Не удалось проверить сохранение чата на сервере.');
            const file = await response.json();
            if (!Array.isArray(file) || !file[0] || !Object.hasOwn(file[0], 'chat_metadata')) throw Error('Сервер вернул неожиданный формат истории. Скрытие отменено.');
            return { messages: file.slice(1), metadata: file[0].chat_metadata };
        },
        hide: (start, end, unhide) => chats.hideChatMessageRange(start, end, unhide),
        render(message) {
            const c = context(), index = c.chat.indexOf(message);
            if (!document.querySelector(`#chat .mes[mesid="${index}"]`)) c.addOneMessage(message, { showSwipes: false });
            if (!document.querySelector(`#chat .mes[mesid="${index}"]`)) throw Error('Не удалось добавить сводку в интерфейс чата. Исходники остаются активны.');
        },
        refresh() {
            const c = context();
            document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
                const m = c.chat[Number(el.getAttribute('mesid'))];
                if (m) el.setAttribute('is_system', String(!!m.is_system));
            });
            c.swipe?.refresh();
        },
    };
}

/** Three compact controls inside the native ellipsis menu; one settings drawer. */
export function mountUI(context, engine, run, doc = document) {
    const settings = () => context().extensionSettings[KEY] ??= { prompt: '' };
    const drawer = doc.createElement('div');
    drawer.id = 'mrs-settings';
    drawer.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Сводка диапазона</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label for="mrs-prompt">Промпт для сводки</label>
            <textarea id="mrs-prompt" class="text_pole" rows="12" placeholder="Вставьте свой промпт. Стандартных инструкций нет."></textarea>
            <small id="mrs-range"></small>
            <div id="mrs-status" role="status" aria-live="polite"></div>
            <button type="button" id="mrs-restore" class="menu_button">Восстановить скрытые исходники</button>
        </div></div>`;
    const container = doc.querySelector('#extensions_settings2') ?? doc.querySelector('#extensions_settings');
    if (!container) throw Error('Не найден контейнер настроек расширений SillyTavern.');
    container.append(drawer);
    const promptInput = drawer.querySelector('#mrs-prompt');
    promptInput.value = settings().prompt;
    promptInput.addEventListener('input', () => {
        settings().prompt = promptInput.value; // deliberately no trim, substitutions or defaults
        context().saveSettingsDebounced();
    });
    let status = '';
    const showStatus = text => { status = text; drawer.querySelector('#mrs-status').textContent = text; };
    let queued = false;
    function paint() {
        queued = false;
        const c = context(), selection = c.chatMetadata[KEY] ?? {};
        let rangeText;
        try {
            const { start, end } = engine.range();
            rangeText = `Выбрано: #${start}–#${end}, сообщений: ${end - start + 1}.`;
        } catch (error) { rangeText = error.message; }
        drawer.querySelector('#mrs-range').textContent = rangeText;
        drawer.querySelector('#mrs-restore').disabled = engine.busy;
        promptInput.disabled = engine.busy;
        doc.querySelectorAll('#chat .mes[mesid]').forEach(el => {
            const index = Number(el.getAttribute('mesid')), m = c.chat[index];
            if (!m) return;
            let buttons = el.querySelector('.mrs-buttons');
            if (!buttons) {
                const panel = el.querySelector('.extraMesButtons');
                if (!panel) return;
                buttons = doc.createElement('span');
                buttons.className = 'mrs-buttons';
                for (const [action, title] of [['start', 'Начало'], ['end', 'Конец'], ['summary', 'Сводка']]) {
                    const button = doc.createElement('button');
                    button.type = 'button'; button.className = 'mes_button mrs-button';
                    button.dataset.mrsAction = action; button.dataset.mrsLabel = title;
                    button.setAttribute('aria-label', title);
                    button.title = `${title}: сообщение #${index}`;
                    button.append(actionIcon(doc, action));
                    buttons.append(button);
                }
                panel.append(buttons);
            }
            const id = m.extra?.[KEY]?.id;
            const start = !!id && selection.start === id, end = !!id && selection.end === id;
            el.classList.toggle('mrs-start', start); el.classList.toggle('mrs-end', end);
            for (const button of buttons.querySelectorAll('button')) {
                button.disabled = engine.busy;
                const action = button.dataset.mrsAction;
                button.title = `${button.dataset.mrsLabel}: сообщение #${index}`;
                if (action !== 'summary') button.setAttribute('aria-pressed', String(action === 'start' ? start : end));
            }
        });
    }
    function schedulePaint() {
        if (queued) return;
        queued = true;
        if (doc.defaultView) doc.defaultView.requestAnimationFrame(paint);
        else setTimeout(paint, 0);
    }
    async function select(action, index) {
        engine.select(action, index);
        paint();
        // Metadata save includes the endpoint IDs in message.extra.
        const c = context(), key = chatKey(c), meta = c.chatMetadata;
        await c.saveMetadata();
        if (chatKey(context()) !== key || context().chatMetadata !== meta) return;
        const disk = await engine.host.read();
        if (!disk.messages.some(m => m.extra?.[KEY]?.id === c.chatMetadata[KEY][action])) throw Error('Выбор диапазона не сохранён на сервере. Проверьте соединение.');
    }
    const click = async event => {
        const button = event.target.closest?.('[data-mrs-action]');
        if (!button || !doc.querySelector('#chat')?.contains(button)) return;
        event.preventDefault(); event.stopPropagation();
        const index = Number(button.closest('.mes').getAttribute('mesid'));
        const action = button.dataset.mrsAction;
        if (action === 'summary') await run(() => engine.summarize(settings().prompt));
        else {
            try { await select(action, index); showStatus(''); }
            catch (error) { showStatus(error.message); globalThis.toastr?.error(error.message, 'Сводка диапазона'); }
        }
        paint();
    };
    doc.addEventListener('click', click);
    drawer.querySelector('#mrs-restore').addEventListener('click', () => run(async () => {
        const restored = await engine.restore();
        showStatus(`Восстановлено исходников: ${restored}. Сводки исключены из контекста.`);
    }, false));
    const observer = new doc.defaultView.MutationObserver(records => {
        if (records.some(r => [...r.addedNodes, ...r.removedNodes].some(n => n.nodeType === 1 && (n.matches?.('.mes') || n.querySelector?.('.mes'))))) schedulePaint();
    });
    const chat = doc.querySelector('#chat');
    if (chat) observer.observe(chat, { childList: true, subtree: true });
    paint();
    return { paint, schedulePaint, showStatus, get status() { return status; }, destroy() { observer.disconnect(); doc.removeEventListener('click', click); drawer.remove(); } };
}

async function initialize() {
    // Internal imports are intentionally limited to APIs missing from getContext.
    const [core, chats] = await Promise.all([import('/script.js'), import('/scripts/chats.js')]);
    const context = () => SillyTavern.getContext();
    if (document.querySelector('#mrs-settings')) return;
    const c = context();
    for (const method of ['generateRawData', 'getTokenCountAsync', 'saveChat', 'saveMetadata', 'uuidv4']) {
        if (typeof c[method] !== 'function') throw Error(`Требуется актуальный SillyTavern: отсутствует ${method}.`);
    }
    if (typeof chats.hideChatMessageRange !== 'function' || typeof core.setSendButtonState !== 'function') throw Error('Несовместимая версия SillyTavern.');
    const host = createHost(context, core, chats), engine = new SummaryEngine(host);
    let ui, locked = false;
    async function run(action, summary = true) {
        if (locked || engine.busy) return;
        if (core.isGenerating()) { globalThis.toastr?.warning('Дождитесь завершения текущей генерации.'); return; }
        if (!context().chatId) { globalThis.toastr?.warning('Откройте сохранённый чат с персонажем или группой.'); return; }
        locked = true;
        core.setSendButtonState(true);
        context().deactivateSendButtons();
        try {
            ui.showStatus(summary ? 'Подготовка диапазона…' : 'Восстановление исходников…');
            const task = action();
            ui.paint();
            await task;
            if (summary) ui.showStatus('Сводка сохранена. Исходники до выбранного конца и сама сводка исключены из контекста.');
        } catch (error) {
            console.error('[Range Summary]', error);
            ui.showStatus(error.message ?? String(error));
            globalThis.toastr?.error(error.message ?? String(error), 'Сводка диапазона');
        } finally {
            locked = false;
            context().activateSendButtons();
            ui.paint();
        }
    }
    ui = mountUI(context, engine, run);
    host.progress = ui.showStatus;
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, () => { engine.invalidate(); ui.showStatus(''); ui.schedulePaint(); });
    c.eventSource.on(c.eventTypes.GENERATION_STOPPED, () => { if (locked) { engine.invalidate(); ui.showStatus('Операция остановлена.'); } });
    for (const event of ['MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED']) {
        if (c.eventTypes[event]) c.eventSource.on(c.eventTypes[event], ui.schedulePaint);
    }
}

if (typeof document !== 'undefined' && globalThis.SillyTavern) {
    const start = () => initialize().catch(error => {
        console.error('[Range Summary] Initialization failed', error);
        globalThis.toastr?.error(error.message, 'Сводка диапазона: ошибка загрузки');
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else void start();
}
