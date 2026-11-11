import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatClock } from '../../services/multitrack/format';
import { activeLyricIndex, parseWorkLyrics, type LyricLine } from '../../services/multitrack/parseWorkLyrics';
import { readPositionSec, seekWork, type WorkPlaybackSnapshot } from '../../services/multitrack/workPlayback';

// src/components/multitrack/WorkTransport.tsx
// 作品的进度和歌词。播放位置每帧写到 DOM 上，只有换句、换字才进 React state。

interface WorkTransportProps {
    isDaylight: boolean;
    playback: WorkPlaybackSnapshot;
    lyrics: string | null;
    title: string;
    artist: string | null;
    onToggle: () => void;
}

const WorkTransport: React.FC<WorkTransportProps> = ({ isDaylight, playback, lyrics, title, artist, onToggle }) => {
    const { t } = useTranslation();
    const rangeRef = useRef<HTMLInputElement>(null);
    const labelRef = useRef<HTMLSpanElement>(null);
    const dragging = useRef(false);
    const seekTimer = useRef<number | null>(null);
    const [cursor, setCursor] = useState({ line: -1, word: -1 });
    const [lines, setLines] = useState<LyricLine[]>([]);
    const linesRef = useRef<LyricLine[]>([]);
    const content = lyrics ?? '';

    useEffect(() => {
        const parsed = content ? parseWorkLyrics(content) : [];
        linesRef.current = parsed;
        setLines(parsed);
        setCursor({ line: -1, word: -1 });
    }, [content]);

    useEffect(() => {
        let frame = 0;
        const tick = () => {
            const position = readPositionSec();
            if (rangeRef.current && !dragging.current) rangeRef.current.value = String(position);
            if (labelRef.current && !dragging.current) labelRef.current.textContent = formatClock(position);
            const next = activeLyricIndex(linesRef.current, position);
            setCursor(prev => (prev.line === next.line && prev.word === next.word ? prev : next));
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(frame);
            if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
        };
    }, []);

    const queueSeek = (sec: number) => {
        if (labelRef.current) labelRef.current.textContent = formatClock(sec);
        if (seekTimer.current !== null) window.clearTimeout(seekTimer.current);
        seekTimer.current = window.setTimeout(() => {
            seekTimer.current = null;
            void seekWork(sec);
        }, 80);
    };

    const muted = isDaylight ? 'text-neutral-500' : 'text-neutral-400';
    const playing = playback.status === 'playing';
    const duration = playback.durationSec || 0;

    return (
        <div data-testid="ok-transport" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{title}</div>
                    {artist && <div className={`truncate text-xs ${muted}`}>{artist}</div>}
                </div>
                <button
                    type="button"
                    onClick={onToggle}
                    disabled={playback.pending || playback.attempt === 0}
                    className="rounded-full bg-[var(--ok-accent)] px-3 py-1 text-xs text-white disabled:opacity-40"
                >
                    {playback.pending ? t('ok.player.loading') : playing ? t('ok.player.pause') : t('ok.player.play')}
                </button>
            </div>
            <div className="flex items-center gap-2">
                <input
                    ref={rangeRef}
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.01}
                    defaultValue={0}
                    aria-label={t('ok.player.seek')}
                    disabled={duration <= 0}
                    onPointerDown={() => { dragging.current = true; }}
                    onPointerUp={() => { dragging.current = false; }}
                    onChange={event => queueSeek(Number(event.target.value))}
                    className="h-1 min-w-0 flex-1 accent-[var(--ok-accent)] disabled:opacity-40"
                />
                <span ref={labelRef} className="w-10 text-right text-xs tabular-nums">{formatClock(0)}</span>
                <span className={`text-xs tabular-nums ${muted}`}>{formatClock(duration)}</span>
            </div>
            <div className="max-h-40 overflow-y-auto text-sm leading-7" data-testid="ok-lyrics">
                {lines.length === 0 && <p className={muted}>{t('ok.player.noLyrics')}</p>}
                {lines.map((line, index) => {
                    const active = index === cursor.line;
                    return (
                        <button
                            key={`${line.timeSec}-${index}`}
                            type="button"
                            onClick={() => { void seekWork(line.timeSec); }}
                            className={`block w-full rounded px-1 text-left ${active ? 'bg-[var(--ok-accent)]/15' : ''}`}
                        >
                            {line.words.length === 0 ? line.text : line.words.map((word, wordIndex) => (
                                <span key={wordIndex} className={active && wordIndex <= cursor.word ? 'text-[var(--ok-accent)]' : undefined}>
                                    {word.text}
                                </span>
                            ))}
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

export default WorkTransport;
