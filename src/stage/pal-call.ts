// The Stage's side of the Tavus call: a Daily call object fed by our own camera/mic tracks.
// The PAL is the one non-local participant. Tavus events arrive as Daily app-messages; interactions go
// back the same way.

import Daily, { type DailyCall, type DailyParticipant, type DailyTrackState } from '@daily-co/daily-js';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface PalCallHandlers {
  /** Raw Tavus event (`event.data` of a Daily app-message). */
  onAppMessage(data: unknown): void;
  /** conversationId: the call this is about (the Room ignores reports about a call swapped out since). */
  onPalJoined(conversationId: string | null): void;
  onPalLeft(conversationId: string | null): void;
  onError(error: string, conversationId: string | null): void;
}

export interface PalCallView {
  video: MediaStreamTrack | null;
  audio: MediaStreamTrack | null;
  /** The PAL participant is in the call. */
  present: boolean;
}

const EMPTY: PalCallView = { video: null, audio: null, present: false };

/**
 * Daily refuses a second call object while another one exists, and StrictMode mounts effects twice.
 * Every teardown (leave + destroy) chains here, and a new call waits for it.
 */
let teardown: Promise<void> = Promise.resolve();

const JOIN_EVENTS = new Set(['system.replica_joined', 'system.pal_joined']);

function playable(t: DailyTrackState | undefined): MediaStreamTrack | null {
  if (!t || t.state !== 'playable') return null;
  return t.persistentTrack ?? t.track ?? null;
}

function findPal(call: DailyCall, excludeSessionId?: string): DailyParticipant | null {
  return Object.values(call.participants()).find((p) => !p.local && p.session_id !== excludeSessionId) ?? null;
}

/**
 * Join `url` while it is set and `ready` (camera settled). Leaves and destroys the call when the URL goes
 * away or on unmount. Our tracks are cloned for Daily so leaving the call can never stop the Self-view.
 */
export function usePalCall(
  url: string | null,
  conversationId: string | null,
  stream: MediaStream | null,
  ready: boolean,
  handlers: PalCallHandlers,
): { view: PalCallView; send: (eventType: string, properties?: Record<string, unknown>) => void } {
  const [view, setView] = useState<PalCallView>(EMPTY);
  const callRef = useRef<DailyCall | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const convRef = useRef(conversationId);
  convRef.current = conversationId;
  const streamRef = useRef(stream);
  streamRef.current = stream;
  const clonesRef = useRef<MediaStreamTrack[]>([]);

  const cloneTracks = useCallback(() => {
    const s = streamRef.current;
    const video = s?.getVideoTracks()[0]?.clone();
    const audio = s?.getAudioTracks()[0]?.clone();
    const clones = [video, audio].filter((t): t is MediaStreamTrack => Boolean(t));
    clonesRef.current.push(...clones);
    return { video, audio };
  }, []);

  useEffect(() => {
    if (!url || !ready) return;
    let cancelled = false;
    let call: DailyCall | null = null;
    let present = false;
    // The conversation this call joins: reports from it stay about it even after the Room has moved on.
    const conv = convRef.current;

    const update = (excludeSessionId?: string) => {
      if (!call || call.isDestroyed()) return;
      const pal = findPal(call, excludeSessionId);
      const next: PalCallView = pal
        ? { video: playable(pal.tracks.video), audio: playable(pal.tracks.audio), present: true }
        : EMPTY;
      setView((v) => (v.video === next.video && v.audio === next.audio && v.present === next.present ? v : next));
      if (pal && !present) markJoined();
      else if (!pal && present) {
        present = false;
        handlersRef.current.onPalLeft(conv);
      }
    };

    const markJoined = () => {
      if (present) return;
      present = true;
      handlersRef.current.onPalJoined(conv);
    };

    void (async () => {
      await teardown;
      if (cancelled) return;
      const { video, audio } = cloneTracks();
      call = Daily.createCallObject({
        videoSource: video ?? false,
        // No camera stream: let Daily open the mic itself so the PAL can still hear the Player.
        audioSource: audio ?? true,
        subscribeToTracksAutomatically: true,
      });
      callRef.current = call;
      call
        .on('participant-joined', () => update())
        .on('participant-updated', () => update())
        .on('participant-left', (ev) => update(ev?.participant.session_id))
        .on('track-started', () => update())
        .on('track-stopped', () => update())
        .on('app-message', (ev) => {
          const data = ev?.data as { event_type?: string } | undefined;
          handlersRef.current.onAppMessage(data);
          if (data?.event_type && JOIN_EVENTS.has(data.event_type)) markJoined();
        })
        .on('left-meeting', () => {
          // Tavus ended the conversation (or ejected us). Our own leave happens after `cancelled`.
          if (cancelled) return;
          setView(EMPTY);
          present = false;
          handlersRef.current.onPalLeft(conv);
        })
        .on('error', (ev) => {
          if (cancelled) return;
          handlersRef.current.onError(ev?.errorMsg ?? 'Daily call error', conv);
        });
      try {
        await call.join({ url });
        update();
      } catch (e) {
        if (!cancelled) handlersRef.current.onError(e instanceof Error ? e.message : String(e), conv);
      }
    })();

    return () => {
      cancelled = true;
      const c = call;
      call = null;
      callRef.current = null;
      setView(EMPTY);
      const clones = clonesRef.current.splice(0);
      if (c) {
        teardown = teardown.then(async () => {
          await c.leave().catch(() => undefined);
          await c.destroy().catch(() => undefined);
          clones.forEach((t) => t.stop());
        });
      }
    };
  }, [url, ready, cloneTracks]);

  // Camera retried after we joined: hand Daily the new tracks.
  useEffect(() => {
    const call = callRef.current;
    if (!call || !stream || call.isDestroyed()) return;
    const old = clonesRef.current.splice(0);
    const { video, audio } = cloneTracks();
    void call
      .setInputDevicesAsync({ videoSource: video ?? false, audioSource: audio ?? false })
      .catch(() => undefined)
      .finally(() => old.forEach((t) => t.stop()));
  }, [stream, cloneTracks]);

  const send = useCallback((eventType: string, properties?: Record<string, unknown>) => {
    const call = callRef.current;
    if (!call || call.isDestroyed() || call.meetingState() !== 'joined-meeting') return;
    call.sendAppMessage(
      { message_type: 'conversation', event_type: eventType, conversation_id: convRef.current, ...(properties ? { properties } : {}) },
      '*',
    );
  }, []);

  return { view, send };
}
