import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createOkEngineSession } = require('../../../electron/okEngine/engineSession.cjs') as {
    createOkEngineSession: (options: Record<string, unknown>) => {
        load: (req: Record<string, unknown>) => Promise<{ ok: boolean; code?: string; value?: { attempt?: number } }>;
        play: (attempt: number) => Promise<{ ok: boolean; code?: string }>;
        seek: (attempt: number, sec: number) => Promise<{ ok: boolean; code?: string; value?: { positionSec?: number } }>;
        getSnapshot: () => Promise<{ ok: boolean; value: unknown }>;
        killSync: () => void;
    };
};

class FakeChild extends EventEmitter {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    lines: string[] = [];

    constructor() {
        super();
        this.stdin.on('data', (chunk) => {
            this.lines.push(...String(chunk).split('\n').filter(line => line.trim()));
            const message = JSON.parse(this.lines[this.lines.length - 1]) as { id: number; cmd: string; args: { sec?: number } };
            if (message.cmd === 'load') {
                this.stdout.write(`${JSON.stringify({ event: 'state', attempt: 2, status: 'ready' })}\n`);
                this.stdout.write(`${JSON.stringify({ id: message.id, ok: true, value: { attempt: 2, durationSec: 1, sampleRate: 44100, tracks: [] } })}\n`);
            } else if (message.cmd === 'seek') {
                this.stdout.write(`${JSON.stringify({ id: message.id, ok: true, value: { positionSec: message.args.sec } })}\n`);
            } else {
                this.stdout.write(`${JSON.stringify({ id: message.id, ok: true, value: null })}\n`);
            }
        });
    }

    kill() {
        this.emit('exit', 0, null);
    }
}

const tracks = { vocal: 'v.wav', instrumental: 'i.wav', original: 'o.wav' };
const loadReq = {
    attempt: 2,
    workId: 'work',
    mix: {
        vocal: { gain: 80, muted: false },
        instrumental: { gain: 80, muted: false },
        original: { gain: 0, muted: false },
    },
    master: { volume: 1, muted: false },
    karaoke: false,
    harmony: false,
    startSec: 0,
    autoplay: false,
    loopOne: false,
};

describe('ok engine session', () => {
    it('returns WORK_NOT_FOUND without spawning when the work is unknown', async () => {
        const spawnImpl = vi.fn();
        const session = createOkEngineSession({
            resolveExe: () => 'ok-engine.exe',
            resolveTracks: async () => null,
            spawnImpl,
            send: () => {},
        });
        await expect(session.load(loadReq)).resolves.toEqual({ ok: false, code: 'WORK_NOT_FOUND' });
        expect(spawnImpl).not.toHaveBeenCalled();
    });

    it('loads, seeks, and drops a stale attempt', async () => {
        const events: Array<{ channel: string; payload: { status?: string } }> = [];
        const session = createOkEngineSession({
            resolveExe: () => 'ok-engine.exe',
            resolveTracks: async () => tracks,
            cacheDir: () => 'cache',
            resolveFfmpeg: async () => null,
            spawnImpl: () => new FakeChild(),
            send: (channel: string, payload: { status?: string }) => events.push({ channel, payload }),
        });
        const loaded = await session.load(loadReq);
        expect(loaded.ok).toBe(true);
        expect(events.some(event => event.channel === 'ok-engine:state' && event.payload.status === 'ready')).toBe(true);
        await expect(session.seek(1, 0.2)).resolves.toEqual({ ok: false, code: 'SUPERSEDED' });
        await expect(session.seek(2, 0.2)).resolves.toEqual({ ok: true, value: { positionSec: 0.2 } });
        await expect(session.getSnapshot()).resolves.toEqual({ ok: true, value: null });
        session.killSync();
    });

    it('opens the circuit after three crashes', async () => {
        const session = createOkEngineSession({
            resolveExe: () => 'ok-engine.exe',
            resolveTracks: async () => tracks,
            spawnImpl: () => {
                const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
                child.stdin = new PassThrough();
                child.stdout = new PassThrough();
                child.stderr = new PassThrough();
                child.stdin.on('data', () => child.emit('exit', 1, null));
                return child;
            },
            send: () => {},
            setTimer: (fn: () => void, ms: number) => (ms === 1000 ? 0 : setTimeout(fn, ms)),
            clearTimer: (id: number) => { if (id) clearTimeout(id as unknown as NodeJS.Timeout); },
            crashWindowMs: 60000,
            crashLimit: 3,
        });
        await expect(session.load(loadReq)).resolves.toMatchObject({ ok: false, code: 'ENGINE_CRASHED' });
        await expect(session.load(loadReq)).resolves.toMatchObject({ ok: false, code: 'ENGINE_CRASHED' });
        await expect(session.load(loadReq)).resolves.toMatchObject({ ok: false, code: 'ENGINE_CRASHED' });
        await expect(session.load(loadReq)).resolves.toEqual({ ok: false, code: 'CIRCUIT_OPEN' });
    });

    it('reports ENGINE_NOT_FOUND when the binary is missing', async () => {
        const session = createOkEngineSession({
            resolveExe: () => null,
            resolveTracks: async () => tracks,
            send: () => {},
        });
        await expect(session.load(loadReq)).resolves.toEqual({ ok: false, code: 'ENGINE_NOT_FOUND' });
    });
});
