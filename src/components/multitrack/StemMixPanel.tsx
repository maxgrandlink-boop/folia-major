import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MixRole, WorkMix, WorkTrack } from '../../types/multitrack';
import { formatGigabytes } from '../../services/multitrack/format';

// src/components/multitrack/StemMixPanel.tsx
// 一首作品的分轨音量：人声、伴奏、原唱，每条静音。清唱和和声是开关，和声没有自己的滑杆。

const ROLES: readonly MixRole[] = ['vocal', 'instrumental', 'original'];

interface StemMixPanelProps {
    isDaylight: boolean;
    mix: WorkMix;
    tracks: readonly WorkTrack[];
    karaoke: boolean;
    harmony: boolean;
    disabled: boolean;
    onGain: (role: MixRole, gain: number) => void;
    onMuted: (role: MixRole, muted: boolean) => void;
    onKaraoke: (on: boolean) => void;
    onHarmony: (on: boolean) => void;
}

const StemMixPanel: React.FC<StemMixPanelProps> = ({
    isDaylight, mix, tracks, karaoke, harmony, disabled, onGain, onMuted, onKaraoke, onHarmony,
}) => {
    const { t } = useTranslation();
    const mutedText = isDaylight ? 'text-neutral-500' : 'text-neutral-400';
    const trackOf = (role: MixRole) => tracks.find(track => track.role === role);

    return (
        <section data-testid="ok-stems" className="flex flex-col gap-3" aria-label={t('ok.stems')}>
            {ROLES.map(role => {
                const track = trackOf(role);
                const row = mix[role];
                const silenced = role === 'instrumental' && karaoke;
                return (
                    <div key={role} className="flex flex-col gap-1">
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                            <span id={`ok-stem-${role}`}>{t(`ok.stem.${role}`)}</span>
                            <span className={mutedText}>
                                {track ? formatGigabytes(track.sizeBytes) : t('ok.stem.missing')}
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                aria-labelledby={`ok-stem-${role}`}
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={row.gain}
                                disabled={disabled || !track}
                                onChange={event => onGain(role, Number(event.target.value))}
                                className="h-1 min-w-0 flex-1 accent-[var(--ok-accent)] disabled:opacity-40"
                            />
                            <span className="w-8 text-right text-xs tabular-nums">{row.gain}</span>
                            <button
                                type="button"
                                aria-pressed={row.muted}
                                disabled={disabled || !track}
                                onClick={() => onMuted(role, !row.muted)}
                                className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-40 ${row.muted ? 'bg-[var(--ok-accent)] text-white' : isDaylight ? 'bg-black/5' : 'bg-white/10'}`}
                            >
                                {row.muted ? t('ok.stem.unmute') : t('ok.stem.mute')}
                            </button>
                        </div>
                        {silenced && <p className={`text-[11px] ${mutedText}`}>{t('ok.stem.karaokeHint')}</p>}
                    </div>
                );
            })}
            <div className="flex flex-wrap gap-2 pt-1">
                <button
                    type="button"
                    aria-pressed={karaoke}
                    disabled={disabled}
                    onClick={() => onKaraoke(!karaoke)}
                    className={`rounded-full px-3 py-1 text-xs disabled:opacity-40 ${karaoke ? 'bg-[var(--ok-accent)] text-white' : isDaylight ? 'bg-black/5' : 'bg-white/10'}`}
                >
                    {t('ok.stem.karaoke')}
                </button>
                <button
                    type="button"
                    aria-pressed={harmony}
                    disabled={disabled}
                    title={t('ok.stem.harmonyHint')}
                    onClick={() => onHarmony(!harmony)}
                    className={`rounded-full px-3 py-1 text-xs disabled:opacity-40 ${harmony ? 'bg-[var(--ok-accent)] text-white' : isDaylight ? 'bg-black/5' : 'bg-white/10'}`}
                >
                    {t('ok.stem.harmony')}
                </button>
            </div>
        </section>
    );
};

export default StemMixPanel;
