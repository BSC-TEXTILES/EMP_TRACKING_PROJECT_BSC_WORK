import { useEffect, useRef, useState, useCallback } from 'react';
import { useRealtime } from '../contexts/RealtimeContext';
import { useAuth } from '../contexts/AuthContext';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../contexts/ToastContext';
import { Icon } from './icons';
import { cx } from '../lib/format';

interface CallParticipant {
  employeeId: number;
  employeeCode: string;
  name: string;
  photoUrl: string | null;
  department: string | null;
  designation: string | null;
}

interface IncomingCall {
  callId: string;
  caller: CallParticipant;
  type: 'audio' | 'video';
  meetingCode?: string;
}

interface ActiveCall {
  callId: string;
  participants: CallParticipant[];
  type: 'audio' | 'video';
  startTime: number;
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  isMuted: boolean;
  isCameraOff: boolean;
  isScreenSharing: boolean;
}

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { socket, connected } = useRealtime();
  const { user } = useAuth();
  const toast = useToast();

  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [callHistory, setCallHistory] = useState<any[]>([]);
  const [missedCalls, setMissedCalls] = useState<number>(0);
  const [showCallUI, setShowCallUI] = useState(false);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRefs = { current: new Map<string, HTMLVideoElement>() } as React.MutableRefObject<Map<string, HTMLVideoElement>>;
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ICE servers configuration
  const iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // Load call history on mount
  useEffect(() => {
    if (!user) return;
    loadCallHistory();
  }, [user]);

  // Handle incoming call signaling
  useEffect(() => {
    if (!socket) return;

    const handleIncomingCall = (payload: any) => {
      if (payload.callId && payload.caller) {
        setIncomingCall({
          callId: payload.callId,
          caller: payload.caller,
          type: payload.type || 'video',
          meetingCode: payload.meetingCode,
        });
        setShowCallUI(true);
        // Play ringtone
        playRingtone();
      }
    };

    const handleCallAccepted = (payload: any) => {
      if (payload.callId === activeCall?.callId) {
        // Call accepted by other party
        stopRingtone();
        if (payload.sdp) {
          handleRemoteSDP(payload.callId, payload.sdp);
        }
      }
    };

    const handleCallRejected = (payload: any) => {
      if (payload.callId === incomingCall?.callId) {
        stopRingtone();
        setIncomingCall(null);
        setShowCallUI(false);
        toast.info('Call declined');
      } else if (payload.callId === activeCall?.callId) {
        endCall();
        toast.info('Call ended by other party');
      }
    };

    const handleCallEnded = (payload: any) => {
      if (payload.callId === activeCall?.callId || payload.callId === incomingCall?.callId) {
        stopRingtone();
        endCall();
        if (payload.callId === incomingCall?.callId) {
          toast.info('Call ended');
        }
      }
    };

    const handleSignal = async (payload: any) => {
      if (payload.from && payload.signal) {
        await handleSignalingMessage(payload.from, payload.signal);
      }
    };

    const handleCallMissed = (payload: any) => {
      if (payload.callId === incomingCall?.callId) {
        stopRingtone();
        setIncomingCall(null);
        setMissedCalls(prev => prev + 1);
        setShowCallUI(false);
        toast.warning('Missed call from ' + payload.caller?.name);
        loadCallHistory();
      }
    };

    socket.on('call:incoming', handleIncomingCall);
    socket.on('call:accepted', handleCallAccepted);
    socket.on('call:rejected', handleCallRejected);
    socket.on('call:ended', handleCallEnded);
    socket.on('call:signal', handleSignal);
    socket.on('call:missed', handleCallMissed);

    return () => {
      socket.off('call:incoming', handleIncomingCall);
      socket.off('call:accepted', handleCallAccepted);
      socket.off('call:rejected', handleCallRejected);
      socket.off('call:ended', handleCallEnded);
      socket.off('call:signal', handleSignal);
      socket.off('call:missed', handleCallMissed);
    };
  }, [socket, activeCall, incomingCall, toast]);

  const loadCallHistory = async () => {
    try {
      const result = await api.get<{ calls: any[] }>('/api/calls/history');
      setCallHistory(result.calls);
      setMissedCalls(result.calls.filter(c => c.status === 'missed' && !c.read).length);
    } catch (caught) {
      console.error('Failed to load call history:', errorMessage(caught));
    }
  };

  const playRingtone = () => {
    // Create audio context for ringtone
    try {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.type = 'sine';
      oscillator.frequency.value = 440;
      gainNode.gain.value = 0.3;
      oscillator.start();
      // Store for stopping
      (window as any).__callRingtone = { oscillator, gainNode, audioContext };
      // Pulse the ringtone
      const pulse = () => {
        if (!(window as any).__callRingtone) return;
        gainNode.gain.value = gainNode.gain.value === 0.3 ? 0 : 0.3;
        setTimeout(pulse, 1000);
      };
      pulse();
    } catch {
      // Fallback to HTML audio
      const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUarm7blmGgU7k9n1unEiBC13yO/eizEIHWq+8+OWT');
      audio.loop = true;
      audio.volume = 0.5;
      audio.play().catch(() => {});
      (window as any).__callRingtoneAudio = audio;
    }
  };

  const stopRingtone = () => {
    const rt = (window as any).__callRingtone;
    if (rt) {
      rt.oscillator.stop();
      rt.gainNode.disconnect();
      rt.audioContext.close();
      delete (window as any).__callRingtone;
    }
    const audio = (window as any).__callRingtoneAudio;
    if (audio) {
      audio.pause();
      audio.src = '';
      delete (window as any).__callRingtoneAudio;
    }
  };

  const getUserMedia = async (type: 'audio' | 'video') => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
      });
      localStreamRef.current = stream;
      return stream;
    } catch (error) {
      toast.error('Camera/microphone access denied. Please allow permissions and try again.');
      throw error;
    }
  };

  const createPeerConnection = (peerId: string, initiator: boolean) => {
    const pc = new RTCPeerConnection({ iceServers });
    peerConnections.current.set(peerId, pc);

    localStreamRef.current?.getTracks().forEach(track => {
      pc.addTrack(track, localStreamRef.current!);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('call:signal', {
          callId: activeCall?.callId,
          target: peerId,
          signal: { candidate: event.candidate.toJSON() },
        });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      setActiveCall(prev => {
        if (!prev) return prev;
        const newStreams = new Map(prev.remoteStreams);
        newStreams.set(peerId, stream);
        return { ...prev, remoteStreams: newStreams };
      });
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        // Handle reconnection or cleanup
        console.log(`Peer ${peerId} connection state: ${pc.connectionState}`);
      }
    };

    return pc;
  };

  const handleSignalingMessage = async (from: string, signal: any) => {
    let pc = peerConnections.current.get(from);
    if (!pc) {
      pc = createPeerConnection(from, false);
    }

    try {
      if (signal.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket?.emit('call:signal', {
            callId: activeCall?.callId,
            target: from,
            signal: { sdp: pc.localDescription },
          });
        }
      } else if (signal.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    } catch (error) {
      console.error('Signaling error:', error);
    }
  };

  const handleRemoteSDP = async (callId: string, sdp: any) => {
    // Handle SDP from caller after we accept
    const pc = peerConnections.current.get(callId);
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  };

  const startCall = async (targetEmployeeId: number, type: 'audio' | 'video') => {
    try {
      // Get caller info first
      const callerInfo = await api.get<{ caller: CallParticipant }>(`/api/calls/initiate/${targetEmployeeId}`);
      
      // Get user media
      const stream = await getUserMedia(type);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Create call via backend
      const result = await api.post<{ callId: string; meetingCode: string }>('/api/calls/start', {
        targetEmployeeId,
        type,
      });

      setActiveCall({
        callId: result.callId,
        participants: [callerInfo.caller],
        type,
        startTime: Date.now(),
        localStream: stream,
        remoteStreams: new Map(),
        isMuted: false,
        isCameraOff: false,
        isScreenSharing: false,
      });
      setShowCallUI(true);
      startCallTimer();

      // Join meeting room for signaling
      socket?.emit('call:join', { code: result.meetingCode, callId: result.callId });

    } catch (caught) {
      toast.error(errorMessage(caught));
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
      }
    }
  };

  const acceptCall = async () => {
    if (!incomingCall) return;

    stopRingtone();
    
    try {
      const stream = await getUserMedia(incomingCall.type);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Accept call via backend
      await api.post(`/api/calls/${incomingCall.callId}/accept`);

      setActiveCall({
        callId: incomingCall.callId,
        participants: [incomingCall.caller],
        type: incomingCall.type,
        startTime: Date.now(),
        localStream: stream,
        remoteStreams: new Map(),
        isMuted: false,
        isCameraOff: false,
        isScreenSharing: false,
      });
      setIncomingCall(null);
      startCallTimer();

      // Join meeting room for signaling
      if (incomingCall.meetingCode) {
        socket?.emit('call:join', { code: incomingCall.meetingCode, callId: incomingCall.callId });
      }

    } catch (caught) {
      toast.error(errorMessage(caught));
      rejectCall();
    }
  };

  const rejectCall = async () => {
    if (!incomingCall) return;
    
    stopRingtone();
    try {
      await api.post(`/api/calls/${incomingCall.callId}/reject`);
    } catch {
      // Ignore
    }
    setIncomingCall(null);
    setShowCallUI(false);
  };

  const endCall = useCallback(() => {
    if (activeCall) {
      socket?.emit('call:leave', { callId: activeCall.callId });
      api.post(`/api/calls/${activeCall.callId}/end`).catch(() => {});
    }
    
    stopRingtone();
    stopCallTimer();
    
    // Close all peer connections
    peerConnections.current.forEach(pc => pc.close());
    peerConnections.current.clear();
    
    // Stop local stream
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    
    setActiveCall(null);
    setShowCallUI(false);
    loadCallHistory();
  }, [activeCall, socket]);

  const toggleMute = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setActiveCall(prev => prev ? { ...prev, isMuted: !track.enabled } : null);
    }
  };

  const toggleCamera = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setActiveCall(prev => prev ? { ...prev, isCameraOff: !track.enabled } : null);
    }
  };

  const toggleScreenShare = async () => {
    if (!activeCall || activeCall.isScreenSharing) {
      // Stop screen sharing, revert to camera
      if (activeCall && cameraTrackRef.current) {
        peerConnections.current.forEach(pc => {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          sender?.replaceTrack(cameraTrackRef.current);
        });
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
        }
      }
      setActiveCall(prev => prev ? { ...prev, isScreenSharing: false } : null);
      return;
    }

    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const videoTrack = displayStream.getVideoTracks()[0];
      
      peerConnections.current.forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        sender?.replaceTrack(videoTrack);
      });
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = displayStream;
      }
      
      videoTrack.onended = () => {
        // User stopped sharing via browser UI
        if (cameraTrackRef.current) {
          peerConnections.current.forEach(pc => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            sender?.replaceTrack(cameraTrackRef.current);
          });
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = localStreamRef.current;
          }
        }
        setActiveCall(prev => prev ? { ...prev, isScreenSharing: false } : null);
      };
      
      setActiveCall(prev => prev ? { ...prev, isScreenSharing: true } : null);
    } catch {
      toast.error('Screen sharing cancelled or failed');
    }
  };

  const startCallTimer = () => {
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    callTimerRef.current = setInterval(() => {
      setActiveCall(prev => prev ? { ...prev } : null); // Trigger re-render for timer
    }, 1000);
  };

  const stopCallTimer = () => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
  };

  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  
  useEffect(() => {
    if (activeCall?.localStream) {
      cameraTrackRef.current = activeCall.localStream.getVideoTracks()[0] || null;
    }
  }, [activeCall?.localStream]);

  // Calculate call duration
  const callDuration = activeCall ? Math.floor((Date.now() - activeCall.startTime) / 1000) : 0;
  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  };

  // Render incoming call UI
  if (incomingCall && !activeCall) {
    return (
      <>
        {children}
        <IncomingCallOverlay
          call={incomingCall}
          onAccept={acceptCall}
          onReject={rejectCall}
          duration={0}
        />
      </>
    );
  }

  // Render active call UI
  if (activeCall) {
    return (
      <>
        {children}
        <ActiveCallOverlay
          call={activeCall}
          localVideoRef={localVideoRef}
          remoteVideoRefs={remoteVideoRefs}
          onEnd={endCall}
          onMute={toggleMute}
          onCameraToggle={toggleCamera}
          onScreenShare={toggleScreenShare}
          duration={callDuration}
          formatDuration={formatDuration}
        />
      </>
    );
  }

  return children;
}

