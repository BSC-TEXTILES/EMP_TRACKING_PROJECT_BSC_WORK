import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRealtime } from '../contexts/RealtimeContext';
import { useAuth } from '../contexts/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { Avatar } from './ui';
import { Icon } from './icons';
import { cx } from '../lib/format';
import { showDesktopNotification, PhoneRingtone, closeCallNotification, pushDeviceId } from '../lib/notifications';
import { hasNativeCalls, nativeCalls, type AudioRoute } from '../lib/nativeCalls';

export type CallType = 'audio' | 'video';

export interface CallPeer {
  employeeId: number;
  employeeCode: string;
  name: string;
  photoUrl: string | null;
  department: string | null;
  designation: string | null;
  location?: string | null;
  locationCode?: string | null;
}

interface IncomingCall {
  callId: string;
  peer: CallPeer;
  type: CallType;
}

interface CallSession {
  callId: string;
  peer: CallPeer;
  type: CallType;
  isCaller: boolean;
  phase: 'ringing' | 'active';
  startedAt: number | null;
  /** Caller side: a device of the callee confirmed it is ringing (until then the screen says "Calling…"). */
  delivered: boolean;
  /** WebRTC media path connected (audio flowing). */
  mediaConnected: boolean;
}

/** Shown for a moment after a call ends, so the user sees what happened (never a silent close). */
interface EndedCall {
  peer: CallPeer;
  message: string;
  tone: 'neutral' | 'warning' | 'error';
  duration?: number;
}

type Quality = 'good' | 'fair' | 'poor' | null;

interface IceServerConfig {
  urls: string;
  username?: string;
  credential?: string;
}

interface CallContextValue {
  call: (employeeId: number, type: CallType, peer?: CallPeer) => Promise<void>;
  incoming: IncomingCall | null;
  active: CallSession | null;
  elapsed: number;
  historyVersion: number;
  accept: () => Promise<void>;
  reject: () => Promise<void>;
  hangup: () => Promise<void>;
}

const CallContext = createContext<CallContextValue | null>(null);

const DEFAULT_ICE: IceServerConfig[] = [{ urls: 'stun:stun.l.google.com:19302' }];
/** The server ends unanswered calls (default 30 s); this client timer is only a backstop. */
const DEFAULT_RING_TIMEOUT_SECONDS = 30;
const DEVICE_ID = pushDeviceId();

interface PendingCallResponse {
  call: { callId: string; type: CallType; caller: CallPeer } | null;
  iceServers?: IceServerConfig[];
}

interface StartCallResponse {
  callId: string;
  peer: CallPeer;
  iceServers: IceServerConfig[];
  ringTimeoutSeconds?: number;
  state?: 'calling' | 'ringing' | 'unreachable';
  message?: string;
}

const ENDED_VISIBLE_MS = 2600;

type SocketLike = { connected: boolean; once: (event: string, cb: () => void) => unknown };

/** Waits (bounded) for the realtime socket: a phone that just woke up is often still reconnecting. */
function waitForSocket(get: () => SocketLike | null, timeoutMs: number): Promise<boolean> {
  const socket = get();
  if (!socket) return Promise.resolve(false);
  if (socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(Boolean(get()?.connected)), timeoutMs);
    socket.once('connect', () => {
      window.clearTimeout(timer);
      resolve(true);
    });
  });
}

type WakeLockSentinelLike = { release: () => Promise<void>; released?: boolean };

// Phone ringing and ringback audio synthesized via PhoneRingtone in sound.ts

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function peerSubtitle(peer: CallPeer): string {
  const parts = [peer.employeeCode, peer.designation, peer.department].filter(Boolean);
  return parts.join(' · ');
}

/** "BEL · Belagavi", or whichever of the two is known. */
function peerLocation(peer: CallPeer): string {
  const code = peer.locationCode?.trim();
  const name = peer.location?.trim();
  if (code && name && code.toLowerCase() !== name.toLowerCase()) return `${code} · ${name}`;
  return code || name || '';
}

/** Three signal bars for the live connection quality. */
function QualityBars({ quality }: { quality: Quality }) {
  const level = quality === 'good' ? 3 : quality === 'fair' ? 2 : quality === 'poor' ? 1 : 0;
  const color = quality === 'good' ? 'bg-emerald-400' : quality === 'fair' ? 'bg-amber-400' : 'bg-red-400';
  return (
    <span className="flex items-end gap-0.5" aria-hidden="true">
      {[1, 2, 3].map((bar) => (
        <span key={bar} className={cx('w-1 rounded-sm', bar <= level ? color : 'bg-white/25')} style={{ height: `${bar * 4 + 2}px` }} />
      ))}
    </span>
  );
}

function isVideoSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { socket, connected } = useRealtime();
  const { user } = useAuth();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const socketRef = useRef(socket);
  socketRef.current = socket;

  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [session, setSession] = useState<CallSession | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [iceServers, setIceServers] = useState<IceServerConfig[]>(DEFAULT_ICE);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioInputId, setAudioInputId] = useState('');
  const [videoInputId, setVideoInputId] = useState('');
  const [audioOutputId, setAudioOutputId] = useState('');
  const [showDevices, setShowDevices] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [speakerEnabled, setSpeakerEnabled] = useState(true);
  const [speakerVolume, setSpeakerVolume] = useState(100);
  const [connectionQuality, setConnectionQuality] = useState<'connecting' | 'ringing' | 'connected' | 'reconnecting' | 'failed'>('connecting');
  const [quality, setQuality] = useState<Quality>(null);
  const [ended, setEnded] = useState<EndedCall | null>(null);
  const [audioRoutes, setAudioRoutes] = useState<AudioRoute[]>([]);
  const [audioRoute, setAudioRouteState] = useState<AudioRoute>('earpiece');
  const [turnConfigured, setTurnConfigured] = useState(true);
  const [ringTimeoutSeconds, setRingTimeoutSeconds] = useState(DEFAULT_RING_TIMEOUT_SECONDS);

  const sessionRef = useRef<CallSession | null>(null);
  const incomingRef = useRef<IncomingCall | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const offerSentRef = useRef(false);
  const ringTimeoutRef = useRef<number | null>(null);
  const ringtoneRef = useRef(new PhoneRingtone());
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const restartAttemptedRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const acceptRef = useRef<() => Promise<void>>(async () => undefined);
  const reconnectNoticeRef = useRef(false);
  /** Call currently being answered on this device: a second Answer (native + web) must not post /accept twice. */
  const acceptingRef = useRef<string | null>(null);
  const connectedReportedRef = useRef<string | null>(null);
  const endedTimerRef = useRef<number | null>(null);
  const nativeStartedRef = useRef<string | null>(null);

  const showEnded = useCallback((info: EndedCall) => {
    if (endedTimerRef.current !== null) window.clearTimeout(endedTimerRef.current);
    setEnded(info);
    endedTimerRef.current = window.setTimeout(() => {
      endedTimerRef.current = null;
      setEnded(null);
    }, ENDED_VISIBLE_MS);
  }, []);

  const updateSession = useCallback((next: CallSession | null) => {
    sessionRef.current = next;
    setSession(next);
  }, []);
  const updateIncoming = useCallback((next: IncomingCall | null) => {
    incomingRef.current = next;
    setIncoming(next);
  }, []);

  const clearRingTimeout = useCallback(() => {
    if (ringTimeoutRef.current !== null) {
      window.clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
  }, []);

  const emitSignal = useCallback((signal: unknown) => {
    const current = sessionRef.current;
    if (!current || !socketRef.current) return;
    socketRef.current.emit('call:signal', { callId: current.callId, signal });
  }, []);

  const stopLocalMedia = useCallback(() => {
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    cameraTrackRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    remoteStreamRef.current = null;
    setRemoteStream(null);
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, []);

  const teardown = useCallback((options: { leaveRoom?: boolean; nativeReason?: string } = {}) => {
    const current = sessionRef.current;
    const ringingId = current?.callId ?? incomingRef.current?.callId;
    if (ringingId) void closeCallNotification(ringingId);
    // Native app: stop the lock-screen ring / ongoing-call service and release call audio.
    if (ringingId) {
      if (nativeStartedRef.current === ringingId) void nativeCalls.callEnded(ringingId, options.nativeReason);
      else void nativeCalls.dismissIncoming(ringingId, 'local');
    }
    nativeStartedRef.current = null;
    acceptingRef.current = null;
    connectedReportedRef.current = null;
    setQuality(null);
    if (current && options.leaveRoom !== false) {
      socketRef.current?.emit('call:leave', { callId: current.callId });
    }
    reconnectNoticeRef.current = false;
    void wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    clearRingTimeout();
    ringtoneRef.current.stop();
    pendingIceRef.current = [];
    offerSentRef.current = false;
    restartAttemptedRef.current = false;
    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }
    stopLocalMedia();
    setMuted(false);
    setCameraOff(false);
    setSharingScreen(false);
    setSpeakerEnabled(true);
    setSpeakerVolume(100);
    setConnectionQuality('connecting');
    setElapsed(0);
    setShowDevices(false);
    setMediaError(null);
    updateSession(null);
    updateIncoming(null);
  }, [clearRingTimeout, stopLocalMedia, updateIncoming, updateSession]);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list);
      setAudioInputId((current) => current || list.find((device) => device.kind === 'audioinput')?.deviceId || '');
      setVideoInputId((current) => current || list.find((device) => device.kind === 'videoinput')?.deviceId || '');
      setAudioOutputId((current) => current || list.find((device) => device.kind === 'audiooutput')?.deviceId || '');
    } catch {
      setDevices([]);
    }
  }, []);

  const acquireMedia = useCallback(async (type: CallType): Promise<MediaStream> => {
    if (!isVideoSupported()) {
      throw new Error('Calling is not supported in this browser.');
    }
    setMediaError(null);
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(audioInputId ? { deviceId: { exact: audioInputId } } : {}),
    };
    const videoConstraints: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
      ...(videoInputId ? { deviceId: { exact: videoInputId } } : { facingMode: 'user' }),
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: type === 'video' ? videoConstraints : false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
      void refreshDevices();
      return stream;
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (type === 'video' && (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError')) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
        localStreamRef.current = stream;
        setLocalStream(stream);
        cameraTrackRef.current = null;
        toastRef.current.warning('Camera is unavailable. The call will continue with audio only.');
        void refreshDevices();
        return stream;
      }
      const message = name === 'NotAllowedError'
        ? (hasNativeCalls
          ? 'Microphone permission is off. Allow it in Settings → Apps → BSC Workforce → Permissions, then try again.'
          : 'Microphone or camera permission was denied. Allow access in the browser (lock icon in the address bar) and try again.')
        : name === 'NotFoundError'
          ? 'No microphone was found on this device.'
          : 'Could not start the microphone or camera.';
      setMediaError(message);
      throw new Error(message);
    }
  }, [audioInputId, refreshDevices, videoInputId]);

  const flushCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || !pc.remoteDescription) return;
    const queued = pendingIceRef.current;
    pendingIceRef.current = [];
    for (const candidate of queued) {
      await pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }, []);

  const createPeer = useCallback((servers: IceServerConfig[]): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: servers, iceCandidatePoolSize: 4 });
    pcRef.current = pc;
    const stream = localStreamRef.current;
    stream?.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.onicecandidate = (event) => {
      if (event.candidate) emitSignal({ candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      const next = event.streams[0] ?? new MediaStream([event.track]);
      remoteStreamRef.current = next;
      setRemoteStream(next);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = next;
        remoteVideoRef.current.muted = !speakerEnabled;
        remoteVideoRef.current.volume = speakerVolume / 100;
        void remoteVideoRef.current.play().catch(() => undefined);
      }
    };
    pc.onconnectionstatechange = () => {
      if (!pcRef.current) return;
      if (pc.connectionState === 'connected') {
        setConnectionQuality('connected');
        const wasRestart = restartAttemptedRef.current;
        restartAttemptedRef.current = false;
        const current = sessionRef.current;
        if (current) {
          if (!current.mediaConnected) {
            const next = { ...current, mediaConnected: true };
            sessionRef.current = next;
            setSession(next);
          }
          if (connectedReportedRef.current !== current.callId) {
            connectedReportedRef.current = current.callId;
            void api.post(`/calls/${current.callId}/connected`).catch(() => undefined);
            // Native app: microphone foreground service, Telecom "active", screen over the lock screen.
            if (nativeStartedRef.current !== current.callId) {
              nativeStartedRef.current = current.callId;
              void nativeCalls.callStarted(current.callId, current.peer.name, current.type === 'video');
            }
          } else if (wasRestart) {
            void api.post(`/calls/${current.callId}/events`, { event: 'reconnected' }).catch(() => undefined);
          }
        }
      } else if (pc.connectionState === 'connecting') {
        setConnectionQuality('connecting');
      } else if (pc.connectionState === 'disconnected') {
        setConnectionQuality('reconnecting');
      } else if (pc.connectionState === 'failed') {
        setConnectionQuality('failed');
        const current = sessionRef.current;
        if (!restartAttemptedRef.current) {
          restartAttemptedRef.current = true;
          if (current) void api.post(`/calls/${current.callId}/events`, { event: 'ice_restart' }).catch(() => undefined);
          try {
            pc.restartIce();
          } catch {
            /* no-op */
          }
          // Only the caller offers (avoids glare); the callee answers the ICE-restart offer.
          if (current?.isCaller) void makeOfferRef.current(true);
        } else {
          const neverConnected = current && !current.mediaConnected;
          if (current && neverConnected && !turnConfigured) {
            void api.post(`/calls/${current.callId}/events`, { event: 'turn_unavailable' }).catch(() => undefined);
          }
          void api.post(`/calls/${current?.callId}/end`, { reason: 'failed' }).catch(() => undefined);
          if (current) {
            showEnded({
              peer: current.peer,
              tone: 'error',
              message: neverConnected
                ? 'Could not connect the audio. One of the networks blocks calls; try Wi-Fi or mobile data.'
                : 'The call connection was lost.',
            });
          }
          teardown({ nativeReason: 'failed' });
          setHistoryVersion((value) => value + 1);
        }
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'checking') {
        setConnectionQuality('reconnecting');
      } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setConnectionQuality('connected');
      }
    };
    return pc;
  }, [emitSignal, showEnded, teardown, turnConfigured]);
  const makeOfferRef = useRef<(restart?: boolean) => Promise<void>>(async () => undefined);

  /**
   * The caller creates the offer, but only once the callee is in the call room
   * (call:peer_joined or the join ack). Sending it on call:accepted lost it whenever
   * the callee had not joined the room yet: "connected" UI with no audio.
   * restart=true renegotiates with an ICE restart after either side reconnected.
   */
  const makeOffer = useCallback(async (restart = false) => {
    const pc = pcRef.current;
    const current = sessionRef.current;
    if (!pc || !current || (offerSentRef.current && !restart)) return;
    offerSentRef.current = true;
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: current.type === 'video', iceRestart: restart });
      await pc.setLocalDescription(offer);
      emitSignal({ sdp: pc.localDescription });
    } catch (error) {
      console.error('[call] offer failed', error);
      toastRef.current.error('Could not start the call. Please try again.');
      await api.post(`/calls/${current.callId}/end`).catch(() => undefined);
      teardown();
      setHistoryVersion((value) => value + 1);
    }
  }, [emitSignal, teardown]);
  makeOfferRef.current = makeOffer;

  const joinRoom = useCallback((callId: string, rejoin = false) => {
    const socket = socketRef.current;
    if (!socket) return;
    let acknowledged = false;
    const timer = window.setTimeout(() => {
      if (acknowledged) return;
      acknowledged = true;
      // A rejoin after a network drop retries on the next reconnect; the server ends the call after its grace period.
      if (rejoin) return;
      toastRef.current.error('Call signalling timed out. Please try again.');
      void api.post(`/calls/${callId}/end`).catch(() => undefined);
      teardown();
      setHistoryVersion((value) => value + 1);
    }, 12_000);
    socket.emit('call:join', { callId }, (response: { ok?: boolean; error?: string; participants?: { employeeId: number }[] }) => {
      if (acknowledged) return;
      acknowledged = true;
      window.clearTimeout(timer);
      if (!response?.ok) {
        if (rejoin && response?.error !== 'call ended' && response?.error !== 'not a participant') return;
        toastRef.current.error(response?.error === 'call ended' ? 'The call has already ended.' : 'Could not join the call.');
        void api.post(`/calls/${callId}/end`).catch(() => undefined);
        teardown();
        setHistoryVersion((value) => value + 1);
        return;
      }
      const current = sessionRef.current;
      if (!current || current.callId !== callId) return;
      const peerPresent = (response.participants ?? []).some((p) => p.employeeId === current.peer.employeeId);
      // The caller (re)negotiates as soon as both ends are in the room.
      if (current.isCaller && peerPresent && current.phase === 'active') void makeOffer(rejoin || offerSentRef.current);
    });
  }, [makeOffer, teardown]);

  const startCall = useCallback(async (employeeId: number, type: CallType, peerHint?: CallPeer) => {
    if (!user) return;
    if (sessionRef.current || incomingRef.current) {
      toastRef.current.info('You are already in a call.');
      return;
    }
    const socket = socketRef.current;
    if (!socket?.connected) {
      toastRef.current.error('Calling requires the live connection. Check your network and try again.');
      return;
    }
    try {
      await acquireMedia(type);
    } catch (error) {
      toastRef.current.error(errorMessage(error));
      return;
    }
    try {
      const result = await api.post<StartCallResponse>('/calls/start', {
        targetEmployeeId: employeeId,
        type,
      });
      const peer: CallPeer = result.peer ?? peerHint ?? {
        employeeId, employeeCode: '', name: 'Colleague', photoUrl: null, department: null, designation: null, location: null,
      };
      if (result.state === 'unreachable') {
        // Nothing could ring: no fake "Ringing", the server already recorded it and told the callee.
        stopLocalMedia();
        showEnded({ peer, tone: 'warning', message: result.message ?? 'User is offline or unreachable' });
        setHistoryVersion((value) => value + 1);
        return;
      }
      const servers = result.iceServers?.length ? result.iceServers : iceServers;
      setIceServers(servers);
      const timeoutSeconds = result.ringTimeoutSeconds ?? ringTimeoutSeconds;
      const next: CallSession = {
        callId: result.callId,
        peer: peer ?? {
          employeeId,
          employeeCode: '',
          name: 'Colleague',
          photoUrl: null,
          department: null,
          designation: null,
          location: null,
        },
        type,
        isCaller: true,
        phase: 'ringing',
        startedAt: null,
        delivered: result.state === 'ringing',
        mediaConnected: false,
      };
      updateSession(next);
      offerSentRef.current = false;
      pendingIceRef.current = [];
      createPeer(servers);
      joinRoom(result.callId);
      // Ringback only once a device really rings (call:ringing); "Calling…" is silent, like a phone.
      if (next.delivered) ringtoneRef.current.start('outgoing');
      ringTimeoutRef.current = window.setTimeout(() => {
        void api.post(`/calls/${result.callId}/cancel`).catch(() => undefined);
        showEnded({ peer: next.peer, tone: 'warning', message: 'No answer' });
        teardown();
        setHistoryVersion((value) => value + 1);
      }, (timeoutSeconds + 5) * 1000);
    } catch (error) {
      stopLocalMedia();
      toastRef.current.error(errorMessage(error));
    }
  }, [acquireMedia, createPeer, iceServers, joinRoom, ringTimeoutSeconds, showEnded, stopLocalMedia, teardown, updateSession, user]);

  const accept = useCallback(async () => {
    const current = incomingRef.current;
    if (!current) return;
    // Native Answer + in-app Answer (or a double tap) for the same call: answer once.
    if (acceptingRef.current === current.callId) return;
    acceptingRef.current = current.callId;
    ringtoneRef.current.stop();
    void closeCallNotification(current.callId);
    void nativeCalls.dismissIncoming(current.callId, 'answered');
    const connectedNow = await waitForSocket(() => socketRef.current, 10_000);
    if (!connectedNow) {
      acceptingRef.current = null;
      toastRef.current.error('The live connection is offline. Check your network and ask the caller to try again.');
      return;
    }
    try {
      await acquireMedia(current.type);
    } catch (error) {
      toastRef.current.error(errorMessage(error));
      void api.post(`/calls/${current.callId}/events`, { event: 'mic_denied' }).catch(() => undefined);
      await api.post(`/calls/${current.callId}/reject`).catch(() => undefined);
      teardown();
      setHistoryVersion((value) => value + 1);
      return;
    }
    try {
      await api.post(`/calls/${current.callId}/accept`, { deviceId: DEVICE_ID });
      const next: CallSession = {
        callId: current.callId,
        peer: current.peer,
        type: current.type,
        isCaller: false,
        phase: 'active',
        startedAt: Date.now(),
        delivered: true,
        mediaConnected: false,
      };
      updateSession(next);
      updateIncoming(null);
      pendingIceRef.current = [];
      offerSentRef.current = false;
      createPeer(iceServers);
      joinRoom(current.callId);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'call_ended') {
        showEnded({ peer: current.peer, tone: 'neutral', message: 'This call has already ended' });
      } else {
        toastRef.current.error(errorMessage(error));
      }
      stopLocalMedia();
      teardown();
      setHistoryVersion((value) => value + 1);
    }
  }, [acquireMedia, createPeer, iceServers, joinRoom, showEnded, stopLocalMedia, teardown, updateIncoming, updateSession]);
  acceptRef.current = accept;

  /** Shows a ringing call fetched from the server (push tap, reconnect, app resumed). */
  const presentIncoming = useCallback((call: { callId: string; type: CallType; caller: CallPeer }, servers?: IceServerConfig[]) => {
    if (servers?.length) setIceServers(servers);
    if (incomingRef.current?.callId === call.callId || sessionRef.current?.callId === call.callId) return;
    if (sessionRef.current || incomingRef.current) return;
    updateIncoming({ callId: call.callId, peer: call.caller, type: call.type });
    // Confirms to the caller that this device is really ringing.
    socketRef.current?.emit('call:ring_ack', { callId: call.callId });
    // In the Android app the native layer rings while the app is in the background; in the
    // foreground the in-app screen takes over so the phone does not ring twice.
    if (!hasNativeCalls || document.visibilityState === 'visible') {
      ringtoneRef.current.start('incoming');
      if (hasNativeCalls) void nativeCalls.dismissIncoming(call.callId, 'local');
    }
  }, [updateIncoming]);

  /**
   * Asks the server for a call that is ringing for us right now. A `call:incoming`
   * socket event is lost when it is emitted while the phone's socket is reconnecting
   * (very common after the screen was off); this makes the ring show up anyway.
   */
  const checkPendingCall = useCallback(async (): Promise<void> => {
    if (sessionRef.current) return;
    try {
      const result = await api.get<PendingCallResponse>('/calls/pending');
      if (result.call) {
        presentIncoming(result.call, result.iceServers);
      } else if (incomingRef.current) {
        // Our ring is stale (answered elsewhere / ended while we were offline).
        ringtoneRef.current.stop();
        updateIncoming(null);
      }
    } catch {
      /* offline: the next reconnect checks again */
    }
  }, [presentIncoming, updateIncoming]);

  /** Opens / answers the call the user tapped in a notification. */
  const restoreFromNotification = useCallback(async (callId: string, answer: boolean, isCancelled: () => boolean = () => false) => {
    if (sessionRef.current?.callId === callId) return;
    try {
      const detail = await api.get<{ callId: string; type: CallType; status: string; direction: string; peer: CallPeer; iceServers: IceServerConfig[] }>(`/calls/detail/${callId}`);
      if (isCancelled()) return;
      if (detail.direction === 'incoming' && detail.status === 'ringing') {
        presentIncoming({ callId: detail.callId, type: detail.type, caller: detail.peer }, detail.iceServers);
        if (answer) await acceptRef.current();
      } else if (detail.direction === 'incoming' && detail.status !== 'active') {
        toastRef.current.info(`The call from ${detail.peer.name} has already ended.`);
      }
    } catch {
      /* the Calls page still shows history */
    }
  }, [presentIncoming]);

  const reject = useCallback(async () => {
    const current = incomingRef.current;
    if (!current) return;
    ringtoneRef.current.stop();
    updateIncoming(null);
    void nativeCalls.dismissIncoming(current.callId, 'declined');
    await api.post(`/calls/${current.callId}/reject`).catch(() => undefined);
    teardown({ leaveRoom: false });
    setHistoryVersion((value) => value + 1);
  }, [teardown, updateIncoming]);

  const hangup = useCallback(async () => {
    const currentSession = sessionRef.current;
    const currentIncoming = incomingRef.current;
    if (currentIncoming) {
      await reject();
      return;
    }
    if (!currentSession) return;
    const path = currentSession.phase === 'ringing' && currentSession.isCaller
      ? `/calls/${currentSession.callId}/cancel`
      : `/calls/${currentSession.callId}/end`;
    const duration = currentSession.phase === 'active' && currentSession.startedAt
      ? Math.max(0, Math.floor((Date.now() - currentSession.startedAt) / 1000))
      : 0;
    showEnded({
      peer: currentSession.peer,
      tone: 'neutral',
      message: currentSession.phase === 'active' ? 'Call ended' : 'Call cancelled',
      duration: currentSession.phase === 'active' ? duration : undefined,
    });
    // Tear down first so the server's own call:missed / call:ended echo is ignored (no stray toast).
    teardown();
    await api.post(path).catch(() => undefined);
    setHistoryVersion((value) => value + 1);
  }, [reject, showEnded, teardown]);
  const hangupRef = useRef(hangup);
  hangupRef.current = hangup;

  // Load TURN/STUN configuration and restore an incoming call opened from a
  // push notification link (/calls?incoming=<callId>).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void api.get<{ iceServers: IceServerConfig[]; ringTimeoutSeconds?: number; turnConfigured?: boolean }>('/calls/config')
      .then((result) => {
        if (cancelled) return;
        if (result.iceServers?.length) setIceServers(result.iceServers);
        if (result.ringTimeoutSeconds) setRingTimeoutSeconds(result.ringTimeoutSeconds);
        if (typeof result.turnConfigured === 'boolean') setTurnConfigured(result.turnConfigured);
      })
      .catch(() => undefined);

    // Opened from a call notification (/calls?incoming=<id>[&answer=1]) or a normal start.
    const params = new URLSearchParams(window.location.search);
    const callId = params.get('incoming');
    if (callId) void restoreFromNotification(callId, params.get('answer') === '1', () => cancelled);
    else void checkPendingCall();
    return () => {
      cancelled = true;
    };
  }, [checkPendingCall, restoreFromNotification, user?.id]);

  // Native Android call layer: Answer / Decline / Hang up from the lock screen, the notification,
  // a Bluetooth headset or a car. Also picks up an Answer tapped while the app was closed.
  useEffect(() => {
    if (!hasNativeCalls || !user) return;
    let disposed = false;
    let remove: (() => void) | null = null;
    const handle = (action: { action: string; callId: string } | null) => {
      if (!action?.callId) return;
      if (action.action === 'answer') void restoreFromNotification(action.callId, true);
      else if (action.action === 'hangup') {
        if (sessionRef.current?.callId === action.callId) void hangupRef.current();
      } else if (action.action === 'declined') {
        if (incomingRef.current?.callId === action.callId) {
          ringtoneRef.current.stop();
          teardown({ leaveRoom: false });
          setHistoryVersion((value) => value + 1);
        }
      } else if (action.action === 'missed') {
        window.dispatchEvent(new CustomEvent('sw:navigate', { detail: '/calls' }));
      }
    };
    void nativeCalls.onAction(handle).then((off) => {
      if (disposed) off();
      else remove = off;
    });
    void nativeCalls.launchAction().then(handle);
    return () => {
      disposed = true;
      remove?.();
    };
  }, [restoreFromNotification, teardown, user?.id]);

  // Internet came back during a call: the caller renegotiates with an ICE restart right away
  // instead of waiting for the browser to notice the old path is dead.
  useEffect(() => {
    const onOnline = () => {
      const current = sessionRef.current;
      if (!current || current.phase !== 'active') return;
      if (current.isCaller) void makeOfferRef.current(true);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // Live connection quality from WebRTC statistics (round-trip time, packet loss, jitter).
  useEffect(() => {
    if (!session || session.phase !== 'active' || !session.mediaConnected) return;
    let lastLost = 0;
    let lastReceived = 0;
    const timer = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let rtt: number | null = null;
        let lost = 0;
        let received = 0;
        let jitter = 0;
        stats.forEach((report) => {
          const r = report as Record<string, unknown>;
          if (r.type === 'candidate-pair' && r.nominated && typeof r.currentRoundTripTime === 'number') rtt = r.currentRoundTripTime as number;
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            lost = Number(r.packetsLost ?? 0);
            received = Number(r.packetsReceived ?? 0);
            jitter = Number(r.jitter ?? 0);
          }
        });
        const dLost = Math.max(0, lost - lastLost);
        const dReceived = Math.max(0, received - lastReceived);
        lastLost = lost;
        lastReceived = received;
        const lossRate = dLost + dReceived > 0 ? dLost / (dLost + dReceived) : 0;
        const rttMs = rtt === null ? 0 : (rtt as number) * 1000;
        setQuality(lossRate > 0.08 || rttMs > 600 || jitter > 0.1 ? 'poor' : lossRate > 0.02 || rttMs > 300 || jitter > 0.04 ? 'fair' : 'good');
      } catch {
        /* stats unavailable */
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [session?.callId, session?.phase, session?.mediaConnected, session]);

  // Native app: available audio outputs (earpiece / speaker / Bluetooth headset / wired).
  useEffect(() => {
    if (!hasNativeCalls || !session || session.phase !== 'active') return;
    const refresh = () => void nativeCalls.audioRoutes().then((r) => {
      if (!r) return;
      setAudioRoutes(r.routes);
      setAudioRouteState(r.current);
    });
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [session?.callId, session?.phase, session]);

  // Notification tapped / "Answer" while the app is already running (no reload).
  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; callId?: string }>).detail;
      if (detail?.callId) void restoreFromNotification(detail.callId, detail.action === 'answer');
    };
    const onRing = () => void checkPendingCall();
    window.addEventListener('sw:call-action', onAction);
    window.addEventListener('sw:call-ring', onRing);
    return () => {
      window.removeEventListener('sw:call-action', onAction);
      window.removeEventListener('sw:call-ring', onRing);
    };
  }, [checkPendingCall, restoreFromNotification]);

  // Reconnect handling: rejoin an ongoing call (the caller renegotiates), and look for
  // a call that started ringing while we were offline or in the background.
  useEffect(() => {
    if (!socket) return;
    const onConnect = () => {
      const current = sessionRef.current;
      if (current) joinRoom(current.callId, true);
      else void checkPendingCall();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !sessionRef.current) void checkPendingCall();
    };
    socket.on('connect', onConnect);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      socket.off('connect', onConnect);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [checkPendingCall, joinRoom, socket]);

  // Keep the screen on while ringing or in a call (Screen Wake Lock API: Android Chrome, iOS 16.4+).
  useEffect(() => {
    const wanted = Boolean(session || incoming);
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> } };
    if (!wanted || !nav.wakeLock) return;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || (wakeLockRef.current && !wakeLockRef.current.released)) return;
      try {
        wakeLockRef.current = await nav.wakeLock!.request('screen');
      } catch {
        /* battery saver or unsupported */
      }
    };
    void acquire();
    // The browser drops the lock when the page is hidden; take it again on return.
    document.addEventListener('visibilitychange', acquire);
    return () => document.removeEventListener('visibilitychange', acquire);
  }, [incoming, session]);

  // Signalling and call lifecycle events.
  useEffect(() => {
    if (!socket) return;

    const matches = (payload: { callId?: string }) =>
      Boolean(payload?.callId && (sessionRef.current?.callId === payload.callId || incomingRef.current?.callId === payload.callId));

    const onIncoming = (payload: { callId: string; caller: CallPeer; type: CallType }) => {
      if (!payload?.callId || !payload.caller) return;
      if (incomingRef.current?.callId === payload.callId || sessionRef.current?.callId === payload.callId) return;
      if (sessionRef.current || incomingRef.current) {
        // Busy: reject the second call immediately so the caller is not left ringing.
        void api.post(`/calls/${payload.callId}/reject`).catch(() => undefined);
        toastRef.current.info(`${payload.caller.name} called while you were on another call.`);
        return;
      }
      updateIncoming({ callId: payload.callId, peer: payload.caller, type: payload.type });
      // Confirms to the caller that this device is really ringing (switches them from "Calling…" to "Ringing…").
      socket.emit('call:ring_ack', { callId: payload.callId });
      if (!hasNativeCalls || document.visibilityState === 'visible') {
        ringtoneRef.current.start('incoming');
        if (hasNativeCalls) void nativeCalls.dismissIncoming(payload.callId, 'local');
      }
      if (hasNativeCalls) return; // the native layer shows the lock-screen ring while in the background
      // Background tab without a push subscription: socket fallback, same tag as the push so they merge.
      if (document.visibilityState !== 'visible') {
        void showDesktopNotification(payload.caller.name, {
          body: `Incoming ${payload.type === 'video' ? 'video' : 'voice'} call`,
          icon: payload.caller.photoUrl || '/icons/icon-192.png',
          tag: `call-${payload.callId}`,
          link: `/calls?incoming=${payload.callId}`,
          urgent: true,
        });
      }
    };

    const onPeerJoined = (payload: { callId: string; employeeId: number }) => {
      const current = sessionRef.current;
      if (!current || current.callId !== payload.callId) return;
      if (payload.employeeId === user?.id) return; // our own second tab
      if (current.phase === 'ringing') {
        clearRingTimeout();
        ringtoneRef.current.stop();
        const next: CallSession = { ...current, phase: 'active', startedAt: Date.now(), delivered: true };
        updateSession(next);
      }
      reconnectNoticeRef.current = false;
      // First join: initial offer. Re-join after a network drop: renegotiate with an ICE restart.
      if (current.isCaller) void makeOffer(offerSentRef.current);
    };

    const onAccepted = (payload: { callId: string }) => {
      const current = sessionRef.current;
      if (!current || current.callId !== payload.callId) return;
      clearRingTimeout();
      ringtoneRef.current.stop();
      if (current.phase !== 'active') {
        const next: CallSession = { ...current, phase: 'active', startedAt: Date.now(), delivered: true };
        updateSession(next);
      }
      // No offer here: the callee may not be in the call room yet. call:peer_joined triggers it.
    };

    const onSignal = async (payload: { callId: string; signal: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
      const current = sessionRef.current;
      if (!current || current.callId !== payload.callId || !payload.signal) return;
      const pc = pcRef.current;
      if (!pc) return;
      try {
        if (payload.signal.sdp) {
          await pc.setRemoteDescription(payload.signal.sdp);
          await flushCandidates();
          if (payload.signal.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            emitSignal({ sdp: pc.localDescription });
          }
        } else if (payload.signal.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(payload.signal.candidate);
          else pendingIceRef.current.push(payload.signal.candidate);
        }
      } catch (error) {
        console.error('[call] signalling failed', error);
      }
    };

    const onRinging = (payload: { callId: string }) => {
      const current = sessionRef.current;
      if (!current || current.callId !== payload.callId || !current.isCaller || current.phase !== 'ringing') return;
      if (!current.delivered) {
        updateSession({ ...current, delivered: true });
        ringtoneRef.current.start('outgoing');
      }
    };

    const onUnreachable = (payload: { callId: string; message?: string }) => {
      const current = sessionRef.current;
      if (!current || current.callId !== payload.callId) return;
      showEnded({ peer: current.peer, tone: 'warning', message: payload.message ?? 'User is offline or unreachable' });
      teardown();
      setHistoryVersion((value) => value + 1);
    };

    const onAnsweredElsewhere = (payload: { callId: string; deviceId?: string | null }) => {
      if (payload.deviceId && payload.deviceId === DEVICE_ID) return;
      if (incomingRef.current?.callId !== payload.callId || acceptingRef.current === payload.callId) return;
      ringtoneRef.current.stop();
      toastRef.current.info('Answered on another device.');
      teardown({ leaveRoom: false });
    };

    const onMissedSummary = (payload: { calls?: { callId: string; caller: { name: string }; startedAt: string }[] }) => {
      const calls = payload?.calls ?? [];
      if (calls.length === 0) return;
      const names = [...new Set(calls.map((c) => c.caller.name))];
      toastRef.current.warning(
        calls.length === 1
          ? `You missed a call from ${names[0]} while you were offline.`
          : `You missed ${calls.length} calls while you were offline (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}).`,
      );
      setHistoryVersion((value) => value + 1);
    };

    const onRejected = (payload: { callId: string }) => {
      if (!matches(payload)) return;
      const current = sessionRef.current;
      if (current) showEnded({ peer: current.peer, tone: 'warning', message: 'Call declined' });
      teardown();
      setHistoryVersion((value) => value + 1);
    };

    const onMissed = (payload: { callId: string }) => {
      if (!matches(payload)) return;
      const current = sessionRef.current;
      if (current?.isCaller) showEnded({ peer: current.peer, tone: 'warning', message: 'No answer' });
      else {
        const peer = incomingRef.current?.peer;
        if (peer) showEnded({ peer, tone: 'warning', message: 'Missed call' });
      }
      teardown();
      setHistoryVersion((value) => value + 1);
    };

    const onEnded = (payload: { callId: string; reason?: string; duration?: number }) => {
      if (!matches(payload)) return;
      const reason = payload.reason;
      const message = reason === 'no_answer'
        ? (sessionRef.current?.isCaller ? 'No answer' : 'Missed call')
        : reason === 'rejected'
          ? 'Call declined'
          : reason === 'unreachable'
            ? 'User is offline or unreachable'
            : reason === 'disconnected'
              ? 'The other participant lost their connection'
              : reason === 'failed'
                ? 'The call connection failed'
                : 'Call ended';
      const peer = sessionRef.current?.peer ?? incomingRef.current?.peer;
      // The callee declined it themselves (e.g. on another device): no "Call declined" screen for their own action.
      const ownDecline = reason === 'rejected' && !sessionRef.current && Boolean(incomingRef.current);
      if (peer && !ownDecline) {
        showEnded({
          peer,
          tone: reason === 'failed' || reason === 'disconnected' ? 'error' : reason === 'ended' ? 'neutral' : 'warning',
          message,
          duration: sessionRef.current?.phase === 'active' ? payload.duration : undefined,
        });
      }
      teardown({ nativeReason: reason === 'disconnected' ? 'remote' : reason });
      setHistoryVersion((value) => value + 1);
    };

    const onPeerLeft = (payload: { callId: string; employeeId: number; reason?: string }) => {
      if (!matches(payload)) return;
      if (payload.employeeId === user?.id) return;
      if (payload.reason === 'reconnecting') {
        // Peer's network dropped; the server ends the call if they do not return in ~20 s.
        setConnectionQuality('reconnecting');
        if (!reconnectNoticeRef.current) {
          reconnectNoticeRef.current = true;
          toastRef.current.info(`${sessionRef.current?.peer.name ?? 'The other participant'} is reconnecting…`);
        }
        return;
      }
      if (sessionRef.current) {
        toastRef.current.info('The other participant left the call.');
        teardown();
        setHistoryVersion((value) => value + 1);
      }
    };

    socket.on('call:incoming', onIncoming);
    socket.on('call:peer_joined', onPeerJoined);
    socket.on('call:accepted', onAccepted);
    socket.on('call:signal', onSignal);
    socket.on('call:rejected', onRejected);
    socket.on('call:missed', onMissed);
    socket.on('call:ended', onEnded);
    socket.on('call:peer_left', onPeerLeft);
    socket.on('call:ringing', onRinging);
    socket.on('call:unreachable', onUnreachable);
    socket.on('call:answered_elsewhere', onAnsweredElsewhere);
    socket.on('call:missed_summary', onMissedSummary);

    return () => {
      socket.off('call:ringing', onRinging);
      socket.off('call:unreachable', onUnreachable);
      socket.off('call:answered_elsewhere', onAnsweredElsewhere);
      socket.off('call:missed_summary', onMissedSummary);
      socket.off('call:incoming', onIncoming);
      socket.off('call:peer_joined', onPeerJoined);
      socket.off('call:accepted', onAccepted);
      socket.off('call:signal', onSignal);
      socket.off('call:rejected', onRejected);
      socket.off('call:missed', onMissed);
      socket.off('call:ended', onEnded);
      socket.off('call:peer_left', onPeerLeft);
    };
  }, [clearRingTimeout, emitSignal, flushCandidates, makeOffer, showEnded, socket, teardown, updateIncoming, updateSession, user?.id]);

  // Duration ticker.
  useEffect(() => {
    if (!session || session.phase !== 'active' || !session.startedAt) {
      setElapsed(0);
      return;
    }
    const started = session.startedAt;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [session?.phase, session?.startedAt, session]);

  // Attach media streams to the video elements.
  useEffect(() => {
    const element = remoteVideoRef.current;
    if (!element) return;
    element.srcObject = remoteStream;
    if (remoteStream) void element.play().catch(() => undefined);
  }, [remoteStream, session?.callId]);

  useEffect(() => {
    const element = localVideoRef.current;
    if (!element) return;
    element.srcObject = localStream;
    if (localStream) void element.play().catch(() => undefined);
  }, [localStream, session?.callId]);

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    const onChange = () => void refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  // Tear down everything when the provider unmounts (logout / navigation away).
  useEffect(() => () => {
    ringtoneRef.current.stop();
    clearRingTimeout();
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, [clearRingTimeout]);

  // Close an active call if the realtime connection is permanently lost.
  useEffect(() => {
    if (!sessionRef.current) return;
    if (connected) return;
    if (!socket) {
      teardown();
    }
  }, [connected, socket, teardown]);

  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    if (tracks.length === 0) return;
    const next = tracks.some((track) => track.enabled);
    tracks.forEach((track) => { track.enabled = !next; });
    setMuted(next);
  }, []);

  const chooseAudioRoute = useCallback(async (route: AudioRoute) => {
    try {
      await nativeCalls.setAudioRoute(route);
      setAudioRouteState(route);
      const current = sessionRef.current;
      if (current) void api.post(`/calls/${current.callId}/events`, { event: 'audio_route', detail: { route } }).catch(() => undefined);
    } catch (error) {
      toastRef.current.info(errorMessage(error));
    }
  }, []);

  const toggleSpeaker = useCallback(() => {
    if (hasNativeCalls) {
      // On the phone the button switches between earpiece and loudspeaker, like a phone call.
      void chooseAudioRoute(audioRoute === 'speaker' ? (audioRoutes.includes('bluetooth') ? 'bluetooth' : audioRoutes.includes('wired') ? 'wired' : 'earpiece') : 'speaker');
      return;
    }
    setSpeakerEnabled((prev) => {
      const next = !prev;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.muted = !next;
        remoteVideoRef.current.volume = next ? speakerVolume / 100 : 0;
      }
      return next;
    });
  }, [audioRoute, audioRoutes, chooseAudioRoute, speakerVolume]);

  const changeSpeakerVolume = useCallback((val: number) => {
    const clamped = Math.max(0, Math.min(100, val));
    setSpeakerVolume(clamped);
    if (remoteVideoRef.current) {
      remoteVideoRef.current.volume = clamped / 100;
      if (clamped > 0 && !speakerEnabled) {
        setSpeakerEnabled(true);
        remoteVideoRef.current.muted = false;
      }
    }
  }, [speakerEnabled]);

  const toggleCamera = useCallback(async () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) {
      toastRef.current.info('No camera track is available in this call.');
      return;
    }
    if (sharingScreen) {
      toastRef.current.info('Stop screen sharing before changing the camera.');
      return;
    }
    track.enabled = !track.enabled;
    setCameraOff(!track.enabled);
  }, [sharingScreen]);

  const toggleScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || sessionRef.current?.type !== 'video') return;
    if (sharingScreen) {
      const camera = cameraTrackRef.current;
      const sender = pc.getSenders().find((item) => item.track?.kind === 'video');
      if (camera && sender) await sender.replaceTrack(camera).catch(() => undefined);
      screenTrackRef.current?.stop();
      screenTrackRef.current = null;
      setSharingScreen(false);
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      if (!track) return;
      screenTrackRef.current = track;
      const sender = pc.getSenders().find((item) => item.track?.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      track.onended = () => {
        const camera = cameraTrackRef.current;
        const videoSender = pcRef.current?.getSenders().find((item) => item.track?.kind === 'video');
        if (camera && videoSender) void videoSender.replaceTrack(camera).catch(() => undefined);
        screenTrackRef.current = null;
        setSharingScreen(false);
      };
      setSharingScreen(true);
    } catch {
      toastRef.current.info('Screen sharing was cancelled.');
    }
  }, [sharingScreen]);

  const selectDevice = useCallback(async (kind: MediaDeviceKind, deviceId: string) => {
    if (kind === 'audiooutput') {
      setAudioOutputId(deviceId);
      const element = remoteVideoRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
      if (element?.setSinkId) {
        await element.setSinkId(deviceId).catch(() => toastRef.current.info('This browser does not allow speaker selection.'));
      } else {
        toastRef.current.info('This browser does not allow speaker selection.');
      }
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === 'audioinput'
          ? { audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } }
          : { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } },
      );
      const track = kind === 'audioinput' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      if (!track) return;
      const senders = pcRef.current?.getSenders() ?? [];
      const sender = senders.find((item) => item.track?.kind === track.kind);
      if (sender) await sender.replaceTrack(track);
      const current = localStreamRef.current;
      current?.getTracks().filter((item) => item.kind === track.kind).forEach((item) => item.stop());
      const next = new MediaStream([...(current?.getTracks().filter((item) => item.kind !== track.kind) ?? []), track]);
      localStreamRef.current = next;
      setLocalStream(next);
      if (track.kind === 'audio') setAudioInputId(deviceId);
      else {
        setVideoInputId(deviceId);
        cameraTrackRef.current = track;
        setCameraOff(!track.enabled);
      }
    } catch (error) {
      toastRef.current.error(errorMessage(error));
    }
  }, []);

  const value = useMemo<CallContextValue>(() => ({
    call: startCall,
    incoming,
    active: session,
    elapsed,
    historyVersion,
    accept,
    reject,
    hangup,
  }), [accept, elapsed, hangup, historyVersion, incoming, reject, session, startCall]);

  const microphoneDevices = devices.filter((device) => device.kind === 'audioinput');
  const cameraDevices = devices.filter((device) => device.kind === 'videoinput');
  const speakerDevices = devices.filter((device) => device.kind === 'audiooutput');
  const canSelectSpeaker = typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function';
  const hasLocalVideo = Boolean(localStream?.getVideoTracks().length);
  // Honest call status: "Calling…" until a device confirms, "Ringing…" after, then the timer.
  const phaseLabel = !session
    ? ''
    : session.phase === 'ringing'
      ? (session.isCaller ? (session.delivered ? 'Ringing…' : 'Calling…') : 'Connecting…')
      : connectionQuality === 'reconnecting'
        ? 'Reconnecting…'
        : session.mediaConnected
          ? formatDuration(elapsed)
          : 'Connecting…';
  const qualityLabel = quality === 'good' ? 'Good connection' : quality === 'fair' ? 'Fair connection' : quality === 'poor' ? 'Poor connection' : '';

  return (
    <CallContext.Provider value={value}>
      {children}

      {incoming && !session && (
        <div className="fixed inset-0 z-[120] flex items-stretch justify-center bg-slate-950/85 backdrop-blur-sm sm:items-center sm:p-4" role="alertdialog" aria-label={`Incoming call from ${incoming.peer.name}`}>
          <div className="relative flex h-full w-full flex-col overflow-hidden bg-gradient-to-b from-brand-600 via-brand-800 to-slate-950 text-white shadow-2xl sm:h-auto sm:min-h-[560px] sm:max-w-sm sm:rounded-3xl">
            <div className="flex flex-1 flex-col items-center px-6 pt-12 text-center" style={{ paddingTop: 'max(3rem, env(safe-area-inset-top))' }}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/60">BSC Workforce</p>
              <p className="mt-1.5 flex items-center gap-2 text-sm font-medium text-white/85">
                <Icon name={incoming.type === 'video' ? 'video' : 'phone'} size={15} />
                Incoming {incoming.type === 'video' ? 'video' : 'voice'} call
              </p>
              <div className="relative mx-auto mb-6 mt-10 flex h-44 w-44 items-center justify-center">
                <span className="absolute inset-4 animate-ping rounded-full bg-white/15 [animation-duration:1.6s]" />
                <span className="absolute inset-0 animate-pulse rounded-full bg-white/10" />
                <Avatar name={incoming.peer.name} src={incoming.peer.photoUrl} size={128} className="relative ring-4 ring-white/30" />
              </div>
              <h2 className="max-w-full truncate text-3xl font-semibold">{incoming.peer.name}</h2>
              {peerSubtitle(incoming.peer) && <p className="mt-1.5 max-w-full truncate text-sm text-white/80">{peerSubtitle(incoming.peer)}</p>}
              {peerLocation(incoming.peer) && (
                <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold tracking-wide">
                  <Icon name="mapPin" size={12} /> {peerLocation(incoming.peer)}
                </span>
              )}
              <p className="mt-6 animate-pulse text-sm text-white/70">{acceptingRef.current === incoming.callId ? 'Connecting…' : 'Ringing…'}</p>
            </div>
            <div className="grid grid-cols-2 gap-6 px-10 pb-10 pt-6" style={{ paddingBottom: 'max(2.5rem, env(safe-area-inset-bottom))' }}>
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => void reject()}
                  className="flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full bg-red-500 text-white shadow-xl shadow-red-950/40 transition hover:bg-red-600 active:scale-95"
                  aria-label="Decline call"
                >
                  <Icon name="phoneOff" size={30} />
                </button>
                <span className="text-sm font-medium text-white/85">Decline</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => void accept()}
                  disabled={acceptingRef.current === incoming.callId}
                  className="flex h-[4.5rem] w-[4.5rem] animate-bounce items-center justify-center rounded-full bg-emerald-500 text-white shadow-xl shadow-emerald-950/40 transition [animation-duration:1.4s] hover:bg-emerald-600 active:scale-95 disabled:animate-none disabled:opacity-70"
                  aria-label="Answer call"
                >
                  <Icon name={incoming.type === 'video' ? 'video' : 'phone'} size={30} />
                </button>
                <span className="text-sm font-medium text-white/85">Answer</span>
              </div>
            </div>
            {mediaError && <p className="px-6 pb-4 text-center text-xs text-red-200">{mediaError}</p>}
          </div>
        </div>
      )}

      {session && (
        <div className="fixed inset-0 z-[110] flex flex-col bg-slate-950 text-white">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{session.peer.name}</p>
              <p className="truncate text-xs text-white/60">{phaseLabel}</p>
            </div>
            <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs" title={qualityLabel || undefined}>
              {session.phase === 'active' && session.mediaConnected && connectionQuality !== 'reconnecting' ? (
                <QualityBars quality={quality} />
              ) : (
                <span
                  className={cx(
                    'h-2 w-2 rounded-full',
                    connectionQuality === 'reconnecting' ? 'animate-ping bg-amber-400' : 'animate-pulse bg-blue-400',
                  )}
                />
              )}
              <span>{qualityLabel && session.mediaConnected && connectionQuality !== 'reconnecting' ? qualityLabel : phaseLabel}</span>
            </div>
          </div>

          <div className="relative flex flex-1 items-center justify-center overflow-hidden">
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={cx('h-full w-full object-contain', session.type === 'video' && remoteStream ? 'block' : 'hidden')}
            />
            {!(session.type === 'video' && remoteStream) && (
              <div className="flex flex-col items-center px-6 text-center">
                <div className="relative mb-5">
                  {session.phase === 'ringing' && <span className="absolute inset-0 animate-ping rounded-full bg-white/10" />}
                  <Avatar name={session.peer.name} src={session.peer.photoUrl} size={120} className="relative ring-4 ring-white/10" />
                </div>
                <h2 className="text-2xl font-semibold">{session.peer.name}</h2>
                <p className="mt-1 text-sm text-white/60">{peerSubtitle(session.peer) || 'Employee'}</p>
                {peerLocation(session.peer) && (
                  <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold text-white/80">
                    <Icon name="mapPin" size={11} /> {peerLocation(session.peer)}
                  </span>
                )}
                <p className={cx('mt-5 text-base font-medium', session.mediaConnected ? 'font-mono text-white/90' : 'animate-pulse text-white/70')}>
                  {phaseLabel}
                </p>
                {connectionQuality === 'reconnecting' && session.phase === 'active' && (
                  <p className="mt-1 text-xs text-amber-200">Connection interrupted. Trying to restore the audio…</p>
                )}
              </div>
            )}

            {session.type === 'video' && hasLocalVideo && (
              <div className="absolute bottom-4 right-4 w-32 overflow-hidden rounded-xl border border-white/20 bg-black shadow-xl sm:w-44">
                <video ref={localVideoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
                  You{muted ? ' · muted' : ''}{sharingScreen ? ' · sharing' : ''}
                </span>
              </div>
            )}
            {session.type === 'video' && !hasLocalVideo && (
              <p className="absolute bottom-4 left-4 rounded-full bg-amber-500/20 px-3 py-1 text-[11px] text-amber-200">
                Camera unavailable — audio only
              </p>
            )}
          </div>

          {showDevices && (
            <div className="mx-auto mb-3 w-full max-w-md space-y-3 rounded-xl bg-white/10 p-3 text-xs">
              {hasNativeCalls && audioRoutes.length > 0 && (
                <div>
                  <span className="mb-1 block text-white/60">Audio output</span>
                  <div className="flex flex-wrap gap-2">
                    {audioRoutes.map((route) => (
                      <button
                        key={route}
                        type="button"
                        onClick={() => void chooseAudioRoute(route)}
                        className={cx('rounded-full px-3 py-1.5 font-medium capitalize', audioRoute === route ? 'bg-white text-slate-900' : 'bg-white/15 text-white hover:bg-white/25')}
                      >
                        {route === 'earpiece' ? 'Phone' : route === 'wired' ? 'Headphones' : route}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <label className="block">
                <span className="mb-1 block text-white/60">Microphone</span>
                <select
                  className="w-full rounded-lg bg-slate-900 px-2 py-1.5 text-white"
                  value={audioInputId}
                  onChange={(event) => void selectDevice('audioinput', event.target.value)}
                >
                  {microphoneDevices.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>
                  ))}
                </select>
              </label>
              {session.type === 'video' && (
                <label className="block">
                  <span className="mb-1 block text-white/60">Camera</span>
                  <select
                    className="w-full rounded-lg bg-slate-900 px-2 py-1.5 text-white"
                    value={videoInputId}
                    onChange={(event) => void selectDevice('videoinput', event.target.value)}
                  >
                    {cameraDevices.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>
                    ))}
                  </select>
                </label>
              )}
              {canSelectSpeaker && speakerDevices.length > 0 && (
                <label className="block">
                  <span className="mb-1 block text-white/60">Speaker Output Device</span>
                  <select
                    className="w-full rounded-lg bg-slate-900 px-2 py-1.5 text-white"
                    value={audioOutputId}
                    onChange={(event) => void selectDevice('audiooutput', event.target.value)}
                  >
                    {speakerDevices.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="block">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white/60">Speaker Volume</span>
                  <span className="font-mono text-white/80">{speakerVolume}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={speakerVolume}
                  onChange={(e) => changeSpeakerVolume(Number(e.target.value))}
                  className="w-full accent-brand-500"
                />
              </label>
            </div>
          )}

          <div className="flex items-center justify-center gap-3 px-4 pb-8 pt-4">
            <button
              type="button"
              onClick={toggleMute}
              className={cx('flex h-14 w-14 items-center justify-center rounded-full transition shadow-md', muted ? 'bg-red-500 hover:bg-red-600' : 'bg-white/15 hover:bg-white/25')}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              title={muted ? 'Unmute microphone' : 'Mute microphone'}
              disabled={session.phase !== 'active'}
            >
              <Icon name={muted ? 'micOff' : 'mic'} size={22} />
            </button>
            <button
              type="button"
              onClick={toggleSpeaker}
              className={cx(
                'flex h-14 w-14 items-center justify-center rounded-full transition shadow-md',
                hasNativeCalls
                  ? (audioRoute === 'speaker' ? 'bg-white text-slate-900' : 'bg-white/15 hover:bg-white/25')
                  : !speakerEnabled ? 'bg-red-500 hover:bg-red-600' : 'bg-white/15 hover:bg-white/25',
              )}
              aria-label={hasNativeCalls ? (audioRoute === 'speaker' ? 'Turn loudspeaker off' : 'Turn loudspeaker on') : speakerEnabled ? 'Turn speaker OFF' : 'Turn speaker ON'}
              title={hasNativeCalls ? (audioRoute === 'speaker' ? 'Loudspeaker on' : 'Loudspeaker off') : speakerEnabled ? 'Speaker ON (Click to mute)' : 'Speaker OFF (Click to unmute)'}
            >
              <Icon name={hasNativeCalls ? (audioRoute === 'speaker' ? 'volume' : 'volumeOff') : speakerEnabled ? 'volume' : 'volumeOff'} size={22} />
            </button>
            {session.type === 'video' && (
              <button
                type="button"
                onClick={() => void toggleCamera()}
                className={cx('flex h-14 w-14 items-center justify-center rounded-full transition', cameraOff ? 'bg-red-500' : 'bg-white/15 hover:bg-white/25')}
                aria-label={cameraOff ? 'Turn camera on' : 'Turn camera off'}
                disabled={session.phase !== 'active'}
              >
                <Icon name={cameraOff ? 'videoOff' : 'video'} size={22} />
              </button>
            )}
            <button
              type="button"
              onClick={() => void hangup()}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 shadow-lg transition hover:bg-red-600"
              aria-label="End call"
            >
              <Icon name="phoneOff" size={26} />
            </button>
            {session.type === 'video' && (
              <button
                type="button"
                onClick={() => void toggleScreenShare()}
                className={cx('flex h-14 w-14 items-center justify-center rounded-full transition', sharingScreen ? 'bg-brand-500' : 'bg-white/15 hover:bg-white/25')}
                aria-label={sharingScreen ? 'Stop sharing screen' : 'Share screen'}
                disabled={session.phase !== 'active' || !hasLocalVideo}
              >
                <Icon name={sharingScreen ? 'screenOff' : 'screen'} size={22} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowDevices((open) => !open)}
              className={cx('flex h-14 w-14 items-center justify-center rounded-full transition', showDevices ? 'bg-white/30' : 'bg-white/15 hover:bg-white/25')}
              aria-label="Call settings"
            >
              <Icon name="settings" size={22} />
            </button>
          </div>
          {mediaError && <p className="pb-4 text-center text-xs text-red-300">{mediaError}</p>}
        </div>
      )}
      {ended && !session && !incoming && (
        <div className="fixed inset-0 z-[115] flex flex-col items-center justify-center bg-slate-950 px-6 text-center text-white" role="status" aria-live="assertive">
          <Avatar name={ended.peer.name} src={ended.peer.photoUrl} size={104} className="opacity-90 ring-4 ring-white/10" />
          <h2 className="mt-5 text-2xl font-semibold">{ended.peer.name}</h2>
          {peerSubtitle(ended.peer) && <p className="mt-1 text-sm text-white/60">{peerSubtitle(ended.peer)}</p>}
          <p className={cx(
            'mt-6 rounded-full px-4 py-1.5 text-sm font-semibold',
            ended.tone === 'error' ? 'bg-red-500/20 text-red-200' : ended.tone === 'warning' ? 'bg-amber-500/20 text-amber-100' : 'bg-white/10 text-white/85',
          )}>
            {ended.message}
          </p>
          {ended.duration !== undefined && <p className="mt-2 font-mono text-sm text-white/60">{formatDuration(ended.duration)}</p>}
          <button type="button" onClick={() => setEnded(null)} className="mt-8 rounded-full bg-white/10 px-5 py-2 text-sm text-white/80 hover:bg-white/20">
            Close
          </button>
        </div>
      )}
    </CallContext.Provider>
  );
}

export function useCall(): CallContextValue {
  const context = useContext(CallContext);
  if (!context) throw new Error('useCall must be used inside CallProvider');
  return context;
}
