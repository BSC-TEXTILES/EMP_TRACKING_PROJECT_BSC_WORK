import { useEffect, useRef, useState } from 'react';
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
}

interface MeetingMessage {
  id: number;
  employeeId: number;
  name: string;
  body: string;
  createdAt: string;
}

export default function MeetingRoom() {
  const { id } = useParams();
  const meetingId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const { socket, connected } = useRealtime();
  useDocumentTitle('Meeting room');

  const [config, setConfig] = useState<RtcConfig | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<MeetingMessage[]>([]);
  const [chatText, setChatText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [localStreamReady, setLocalStreamReady] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

  const localVideo = useRef<HTMLVideoElement>(null);
  const localStream = useRef<MediaStream | null>(null);
  const cameraTrack = useRef<MediaStreamTrack | null>(null);
  const peers = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingIce = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      try {
        await api.post(`/meetings/${meetingId}/join`);
        const rtc = await api.get<RtcConfig>(`/meetings/${meetingId}/rtc-config`);
        if (cancelled) return;
        setConfig(rtc);
        const detail = await api.get<{ messages: MeetingMessage[] }>(`/meetings/${meetingId}`);
        if (!cancelled) setMessages(detail.messages);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        localStream.current = stream;
        cameraTrack.current = stream.getVideoTracks()[0] ?? null;
        if (localVideo.current) {
          localVideo.current.srcObject = stream;
          void localVideo.current.play().catch(() => undefined);
        }
        setLocalStreamReady(true);
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        toast.error(message);
      }
    };
    void start();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  useEffect(() => {
    if (!socket || !config) return;
    const code = config.meetingCode;

    const createPeer = (peerId: string, initiator: boolean) => {
      const existing = peers.current.get(peerId);
      if (existing) return existing;
      const peer = new RTCPeerConnection({ iceServers: config.iceServers });
      peers.current.set(peerId, peer);

      localStream.current?.getTracks().forEach((track) => peer.addTrack(track, localStream.current!));

      peer.onicecandidate = (event) => {
        if (event.candidate) socket.emit('meeting:signal', { code, target: peerId, signal: { candidate: event.candidate } });
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
      const others = list.filter((participant) => participant.socketId !== selfId);
      others.forEach((participant) => {
        createPeer(participant.socketId, selfId < participant.socketId);
      });
      peers.current.forEach((peer, peerId) => {
        if (!others.some((participant) => participant.socketId === peerId)) {
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
          if (peer.remoteDescription) await peer.addIceCandidate(new RTCIceCandidate(payload.signal.candidate));
          else {
            const queued = pendingIce.current.get(payload.from) ?? [];
            queued.push(payload.signal.candidate);
            pendingIce.current.set(payload.from, queued);
          }
        }
      } catch {
        /* ignore malformed signals from transient peers */
      }
    };

    socket.on('meeting:participants', handleParticipants);
    socket.on('meeting:signal', handleSignal);
    socket.emit('meeting:join', { code }, (ack: { ok: boolean; participants?: Participant[]; error?: string }) => {
      if (ack?.ok && ack.participants) handleParticipants(ack.participants);
      else if (ack?.error) setError(`Could not join the meeting room: ${ack.error}`);
    });

    const poll = window.setInterval(() => {
      api
        .get<{ messages: MeetingMessage[] }>(`/meetings/${meetingId}`)
        .then((detail) => setMessages(detail.messages))
        .catch(() => undefined);
    }, 15_000);

    return () => {
      socket.emit('meeting:leave', { code });
      socket.off('meeting:participants', handleParticipants);
      socket.off('meeting:signal', handleSignal);
      window.clearInterval(poll);
      peers.current.forEach((peer) => peer.close());
      peers.current.clear();
      localStream.current?.getTracks().forEach((track) => track.stop());
      localStream.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, config?.meetingCode]);

  const toggleMic = () => {
    const track = localStream.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  };

  const toggleCamera = () => {
    const track = localStream.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
  };

  const toggleShare = async () => {
    if (!localStream.current) return;
    if (sharing) {
      if (cameraTrack.current) {
        peers.current.forEach((peer) => {
          const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
          void sender?.replaceTrack(cameraTrack.current);
        });
        if (localVideo.current) localVideo.current.srcObject = localStream.current;
      }
      setSharing(false);
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      peers.current.forEach((peer) => {
        const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
        void sender?.replaceTrack(track);
      });
      if (localVideo.current) {
        const preview = new MediaStream([track]);
        localVideo.current.srcObject = preview;
      }
      track.onended = () => setSharing(false);
      setSharing(true);
    } catch {
      toast.error('Screen sharing was cancelled.');
    }
  };

  const leave = () => {
    navigate('/meetings');
  };

  const sendChat = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!chatText.trim()) return;
    try {
      await api.post(`/meetings/${meetingId}/messages`, { body: chatText });
      setChatText('');
      const detail = await api.get<{ messages: MeetingMessage[] }>(`/meetings/${meetingId}`);
      setMessages(detail.messages);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  };

  const remoteList = Object.entries(remoteStreams);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">{config?.title ?? 'Meeting room'}</h1>
          <p className="text-xs text-ink-500">
            {config ? `Code ${config.meetingCode}` : 'Connecting…'} · {participants.length} in room ·{' '}
            <span className={connected ? 'text-emerald-600' : 'text-amber-600'}>{connected ? 'Signalling connected' : 'Reconnecting…'}</span>
            {config && !config.turnConfigured && ' · STUN only (configure TURN for restrictive networks)'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/meetings" className="btn-secondary btn-sm">Back to meetings</Link>
          <button type="button" className="btn-danger btn-sm" onClick={leave}>
            <Icon name="phoneOff" size={15} /> Leave
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
          {error.toLowerCase().includes('permission') && ' — allow camera and microphone access in the browser and reload.'}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="relative overflow-hidden rounded-xl bg-slate-900">
              <video ref={localVideo} muted playsInline className="h-56 w-full object-cover sm:h-64" />
              <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-white">
                You {micOn ? '' : '· muted'} {sharing ? '· sharing screen' : ''}
              </span>
              {!localStreamReady && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-300">
                  {error ? 'Camera unavailable' : 'Starting camera…'}
                </div>
              )}
            </div>
            {remoteList.map(([peerId, stream]) => (
              <RemoteTile key={peerId} stream={stream} name={participants.find((participant) => participant.socketId === peerId)?.name ?? 'Participant'} />
            ))}
            {remoteList.length === 0 && (
              <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-ink-300 bg-white text-center text-sm text-ink-500 sm:h-64">
                <div>
                  <p className="font-medium text-ink-700">Waiting for others to join</p>
                  <p className="mt-1 text-xs">Share the meeting from the Meetings page. Audio and video connect peer-to-peer.</p>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-200 bg-white p-2.5">
            <button type="button" className={cx('btn-sm', micOn ? 'btn-secondary' : 'btn-danger')} onClick={toggleMic}>
              <Icon name={micOn ? 'mic' : 'micOff'} size={15} /> {micOn ? 'Mute' : 'Unmute'}
            </button>
            <button type="button" className={cx('btn-sm', cameraOn ? 'btn-secondary' : 'btn-danger')} onClick={toggleCamera}>
              <Icon name="video" size={15} /> {cameraOn ? 'Stop video' : 'Start video'}
            </button>
            <button type="button" className={cx('btn-sm', sharing ? 'btn-primary' : 'btn-secondary')} onClick={() => void toggleShare()}>
              <Icon name="screen" size={15} /> {sharing ? 'Stop sharing' : 'Share screen'}
            </button>
            <span className="ml-auto text-xs text-ink-400">
              {user?.fullName} · {localStreamReady ? 'media active' : 'media starting'}
            </span>
          </div>

          <div className="rounded-xl border border-ink-200 bg-white p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Participants</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {participants.length === 0 ? (
                <span className="text-xs text-ink-400">No one else has joined yet.</span>
              ) : (
                participants.map((participant) => (
                  <span key={participant.socketId} className="flex items-center gap-1.5 rounded-full border border-ink-200 px-2 py-1 text-xs text-ink-700">
                    <Avatar name={participant.name} size={18} /> {participant.name}
                    {participant.employeeId === user?.id && <Badge tone="brand">you</Badge>}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>

        <aside className="flex max-h-[540px] flex-col rounded-xl border border-ink-200 bg-white">
          <p className="border-b border-ink-100 px-3 py-2 text-sm font-semibold text-ink-800">Meeting chat</p>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {messages.length === 0 ? (
              <p className="text-xs text-ink-400">No messages yet. Chat is stored with the meeting record.</p>
            ) : (
              messages.map((message) => (
                <div key={message.id} className={cx('rounded-lg px-2 py-1.5 text-sm', message.employeeId === user?.id ? 'bg-brand-50' : 'bg-ink-50')}>
                  <p className="text-[11px] font-semibold text-ink-700">{message.name} <span className="font-normal text-ink-400">{formatTime(message.createdAt)}</span></p>
                  <p className="text-ink-700">{message.body}</p>
                </div>
              ))
            )}
          </div>
          <form onSubmit={sendChat} className="flex gap-2 border-t border-ink-100 p-2">
            <input className="input py-1.5 text-sm" value={chatText} onChange={(event) => setChatText(event.target.value)} placeholder="Message…" />
            <button type="submit" className="btn-primary btn-sm" disabled={!chatText.trim()}>Send</button>
          </form>
        </aside>
      </div>

      {!config && !error && <Skeleton lines={4} />}
    </div>
  );
}

function RemoteTile({ stream, name }: { stream: MediaStream; name: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => undefined);
    }
  }, [stream]);
  return (
    <div className="relative overflow-hidden rounded-xl bg-slate-900">
      <video ref={ref} autoPlay playsInline className="h-56 w-full object-cover sm:h-64" />
      <span className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-[11px] text-white">{name}</span>
    </div>
  );
}
