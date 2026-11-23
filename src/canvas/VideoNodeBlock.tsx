/**
 * @file VideoNodeBlock.tsx
 * @description 画布视频节点组件（纯外链模式，不创建 blob: 对象避免大视频撑爆浏览器内存）：
 * 支持 MP4/WebM/OGG 外链直链（http/https 或同源 /api/）、倍速/循环/静音切换，
 * 并在移出活跃视口（mediaActive=false）时自动暂停省资源。
 */

import { useEffect, useRef, useState } from 'react';
import { Film, RefreshCw, Repeat, Volume2, VolumeX } from 'lucide-react';
import { isSafeVideoUrl } from '../core/mediaHelper';

const PLAYBACK_RATES = [0.5, 1, 1.5, 2] as const;

export interface VideoNodeBlockProps {
  url: string;
  poster?: string;
  loop?: boolean;
  muted?: boolean;
  mediaActive?: boolean;
  onChangeUrl: (nextUrl: string) => void;
  onChangeLoop?: (nextLoop: boolean) => void;
  onChangeMuted?: (nextMuted: boolean) => void;
}

export function VideoNodeBlock({
  url,
  poster,
  loop = false,
  muted = false,
  mediaActive = true,
  onChangeUrl,
  onChangeLoop,
  onChangeMuted,
}: VideoNodeBlockProps) {
  const safeUrl = isSafeVideoUrl(url) ? url.trim() : '';
  const [urlDraft, setUrlDraft] = useState(safeUrl ? '' : url);
  const [errorMsg, setErrorMsg] = useState('');
  const [videoFailed, setVideoFailed] = useState(false);
  const [editingSource, setEditingSource] = useState(!safeUrl);
  const [rateIdx, setRateIdx] = useState(1); // 1x
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    setVideoFailed(false);
    if (safeUrl) {
      setEditingSource(false);
      setErrorMsg('');
    } else {
      setEditingSource(true);
    }
  }, [safeUrl]);

  // 移出 Ring 0 活跃视口时自动暂停，避免后台耗电和离屏发声
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!mediaActive && !el.paused) {
      el.pause();
    }
  }, [mediaActive]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) {
      el.playbackRate = PLAYBACK_RATES[rateIdx];
    }
  }, [rateIdx, safeUrl]);

  const applyUrl = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setErrorMsg('请输入视频外链直链（https://...mp4 / webm）');
      return;
    }
    if (!isSafeVideoUrl(trimmed)) {
      setErrorMsg('仅支持 http/https 视频外链或同源 /api/ 地址（拒绝 blob:/data:）');
      return;
    }
    setErrorMsg('');
    setVideoFailed(false);
    onChangeUrl(trimmed);
    setEditingSource(false);
  };

  const cycleRate = () => {
    setRateIdx((prev) => (prev + 1) % PLAYBACK_RATES.length);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950">
      {editingSource || !safeUrl ? (
        <div
          className="nodrag nopan nowheel flex flex-1 flex-col items-center justify-center gap-2.5 bg-slate-50 p-3"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-50 text-rose-600">
            <Film className="h-5 w-5" />
          </div>
          <div className="text-center text-xs font-medium text-slate-700">加载外链视频到画布</div>
          <div className="flex w-full max-w-[340px] items-center gap-1.5">
            <input
              type="text"
              value={urlDraft}
              placeholder="粘贴 MP4 / WebM 视频外链（https://...）"
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  applyUrl(urlDraft);
                }
              }}
              className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-rose-500"
            />
            <button
              type="button"
              onClick={() => applyUrl(urlDraft)}
              className="shrink-0 rounded bg-rose-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-rose-700"
            >
              加载
            </button>
          </div>
          {safeUrl && (
            <button
              type="button"
              onClick={() => setEditingSource(false)}
              className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-200/70"
            >
              取消
            </button>
          )}
          {errorMsg && <div className="text-center text-[11px] text-rose-600">{errorMsg}</div>}
        </div>
      ) : (
        <div className="group/vid relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-slate-950">
          {videoFailed ? (
            <div className="nodrag nopan flex flex-col items-center gap-2 p-3 text-center">
              <div className="text-xs text-rose-300">视频加载失败（格式不支持、跨域受限或外链失效）</div>
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => {
                  setUrlDraft(safeUrl);
                  setEditingSource(true);
                }}
                className="inline-flex items-center gap-1 rounded bg-white/15 px-2.5 py-1 text-xs text-white hover:bg-white/25"
              >
                <RefreshCw className="h-3 w-3" />
                更换视频外链
              </button>
            </div>
          ) : (
            <video
              ref={videoRef}
              src={safeUrl}
              poster={poster}
              controls
              playsInline
              loop={loop}
              muted={muted}
              preload={mediaActive ? 'metadata' : 'none'}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onError={() => setVideoFailed(true)}
              className="nodrag nopan nowheel h-full w-full object-contain"
            />
          )}

          {/* 右上角快捷控制条 */}
          <div
            className="nodrag nopan absolute right-2 top-2 flex items-center gap-1 rounded-md bg-slate-900/75 p-1 text-white opacity-0 shadow backdrop-blur-sm transition-opacity group-hover/vid:opacity-100"
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              title="切换倍速"
              onClick={cycleRate}
              className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold hover:bg-white/20"
            >
              {PLAYBACK_RATES[rateIdx]}×
            </button>
            <button
              type="button"
              title={loop ? '关闭循环播放' : '开启循环播放'}
              onClick={() => onChangeLoop?.(!loop)}
              className={`rounded p-1 hover:bg-white/20 ${loop ? 'text-emerald-400' : 'text-white/80'}`}
            >
              <Repeat className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title={muted ? '取消静音' : '静音'}
              onClick={() => onChangeMuted?.(!muted)}
              className={`rounded p-1 hover:bg-white/20 ${muted ? 'text-amber-300' : 'text-white/80'}`}
            >
              {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              title="更换视频外链"
              onClick={() => {
                setUrlDraft(safeUrl);
                setEditingSource(true);
              }}
              className="rounded p-1 hover:bg-white/20"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
