import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveMode } from '../../types/live';
import { setKaraoke } from '../../services/multitrack/workPlayback';
import { okFillClass } from '../ok/okChrome';
import { getLiveSession, setLiveMode, subscribeLiveLevels, subscribeLiveSession } from '../../services/live/liveSession';

// src/components/live/LiveBar.tsx
// 直播条：四个模式、插件连接、输出去向、麦克风和跟唱门。断开插件时显示未连接，去向变本机。

const MODES: readonly LiveMode[] = ['speech', 'reverb-speech', 'ai-follow', 'ai-sing'];

interface LiveBarProps {
    isDaylight: boolean;
    karaoke: boolean;
}

function meterScale(value: number): string {
    const clamped = Math.min(1, Math.max(0, value));
    return `scaleX(${clamped})`;
}

const LiveBar: React.FC<LiveBarProps> = ({ isDaylight, karaoke }) => {
    const { t } = useTranslation();
    const session = useSyncExternalStore(subscribeLiveSession, getLiveSession, getLiveSession);
    const micRef = useRef<HTMLSpanElement>(null);
    const gateRef = useRef<HTMLSpanElement>(null);
    const status = session.status;
    const connected = status?.connection === 'connected';
    const muted = isDaylight ? 'bg-black/10' : 'bg-white/15';

    useEffect(() => subscribeLiveLevels(levels => {
        if (micRef.current) micRef.current.style.transform = meterScale((levels.micDb + 60) / 60);
        if (gateRef.current) gateRef.current.style.transform = meterScale(levels.aiGate);
    }), []);

    const connectionKey = status?.connection ?? 'absent';
    const connectionLabel = t(`ok.live.connection.${connectionKey}`, connectionKey);
    const routeLabel = status?.route === 'live' ? t('ok.live.route.live') : t('ok.live.route.local');

    return (
        <div
            data-testid="ok-live-bar"
            className={`pointer-events-auto flex max-w-[40rem] flex-wrap items-center gap-2 rounded-2xl border px-3 py-2 text-xs shadow-lg ${isDaylight ? 'border-black/10 bg-white/95 text-neutral-900' : 'border-white/15 bg-neutral-950/92 text-neutral-100'}`}
        >
            {MODES.map(mode => {
                const active = status?.userMode === mode;
                const switching = active && status?.switching;
                return (
                    <button
                        key={mode}
                        type="button"
                        aria-pressed={active}
                        onClick={() => { void setLiveMode(mode, 'ui'); }}
                        className={`rounded-full px-2.5 py-1 ${active ? okFillClass(isDaylight) : muted}`}
                    >
                        {t(`ok.live.mode.${mode}`)}{switching ? ` · ${t('ok.live.switching')}` : ''}
                    </button>
                );
            })}
            <span className="tabular-nums">{connectionLabel} · {routeLabel}</span>
            {status?.smartReverbActive && <span>{t('ok.live.smartReverb')}</span>}
            {session.error && <span className="text-red-500">{t(`ok.errors.${session.error}`, session.error)}</span>}
            <span className="flex items-center gap-1" title={t('ok.live.mic')}>
                <span className={isDaylight ? 'text-neutral-500' : 'text-neutral-400'}>{t('ok.live.mic')}</span>
                <span className={`relative h-1.5 w-14 overflow-hidden rounded-full ${muted}`}>
                    <span ref={micRef} data-ok-meter-fill="" className="absolute inset-0 origin-left bg-[var(--ok-accent)]" style={{ transform: 'scaleX(0)' }} />
                </span>
            </span>
            <span className={`flex items-center gap-1 ${connected ? '' : 'opacity-40'}`} title={t('ok.live.gate')}>
                <span className={isDaylight ? 'text-neutral-500' : 'text-neutral-400'}>{t('ok.live.gate')}</span>
                <span className={`relative h-1.5 w-14 overflow-hidden rounded-full ${muted}`}>
                    <span ref={gateRef} data-ok-meter-fill="" className="absolute inset-0 origin-left bg-[var(--ok-accent)]" style={{ transform: 'scaleX(0)' }} />
                </span>
            </span>
            <button
                type="button"
                aria-pressed={karaoke}
                onClick={() => { void setKaraoke(!karaoke); }}
                className={`rounded-full px-2.5 py-1 ${karaoke ? okFillClass(isDaylight) : muted}`}
            >
                {t('ok.stem.karaoke')}
            </button>
        </div>
    );
};

export default LiveBar;