// Incoming Call Overlay Component
function IncomingCallOverlay({
  call,
  onAccept,
  onReject,
}: {
  call: IncomingCall;
  onAccept: () => void;
  onReject: () => void;
  duration: number;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-fade-in">
      <div className="w-full max-w-md rounded-2xl shadow-2xl border-0 overflow-hidden animate-slide-up bg-white">
        <div className="p-6 text-center">
          <div className="relative w-24 h-24 mx-auto mb-4">
            <div className="absolute inset-0 rounded-full bg-brand-500/20 animate-ping"></div>
            <div className="absolute inset-4 rounded-full bg-brand-500/10 animate-ping" style={{ animationDelay: '0.5s' }}></div>
            <div className="relative w-full h-full rounded-full bg-white border-4 border-brand-500 flex items-center justify-center">
              <img
                src={call.caller.photoUrl || `/api/avatar/${call.caller.employeeId}`}
                alt={call.caller.name}
                className="w-full h-full rounded-full object-cover"
                onError={(e) => { e.currentTarget.src = `/api/avatar/${call.caller.employeeId}`; }}
              />
            </div>
          </div>
          
          <div className="flex items-center justify-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700 animate-pulse">
              <span className="w-2 h-2 rounded-full bg-red-500"></span>
              Incoming {call.type} Call
            </span>
          </div>
          
          <h2 className="text-xl font-bold text-ink-900">{call.caller.name}</h2>
          <p className="mt-1 text-sm text-ink-500">
            {call.caller.employeeCode} · {call.caller.department || call.caller.designation || 'Employee'}
          </p>
          
          <div className="mt-6 flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={onReject}
              className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center text-white shadow-lg hover:bg-red-600 transition-colors"
              aria-label="Reject call"
            >
              <Icon name="phoneOff" size={28} />
            </button>
            <button
              type="button"
              onClick={onAccept}
              className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center text-white shadow-lg hover:bg-emerald-600 transition-colors"
              aria-label="Accept call"
            >
              <Icon name={call.type === 'video' ? 'video' : 'phone'} size={28} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Active Call Overlay Component
function ActiveCallOverlay({
  call,
  localVideoRef,
  remoteVideoRefs,
  onEnd,
  onMute,
  onCameraToggle,
  onScreenShare,
  duration,
  formatDuration,
}: {
  call: ActiveCall;
  localVideoRef: React.RefObject<HTMLVideoElement | null>;
  remoteVideoRefs: React.MutableRefObject<Map<string, HTMLVideoElement>>;
  onEnd: () => void;
  onMute: () => void;
  onCameraToggle: () => void;
  onScreenShare: () => void;
  duration: number;
  formatDuration: (seconds: number) => string;
}) {
  const remoteEntries = Array.from(call.remoteStreams.entries());

  return (
    <div className="fixed inset-0 z-[90] bg-slate-900">
      {/* Video Grid */}
      <div className="relative h-full w-full">
        {/* Remote videos */}
        {remoteEntries.length > 0 ? (
          <div className="grid grid-cols-1 h-full gap-2 p-2">
            {remoteEntries.map(([peerId, stream]) => (
              <div key={peerId} className="relative rounded-xl overflow-hidden bg-black">
                <video
                  ref={(el) => { if (el) remoteVideoRefs.current.set(peerId, el); }}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover"
                  // @ts-expect-error - srcObject is a valid property for HTMLVideoElement
                  srcObject={stream}
                />
                <div className="absolute bottom-3 left-3 flex items-center gap-1.5 text-white text-xs">
                  <span className="bg-black/60 px-2 py-1 rounded">Remote</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-white">
            <div className="text-center">
              <Icon name="userCheck" size={48} className="mx-auto mb-3 opacity-50" />
              <p className="text-lg font-medium">Waiting for participants...</p>
              <p className="text-sm opacity-50 mt-1">Connecting peer-to-peer</p>
            </div>
          </div>
        )}

        {/* Local video preview (picture-in-picture) */}
        <div className="absolute bottom-20 right-4 z-10">
          <div className="relative w-40 h-30 sm:w-48 sm:h-36 rounded-xl overflow-hidden border-2 border-white/20 bg-black">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            <span className="absolute bottom-1 left-1 text-[10px] bg-black/60 px-1.5 py-0.5 rounded text-white">
              You {call.isMuted ? '· muted' : ''} {call.isScreenSharing ? '· sharing' : ''}
            </span>
          </div>
        </div>

        {/* Call Duration */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10">
          <div className="bg-black/70 backdrop-blur-sm rounded-full px-4 py-1.5 text-white font-mono text-sm">
            {formatDuration(duration)}
          </div>
        </div>
      </div>

      {/* Call Controls */}
      <div className="absolute bottom-0 left-0 right-0 p-6 pb-8 bg-gradient-to-t from-black/80 to-transparent">
        <div className="max-w-2xl mx-auto flex items-center justify-center gap-4">
          {/* Mute */}
          <button
            type="button"
            onClick={onMute}
            className={cx(
              'w-14 h-14 rounded-full flex items-center justify-center text-white text-xl transition-all',
              call.isMuted ? 'bg-red-500' : 'bg-white/20 hover:bg-white/30'
            )}
            aria-label={call.isMuted ? 'Unmute' : 'Mute'}
          >
            <Icon name={call.isMuted ? 'micOff' : 'mic'} size={24} />
          </button>

          {/* End Call */}
          <button
            type="button"
            onClick={onEnd}
            className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center text-white text-2xl shadow-lg hover:bg-red-600 transition-colors"
            aria-label="End call"
          >
            <Icon name="phoneOff" size={30} />
          </button>

          {/* Camera Toggle */}
          <button
            type="button"
            onClick={onCameraToggle}
            className={cx(
              'w-14 h-14 rounded-full flex items-center justify-center text-white text-xl transition-all',
              call.isCameraOff ? 'bg-red-500' : 'bg-white/20 hover:bg-white/30'
            )}
            aria-label={call.isCameraOff ? 'Start video' : 'Stop video'}
          >
            <Icon name={call.isCameraOff ? 'videoOff' : 'video'} size={24} />
          </button>

          {/* Screen Share */}
          <button
            type="button"
            onClick={onScreenShare}
            className={cx(
              'w-14 h-14 rounded-full flex items-center justify-center text-white text-xl transition-all',
              call.isScreenSharing ? 'bg-brand-500' : 'bg-white/20 hover:bg-white/30'
            )}
            aria-label={call.isScreenSharing ? 'Stop sharing' : 'Share screen'}
          >
            <Icon name={call.isScreenSharing ? 'screenOff' : 'screen'} size={24} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Export hook for making calls
export function useCall() {
  const { socket } = useRealtime();
  const toast = useToast();

  const call = useCallback(async (employeeId: number, type: 'audio' | 'video') => {
    try {
      const result = await api.post<{ callId: string; meetingCode: string }>('/api/calls/start', {
        targetEmployeeId: employeeId,
        type,
      });
      return result;
    } catch (caught) {
      toast.error(errorMessage(caught));
      throw caught;
    }
  }, [toast]);

  return { call };
}