import { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useRealtime } from '../contexts/RealtimeContext';
import { useToast } from '../contexts/ToastContext';
import { useDocumentTitle } from '../lib/hooks';
import { Avatar, Badge, Skeleton } from '../components/ui';
import { Icon } from '../components/icons';
import { cx, formatTime } from '../lib/format';

interface RtcConfig {
  iceServers: RTCIceServer[];
  meetingCode: string;
  title: string;
  turnConfigured: boolean;
}

interface Participant {
  socketId: string;
  employeeId: number;
  name: string;
  photoUrl?: string | null;
  micOn?: boolean;
  cameraOn?: boolean;
  sharing?: boolean;
  speaking?: boolean;
}

interface MeetingMessage {
  id: number;
  employeeId: number;
  name: string;
  body: string;
  createdAt: string;
}

export default function MeetingRoom() {
  const { id: paramId, code: paramCode } = useParams<{ id?: string; code?: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, has } = useAuth();
  const { socket, connected } = useRealtime();

  const [meetingId, setMeetingId] = useState<number | null>(() => {
    if (paramId && /^\d+$/.test(paramId)) return Number(paramId);
    return null;
  });
  const [meetingCode, setMeetingCode] = useState<string>(() => {
    if (paramCode) return paramCode.toUpperCase();
    if (paramId && !/^\d+$/.test(paramId)) return paramId.toUpperCase();
    return '';
  });

  const [config, setConfig] = useState<RtcConfig | null>(null);
  const [isOrganizer, setIsOrganizer] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<MeetingMessage[]>([]);
  const [chatText, setChatText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Media States
  const [localStreamReady, setLocalStreamReady] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [hasCameraDevice, setHasCameraDevice] = useState(true);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [sharing, setSharing] = useState(false);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);

  // Streams
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [participantMeta, setParticipantMeta] = useState<Record<string, { micOn: boolean; cameraOn: boolean; sharing: boolean; speaking: boolean }>>({});

  const localVideo = useRef<HTMLVideoElement>(null);
  const localStream = useRef<MediaStream | null>(null);
  const cameraTrack = useRef<MediaStreamTrack | null>(null);
  const displayTrack = useRef<MediaStreamTrack | null>(null);
  const peers = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingIce = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  useDocumentTitle(config ? `Meeting: ${config.title}` : 'Meeting Room');

  // 1. Resolve meeting code if navigated via /meet/:code
  useEffect(() => {
    let cancelled = false;
    const resolveMeeting = async () => {
      try {
        if (!meetingId && meetingCode) {
          const detail = await api.get<{ id: number; meetingCode: string; title: string; organizerId: number }>(
            `/meetings/by-code/${meetingCode}`,
          );
          if (cancelled) return;
          setMeetingId(detail.id);
          setIsOrganizer(detail.organizerId === user?.id || has('meetings.manage'));
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err));
          toast.error(errorMessage(err));
        }
      }
    };
    void resolveMeeting();
    return () => {
      cancelled = true;
    };
  }, [meetingId, meetingCode, user?.id, has, toast]);

  // 2. Initialize media and meeting configuration
  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;

    const initMeeting = async () => {
      try {
        await api.post(`/meetings/${meetingId}/join`);
        const rtc = await api.get<RtcConfig>(`/meetings/${meetingId}/rtc-config`);
        if (cancelled) return;
        setConfig(rtc);
        setMeetingCode(rtc.meetingCode);

        // Fetch past meeting chat messages
        const detail = await api.get<{ messages: MeetingMessage[]; organizerId: number }>(`/meetings/${meetingId}`);
        if (!cancelled) {
          setMessages(detail.messages ?? []);
          setIsOrganizer(detail.organizerId === user?.id || has('meetings.manage'));
        }

        // Camera & Microphone initialization with resilient graceful fallback
        let stream: MediaStream | null = null;
        let camSuccess = false;
        let micSuccess = false;

        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              facingMode: 'user',
            },
          });
          camSuccess = true;
          micSuccess = true;
        } catch (camErr) {
          console.warn('[Meeting] Camera unavailable or denied, falling back to audio-only:', camErr);
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            micSuccess = true;
            camSuccess = false;
            setNotice('Camera is unavailable or permission denied. You are joined in audio-only mode.');
          } catch (micErr) {
            console.warn('[Meeting] Microphone unavailable or denied, falling back to listen-only:', micErr);
            stream = new MediaStream();
            micSuccess = false;
            camSuccess = false;
            setNotice('Camera & Microphone are unavailable. You are joined in listen-only mode.');
          }
        }

        if (cancelled) {
          stream?.getTracks().forEach((t) => t.stop());
          return;
        }

        localStream.current = stream;
        cameraTrack.current = stream.getVideoTracks()[0] ?? null;
        setHasCameraDevice(camSuccess);
        setCameraOn(camSuccess);
        setMicOn(micSuccess);

        if (localVideo.current && stream.getVideoTracks().length > 0) {
          localVideo.current.srcObject = stream;
          void localVideo.current.play().catch(() => undefined);
        }
        setLocalStreamReady(true);

        // Setup local audio level monitor for speaking ring
        if (micSuccess && stream.getAudioTracks().length > 0) {
          try {
            const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const audioCtx = new AudioContextClass();
            audioContextRef.current = audioCtx;
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);

            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            let speakingInterval: number | null = null;

            const checkAudio = () => {
              if (cancelled) return;
              analyser.getByteFrequencyData(dataArray);
              let sum = 0;
              for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
              const average = sum / bufferLength;
              const isSpeaking = average > 18;
              if (isSpeaking) {
                setActiveSpeakerId(socket?.id ?? 'self');
              }
              speakingInterval = window.setTimeout(checkAudio, 250);
            };
            checkAudio();
          } catch {
            // Audio analyser optional
          }
        }
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        toast.error(message);
      }
    };

    void initMeeting();

    return () => {
      cancelled = true;
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        void audioContextRef.current.close().catch(() => undefined);
      }
    };
  }, [meetingId, user?.id, has, toast, socket]);

  // 3. WebRTC Signaling and Real-Time Socket Connection
  useEffect(() => {
    if (!socket || !config || !meetingId) return;
    const code = config.meetingCode;

    const createPeer = (peerId: string, initiator: boolean) => {
      const existing = peers.current.get(peerId);
      if (existing) return existing;
      const peer = new RTCPeerConnection({ iceServers: config.iceServers });
      peers.current.set(peerId, peer);

      if (localStream.current) {
        localStream.current.getTracks().forEach((track) => {
          peer.addTrack(track, localStream.current!);
        });
      }

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('meeting:signal', { code, target: peerId, signal: { candidate: event.candidate } });
        }
      };

      peer.ontrack = (event) => {
        const [stream] = event.streams;
        setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
      };

      peer.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(peer.connectionState)) {
          setRemoteStreams((prev) => {
            const next = { ...prev };
            delete next[peerId];
            return next;
          });
        }
      };

      if (initiator) {
        void (async () => {
          try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            socket.emit('meeting:signal', { code, target: peerId, signal: { sdp: peer.localDescription } });
          } catch {
            /* peer may have gone away */
          }
        })();
      }
      return peer;
    };

    const selfId = socket.id ?? '';

    const handleParticipants = (list: Participant[]) => {
      setParticipants(list);
      const others = list.filter((p) => p.socketId !== selfId);
      others.forEach((p) => {
        createPeer(p.socketId, selfId < p.socketId);
      });
      peers.current.forEach((peer, peerId) => {
        if (!others.some((p) => p.socketId === peerId)) {
          peer.close();
          peers.current.delete(peerId);
          setRemoteStreams((prev) => {
            const next = { ...prev };
            delete next[peerId];
            return next;
          });
        }
      });
    };

    const handleSignal = async (payload: { from: string; signal: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
      const peer = createPeer(payload.from, false);
      try {
        if (payload.signal.sdp) {
          await peer.setRemoteDescription(new RTCSessionDescription(payload.signal.sdp));
          const queued = pendingIce.current.get(payload.from) ?? [];
          for (const candidate of queued) await peer.addIceCandidate(new RTCIceCandidate(candidate));
          pendingIce.current.delete(payload.from);
          if (payload.signal.sdp.type === 'offer') {
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            socket.emit('meeting:signal', { code, target: payload.from, signal: { sdp: peer.localDescription } });
          }
        } else if (payload.signal.candidate) {
          if (peer.remoteDescription) {
            await peer.addIceCandidate(new RTCIceCandidate(payload.signal.candidate));
          } else {
            const queued = pendingIce.current.get(payload.from) ?? [];
            queued.push(payload.signal.candidate);
            pendingIce.current.set(payload.from, queued);
          }
        }
      } catch {
        /* ignore transient errors */
      }
    };

    const handleStateChanged = (payload: { socketId: string; employeeId: number; name: string; state: { micOn: boolean; cameraOn: boolean; sharing: boolean; speaking: boolean } }) => {
      setParticipantMeta((prev) => ({
        ...prev,
        [payload.socketId]: payload.state,
      }));
      if (payload.state.speaking) {
        setActiveSpeakerId(payload.socketId);
      }
    };

    const handleChatMessage = (msg: MeetingMessage) => {
      setMessages((prev) => [...prev, msg]);
      setTimeout(() => {
        chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: 'smooth' });
      }, 50);
    };

    const handleMutedByHost = (payload: { by: string }) => {
      const audioTrack = localStream.current?.getAudioTracks()[0];
      if (audioTrack && audioTrack.enabled) {
        audioTrack.enabled = false;
        setMicOn(false);
        socket.emit('meeting:state', { code, micOn: false });
        toast.info(`You were muted by ${payload.by || 'the host'}.`);
      }
    };

    const handleKicked = (payload: { by: string }) => {
      toast.error(`You have been removed from the meeting by ${payload.by || 'the host'}.`);
      navigate('/meetings');
    };

    const handleMeetingEnded = (payload: { endedBy: string }) => {
      toast.info(`This meeting has been ended by ${payload.endedBy || 'the host'}.`);
      navigate('/meetings');
    };

    socket.on('meeting:participants', handleParticipants);
    socket.on('meeting:signal', handleSignal);
    socket.on('meeting:state_changed', handleStateChanged);
    socket.on('meeting:chat', handleChatMessage);
    socket.on('meeting:muted_by_host', handleMutedByHost);
    socket.on('meeting:kicked', handleKicked);
    socket.on('meeting:ended', handleMeetingEnded);

    socket.emit(
      'meeting:join',
      { code, micOn: true, cameraOn: hasCameraDevice },
      (ack: { ok: boolean; participants?: Participant[]; error?: string }) => {
        if (ack?.ok && ack.participants) {
          handleParticipants(ack.participants);
        } else if (ack?.error) {
          setError(`Could not join the meeting room: ${ack.error}`);
        }
      },
    );

    return () => {
      socket.emit('meeting:leave', { code });
      socket.off('meeting:participants', handleParticipants);
      socket.off('meeting:signal', handleSignal);
      socket.off('meeting:state_changed', handleStateChanged);
      socket.off('meeting:chat', handleChatMessage);
      socket.off('meeting:muted_by_host', handleMutedByHost);
      socket.off('meeting:kicked', handleKicked);
      socket.off('meeting:ended', handleMeetingEnded);

      peers.current.forEach((peer) => peer.close());
      peers.current.clear();
      localStream.current?.getTracks().forEach((track) => track.stop());
      localStream.current = null;
    };
  }, [socket, config, meetingId, hasCameraDevice, navigate, toast]);

  // Toggle Microphone
  const toggleMic = () => {
    const track = localStream.current?.getAudioTracks()[0];
    if (!track) {
      toast.error('No microphone device available.');
      return;
    }
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
    if (socket && config) {
      socket.emit('meeting:state', { code: config.meetingCode, micOn: track.enabled });
    }
  };

  // Toggle Camera
  const toggleCamera = async () => {
    if (!hasCameraDevice || !localStream.current) {
      // Try to acquire camera if user previously had none
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode },
        });
        const vTrack = camStream.getVideoTracks()[0];
        localStream.current?.addTrack(vTrack);
        cameraTrack.current = vTrack;
        peers.current.forEach((peer) => {
          peer.addTrack(vTrack, localStream.current!);
        });
        if (localVideo.current) {
          localVideo.current.srcObject = localStream.current;
          void localVideo.current.play().catch(() => undefined);
        }
        setHasCameraDevice(true);
        setCameraOn(true);
        if (socket && config) {
          socket.emit('meeting:state', { code: config.meetingCode, cameraOn: true });
        }
        toast.success('Camera activated.');
        return;
      } catch (err) {
        toast.error('Could not activate camera: ' + errorMessage(err));
        return;
      }
    }

    const track = cameraTrack.current ?? localStream.current.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
    if (socket && config) {
      socket.emit('meeting:state', { code: config.meetingCode, cameraOn: track.enabled });
    }
  };

  // Switch Mobile / Android Camera (Front vs Back)
  const switchCamera = async () => {
    if (!hasCameraDevice || !localStream.current) return;
    const nextMode = facingMode === 'user' ? 'environment' : 'user';
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { exact: nextMode } },
      });
      const newTrack = nextStream.getVideoTracks()[0];

      // Stop old video track
      const oldTrack = cameraTrack.current ?? localStream.current.getVideoTracks()[0];
      if (oldTrack) {
        localStream.current.removeTrack(oldTrack);
        oldTrack.stop();
      }

      localStream.current.addTrack(newTrack);
      cameraTrack.current = newTrack;
      setFacingMode(nextMode);

      // Replace video track across all active WebRTC peers
      peers.current.forEach((peer) => {
        const sender = peer.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) void sender.replaceTrack(newTrack);
      });

      if (localVideo.current) {
        localVideo.current.srcObject = localStream.current;
        void localVideo.current.play().catch(() => undefined);
      }
      toast.success(`Switched to ${nextMode === 'environment' ? 'rear' : 'front'} camera.`);
    } catch {
      // Fallback without exact constraint if device has only one camera
      toast.info('Only one camera available on this device.');
    }
  };

  // Screen Sharing
  const toggleShare = async () => {
    if (!localStream.current) return;
    if (sharing) {
      // Stop sharing, restore camera track
      if (displayTrack.current) {
        displayTrack.current.stop();
        displayTrack.current = null;
      }
      if (cameraTrack.current) {
        peers.current.forEach((peer) => {
          const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
          void sender?.replaceTrack(cameraTrack.current);
        });
        if (localVideo.current) localVideo.current.srcObject = localStream.current;
      }
      setSharing(false);
      if (socket && config) {
        socket.emit('meeting:state', { code: config.meetingCode, sharing: false });
      }
      return;
    }

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const track = display.getVideoTracks()[0];
      displayTrack.current = track;

      peers.current.forEach((peer) => {
        const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
        if (sender) void sender.replaceTrack(track);
        else peer.addTrack(track, localStream.current!);
      });

      if (localVideo.current) {
        const preview = new MediaStream([track]);
        localVideo.current.srcObject = preview;
        void localVideo.current.play().catch(() => undefined);
      }

      track.onended = () => {
        if (cameraTrack.current) {
          peers.current.forEach((peer) => {
            const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
            void sender?.replaceTrack(cameraTrack.current);
          });
          if (localVideo.current) localVideo.current.srcObject = localStream.current;
        }
        setSharing(false);
        if (socket && config) {
          socket.emit('meeting:state', { code: config.meetingCode, sharing: false });
        }
      };

      setSharing(true);
      if (socket && config) {
        socket.emit('meeting:state', { code: config.meetingCode, sharing: true });
      }
      toast.success('You are now sharing your screen.');
    } catch {
      toast.info('Screen sharing was cancelled.');
    }
  };

  // Host Action: Mute Participant
  const hostMute = (participant: Participant) => {
    if (!socket || !config || !meetingId) return;
    socket.emit('meeting:host_action', {
      code: config.meetingCode,
      meetingId,
      action: 'mute',
      targetSocketId: participant.socketId,
      targetEmployeeId: participant.employeeId,
    });
    toast.success(`Mute request sent for ${participant.name}.`);
  };

  // Host Action: Kick Participant
  const hostKick = (participant: Participant) => {
    if (!socket || !config || !meetingId) return;
    if (!window.confirm(`Remove ${participant.name} from the meeting?`)) return;
    socket.emit('meeting:host_action', {
      code: config.meetingCode,
      meetingId,
      action: 'kick',
      targetSocketId: participant.socketId,
      targetEmployeeId: participant.employeeId,
    });
  };

  // Host Action: End Meeting for All
  const endMeetingForAll = async () => {
    if (!meetingId) return;
    if (!window.confirm('Are you sure you want to end this meeting for everyone?')) return;
    try {
      await api.post(`/meetings/${meetingId}/end`);
      toast.success('Meeting ended.');
      navigate('/meetings');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  // Send Chat Message via Socket and API
  const sendChat = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text || !meetingId || !socket || !config) return;

    setChatText('');
    socket.emit('meeting:message', {
      code: config.meetingCode,
      meetingId,
      text,
    });
  };

  // Copy Meeting Link
  const copyMeetingLink = () => {
    if (!config) return;
    const url = `${window.location.origin}/meet/${config.meetingCode}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success('Meeting link copied to clipboard.'))
      .catch(() => toast.error('Could not copy meeting link.'));
  };

  const remoteList = Object.entries(remoteStreams);
  const activePresenter = remoteList.find(([peerId]) => participantMeta[peerId]?.sharing);

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-ink-100 pb-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-ink-900 truncate">{config?.title ?? 'Meeting Room'}</h1>
            {config && (
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1 text-xs font-mono font-bold text-brand-800 border border-brand-200">
                <span>{config.meetingCode}</span>
                <button
                  type="button"
                  onClick={copyMeetingLink}
                  title="Copy meeting share link"
                  className="hover:text-brand-950 transition-colors ml-1 text-brand-600 font-sans text-[11px]"
                >
                  <Icon name="copy" size={12} />
                </button>
              </span>
            )}
            <Badge tone="success" className="text-xs font-semibold">
              Live
            </Badge>
          </div>
          <p className="text-xs text-ink-500 mt-0.5">
            {participants.length} connected ·{' '}
            <span className={connected ? 'text-emerald-600 font-medium' : 'text-amber-600 font-medium'}>
              {connected ? '● Real-time connected' : '○ Reconnecting…'}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={copyMeetingLink}>
            <Icon name="link" size={14} /> Invite Link
          </button>
          {isOrganizer && (
            <button
              type="button"
              className="btn-danger btn-sm bg-red-600 hover:bg-red-700 text-white font-semibold"
              onClick={() => void endMeetingForAll()}
            >
              <Icon name="phoneOff" size={14} /> End for All
            </button>
          )}
          <button type="button" className="btn-secondary btn-sm text-red-600 border-red-200 hover:bg-red-50" onClick={() => navigate('/meetings')}>
            <Icon name="logOut" size={14} /> Leave
          </button>
        </div>
      </div>

      {/* Info notice or Error alert */}
      {notice && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/90 p-3 text-xs text-amber-900 font-medium flex items-center justify-between gap-2 shadow-2xs">
          <div className="flex items-center gap-2">
            <span className="text-amber-600 text-sm">ℹ</span>
            <span>{notice}</span>
          </div>
          <button type="button" onClick={() => setNotice(null)} className="text-amber-700 hover:text-amber-950 text-xs font-bold">
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800 font-medium flex items-center justify-between gap-2">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-700 hover:text-red-950 text-xs font-bold">
            Dismiss
          </button>
        </div>
      )}

      {/* Main Grid: Video Stream Area + Live Interactive Chat */}
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {/* Active Screen Share Spotlight View */}
          {activePresenter && (
            <div className="relative overflow-hidden rounded-2xl bg-black border-2 border-brand-500 shadow-lg p-1">
              <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-lg bg-black/70 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-xs">
                <Icon name="screen" size={14} className="text-brand-400" />
                <span>
                  {participants.find((p) => p.socketId === activePresenter[0])?.name ?? 'Participant'} is presenting screen
                </span>
              </div>
              <RemoteTile
                stream={activePresenter[1]}
                name="Screen Presentation"
                cameraOn={true}
                sharing={true}
                speaking={false}
                isPresenter={true}
              />
            </div>
          )}

          {/* Peer Tiles Grid */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
            {/* Local User Tile */}
            <div
              className={cx(
                'relative flex items-center justify-center overflow-hidden rounded-2xl bg-slate-900 aspect-video shadow-xs transition-all border',
                activeSpeakerId === (socket?.id ?? 'self') ? 'border-emerald-400 ring-2 ring-emerald-400/40' : 'border-slate-800',
              )}
            >
              {cameraOn && hasCameraDevice ? (
                <video ref={localVideo} muted playsInline autoPlay className="h-full w-full object-cover" />
              ) : (
                <div className="flex flex-col items-center justify-center p-4 text-center">
                  <div
                    className={cx(
                      'flex h-20 w-20 items-center justify-center rounded-full bg-brand-700 text-white font-bold text-xl shadow-md transition-all',
                      micOn && 'ring-4 ring-emerald-500/50 animate-pulse',
                    )}
                  >
                    {user?.fullName
                      ?.split(' ')
                      .map((n) => n[0])
                      .slice(0, 2)
                      .join('') ?? 'U'}
                  </div>
                  <p className="mt-3 text-sm font-semibold text-slate-200">{user?.fullName ?? 'You'}</p>
                  <span className="text-[11px] text-slate-400 mt-0.5">{micOn ? 'Microphone on' : 'Muted'}</span>
                </div>
              )}

              {/* Status Overlay Badges */}
              <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1 text-xs text-white backdrop-blur-xs">
                <span className="font-semibold text-white">You</span>
                {!micOn && (
                  <span className="text-red-400" title="Muted">
                    <Icon name="micOff" size={12} />
                  </span>
                )}
                {sharing && (
                  <span className="text-blue-300" title="Sharing screen">
                    <Icon name="screen" size={12} />
                  </span>
                )}
              </div>
            </div>

            {/* Remote Tiles */}
            {remoteList
              .filter(([peerId]) => !activePresenter || peerId !== activePresenter[0])
              .map(([peerId, stream]) => {
                const part = participants.find((p) => p.socketId === peerId);
                const meta = participantMeta[peerId] ?? {
                  micOn: part?.micOn ?? true,
                  cameraOn: part?.cameraOn ?? true,
                  sharing: part?.sharing ?? false,
                  speaking: part?.speaking ?? false,
                };
                return (
                  <RemoteTile
                    key={peerId}
                    stream={stream}
                    name={part?.name ?? 'Participant'}
                    cameraOn={meta.cameraOn}
                    sharing={meta.sharing}
                    speaking={meta.speaking || activeSpeakerId === peerId}
                    photoUrl={part?.photoUrl}
                    onMute={isOrganizer ? () => part && hostMute(part) : undefined}
                    onKick={isOrganizer ? () => part && hostKick(part) : undefined}
                  />
                );
              })}

            {/* Waiting Placeholder */}
            {remoteList.length === 0 && (
              <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-ink-200 bg-white p-6 text-center text-ink-500 aspect-video shadow-xs">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600 mb-2">
                  <Icon name="users" size={22} />
                </div>
                <p className="font-bold text-ink-800 text-sm">Waiting for others to join…</p>
                <p className="mt-1 text-xs text-ink-500 max-w-xs">
                  Share the meeting link or code <strong className="font-mono text-ink-800">{config?.meetingCode}</strong> with your colleagues.
                </p>
                <button type="button" onClick={copyMeetingLink} className="mt-3 btn-secondary btn-sm">
                  <Icon name="copy" size={13} /> Copy Invite Link
                </button>
              </div>
            )}
          </div>

          {/* Interactive Meeting Media Controls Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-ink-200 bg-white p-3 shadow-xs">
            <div className="flex flex-wrap items-center gap-2">
              {/* Mic Toggle */}
              <button
                type="button"
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-all shadow-2xs',
                  micOn ? 'bg-ink-100 text-ink-800 hover:bg-ink-200' : 'bg-red-500 text-white hover:bg-red-600',
                )}
                onClick={toggleMic}
              >
                <Icon name={micOn ? 'mic' : 'micOff'} size={16} />
                <span>{micOn ? 'Mute' : 'Unmute'}</span>
              </button>

              {/* Camera Toggle */}
              <button
                type="button"
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-all shadow-2xs',
                  cameraOn ? 'bg-ink-100 text-ink-800 hover:bg-ink-200' : 'bg-red-500 text-white hover:bg-red-600',
                )}
                onClick={() => void toggleCamera()}
              >
                <Icon name={cameraOn ? 'video' : 'videoOff'} size={16} />
                <span>{cameraOn ? 'Stop Video' : 'Start Video'}</span>
              </button>

              {/* Mobile Camera Switch (Front/Back) */}
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-xl bg-ink-100 text-ink-800 hover:bg-ink-200 px-3.5 py-2 text-xs font-bold transition-all shadow-2xs"
                onClick={() => void switchCamera()}
                title="Switch front/rear camera (Mobile)"
              >
                <Icon name="refresh" size={16} />
                <span className="hidden sm:inline">Flip Camera</span>
              </button>

              {/* Screen Sharing Toggle */}
              <button
                type="button"
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-all shadow-2xs',
                  sharing ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-ink-100 text-ink-800 hover:bg-ink-200',
                )}
                onClick={() => void toggleShare()}
              >
                <Icon name="screen" size={16} />
                <span>{sharing ? 'Stop Sharing' : 'Share Screen'}</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-500 font-medium">
                {localStreamReady ? '✓ Audio/Video connected' : 'Connecting media…'}
              </span>
            </div>
          </div>

          {/* Connected Participants List */}
          <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-xs">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold uppercase tracking-wider text-ink-500">
                Connected Participants ({participants.length})
              </p>
              {isOrganizer && (
                <span className="text-[11px] font-semibold text-brand-700">Host Controls Active</span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {participants.map((p) => {
                const isSelf = p.socketId === socket?.id;
                const meta = participantMeta[p.socketId] ?? { micOn: p.micOn ?? true, cameraOn: p.cameraOn ?? false };
                return (
                  <div
                    key={p.socketId}
                    className="flex items-center gap-2 rounded-xl border border-ink-200 bg-ink-50/80 px-2.5 py-1.5 text-xs text-ink-800 shadow-2xs"
                  >
                    <Avatar name={p.name} size={20} />
                    <span className="font-semibold">{p.name}</span>
                    {isSelf && <Badge tone="brand">You</Badge>}
                    {!meta.micOn && (
                      <span className="text-red-500" title="Muted">
                        <Icon name="micOff" size={12} />
                      </span>
                    )}
                    {isOrganizer && !isSelf && (
                      <div className="flex items-center gap-1 ml-1 pl-1 border-l border-ink-200">
                        <button
                          type="button"
                          onClick={() => hostMute(p)}
                          className="text-ink-500 hover:text-red-600 p-0.5"
                          title={`Mute ${p.name}`}
                        >
                          <Icon name="micOff" size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => hostKick(p)}
                          className="text-ink-500 hover:text-red-600 p-0.5"
                          title={`Remove ${p.name}`}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Real-Time Meeting Chat Sidebar */}
        <aside className="flex flex-col h-[560px] xl:h-auto rounded-2xl border border-ink-200 bg-white shadow-xs overflow-hidden">
          <div className="border-b border-ink-100 bg-ink-50/70 px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-ink-900">Meeting Chat</p>
              <p className="text-[11px] text-ink-500">Live chat synced with meeting record</p>
            </div>
            <Badge tone="brand" className="text-[10px]">
              Socket.IO
            </Badge>
          </div>

          <div ref={chatScrollRef} className="flex-1 space-y-2.5 overflow-y-auto p-3.5">
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center p-4">
                <Icon name="messageSquare" size={24} className="text-ink-300 mb-1" />
                <p className="text-xs font-semibold text-ink-600">No messages yet</p>
                <p className="text-[11px] text-ink-400 mt-0.5">Send a message to everyone in this meeting.</p>
              </div>
            ) : (
              messages.map((m) => {
                const isMine = m.employeeId === user?.id;
                return (
                  <div
                    key={m.id}
                    className={cx(
                      'rounded-xl p-2.5 text-xs shadow-2xs',
                      isMine ? 'bg-brand-50 border border-brand-200 ml-4' : 'bg-ink-50 border border-ink-200 mr-4',
                    )}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className={cx('font-bold', isMine ? 'text-brand-950' : 'text-ink-800')}>{m.name}</span>
                      <span className="text-[10px] text-ink-400 font-mono">{formatTime(m.createdAt)}</span>
                    </div>
                    <p className="text-ink-800 break-words font-medium">{m.body}</p>
                  </div>
                );
              })
            )}
          </div>

          <form onSubmit={sendChat} className="flex gap-2 border-t border-ink-100 p-2.5 bg-ink-50/50">
            <input
              className="input text-xs py-2"
              value={chatText}
              onChange={(e) => setChatText(e.target.value)}
              placeholder="Type message to meeting…"
            />
            <button type="submit" className="btn-primary btn-sm px-3 shrink-0" disabled={!chatText.trim()}>
              <Icon name="send" size={13} />
            </button>
          </form>
        </aside>
      </div>

      {!config && !error && <Skeleton lines={4} />}
    </div>
  );
}

function RemoteTile({
  stream,
  name,
  cameraOn = true,
  sharing = false,
  speaking = false,
  photoUrl,
  isPresenter = false,
  onMute,
  onKick,
}: {
  stream: MediaStream;
  name: string;
  cameraOn?: boolean;
  sharing?: boolean;
  speaking?: boolean;
  photoUrl?: string | null;
  isPresenter?: boolean;
  onMute?: () => void;
  onKick?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => undefined);
    }
  }, [stream]);

  return (
    <div
      className={cx(
        'relative flex items-center justify-center overflow-hidden rounded-2xl bg-slate-900 shadow-xs transition-all border',
        isPresenter ? 'h-96 sm:h-[450px] w-full' : 'aspect-video w-full',
        speaking ? 'border-emerald-400 ring-2 ring-emerald-400/40' : 'border-slate-800',
      )}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        className={cx('h-full w-full', isPresenter ? 'object-contain bg-black' : 'object-cover')}
      />

      {/* When video is off or has no video tracks, show Avatar */}
      {!cameraOn && !isPresenter && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 p-4 text-center">
          <div
            className={cx(
              'flex h-20 w-20 items-center justify-center rounded-full bg-violet-700 text-white font-bold text-xl shadow-md transition-all',
              speaking && 'ring-4 ring-emerald-500/50 animate-pulse',
            )}
          >
            {name
              .split(' ')
              .map((n) => n[0])
              .slice(0, 2)
              .join('')}
          </div>
          <p className="mt-3 text-sm font-semibold text-slate-200">{name}</p>
        </div>
      )}

      {/* Name and status badge */}
      <div className="absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1 text-xs text-white backdrop-blur-xs">
        <span className="font-semibold text-white">{name}</span>
        {sharing && (
          <span className="text-blue-300" title="Sharing screen">
            <Icon name="screen" size={12} />
          </span>
        )}
      </div>

      {/* Host Action Quick Overlay */}
      {(onMute || onKick) && (
        <div className="absolute top-2.5 right-2.5 flex items-center gap-1 opacity-0 hover:opacity-100 transition-opacity bg-black/60 rounded-lg p-1 backdrop-blur-xs">
          {onMute && (
            <button
              type="button"
              onClick={onMute}
              className="text-slate-200 hover:text-red-400 p-1"
              title={`Mute ${name}`}
            >
              <Icon name="micOff" size={14} />
            </button>
          )}
          {onKick && (
            <button
              type="button"
              onClick={onKick}
              className="text-slate-200 hover:text-red-400 p-1"
              title={`Remove ${name}`}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
