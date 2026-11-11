import React, { useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { formatGigabytes } from '../../services/multitrack/format';
import { okFillClass } from '../ok/okChrome';
import {
    addCoverModel,
    buildCoverRequest,
    cancelCoverInstall,
    cancelCoverJob,
    getCoverSession,
    installCoverComponent,
    submitCoverJob,
    subscribeCoverSession,
} from '../../services/cover/coverSession';
import { playWork, type PlayRequest } from '../../services/multitrack/workPlayback';
import { CustomSelect } from '../shared/CustomSelect';
import CoverJobProgress from './CoverJobProgress';

// src/components/cover/CoverEntry.tsx
// 翻唱入口和任务进度。组件页、音色管理留给 F2、F3：这里的状态卡和进度条是分开的。

interface CoverEntryProps {
    isDaylight: boolean;
    playRequest: PlayRequest;
}

const CoverEntry: React.FC<CoverEntryProps> = ({ isDaylight, playRequest }) => {
    const { t } = useTranslation();
    const session = useSyncExternalStore(subscribeCoverSession, getCoverSession, getCoverSession);
    const [title, setTitle] = useState('翻唱示例');
    const [artist, setArtist] = useState('示例歌手');
    const [modelId, setModelId] = useState('');
    const [keySemitones, setKeySemitones] = useState(0);
    const component = session.component;
    const installed = component?.state === 'installed';
    const installing = component?.state === 'installing' || session.install?.phase === 'downloading' || session.install?.phase === 'verifying' || session.install?.phase === 'extracting';
    const chosenModel = modelId || session.models[0]?.id || '';
    const field = `w-full rounded-md border px-2 py-1 text-sm ${isDaylight ? 'border-black/15 bg-white' : 'border-white/15 bg-white/5'}`;
    const job = session.job;
    const running = job !== null && job.phase !== 'done' && job.phase !== 'failed' && job.phase !== 'cancelled';

    const start = () => {
        if (!chosenModel || title.trim().length === 0) return;
        void submitCoverJob(buildCoverRequest({
            modelId: chosenModel,
            title: title.trim(),
            artist: artist.trim(),
            keySemitones,
        }));
    };

    return (
        <section data-testid="ok-cover" className="flex flex-col gap-3" aria-label={t('ok.cover.title')}>
            <div data-testid="ok-cover-component" className="flex flex-col gap-1 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                    <span>{t('ok.cover.component')}</span>
                    <span>{component ? t(`ok.cover.state.${component.state}`) : '…'}</span>
                </div>
                {component && (
                    <p className="opacity-70">
                        {formatGigabytes(component.state === 'installed' ? component.installedBytes : component.downloadBytes)}
                        {component.gpu.name ? ` · ${component.gpu.name}` : ''}
                    </p>
                )}
                {!installed && !installing && (
                    <button type="button" className={`self-start rounded-full px-3 py-1 ${okFillClass(isDaylight)}`} onClick={() => { void installCoverComponent(); }}>
                        {t('ok.cover.install')}
                    </button>
                )}
                {installing && session.install && session.install.totalBytes > 0 && (
                    <div className="flex flex-col gap-1">
                        <div className="h-1.5 overflow-hidden rounded-full bg-black/10">
                            <span
                                className="block h-full bg-[var(--ok-accent)]"
                                style={{ width: `${Math.round(session.install.receivedBytes / session.install.totalBytes * 100)}%` }}
                            />
                        </div>
                        <div className="flex justify-between">
                            <span>{t(`ok.cover.installPhase.${session.install.phase}`)}</span>
                            <button type="button" className="underline" onClick={() => { void cancelCoverInstall(); }}>{t('ok.cover.cancel')}</button>
                        </div>
                    </div>
                )}
            </div>
            {session.error && <p className="text-xs text-red-500" role="alert">{t(`ok.errors.${session.error}`, session.error)}</p>}
            <label className="flex flex-col gap-1 text-xs">
                {t('ok.cover.model')}
                <CustomSelect
                    isDaylight={isDaylight}
                    size="compact"
                    ariaLabel={t('ok.cover.model')}
                    value={chosenModel}
                    onChange={setModelId}
                    options={session.models.map(model => ({ value: model.id, label: model.name }))}
                />
            </label>
            <button type="button" className="self-start text-xs underline" onClick={() => { void addCoverModel(); }}>{t('ok.cover.addModel')}</button>
            <label className="flex flex-col gap-1 text-xs">
                {t('ok.cover.titleField')}
                <input className={field} value={title} onChange={event => setTitle(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs">
                {t('ok.cover.artist')}
                <input className={field} value={artist} onChange={event => setArtist(event.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-xs">
                {t('ok.cover.key')}
                <input type="range" min={-12} max={12} step={1} value={keySemitones} onChange={event => setKeySemitones(Number(event.target.value))} className="h-1 flex-1 accent-[var(--ok-accent)]" />
                <span className="w-6 text-right tabular-nums">{keySemitones}</span>
            </label>
            <div className="flex gap-2">
                <button type="button" disabled={!installed || running || title.trim().length === 0} className={`rounded-full px-3 py-1 text-xs disabled:opacity-40 ${okFillClass(isDaylight)}`} onClick={start}>
                    {t('ok.cover.start')}
                </button>
                {running && job && (
                    <button type="button" className="text-xs underline" onClick={() => { void cancelCoverJob(job.jobId); }}>{t('ok.cover.cancel')}</button>
                )}
            </div>
            {job && <CoverJobProgress job={job} />}
            {job?.phase === 'done' && job.workId && (
                <button
                    type="button"
                    className={`self-start rounded-full px-3 py-1 text-xs ${okFillClass(isDaylight)}`}
                    onClick={() => { void playWork(job.workId!, playRequest); }}
                >
                    {t('ok.cover.playResult')}
                </button>
            )}
        </section>
    );
};

export default CoverEntry;
