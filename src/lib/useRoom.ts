import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMsg, Role, RoomEvent, ServerMsg, Snapshot } from '../../shared/protocol';

export type RoomError = 'not_found' | 'room_taken' | 'room_closed' | null;

export interface RoomConn {
  state: Snapshot | null;
  connected: boolean;
  error: RoomError;
  send: (m: ClientMsg) => void;
  /** Server clock minus local clock, for timers. */
  clockOffset: number;
}

/**
 * WebSocket to the Room DO with reconnects. `onMessage` runs synchronously for every message, so the
 * Stage's PAL director sees each event exactly once and in order (React state would batch them).
 */
export function useRoom(
  code: string | null,
  role: Role,
  hello: ClientMsg | null,
  onMessage?: (state: Snapshot, event?: RoomEvent) => void,
): RoomConn {
  const [state, setState] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<RoomError>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const helloRef = useRef(hello);
  helloRef.current = hello;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    if (!code || !hello) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const open = async () => {
      // A 404 on a WebSocket upgrade is invisible to the browser, so check first.
      const info = await fetch(`/api/rooms/${code}`).catch(() => null);
      if (stopped) return;
      if (info?.status === 404) return setError('not_found');
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/${code}?role=${role}`);
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        if (helloRef.current) ws.send(JSON.stringify(helloRef.current));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMsg;
        if (msg.t === 'error') {
          if (msg.code === 'room_taken' || msg.code === 'room_closed' || msg.code === 'not_found') {
            stopped = true;
            setError(msg.code);
          }
          return;
        }
        setClockOffset(msg.state.serverNow - Date.now());
        setState(msg.state);
        onMessageRef.current?.(msg.state, msg.event);
      };
      ws.onclose = () => {
        setConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        if (!stopped) retry = setTimeout(open, Math.min(500 * 2 ** attempt++, 5000));
      };
    };
    void open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // Reconnect only when the Room or role changes; hello is read from a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, role, Boolean(hello)]);

  const send = useCallback((m: ClientMsg) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  return { state, connected, error, send, clockOffset };
}

/** Re-render every `ms` while `active`, for countdowns. */
export function useTick(active: boolean, ms = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

export function secondsLeft(endsAt: number, now: number, clockOffset: number): number {
  return Math.max(0, Math.ceil((endsAt - (now + clockOffset)) / 1000));
}
