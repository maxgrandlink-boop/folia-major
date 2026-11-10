import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/okIpc.test.ts
// W1 桩：每条 ok-* invoke 都套了来源校验，不可信来源进不了处理函数；preload 的方法名对上这些通道。

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../..');
const { registerOkIpc, OK_INVOKE_CHANNELS } = require(path.join(root, 'electron/okIpc.cjs')) as {
    registerOkIpc: (options: {
        ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => void };
        isTrustedSender: (event: { trusted?: boolean }) => boolean;
    }) => { channels: readonly string[] };
    OK_INVOKE_CHANNELS: readonly string[];
};

const EVENT_CHANNELS = [
    'ok-works:changed',
    'ok-engine:state',
    'ok-engine:clock',
    'ok-engine:ended',
    'ok-engine:looped',
    'ok-engine:error',
    'ok-engine:devices',
    'ok-live:status',
    'ok-live:levels',
    'ok-cover:install-progress',
    'ok-cover:job',
];

describe('ok ipc stubs', () => {
    it('answers every invoke channel with not implemented, and refuses an untrusted sender', () => {
        const handlers = new Map<string, (event: { trusted?: boolean }, ...args: unknown[]) => unknown>();
        const registered = registerOkIpc({
            ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
            isTrustedSender: event => event.trusted === true,
        });
        expect([...registered.channels].sort()).toEqual([...OK_INVOKE_CHANNELS].sort());
        expect([...handlers.keys()].sort()).toEqual([...OK_INVOKE_CHANNELS].sort());
        for (const channel of OK_INVOKE_CHANNELS) {
            expect(handlers.get(channel)?.({ trusted: true }, 'ignored')).toEqual({
                ok: false,
                code: 'UNKNOWN',
                detail: 'not implemented',
            });
            expect(() => handlers.get(channel)?.({ trusted: false })).toThrow(/Untrusted renderer attempted to call the ok-/);
        }
    });

    it('main.cjs registers the stubs with the main-window check', () => {
        const main = readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
        expect(main).toContain("require('./okIpc.cjs')");
        const site = main.match(/registerOkIpc\(\{[\s\S]{0,240}/);
        expect(site?.[0]).toContain('isTrustedSender: event => isTrustedMainWindowContents(event.sender)');
    });

    it('preload ok methods invoke the stub channels and subscribe to the event channels', async () => {
        const source = readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8');
        const exposed: Record<string, unknown> = {};
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            send: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        new Function('require', source)((name: string) => {
            if (name !== 'electron') throw new Error(`preload required ${name}`);
            return {
                contextBridge: { exposeInMainWorld: (key: string, api: unknown) => { exposed[key] = api; } },
                ipcRenderer,
                webUtils: { getPathForFile: () => '' },
            };
        });
        const ok = (exposed.electron as { ok: Record<string, unknown> }).ok;
        expect(ok.contractVersion).toBe('1.1');
        const visit = async (value: unknown): Promise<void> => {
            if (typeof value === 'function') {
                const unsubscribe = await value('arg', { parentDir: 'D:\\ok' }, true);
                if (typeof unsubscribe === 'function') unsubscribe();
                return;
            }
            if (value && typeof value === 'object') {
                for (const child of Object.values(value)) await visit(child);
            }
        };
        await visit({ works: ok.works, engine: ok.engine, live: ok.live, cover: ok.cover });
        const invoked = (ipcRenderer.invoke.mock.calls as unknown[][]).map(call => call[0]);
        expect([...new Set(invoked)].sort()).toEqual([...OK_INVOKE_CHANNELS].sort());
        const subscribed = (ipcRenderer.on.mock.calls as unknown[][]).map(call => call[0]);
        expect([...new Set(subscribed)].sort()).toEqual([...EVENT_CHANNELS].sort());
        expect(ipcRenderer.removeListener).toHaveBeenCalled();
    });
});
