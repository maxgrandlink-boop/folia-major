import React, { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LiveMode, PluginInfo, VocalControl } from '../../../../types/live';
import { DEFAULT_LIVE_SETTINGS, PLUGIN_TRACK_VOLUME_DB_MAX, PLUGIN_TRACK_VOLUME_DB_MIN } from '../../../../types/live';
import { useLiveSettingsStore } from '../../../../stores/useLiveSettingsStore';
import { okBridgeReady } from '../../../../services/ok/okAccess';
import {
    openPluginFolder,
    pluginGainPercent,
    pushFollow,
    pushLeaveAiGap,
    pushPluginGains,
    pushSmartReverb,
    readPluginInfo,
    setLiveMode,
} from '../../../../services/live/liveSession';
import { setHarmony, setKaraoke } from '../../../../services/multitrack/workPlayback';
import { Button, Group, Reveal, Row, Segmented, Slider, Toggle, option, type SettingsGroupDef, type SettingsOptionDef } from '../kit';

// src/components/modal/settings/pages/LivePage.tsx
// 直播设置。模式、跟唱、智能混响、四轨音量和离开 AI 的间隔。改动写进 ok_live_settings，桥在时立刻下发。

const MODE: SettingsGroupDef = { id: 'liveMode', titleKey: 'options.liveMode' };
const FOLLOW: SettingsGroupDef = { id: 'liveFollow', titleKey: 'options.liveFollow' };
const REVERB: SettingsGroupDef = { id: 'liveSmartReverb', titleKey: 'options.liveSmartReverb' };
const GAINS: SettingsGroupDef = { id: 'livePluginGains', titleKey: 'options.livePluginGains' };
const GAP: SettingsGroupDef = { id: 'liveLeaveGap', titleKey: 'options.liveLeaveGap' };
const PLUGIN: SettingsGroupDef = { id: 'livePlugin', titleKey: 'options.livePlugin' };

const O = {
    mode: option(MODE, 'liveModeChoice', 'options.liveMode'),
    control: option(FOLLOW, 'liveVocalControl', 'options.liveControl'),
    threshold: option(FOLLOW, 'liveThreshold', 'options.liveThreshold'),
    fadeIn: option(FOLLOW, 'liveFadeIn', 'options.liveFadeIn'),
    fadeOut: option(FOLLOW, 'liveFadeOut', 'options.liveFadeOut'),
    vocalCap: option(FOLLOW, 'liveVocalCap', 'options.liveVocalCap'),
    smart: option(REVERB, 'liveSmartEnabled', 'options.liveSmartReverb'),
    silence: option(REVERB, 'liveSilence', 'options.liveSilence'),
    early: option(REVERB, 'liveEarlyReturn', 'options.liveEarlyReturn'),
    returnMode: option(REVERB, 'liveReturnMode', 'options.liveReturnMode'),
    normal: option(GAINS, 'liveGainNormal', 'options.liveGainNormal'),
    reverb: option(GAINS, 'liveGainReverb', 'options.liveGainReverb'),
    aiVoice: option(GAINS, 'liveGainAiVoice', 'options.liveGainAiVoice'),
    aiAccomp: option(GAINS, 'liveGainAiAccomp', 'options.liveGainAiAccomp'),
    gap: option(GAP, 'liveLeaveGapMs', 'options.liveLeaveGap'),
    folder: option(PLUGIN, 'livePluginFolder', 'options.liveOpenPluginFolder'),
};

export const OPTIONS: SettingsOptionDef[] = Object.values(O);

const MODES: LiveMode[] = ['speech', 'reverb-speech', 'ai-follow', 'ai-sing'];
const db = (value: number) => `${value} dB · ${pluginGainPercent(value)}%`;

