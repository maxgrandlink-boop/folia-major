import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CoverJobEvent } from '../../types/cover';
import { formatClock } from '../../services/multitrack/format';

// src/components/cover/CoverJobProgress.tsx
// 一条翻唱任务的进度。不定进度时不画百分比，改画动画条和已用时间。F2 可以原样复用。

interface CoverJobProgressProps {
    job: CoverJobEvent;
}

const CoverJobProgress: React.FC<CoverJobProgressProps> = ({ job }) => {
    const { t } = useTranslation();
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        if (!job.indeterminate) {
            setElapsed(0);
            return undefined;
        }
        const started = performance.now();
        const timer = window.setInterval(() => {
            setElapsed(Math.floor((performance.now() - started) / 1000));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [job.indeterminate, job.phase, job.jobId]);

    const width = `${Math.round(Math.min(1, Math.max(0, job.progress)) * 100)}%`;

    return (
        <div data-testid="ok-cover-job" className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
                <span>{job.title} · {t(`ok.cover.phase.${job.phase}`)}</span>
                {!job.indeterminate && <span className="tabular-nums">{width}</span>}
            </div>
            <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={job.indeterminate ? undefined : Math.round(job.progress * 100)}
                aria-label={t(`ok.cover.phase.${job.phase}`)}
                className="relative h-1.5 overflow-hidden rounded-full bg-black/10"
            >
                {job.indeterminate ? (
                    <span className="absolute inset-0 animate-pulse bg-[var(--ok-accent)]" />
                ) : (
                    <span className="absolute inset-y-0 left-0 bg-[var(--ok-accent)]" style={{ width }} />
                )}
            </div>
            {job.indeterminate && (
                <p className="text-[11px] opacity-70">
                    {t('ok.cover.indeterminate')}
                    <span data-ok-elapsed=""> · {formatClock(elapsed)}</span>
                </p>
            )}
            {job.message && <p className="text-[11px] opacity-70">{job.message}</p>}
        </div>
    );
};

export default CoverJobProgress;
