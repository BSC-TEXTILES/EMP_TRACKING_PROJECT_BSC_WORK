import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRealtime } from '../contexts/RealtimeContext';
import { useAuth } from '../contexts/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { Avatar } from './ui';
import { Icon } from './icons';
import { cx } from '../lib/format';
import { showDesktopNotification, PhoneRingtone } from '../lib/notifications';

export type CallType = 'audio' | 'video';

export interface CallPeer {
  employeeId: number;
  employeeCode: string;
  name: string;
  photoUrl: string | null;
  department: string | null;
  designation: string | null;
  location?: string | null;
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
}

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
const RING_TIMEOUT_MS = 45_000;

// Phone ringing and ringback audio synthesized via PhoneRingtone in sound.ts

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function peerSubtitle(peer: CallPeer): string {
  const parts = [peer.employeeCode, peer.designation, peer.department, peer.location].filter(Boolean);
  return parts.join(' · ');
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

  const teardown = useCallback((options: { leaveRoom?: boolean } = {}) => {
    const current = sessionRef.current;
    if (current && options.leaveRoom !== false) {
      socketRef.current?.emit('call:leave', { callId: current.callId });
    }
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
        ? 'Microphone or camera permission was denied. Allow access in the browser and try again.'
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
        void remoteVideoRef.current.play().catch(() => undefined);
      }
    };
    pc.onconnectionstatechange = () => {
      if (!pcRef.current) return;
      if (pc.connectionState === 'connected') {
        restartAttemptedRef.current = false;
      } else if (pc.connectionState === 'failed') {
        if (!restartAttemptedRef.current) {
          restartAttemptedRef.current = true;
          try {
            pc.restartIce();
          } catch {
            /* no-op */
          }
        } else {
          toastRef.current.error('The call connection was lost.');
          void api.post(`/calls/${sessionRef.current?.callId}/end`).catch(() => undefined);
          teardown();
          setHistoryVersion((value) => value + 1);
        }
      }
    };
    return pc;
  }, [emitSignal, teardown]);

  const makeOffer = useCallback(async () => {
    const pc = pcRef.current;
    const current = sessionRef.current;
    if (!pc || !current || offerSentRef.current) return;
    offerSentRef.current = true;
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: current.type === 'video' });
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

  const joinRoom = useCallback((callId: string) => {
    const socket = socketRef.current;
    if (!socket) return;
    let acknowledged = false;
    const timer = window.setTimeout(() => {
      if (acknowledged) return;
      acknowledged = true;
      toastRef.current.error('Call signalling timed out. Please try again.');
      void api.post(`/calls/${callId}/end`).catch(() => undefined);
      teardown();
      setHistoryVersion((value) => value + 1);
    }, 12_000);
    socket.emit('call:join', { callId }, (response: { ok?: boolean; error?: string }) => {
      if (acknowledged) return;
      acknowledged = true;
      window.clearTimeout(timer);
      if (!response?.ok) {
        toastRef.current.error(response?.error === 'call ended' ? 'The call has already ended.' : 'Could not join the call.');
        void api.post(`/calls/${callId}/end`).catch(() => undefined);
        teardown();
        setHistoryVersion((value) => value + 1);
      }
    });
  }, [teardown]);

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
      const result = await api.post<{ callId: string; peer: CallPeer; iceServers: IceServerConfig[] }>('/calls/start', {
        targetEmployeeId: employeeId,
        type,
      });
      const servers = result.iceServers?.length ? result.iceServers : iceServers;
      setIceServers(servers);
      const next: CallSession = {
        callId: result.callId,
        peer: result.peer ?? peerHint ?? {
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
      };
      updateSession(next);
      offerSentRef.current = false;
      pendingIceRef.current = [];
      createPeer(servers);
      joinRoom(result.callId);
      ringtoneRef.current.start('outgoing');
      ringTimeoutRef.current = window.setTimeout(() => {
        void api.post(`/calls/${result.callId}/cancel`).catch(() => undefined);
        toastRef.current.warning('No answer. The call was cancelled.');
        teardown();
        setHistoryVersion((value) => value + 1);
      }, RING_TIMEOUT_MS);
    } catch (error) {
      stopLocalMedia();
      toastRef.current.error(errorMessage(error));
    }
  }, [acquireMedia, createPeer, iceServers, joinRoom, stopLocalMedia, teardown, updateSession, user]);

  const accept = useCallback(async () => {
    const current = incomingRef.current;
    if (!current) return;
    ringtoneRef.current.stop();
    const socket = socketRef.current;
    if (!socket?.connected) {
      toastRef.current.error('The live connection is offline. Ask the caller to try again.');
      return;
    }
    try {
      await acquireMedia(current.type);
    } catch (error) {
      toastRef.current.error(errorMessage(error));
      await api.post(`/calls/${current.callId}/reject`).catch(() => undefined);
      teardown();
      setHistoryVersion((value) => value + 1);
      return;
    }
    try {
      await api.post(`/calls/${current.callId}/accept`);
      const next: CallSession = {
        callId: current.callId,
        peer: current.peer,
        type: current.type,
        isCaller: false,
        phase: 'active',
        startedAt: Date.now(),
      };
      updateSession(next);
      updateIncoming(null);
      pendingIceRef.current = [];
      offerSentRef.current = false;
      createPeer(iceServers);
      joinRoom(current.callId);
    } catch (error) {
      toastRef.current.error(errorMessage(error));
      stopLocalMedia();
      teardown();
      setHistoryVersion((value) => value + 1);
    }
  }, [acquireMedia, createPeer, iceServers, joinRoom, stopLocalMedia, teardown, updateIncoming, updateSession]);

  const reject = useCallback(async () => {
    const current = incomingRef.current;
    if (!current) return;
    ringtoneRef.current.stop();
    updateIncoming(null);
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
    await api.post(path).catch(() => undefined);
    teardown();
    setHistoryVersion((value) => value + 1);
  }, [reject, teardown]);

  // Load TURN/STUN configuration and restore an incoming call opened from a
  // push notification link (/calls?incoming=<callId>).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void api.get<{ iceServers: IceServerConfig[] }>('/calls/config')
      .then((result) => {
        if (!cancelled && result.iceServers?.length) setIceServers(result.iceServers);
      })
      .catch(() => undefined);

    const callId = new URLSearchParams(window.location.search).get('incoming');
    if (callId && !sessionRef.current && !incomingRef.current) {
      void api.get<{ callId: string; type: CallType; status: string; direction: string; peer: CallPeer; iceServers: IceServerConfig[] }>(`/calls/detail/${callId}`)
        .then((detail) => {
          if (cancelled) return;
          if (detail.iceServers?.length) setIceServers(detail.iceServers);
          if (detail.direction === 'incoming' && detail.status === 'ringing') {
            updateIncoming({ callId: detail.callId, peer: detail.peer, type: detail.type });
            ringtoneRef.current.start('incoming');
          } else if (detail.status === 'missed' || detail.status === 'declined') {
            void api.post('/calls/missed', { callId }).catch(() => undefined);
          }
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [updateIncoming, user?.id]);

  // Signalling and call lifecycle events.
  useEffect(() => {
    if (!socket) return;

    const matches = (payload: { callId?: string }) =>
      Boolean(payload?.callId && (sessionRef.current?.callId === payload.callId || incomingRef.current?.callId === payload.callId));

    const onIncoming = (payload: { callId: string; caller: CallPeer; type: CallType }) => {
      if (!payload?.callId || !payload.caller) return;
      if (sessionRef.current || incomingRef.current) {
        // Busy: reject the second call immediately so the caller is not left ringing.
        void api.post(`/calls/${payload.callId}/reject`).catch(() => undefined);
        toastRef.current.info(`${payload.caller.name} called while you were on another call.`);
        return;
      }
      updateIncoming({ callId: payload.callId, peer: payload.caller, type: payload.type });
      ringtoneRef.current.start('incoming');
      void showDesktopNotification(`Incoming ${payload.type === 'video' ? 'Video' : 'Audio'} Call`, {
        body: `${payload.caller.name} (${payload.caller.designation || 'Colleague'} · ${payload.caller.location || 'BSC Textiles'}) is calling you`,
        icon: payload.caller.photoUrl || '/icons/icon-192.png',
        tag: `call_${payload.callId}`,
        link: `/calls?incoming=${payload.callId}`,
        urgent: true,
      });
    };

    const onPeerJoined = (payload: { callId: string; employeeId: number }) => {
      const current = sessionRef.current;
      if (!current || current.callId !== payload.callId) return;
      if (current.phase === 'ringing') {
        clearRingTimeout();
        ringtoneRef.current.stop();
        const next: CallSession = { ...current, phase: 'active', startedAt: Date.now() };
        updateSession(next);
      }
      if (current.isCaller) void makeOffer();
    };

    const onAccepted = (payload: { callId: string }) => {
      const current = sessionRef.current;
      if (!current || current.callId !== payload.callId) return;
      clearRingTimeout();
      ringtoneRef.current.stop();
      if (current.phase !== 'active') {
        const next: CallSession = { ...current, phase: 'active', startedAt: Date.now() };
        updateSession(next);
      }
      if (current.isCaller) void makeOffer();
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

    const onRejected = (payload: { callId: string }) => {
      if (!matches(payload)) return;
      toastRef.current.info('Call declined.');
      teardown();
      setHistoryVersion((value) => value + 1);
    };

    const onMissed = (payload: { callId: string }) => {
      if (!matches(payload)) return;
      toastRef.current.warning('Missed call.');
      teardown();
      setHistoryVersion((value) => value + 1);
    };

    const onEnded = (payload: { callId: string; reason?: string }) => {
      if (!matches(payload)) return;
      const reason = payload.reason;
      const message = reason === 'no_answer'
        ? 'No answer.'
        : reason === 'rejected'
          ? 'Call declined.'
          : reason === 'disconnected'
            ? 'The other participant disconnected.'
            : 'Call ended.';
      if (incomingRef.current) toastRef.current.warning(message);
      else if (sessionRef.current?.phase === 'active') toastRef.current.info(message);
      teardown();
      setHistoryVersion((value) => value + 1);
    };

    const onPeerLeft = (payload: { callId: string; employeeId: number }) => {
      if (!matches(payload)) return;
      if (payload.employeeId === user?.id) return;
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

    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:peer_joined', onPeerJoined);
      socket.off('call:accepted', onAccepted);
      socket.off('call:signal', onSignal);
      socket.off('call:rejected', onRejected);
      socket.off('call:missed', onMissed);
      socket.off('call:ended', onEnded);
      socket.off('call:peer_left', onPeerLeft);
    };
  }, [clearRingTimeout, emitSignal, flushCandidates, makeOffer, socket, teardown, updateIncoming, updateSession, user?.id]);

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
  const phaseLabel = session?.phase === 'ringing'
    ? (session.isCaller ? 'Ringing…' : 'Connecting…')
    : elapsed > 0
      ? formatDuration(elapsed)
      : 'Connecting…';

  return (
    <CallContext.Provider value={value}>
      {children}

      {incoming && !session && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="bg-gradient-to-b from-brand-600 to-brand-700 px-6 pb-6 pt-8 text-center text-white">
              <div className="relative mx-auto mb-4 h-28 w-28">
                <span className="absolute inset-0 animate-ping rounded-full bg-white/20" />
                <Avatar name={incoming.peer.name} src={incoming.peer.photoUrl} size={112} className="relative ring-4 ring-white/30" />
              </div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/70">
                Incoming {incoming.type} call
              </p>
              <h2 className="mt-1 truncate text-2xl font-semibold">{incoming.peer.name}</h2>
              <p className="mt-1 truncate text-sm text-white/80">{peerSubtitle(incoming.peer) || 'Employee'}</p>
            </div>
            <div className="flex items-center justify-center gap-10 px-6 py-6">
              <button
                type="button"
                onClick={() => void reject()}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition hover:bg-red-600"
                aria-label="Decline call"
              >
                <Icon name="phoneOff" size={26} />
              </button>
              <button
                type="button"
                onClick={() => void accept()}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg transition hover:bg-emerald-600"
                aria-label="Accept call"
              >
                <Icon name={incoming.type === 'video' ? 'video' : 'phone'} size={26} />
              </button>
            </div>
            {mediaError && <p className="px-6 pb-4 text-center text-xs text-red-600">{mediaError}</p>}
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
            <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs">
              <span className={cx('h-2 w-2 rounded-full', session.phase === 'active' ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse')} />
              {session.phase === 'active' ? formatDuration(elapsed) : 'Ringing'}
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
                <p className="mt-4 text-sm text-white/50">
                  {session.phase === 'ringing' ? (session.isCaller ? 'Waiting for answer…' : 'Connecting…') : 'Audio call in progress'}
                </p>
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
                  <span className="mb-1 block text-white/60">Speaker</span>
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
            </div>
          )}

          <div className="flex items-center justify-center gap-3 px-4 pb-8 pt-4">
            <button
              type="button"
              onClick={toggleMute}
              className={cx('flex h-14 w-14 items-center justify-center rounded-full transition', muted ? 'bg-red-500' : 'bg-white/15 hover:bg-white/25')}
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              disabled={session.phase !== 'active'}
            >
              <Icon name={muted ? 'micOff' : 'mic'} size={22} />
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
    </CallContext.Provider>
  );
}

export function useCall(): CallContextValue {
  const context = useContext(CallContext);
  if (!context) throw new Error('useCall must be used inside CallProvider');
  return context;
}
