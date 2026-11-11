import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { Work } from '../../types/multitrack';
import { okBridgeReady, readOkBridge } from '../../services/ok/okAccess';
import { clampMasterVolume } from '../../stores/useLiveSettingsStore';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import {
    getWorkPlayback,
    playWork,
    SAMPLE_WORK_ID,
    setHarmony,
    setKaraoke,
    setLoopOne,
    setMaster,
    setTrackGain,
    setTrackMuted,
    startWorkPlayback,
    subscribeWorkPlayback,
    toggleWorkPlayback,
} from '../../services/multitrack/workPlayback';
import StemMixPanel from '../multitrack/StemMixPanel';
import WorkTransport from '../multitrack/WorkTransport';
import { getOkPanel, setOkPanel, subscribeOkPanel } from './okPanels';

// src/components/ok/OkHost.tsx
// ok唱歌 界面的装配点。没有桥就不画。分轨面板是第一块；直播条、作品库、翻唱从这里往上加。

interface OkHostProps {
    isDaylight: boolean;
    accentColor: string;
}

function masterOf(): { volume: number; muted: boolean } {
    const audio = useAudioSettingsStore.getState();
    return { volume: clampMasterVolume(audio.volume), muted: audio.isMuted };
}

const OkHost: React.FC<OkHostProps> = ({ isDaylight, accentColor }) => {
    const { t } = useTranslation();
    const ready = okBridgeReady();
    const panel = useSyncExternalStore(subscribeOkPanel, getOkPanel, () => null);
    const playback = useSyncExternalStore(subscribeWorkPlayback, getWorkPlayback, getWorkPlayback);
    const [work, setWork] = useState<Work | null>(null);

    useEffect(() => {
        if (!ready) return undefined;
        return startWorkPlayback();
    }, [ready]);

    useEffect(() => {
        if (!ready) return undefined;
        return useAudioSettingsStore.subscribe((state, previous) => {
            if (state.volume === previous.volume && state.isMuted === previous.isMuted && state.loopMode === previous.loopMode) return;
            void setMaster(clampMasterVolume(state.volume), state.isMuted);
            void setLoopOne(state.loopMode === 'one');
        });
    }, [ready]);

    if (!ready) return null;

    const open = panel === 'stems';
    const shell = isDaylight ? 'border-black/10 bg-white/95 text-neutral-900' : 'border-white/15 bg-neutral-950/92 text-neutral-100';

    const playSample = async () => {
        const bridge = readOkBridge();
        if (!bridge) return;
        const listed = await bridge.works.list();
        const found = listed.ok ? listed.value.find(item => item.id === SAMPLE_WORK_ID) ?? null : null;
        setWork(found);
        await playWork(SAMPLE_WORK_ID, { master: masterOf(), loopOne: useAudioSettingsStore.getState().loopMode === 'one' });
    };

    const shown = work && playback.workId === work.id ? work : null;

    return (
        <div className="pointer-events-none fixed bottom-4 left-4 z-[60] flex items-end gap-3" style={{ ['--ok-accent' as string]: accentColor }}>
            <button
                type="button"
                className={`pointer-events-auto rounded-full border px-3 py-1.5 text-xs shadow-lg ${shell}`}
                onClick={() => setOkPanel(open ? null : 'stems')}
            >
                {t('ok.stems')}
            </button>
            {open && (
                <div
                    data-testid="ok-stem-sheet"
                    className={`pointer-events-auto flex max-h-[70vh] w-[22rem] flex-col gap-4 overflow-y-auto rounded-2xl border p-4 shadow-2xl ${shell}`}
                >
                    <div className="flex items-center justify-between">
                        <h2 className="text-sm font-medium">{t('ok.stems')}</h2>
                        <button type="button" className="text-xs opacity-70" onClick={() => setOkPanel(null)}>{t('ok.close')}</button>
                    </div>
                    {playback.error && (
                        <p className="text-xs text-red-500" role="alert">{t(`ok.errors.${playback.error.code}`, playback.error.code)}</p>
                    )}
                    {shown && playback.workId === shown.id ? (
                        <WorkTransport
                            isDaylight={isDaylight}
                            playback={playback}
                            lyrics={shown.lyrics?.content ?? null}
                            title={shown.title}
                            artist={shown.artist}
                            onToggle={() => { void toggleWorkPlayback(); }}
                        />
                    ) : (
                        <button type="button" className="self-start rounded-full bg-[var(--ok-accent)] px-3 py-1 text-xs text-white" onClick={() => { void playSample(); }}>
                            {t('ok.playSample')}
                        </button>
                    )}
                    <StemMixPanel
                        isDaylight={isDaylight}
                        mix={playback.mix}
                        tracks={shown?.tracks ?? []}
                        karaoke={playback.karaoke}
                        harmony={playback.harmony}
                        disabled={playback.pending}
                        onGain={(role, gain) => { void setTrackGain(role, gain); }}
                        onMuted={(role, muted) => { void setTrackMuted(role, muted); }}
                        onKaraoke={on => { void setKaraoke(on); }}
                        onHarmony={on => { void setHarmony(on); }}
                    />
                </div>
            )}
        </div>
    );
};

export default OkHost;
