import React, { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { Work } from '../../types/multitrack';
import { formatClock } from '../../services/multitrack/format';
import { okFillClass } from '../ok/okChrome';
import { addWorksRoot, getWorksLibrary, removeWorksRoot, rescanWorks, subscribeWorksLibrary } from '../../services/multitrack/worksLibrary';
import type { WorkPlaybackError } from '../../services/multitrack/workPlayback';

// src/components/multitrack/WorksLibraryPanel.tsx
// 作品库入口：根目录、作品、跳过原因。点播放交给外面的播放会话。

interface WorksLibraryPanelProps {
    isDaylight: boolean;
    playingId: string | null;
    error: WorkPlaybackError | null;
    onPlay: (work: Work) => void;
}

function trackDuration(work: Work): number {
    const instrumental = work.tracks.find(track => track.role === 'instrumental');
    const original = work.tracks.find(track => track.role === 'original');
    const vocal = work.tracks.find(track => track.role === 'vocal');
    return instrumental?.durationSec ?? original?.durationSec ?? vocal?.durationSec ?? 0;
}

const WorksLibraryPanel: React.FC<WorksLibraryPanelProps> = ({ isDaylight, playingId, error, onPlay }) => {
    const { t } = useTranslation();
    const library = useSyncExternalStore(subscribeWorksLibrary, getWorksLibrary, getWorksLibrary);
    const muted = isDaylight ? 'text-neutral-500' : 'text-neutral-400';
    const row = isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/5';

    return (
        <section data-testid="ok-works" className="flex flex-col gap-3" aria-label={t('ok.works.title')}>
            <div className="flex flex-wrap gap-2">
                <button type="button" className={`rounded-full px-3 py-1 text-xs ${okFillClass(isDaylight)}`} onClick={() => { void addWorksRoot(); }}>
                    {t('ok.works.addRoot')}
                </button>
                <button type="button" className={`rounded-full px-3 py-1 text-xs ${isDaylight ? 'bg-black/5' : 'bg-white/10'}`} onClick={() => { void rescanWorks(); }}>
                    {t('ok.works.rescan')}
                </button>
            </div>
            {library.error && <p className="text-xs text-red-500" role="alert">{t(`ok.errors.${library.error}`, library.error)}</p>}
            {library.roots.map(root => (
                <div key={root.id} className="flex items-start justify-between gap-2 text-[11px]">
                    <span className={`min-w-0 break-all ${root.available ? muted : 'text-red-500'}`}>{root.displayPath}</span>
                    {!root.isCoverOutput && (
                        <button type="button" className="shrink-0 underline" onClick={() => { void removeWorksRoot(root.id); }}>{t('ok.works.removeRoot')}</button>
                    )}
                </div>
            ))}
            <ul className="flex flex-col">
                {library.works.map(work => {
                    const failed = error?.workId === work.id ? error.code : null;
                    return (
                        <li key={work.id}>
                            <button
                                type="button"
                                onClick={() => onPlay(work)}
                                className={`flex w-full items-baseline justify-between gap-2 rounded px-1 py-1.5 text-left text-sm ${row} ${playingId === work.id ? 'text-[var(--ok-accent)]' : ''}`}
                            >
                                <span className="min-w-0 truncate">{work.title}{work.artist ? ` · ${work.artist}` : ''}</span>
                                <span className={`shrink-0 text-xs tabular-nums ${muted}`}>{formatClock(trackDuration(work))}</span>
                            </button>
                            {failed && <p className="px-1 text-xs text-red-500">{t(`ok.errors.${failed}`, failed)}</p>}
                        </li>
                    );
                })}
            </ul>
            {library.works.length === 0 && <p className={`text-xs ${muted}`}>{t('ok.works.empty')}</p>}
            <div>
                <h3 className={`mb-1 text-xs ${muted}`}>{t('ok.works.skipped', { count: library.skipped.length })}</h3>
                <ul className="flex flex-col gap-1">
                    {library.skipped.map(skip => (
                        <li key={`${skip.relPath}:${skip.reason}`} className="flex items-baseline justify-between gap-2 text-xs">
                            <span className="min-w-0 truncate">{skip.relPath}</span>
                            <span className={muted}>{t(`ok.skip.${skip.reason}`)}</span>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    );
};

export default WorksLibraryPanel;
