import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installOkMock, type OkMockHandle } from '../../../src/services/okMock/installOkMock';
import { DEFAULT_WORK_MIX, type EngineClock, type EngineLoadRequest, type EngineSnapshot, type EngineState } from '../../../src/types/multitrack';
import { OK_CONTRACT_VERSION } from '../../../src/types/multitrack';
import type { OkBridge } from '../../../src/types/okBridge';
import { COVER_MODE_TRACKS } from '../../../src/types/cover';
import type { CoverInstallProgress, CoverJobEvent, CoverJobPhase, CoverJobRequest, CoverPartId } from '../../../src/types/cover';
import type { LiveMode, LiveStatus } from '../../../src/types/live';

// test/unit/okMock/okMock.test.ts
// W1.8：mock 下走完播放、直播模式、翻唱三条流程，以及契约里的故障注入。用假定时器。

let handle: OkMockHandle | undefined;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
});

afterEach(() => {
    handle?.uninstall();
    handle = undefined;
    vi.useRealTimers();
});

function bridgeOf(): OkBridge {
    handle = installOkMock();
    const bridge: OkBridge = handle.bridge;
    return bridge;
}

async function settle<T>(pending: Promise<T>, ms: number): Promise<T> {
    await vi.advanceTimersByTimeAsync(ms);
    return pending;
}

function valueOf<T>(result: { ok: true; value: T } | { ok: false; code: string }): T {
    if (!result.ok) throw new Error(result.code);
    return result.value;
}

function snapshotOf(result: { ok: true; value: EngineSnapshot | null } | { ok: false; code: string }): EngineSnapshot {
    const snapshot = valueOf(result);
    if (!snapshot) throw new Error('engine has no snapshot');
    return snapshot;
}

function loadReq(over: Partial<EngineLoadRequest> = {}): EngineLoadRequest {
    return {
        attempt: 1,
        workId: 'w-anhao',
        mix: DEFAULT_WORK_MIX,
        karaoke: false,
        harmony: false,
        master: { volume: 1, muted: false },
        startSec: 0,
        autoplay: false,
        loopOne: false,
        ...over,
    };
}

function coverReq(title: string, over: Partial<CoverJobRequest> = {}): CoverJobRequest {
    return {
        sourceSongId: 'local-song',
        source: { fileName: 'src.wav', bytes: new ArrayBuffer(8) },
        lyrics: null,
        modelId: 'm-demo',
        title,
        artist: '示例',
        ...over,
    };
}