const LivePage: React.FC = () => {
    const { t } = useTranslation();
    const settings = useLiveSettingsStore();
    const [plugin, setPlugin] = useState<PluginInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const ready = okBridgeReady();

    useEffect(() => {
        if (!ready) return undefined;
        let alive = true;
        void readPluginInfo().then(info => { if (alive) setPlugin(info); });
        return () => { alive = false; };
    }, [ready]);

    const note = (code: string | null) => setError(code);
    const modes = MODES.map(mode => ({ value: mode, label: t(`ok.live.mode.${mode}`) }));
    const controls: Array<{ value: VocalControl; label: string }> = [
        { value: 'monitor', label: t('options.liveControlMonitor') },
        { value: 'threshold', label: t('options.liveControlThreshold') },
    ];

    const restore = () => {
        settings.reset();
        void setLiveMode(DEFAULT_LIVE_SETTINGS.mode, 'ui');
        void pushFollow(DEFAULT_LIVE_SETTINGS.follow).then(note);
        void pushSmartReverb(DEFAULT_LIVE_SETTINGS.smartReverb).then(note);
        void pushPluginGains(DEFAULT_LIVE_SETTINGS.gains).then(note);
        void pushLeaveAiGap(DEFAULT_LIVE_SETTINGS.leaveAiGapMs).then(note);
        void setKaraoke(false);
        void setHarmony(false);
    };

    return (
        <>
            {!ready && <p className="mb-3 text-xs opacity-70">{t('options.liveNoBridge')}</p>}
            {error && <p className="mb-3 text-xs text-red-500" role="alert">{t(`ok.errors.${error}`, error)}</p>}
            <Group def={MODE} foot={t('options.liveHotkeys')}>
                <Row option={O.mode}>
                    <Segmented value={settings.mode} options={modes} onChange={mode => { void setLiveMode(mode, 'ui'); }} />
                </Row>
            </Group>
            <Group def={FOLLOW}>
                <Row option={O.control}>
                    <Segmented
                        value={settings.follow.control}
                        options={controls}
                        onChange={control => { void pushFollow({ ...settings.follow, control }).then(note); }}
                    />
                </Row>
                <Reveal when={settings.follow.control === 'threshold'}>
                    <Row option={O.threshold}>
                        <Slider min={-80} max={0} step={1} value={settings.follow.thresholdDb} format={value => `${value} dB`} onChange={thresholdDb => { void pushFollow({ ...settings.follow, thresholdDb }).then(note); }} />
                    </Row>
                </Reveal>
                <Row option={O.fadeIn}>
                    <Slider min={0} max={2} step={0.1} value={settings.follow.fadeInSec} format={value => `${value.toFixed(1)} s`} onChange={fadeInSec => { void pushFollow({ ...settings.follow, fadeInSec }).then(note); }} />
                </Row>
                <Row option={O.fadeOut}>
                    <Slider min={0.1} max={2} step={0.1} value={settings.follow.fadeOutSec} format={value => `${value.toFixed(1)} s`} onChange={fadeOutSec => { void pushFollow({ ...settings.follow, fadeOutSec }).then(note); }} />
                </Row>
                <Row option={O.vocalCap}>
                    <Slider min={0} max={1} step={0.01} value={settings.follow.vocalCap} format={value => `${Math.round(value * 100)}%`} onChange={vocalCap => { void pushFollow({ ...settings.follow, vocalCap }).then(note); }} />
                </Row>
            </Group>
            <Group def={REVERB}>
                <Row option={O.smart} hint={t('options.liveSmartReverbHint')}>
                    <Toggle checked={settings.smartReverb.enabled} onChange={enabled => { void pushSmartReverb({ ...settings.smartReverb, enabled }).then(note); }} />
                </Row>
                <Reveal when={settings.smartReverb.enabled}>
                    <Row option={O.silence}>
                        <Slider min={0.1} max={5} step={0.1} value={settings.smartReverb.silenceSec} format={value => `${value.toFixed(1)} s`} onChange={silenceSec => { void pushSmartReverb({ ...settings.smartReverb, silenceSec }).then(note); }} />
                    </Row>
                    <Row option={O.early}>
                        <Slider min={0.1} max={5} step={0.1} value={settings.smartReverb.earlyReturnSec} format={value => `${value.toFixed(1)} s`} onChange={earlyReturnSec => { void pushSmartReverb({ ...settings.smartReverb, earlyReturnSec }).then(note); }} />
                    </Row>
                    <Row option={O.returnMode}>
                        <Segmented
                            value={settings.smartReverb.returnMode}
                            options={[
                                { value: 'ai-follow', label: t('ok.live.mode.ai-follow') },
                                { value: 'ai-sing', label: t('ok.live.mode.ai-sing') },
                            ]}
                            onChange={returnMode => { void pushSmartReverb({ ...settings.smartReverb, returnMode }).then(note); }}
                        />
                    </Row>
                </Reveal>
            </Group>
            <Group def={GAINS}>
                {([
                    [O.normal, 'normalSpeechDb'],
                    [O.reverb, 'reverbSpeechDb'],
                    [O.aiVoice, 'aiVoiceDb'],
                    [O.aiAccomp, 'aiAccompDb'],
                ] as const).map(([row, key]) => (
                    <Row key={key} option={row}>
                        <Slider
                            min={PLUGIN_TRACK_VOLUME_DB_MIN}
                            max={PLUGIN_TRACK_VOLUME_DB_MAX}
                            step={1}
                            value={settings.gains[key]}
                            format={db}
                            onChange={value => { void pushPluginGains({ ...settings.gains, [key]: value }).then(note); }}
                        />
                    </Row>
                ))}
            </Group>
            <Group def={GAP}>
                <Row option={O.gap} hint={t('options.liveLeaveGapHint')}>
                    <Slider min={0} max={1000} step={10} value={settings.leaveAiGapMs} format={value => `${value} ms`} onChange={ms => { void pushLeaveAiGap(ms).then(note); }} />
                </Row>
            </Group>
            <Group def={PLUGIN}>
                <Row label={t('options.livePluginBundled')}><span className="text-xs tabular-nums">{plugin?.bundledVersion ?? '—'}</span></Row>
                <Row label={t('options.livePluginInstalled')}>
                    <span className="text-xs">{plugin?.installedVersion ?? t('options.livePluginMissing')}</span>
                </Row>
                <Row option={O.folder}>
                    <Button icon={FolderOpen} tip={t('options.liveOpenPluginFolder')} onClick={() => { void openPluginFolder().then(note); }} />
                </Row>
                <Row label={t('options.liveRestore')}>
                    <Button onClick={restore}>{t('options.liveRestore')}</Button>
                </Row>
            </Group>
        </>
    );
};

export default LivePage;