describe('ok mock', () => {
    it('桥的类型是 OkBridge，契约版本一致', () => {
        const bridge = bridgeOf();
        expect(bridge.contractVersion).toBe(OK_CONTRACT_VERSION);
        const host = (globalThis as unknown as { window: { electron: { ok: OkBridge }; __okMock?: OkMockHandle } }).window;
        expect(host.electron.ok).toBe(bridge);
        expect(host.__okMock).toBe(handle);
    });

    it('加载示例作品、播放、seek、分轨音量、暂停和结束', async () => {
        const bridge = bridgeOf();
        const listed = valueOf(await settle(bridge.works.list(), 20));
        expect(listed.map(work => work.id)).toEqual(['w-anhao', 'w-yehang', 'w-lianxi', 'w-broken']);

        const statuses: EngineState['status'][] = [];
        const clocks: EngineClock[] = [];
        bridge.engine.onState(state => statuses.push(state.status));
        bridge.engine.onClock(clock => clocks.push(clock));
        const loaded = valueOf(await settle(bridge.engine.load(loadReq({ autoplay: true })), 150));
        expect(statuses).toEqual(['loading', 'ready', 'playing']);
        expect(loaded.sampleRate).toBe(44100);
        expect(loaded.durationSec).toBeCloseTo(269.23394557823127, 5);
        expect(loaded.tracks.every(track => !track.padded && !track.trimmed)).toBe(true);

        const clockCount = clocks.length;
        await vi.advanceTimersByTimeAsync(1000);
        const during = clocks.slice(clockCount);
        expect(during.length).toBeGreaterThanOrEqual(9);
        expect(during.length).toBeLessThanOrEqual(11);
        expect(during[during.length - 1].positionSec).toBeCloseTo(1, 1);

        const seekClocks: number[] = [];
        const offSeek = bridge.engine.onClock(clock => seekClocks.push(clock.positionSec));
        expect(valueOf(await settle(bridge.engine.seek(1, 60), 20)).positionSec).toBe(60);
        expect(seekClocks[0]).toBe(60);
        offSeek();

        expect((await settle(bridge.engine.setMix(1, {
            vocal: { gain: 50, muted: false },
            instrumental: { gain: 70, muted: false },
            original: { gain: 10, muted: true },
        }), 20)).ok).toBe(true);

        const afterPause = snapshotOf(await settle(bridge.engine.getSnapshot(), 20));
        expect((await settle(bridge.engine.pause(1), 20)).ok).toBe(true);
        const paused = snapshotOf(await settle(bridge.engine.getSnapshot(), 20));
        expect(paused.state.status).toBe('paused');
        const frozen = clocks.length;
        await vi.advanceTimersByTimeAsync(500);
        expect(clocks.length).toBe(frozen);
        expect(paused.clock.positionSec).toBeGreaterThan(afterPause.clock.positionSec - 1);

        handle?.setClockRate(100);
        expect((await settle(bridge.engine.play(1), 20)).ok).toBe(true);
        const ended: number[] = [];
        bridge.engine.onEnded(event => ended.push(event.attempt));
        await vi.advanceTimersByTimeAsync(3000);
        expect(ended).toEqual([1]);

        expect((await settle(bridge.engine.setLoopOne(true), 20)).ok).toBe(true);
        const duration = snapshotOf(await settle(bridge.engine.getSnapshot(), 20)).state.durationSec;
        expect(valueOf(await settle(bridge.engine.seek(1, duration - 0.05), 20)).positionSec).toBeCloseTo(duration - 0.05, 5);
        let loopClock: number | null = null;
        let looped = false;
        bridge.engine.onLooped(() => { looped = true; });
        bridge.engine.onClock(clock => { if (looped && loopClock === null) loopClock = clock.positionSec; });
        expect((await settle(bridge.engine.play(1), 20)).ok).toBe(true);
        await vi.advanceTimersByTimeAsync(200);
        expect(looped).toBe(true);
        expect(loopClock).toBeCloseTo(0, 5);

        expect(await settle(bridge.engine.load(loadReq({ attempt: 2, workId: 'w-broken' })), 150)).toEqual({ ok: false, code: 'TRACK_UNREADABLE' });
        const first = bridge.engine.load(loadReq({ attempt: 3, autoplay: false }));
        const second = bridge.engine.load(loadReq({ attempt: 4, autoplay: false }));
        await vi.advanceTimersByTimeAsync(150);
        expect(await first).toEqual({ ok: false, code: 'SUPERSEDED' });
        expect((await second).ok).toBe(true);
    });

    it('插件在线时切换四个模式，智能混响来回，断连后仍能切模式', async () => {
        const bridge = bridgeOf();
        const events: LiveStatus[] = [];
        bridge.live.onStatus(status => events.push(status));
        const initial = valueOf(await settle(bridge.live.getStatus(), 20));
        expect(initial.connection).toBe('connected');
        expect(initial.route).toBe('live');
        expect(initial.userMode).toBe('speech');

        const switchMode = async (mode: LiveMode, waitMs: number) => {
            events.length = 0;
            const pending = bridge.live.setMode(mode, 'ui');
            await vi.advanceTimersByTimeAsync(20);
            const first = valueOf(await pending);
            expect(first.switching).toBe(true);
            expect(first.userMode).toBe(mode);
            await vi.advanceTimersByTimeAsync(waitMs - 1);
            expect(events[events.length - 1].switching).toBe(true);
            await vi.advanceTimersByTimeAsync(1);
            const done = events[events.length - 1];
            expect(done.switching).toBe(false);
            expect(done.userMode).toBe(mode);
            expect(done.effectiveMode).toBe(mode);
        };

        await switchMode('ai-follow', 40);
        await switchMode('ai-sing', 320);
        await switchMode('reverb-speech', 320);
        await switchMode('speech', 40);
        await switchMode('ai-follow', 40);

        expect((await settle(bridge.live.setSmartReverb({
            enabled: true, silenceSec: 1, earlyReturnSec: 0.3, returnMode: 'ai-follow',
        }), 20)).ok).toBe(true);
        expect((await settle(bridge.engine.load(loadReq({ autoplay: true, startSec: 120.5 })), 150)).ok).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);
        const inGap = valueOf(await settle(bridge.live.getStatus(), 20));
        expect(inGap.effectiveMode).toBe('reverb-speech');
        expect(inGap.smartReverbActive).toBe(true);
        await vi.advanceTimersByTimeAsync(9300);
        const leaving = valueOf(await settle(bridge.live.getStatus(), 20));
        expect(leaving.effectiveMode).toBe('ai-follow');
        expect(leaving.smartReverbActive).toBe(false);

        const routes: EngineState['route'][] = [];
        bridge.engine.onState(state => routes.push(state.route));
        handle?.disconnectPlugin();
        expect(routes).toContain('local');
        const offline = valueOf(await settle(bridge.live.getStatus(), 20));
        expect(offline.connection).toBe('absent');
        expect(offline.route).toBe('local');
        expect((await settle(bridge.live.setMode('speech', 'hotkey'), 20)).ok).toBe(true);
    });

    it('认领翻唱组件并走完完成、失败和取消', async () => {
        const bridge = bridgeOf();
        const absent = valueOf(await settle(bridge.cover.getComponent(), 20));
        expect(absent.state).toBe('absent');
        expect(absent.downloadBytes).toBe(9_092_658_766);
        expect(absent.parts.map(part => part.id)).toEqual(['torch-cuda', 'runtime', 'base-models', 'enhance-models', 'msst-native']);
        expect(absent.parts.map(part => part.downloadBytes)).toEqual([5_814_173_571, 1_994_686_114, 1_283_799_081, 1_826_204_379, 1_902_601_117]);
        expect(absent.parts.every(part => part.installedBytes === part.downloadBytes)).toBe(true);
        expect(absent.modes).toHaveLength(6);
        expect(absent.modes.every(mode => mode.available === false)).toBe(true);
        expect(absent.defaultSeparator).toBe('builtin');
        expect(await settle(bridge.cover.submit(coverReq('还没装')), 20)).toEqual({ ok: false, code: 'COMPONENT_MISSING' });
        expect(await settle(bridge.cover.installComponent({ parentDir: 'X:\\full' }), 20)).toEqual({ ok: false, code: 'DOWNLOAD_UNAVAILABLE' });
        expect(await settle(bridge.cover.installComponent(), 20)).toEqual({ ok: false, code: 'DOWNLOAD_UNAVAILABLE' });
        expect(await settle(bridge.cover.locateComponent('X:\\missing'), 20)).toEqual({ ok: false, code: 'COMPONENT_MISSING' });
        expect(await settle(bridge.cover.locateComponent('C:\\other'), 20)).toEqual({ ok: false, code: 'CHECKSUM_MISMATCH' });
        expect(valueOf(await settle(bridge.cover.getComponent(), 20)).state).toBe('absent');

        const cancelledProgress: CoverInstallProgress[] = [];
        const offCancelled = bridge.cover.onInstallProgress(event => cancelledProgress.push(event));
        const aborted = bridge.cover.locateComponent('D:\\okchang-test\\cover-runtime');
        await vi.advanceTimersByTimeAsync(400);
        expect((await settle(bridge.cover.cancelInstall(), 20)).ok).toBe(true);
        expect(cancelledProgress.some(event => event.phase === 'cancelled' && event.partId === null)).toBe(true);
        expect(valueOf(await aborted).state).toBe('absent');
        expect(valueOf(await settle(bridge.cover.getComponent(), 20)).state).toBe('absent');
        offCancelled();

        const progress: CoverInstallProgress[] = [];
        bridge.cover.onInstallProgress(event => progress.push(event));
        const locating = bridge.cover.locateComponent('D:\\okchang-test\\cover-runtime');
        await vi.advanceTimersByTimeAsync(2020);
        const located = valueOf(await locating);
        expect(located.state).toBe('installed');
        expect(located.installRoot).toBe('D:\\okchang-test\\cover-runtime');
        const verifyIds = progress.filter(event => event.phase === 'verifying').map(event => event.partId);
        const cycle: CoverPartId[] = ['torch-cuda', 'runtime', 'base-models', 'enhance-models'];
        expect(verifyIds).toEqual(Array.from({ length: 10 }, (_, index) => cycle[index % cycle.length]));
        expect(progress[progress.length - 1]).toMatchObject({ phase: 'done', partId: null });
        const installed = valueOf(await settle(bridge.cover.getComponent(), 20));
        expect(installed.state).toBe('installed');
        expect(installed.defaultMode).toBe('normal');
        expect(installed.defaultSeparator).toBe('builtin');

        expect(await settle(bridge.cover.submit(coverReq('变调越界', { keySemitones: 13 })), 20)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
        expect(await settle(bridge.cover.submit(coverReq('没有模型', { modelId: 'missing' })), 20)).toEqual({ ok: false, code: 'MODEL_INVALID' });
        expect(await settle(bridge.cover.submit(coverReq('加密', {
            source: { fileName: 'x.ncm', bytes: new ArrayBuffer(8) },
        })), 20)).toEqual({ ok: false, code: 'SOURCE_ENCRYPTED' });
        expect(await settle(bridge.cover.submit(coverReq('不开放', { mode: 'aggressive' })), 20)).toEqual({ ok: false, code: 'MODE_UNAVAILABLE' });

        const before = valueOf(await settle(bridge.works.list(), 20)).length;
        const timeline: string[] = [];
        const jobs: CoverJobEvent[] = [];
        bridge.cover.onJob(event => {
            jobs.push(event);
            timeline.push(`job:${event.phase}`);
        });
        bridge.works.onChanged(event => timeline.push(`works:${event.added.map(work => work.id).join(',')}`));
        const submitted = valueOf(await settle(bridge.cover.submit(coverReq('翻唱示例')), 20));
        expect(submitted.jobId).toMatch(/^job-/);
        await vi.advanceTimersByTimeAsync(9000);
        const jobPhases = jobs.map(event => event.phase);
        let cursor = -1;
        const expectedPhases: CoverJobPhase[] = ['queued', 'preparing', 'separating', 'converting', 'ingesting', 'done'];
        for (const phase of expectedPhases) {
            const index = jobPhases.indexOf(phase);
            expect(index).toBeGreaterThan(cursor);
            cursor = index;
        }
        for (let i = 1; i < jobs.length; i += 1) expect(jobs[i].progress).toBeGreaterThanOrEqual(jobs[i - 1].progress);
        expect(jobs.filter(event => event.phase === 'converting').every(event => event.indeterminate)).toBe(true);
        expect(jobs.filter(event => event.phase !== 'converting').every(event => !event.indeterminate)).toBe(true);
        const separated = jobs.filter(event => event.phase === 'separating' || event.phase === 'converting' || event.phase === 'ingesting' || event.phase === 'done');
        expect(separated.every(event => event.separator === 'builtin')).toBe(true);
        expect(jobs.filter(event => event.phase === 'queued' || event.phase === 'preparing').every(event => event.separator === undefined)).toBe(true);
        const worksAt = timeline.findIndex(item => item.startsWith('works:w-cover-'));
        expect(worksAt).toBeGreaterThanOrEqual(0);
        expect(worksAt).toBeLessThan(timeline.indexOf('job:done'));
        const afterDone = valueOf(await settle(bridge.works.list(), 20));
        expect(afterDone).toHaveLength(before + 1);
        const created = afterDone.find(work => work.title === '翻唱示例');
        expect(created?.rootId).toBe('root-cover');
        expect(created?.tracks.map(track => track.role)).toEqual([...COVER_MODE_TRACKS.normal]);

        handle?.failCoverJob('JOB_FAILED');
        const failed: CoverJobEvent[] = [];
        const offFailed = bridge.cover.onJob(event => failed.push(event));
        await settle(bridge.cover.submit(coverReq('失败示例')), 20);
        await vi.advanceTimersByTimeAsync(9000);
        expect(failed.some(event => event.phase === 'failed' && event.errorCode === 'JOB_FAILED')).toBe(true);
        expect(failed.some(event => event.phase === 'done')).toBe(false);
        expect(valueOf(await settle(bridge.works.list(), 20))).toHaveLength(before + 1);
        offFailed();

        const cancelled: CoverJobEvent[] = [];
        bridge.cover.onJob(event => cancelled.push(event));
        const jobId = valueOf(await settle(bridge.cover.submit(coverReq('取消示例')), 20)).jobId;
        await vi.advanceTimersByTimeAsync(600);
        expect((await settle(bridge.cover.cancel(jobId), 20)).ok).toBe(true);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(cancelled.some(event => event.jobId === jobId && event.phase === 'cancelled')).toBe(true);
        expect(cancelled.some(event => event.jobId === jobId && event.phase === 'done')).toBe(false);
        expect(valueOf(await settle(bridge.works.list(), 20))).toHaveLength(before + 1);
        expect(await settle(bridge.cover.cancel('missing-job'), 20)).toEqual({ ok: false, code: 'JOB_NOT_FOUND' });

        if (!handle) throw new Error('mock missing');
        handle.uninstall();
        handle = installOkMock({ componentInstalled: true, enhanceInstalled: false });
        const limited = handle.bridge;
        const modes = valueOf(await settle(limited.cover.getComponent(), 20)).modes;
        expect(modes.find(mode => mode.mode === 'normal' && mode.separator === 'builtin')).toMatchObject({
            available: false, reason: 'missing-part', missingParts: ['enhance-models'],
        });
        expect(modes.filter(mode => mode.mode === 'aggressive').every(mode => mode.available === false && mode.reason === 'not-in-v1')).toBe(true);
        expect(await settle(limited.cover.submit(coverReq('缺包', { mode: 'normal' })), 20)).toEqual({ ok: false, code: 'MODE_UNAVAILABLE' });

        handle.uninstall();
        handle = installOkMock({ componentInstalled: true, msstNativeInstalled: true });
        const withNative = handle.bridge;
        expect((await settle(withNative.cover.removeComponent({ parts: ['msst-native'] }), 20)).ok).toBe(true);
        const kept = valueOf(await settle(withNative.cover.getComponent(), 20));
        expect(kept.state).toBe('installed');
        expect(kept.parts.find(part => part.id === 'msst-native')?.state).toBe('absent');
        expect(kept.parts.find(part => part.id === 'runtime')?.state).toBe('installed');
        expect((await settle(withNative.cover.removeComponent(), 20)).ok).toBe(true);
        expect(valueOf(await settle(withNative.cover.getComponent(), 20)).state).toBe('absent');
        expect(valueOf(await settle(withNative.cover.getComponent(), 20)).installRoot).toBeNull();
    });

    it('故障注入：崩溃、断连、ABI、损坏作品、failNext', async () => {
        const bridge = bridgeOf();
        const errors: Array<{ code: string; fatal: boolean }> = [];
        const statuses: EngineState['status'][] = [];
        bridge.engine.onError(event => errors.push({ code: event.code, fatal: event.fatal }));
        bridge.engine.onState(state => statuses.push(state.status));
        handle?.crashEngine();
        expect(errors[errors.length - 1]).toEqual({ code: 'ENGINE_CRASHED', fatal: true });
        expect(statuses).toContain('error');
        expect(await settle(bridge.live.getStatus(), 20)).toEqual({ ok: false, code: 'ENGINE_NOT_RUNNING' });
        await vi.advanceTimersByTimeAsync(1000);
        expect(statuses[statuses.length - 1]).toBe('idle');
        handle?.crashEngine();
        await vi.advanceTimersByTimeAsync(1000);
        handle?.crashEngine();
        await vi.advanceTimersByTimeAsync(1000);
        expect(await settle(bridge.engine.load(loadReq()), 150)).toEqual({ ok: false, code: 'CIRCUIT_OPEN' });

        if (!handle) throw new Error('mock missing');
        handle.uninstall();
        handle = installOkMock();
        const again = handle.bridge;
        expect((await settle(again.engine.load(loadReq()), 150)).ok).toBe(true);
        const clocks: number[] = [];
        const routes: string[] = [];
        again.engine.onClock(() => clocks.push(1));
        again.engine.onState(state => routes.push(state.route));
        handle.disconnectPlugin();
        expect(routes).toContain('local');
        handle.reconnectPlugin();
        expect(clocks.length).toBeGreaterThan(0);
        expect(routes).toContain('live');
        handle.setPluginAbiMismatch();
        expect(valueOf(await settle(again.live.getStatus(), 20)).connection).toBe('abi-mismatch');
        expect(valueOf(await settle(again.live.getStatus(), 20)).route).toBe('local');
        handle.setPluginDuplicate();
        expect(valueOf(await settle(again.live.getStatus(), 20)).connection).toBe('duplicate');

        handle.breakWork('w-yehang');
        expect(await settle(again.engine.load(loadReq({ attempt: 2, workId: 'w-yehang' })), 150)).toEqual({ ok: false, code: 'TRACK_UNREADABLE' });
        const scanned = valueOf(await settle(again.works.rescan(), 500));
        expect(scanned.removed).toBe(1);
        expect(scanned.skipped).toEqual(expect.arrayContaining([
            { relPath: '周杰伦 - 稻香', reason: 'no-tracks' },
            { relPath: '残缺作品', reason: 'not-complete' },
            { relPath: '自建歌单/练习/示例歌手B - 夜航', reason: 'unreadable' },
        ]));
        expect(valueOf(await settle(again.works.list(), 20)).some(work => work.id === 'w-yehang')).toBe(false);

        handle.failNext('works.list', 'UNKNOWN');
        expect(await settle(again.works.list(), 20)).toEqual({ ok: false, code: 'UNKNOWN' });
        expect((await settle(again.works.list(), 20)).ok).toBe(true);
        expect(await settle(again.works.removeRoot('root-cover'), 20)).toEqual({ ok: false, code: 'ROOT_PROTECTED' });
        expect(await settle(again.engine.setOutputDevice('dev-missing'), 20)).toEqual({ ok: false, code: 'DEVICE_UNAVAILABLE' });
        expect(await settle(again.live.setPluginGains({
            normalSpeechDb: 0, reverbSpeechDb: 0, aiVoiceDb: 13, aiAccompDb: 0,
        }), 20)).toEqual({ ok: false, code: 'INVALID_REQUEST' });
        expect(await settle(again.cover.removeModel('missing'), 20)).toEqual({ ok: false, code: 'MODEL_NOT_FOUND' });
    });

    it('每个 onX 退订后不再收到事件，uninstall 后没有定时器', async () => {
        const bridge = bridgeOf();
        const worksEvents: number[] = [];
        const offWorks = bridge.works.onChanged(() => worksEvents.push(1));
        await settle(bridge.works.addRoot(), 300);
        expect(worksEvents).toHaveLength(1);
        offWorks();
        await settle(bridge.works.removeRoot('root-extra'), 20);
        expect(worksEvents).toHaveLength(1);

        await settle(bridge.engine.load(loadReq({ autoplay: true })), 150);
        const states: string[] = [];
        const offState = bridge.engine.onState(state => states.push(state.status));
        await settle(bridge.engine.setLoopOne(true), 20);
        expect(states.length).toBeGreaterThan(0);
        const stateCount = states.length;
        offState();
        await settle(bridge.engine.setLoopOne(false), 20);
        expect(states).toHaveLength(stateCount);

        const clocks: number[] = [];
        const offClock = bridge.engine.onClock(clock => clocks.push(clock.seq));
        await settle(bridge.engine.seek(1, 10), 20);
        expect(clocks.length).toBeGreaterThan(0);
        const clockCount = clocks.length;
        offClock();
        await settle(bridge.engine.seek(1, 12), 20);
        expect(clocks).toHaveLength(clockCount);

        handle?.setClockRate(200);
        const ended: number[] = [];
        const offEnded = bridge.engine.onEnded(() => ended.push(1));
        await vi.advanceTimersByTimeAsync(3000);
        expect(ended.length).toBeGreaterThan(0);
        const endedCount = ended.length;
        offEnded();
        await settle(bridge.engine.setLoopOne(true), 20);
        await settle(bridge.engine.seek(1, 1), 20);
        await settle(bridge.engine.play(1), 20);
        await vi.advanceTimersByTimeAsync(3000);
        expect(ended).toHaveLength(endedCount);

        const looped: number[] = [];
        const offLooped = bridge.engine.onLooped(() => looped.push(1));
        await vi.advanceTimersByTimeAsync(3000);
        expect(looped.length).toBeGreaterThan(0);
        const loopCount = looped.length;
        offLooped();
        await vi.advanceTimersByTimeAsync(3000);
        expect(looped).toHaveLength(loopCount);

        const errors: number[] = [];
        const offError = bridge.engine.onError(() => errors.push(1));
        handle?.crashEngine();
        expect(errors).toHaveLength(1);
        offError();
        handle?.crashEngine();
        expect(errors).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1000);

        expect((await settle(bridge.engine.load(loadReq({ attempt: 4 })), 150)).ok).toBe(true);
        const devices: number[] = [];
        const offDevices = bridge.engine.onDevices(() => devices.push(1));
        await settle(bridge.engine.setOutputDevice('dev-headset'), 20);
        expect(devices).toHaveLength(1);
        offDevices();
        await settle(bridge.engine.setOutputDevice(null), 20);
        expect(devices).toHaveLength(1);

        const liveEvents: number[] = [];
        const offLive = bridge.live.onStatus(() => liveEvents.push(1));
        handle?.disconnectPlugin();
        expect(liveEvents.length).toBeGreaterThan(0);
        const liveCount = liveEvents.length;
        offLive();
        handle?.reconnectPlugin();
        expect(liveEvents).toHaveLength(liveCount);

        const levels: number[] = [];
        const offLevels = bridge.live.onLevels(() => levels.push(1));
        await settle(bridge.live.setLevelsSubscribed(true), 20);
        await vi.advanceTimersByTimeAsync(200);
        expect(levels.length).toBeGreaterThan(0);
        const levelCount = levels.length;
        offLevels();
        await vi.advanceTimersByTimeAsync(200);
        expect(levels).toHaveLength(levelCount);

        const progress: number[] = [];
        const offProgress = bridge.cover.onInstallProgress(() => progress.push(1));
        const locating = bridge.cover.locateComponent('D:\\okchang-test\\cover-runtime');
        await vi.advanceTimersByTimeAsync(220);
        expect(progress.length).toBeGreaterThan(0);
        const progressCount = progress.length;
        offProgress();
        await vi.advanceTimersByTimeAsync(2000);
        expect(progress).toHaveLength(progressCount);
        expect((await locating).ok).toBe(true);
        expect(valueOf(await settle(bridge.cover.getComponent(), 20)).state).toBe('installed');

        const jobEvents: number[] = [];
        const offJob = bridge.cover.onJob(() => jobEvents.push(1));
        await settle(bridge.cover.submit(coverReq('退订')), 20);
        expect(jobEvents.length).toBeGreaterThan(0);
        const jobCount = jobEvents.length;
        offJob();
        await vi.advanceTimersByTimeAsync(1000);
        expect(jobEvents).toHaveLength(jobCount);

        handle?.uninstall();
        handle = undefined;
        expect(vi.getTimerCount()).toBe(0);
    });
});
