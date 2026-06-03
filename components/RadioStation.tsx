'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection, MediaConnection } from 'peerjs';
import { Play, Pause, Power, Users, Music, SkipForward, UploadCloud } from 'lucide-react';

const CHANNELS = [88.1, 91.3, 94.5, 97.7, 100.9, 104.1, 107.3];

const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  },
  pingInterval: 10000,
};
const MIN_FREQ = 87.5;
const MAX_FREQ = 108.0;

class RadioSynth {
  ctx: AudioContext;
  noiseBuffer: AudioBuffer;
  noiseSource: AudioBufferSourceNode | null = null;
  filter: BiquadFilterNode;
  gain: GainNode;
  masterGain: GainNode;

  constructor() {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);
    this.masterGain.gain.value = 0.5;

    const bufferSize = this.ctx.sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const output = this.noiseBuffer.getChannelData(0);
    for(let i=0; i<bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
    }

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = 1000;
    this.filter.Q.value = 1.0;

    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;

    this.filter.connect(this.gain);
    this.gain.connect(this.masterGain);
  }

  start() {
    if(this.ctx.state === 'suspended') this.ctx.resume();
    if(!this.noiseSource) {
        this.noiseSource = this.ctx.createBufferSource();
        this.noiseSource.buffer = this.noiseBuffer;
        this.noiseSource.loop = true;
        this.noiseSource.connect(this.filter);
        this.noiseSource.start();
    }
  }

  setTuning(isTuning: boolean, dist: number, volume: number = 0.4) {
    if(this.ctx.state === 'suspended') this.ctx.resume();
    if(isTuning) {
        const staticVol = Math.max(0.05, Math.min(dist, 1.0)) * volume;
        this.gain.gain.setTargetAtTime(staticVol, this.ctx.currentTime, 0.1);
        this.filter.frequency.setTargetAtTime(800 + Math.random() * 1500, this.ctx.currentTime, 0.1);
    } else {
        this.gain.gain.setTargetAtTime(dist > 0.1 ? volume : 0.0, this.ctx.currentTime, 0.2);
        this.filter.frequency.setTargetAtTime(1000, this.ctx.currentTime, 0.5);
    }
  }
  
  destroy() {
    if(this.noiseSource) {
        this.noiseSource.stop();
        this.noiseSource.disconnect();
    }
    if (this.ctx.state !== 'closed') this.ctx.close();
  }
}

interface Track {
  id: string;
  file: File;
  name: string;
  url: string;
}

export default function RadioStation() {
  const [power, setPower] = useState(false);
  const [frequency, setFrequency] = useState(88.1);
  const [activeChannel, setActiveChannel] = useState<number | null>(null);
  const [mode, setMode] = useState<'tuning' | 'locked_empty' | 'locked_rx' | 'host'>('tuning');
  const [nowPlaying, setNowPlaying] = useState('');
  
  // Host State
  const [playlist, setPlaylist] = useState<Track[]>([]);
  const [currentTrackIndex, setCurrentTrackIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [peerConnections, setPeerConnections] = useState<DataConnection[]>([]);

  // Physics & Hardware Refs
  const knobRef = useRef<HTMLDivElement>(null);
  const [knobRot, setKnobRot] = useState(0);
  const isDragging = useRef(false);
  const velocity = useRef(0);
  const lastAngle = useRef(0);
  const currentFreqRef = useRef(frequency);
  const synthRef = useRef<RadioSynth | null>(null);
  
  const currentPeerRef = useRef<Peer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamDestRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeCallsRef = useRef<MediaConnection[]>([]);
  const playlistRef = useRef<Track[]>([]);
  const currentTrackRef = useRef<number>(-1);

  useEffect(() => {
    playlistRef.current = playlist;
    currentTrackRef.current = currentTrackIndex;
  }, [playlist, currentTrackIndex]);

  const initAudio = () => {
    if(!synthRef.current) {
        synthRef.current = new RadioSynth();
        synthRef.current.start();
    } else if (synthRef.current.ctx.state === 'suspended') {
        synthRef.current.ctx.resume();
    }
  };

  const disconnectNetwork = useCallback(() => {
    if (currentPeerRef.current) {
        currentPeerRef.current.destroy();
        currentPeerRef.current = null;
    }
    setPeerConnections([]);
    activeCallsRef.current.forEach(c => c.close());
    activeCallsRef.current = [];
    if(audioRef.current) {
        audioRef.current.pause();
        audioRef.current.srcObject = null;
    }
    setCurrentTrackIndex(-1);
    setIsPlaying(false);
  }, []);

  const togglePower = () => {
    if (power) {
        setPower(false);
        setActiveChannel(null);
        disconnectNetwork();
        if(synthRef.current) {
            synthRef.current.destroy();
            synthRef.current = null;
        }
        setMode('tuning');
    } else {
        setPower(true);
        initAudio();
        // Immediately try to lock based on initial frequency
        const closest = CHANNELS.reduce((prev, curr) => Math.abs(curr - frequency) < Math.abs(prev - frequency) ? curr : prev);
        if (Math.abs(closest - frequency) < 0.15) {
            setActiveChannel(closest);
        }
    }
  };

  // Knob Physics Loop
  useEffect(() => {
     let raf: number;
     const loop = () => {
         if (!isDragging.current && Math.abs(velocity.current) > 0.001) {
             currentFreqRef.current += velocity.current;
             velocity.current *= 0.90; // friction
             
             if (currentFreqRef.current < MIN_FREQ) {
                 currentFreqRef.current = MIN_FREQ;
                 velocity.current = 0;
             }
             if (currentFreqRef.current > MAX_FREQ) {
                 currentFreqRef.current = MAX_FREQ;
                 velocity.current = 0;
             }
             setFrequency(Math.round(currentFreqRef.current * 10) / 10);
             setKnobRot(prev => prev + velocity.current * 30);
         }
         raf = requestAnimationFrame(loop);
     }
     raf = requestAnimationFrame(loop);
     return () => cancelAnimationFrame(raf);
  }, []);

  // Snapping & Tuning Effect
  useEffect(() => {
     if(!power) return;
     
     const timeout = setTimeout(() => {
         if (!isDragging.current && Math.abs(velocity.current) < 0.01) {
             const closest = CHANNELS.reduce((prev, curr) => Math.abs(curr - frequency) < Math.abs(prev - frequency) ? curr : prev);
             if (Math.abs(closest - frequency) < 0.15) {
                 // Snap
                 currentFreqRef.current = closest;
                 setFrequency(closest);
                 setActiveChannel(closest);
                 if (synthRef.current) synthRef.current.setTuning(false, 0);
             } else {
                 if(activeChannel !== null) setActiveChannel(null);
                 setMode('tuning');
                 if (synthRef.current) synthRef.current.setTuning(true, 1.0);
             }
         }
     }, 200);

     if (synthRef.current) {
         const closest = CHANNELS.reduce((prev, curr) => Math.abs(curr - frequency) < Math.abs(prev - frequency) ? curr : prev);
         const dist = Math.min(Math.abs(closest - frequency), 0.5) * 2; 
         synthRef.current.setTuning(true, dist);
     }

     return () => clearTimeout(timeout);
  }, [frequency, power]);

  const attemptRx = useCallback((channel: number) => {
      setMode('tuning');
      setNowPlaying('');
      disconnectNetwork();

      const peer = new Peer(PEER_CONFIG);
      currentPeerRef.current = peer;

      let timeout: NodeJS.Timeout | null = null;
      let isResolved = false;

      peer.on('open', () => {
          const hostId = `steezyfm-${channel.toString().replace('.', '-')}`;
          const conn = peer.connect(hostId, { reliable: true });
          
          timeout = setTimeout(() => {
              if (isResolved) return;
              isResolved = true;
              setMode(prev => prev !== 'host' ? 'locked_empty' : prev);
              if(synthRef.current) synthRef.current.setTuning(false, 1.0);
          }, 8000);

          conn.on('open', () => {
              if (isResolved) return;
              isResolved = true;
              if(timeout) clearTimeout(timeout);
              setMode('locked_rx');
              if(synthRef.current) synthRef.current.setTuning(false, 0);
          });

          conn.on('data', (data: any) => {
             if(data.type === 'now_playing') setNowPlaying(data.title);
          });
          
          conn.on('close', () => {
             setMode('locked_empty');
             if(synthRef.current) synthRef.current.setTuning(false, 1.0);
          });
      });

      peer.on('call', (call) => {
         call.answer();
         call.on('stream', (stream) => {
            if(audioRef.current) {
                audioRef.current.srcObject = stream;
                audioRef.current.play().catch(e => console.log('Autoplay blocked', e));
            }
         });
      });

      peer.on('error', (err) => {
         if (err.type === 'peer-unavailable') {
             if (isResolved) return;
             isResolved = true;
             if(timeout) clearTimeout(timeout);
             setMode('locked_empty');
             if(synthRef.current) synthRef.current.setTuning(false, 1.0);
         }
      });

      peer.on('disconnected', () => {
         peer.reconnect();
      });
  }, [disconnectNetwork]);

  useEffect(() => {
      if(!power) return;
      if(activeChannel !== null) {
          attemptRx(activeChannel);
      } else {
          disconnectNetwork();
          setMode('tuning');
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannel, power]);

  const setupHostAudioContext = () => {
    if (!audioCtxRef.current && audioRef.current) {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      
      const source = ctx.createMediaElementSource(audioRef.current);
      const dest = ctx.createMediaStreamDestination();
      streamDestRef.current = dest;
      
      source.connect(dest);
      source.connect(ctx.destination);
    }
  };

  const hostStation = () => {
    if(!activeChannel) return;
    setMode('tuning');
    disconnectNetwork();

    const peerId = `steezyfm-${activeChannel.toString().replace('.', '-')}`;
    const peer = new Peer(peerId, PEER_CONFIG);
    currentPeerRef.current = peer;

    peer.on('open', () => {
        setMode('host');
        setupHostAudioContext();
        if(synthRef.current) synthRef.current.setTuning(false, 0);
    });

    peer.on('error', (err) => {
        console.error('Peer error in Host:', err.type, err);
        if(err.type === 'unavailable-id') {
            attemptRx(activeChannel);
        } else {
            setMode('locked_empty');
        }
    });

    peer.on('disconnected', () => {
        peer.reconnect();
    });

    peer.on('connection', (conn) => {
        setPeerConnections(prev => [...prev, conn]);
        conn.on('open', () => {
            if (currentTrackRef.current >= 0 && playlistRef.current[currentTrackRef.current]) {
               conn.send({ type: 'now_playing', title: playlistRef.current[currentTrackRef.current].name });
            }
            if(streamDestRef.current) {
               const call = peer.call(conn.peer, streamDestRef.current.stream);
               activeCallsRef.current.push(call);
            }
        });
        conn.on('close', () => {
            setPeerConnections(prev => prev.filter(c => c.peer !== conn.peer));
        });
    });
  };

  // Knob Controls
  const getAngle = (e: React.PointerEvent) => {
      if(!knobRef.current) return 0;
      const rect = knobRef.current.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      return Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
  };

  const onPointerDown = (e: React.PointerEvent) => {
      initAudio();
      isDragging.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      lastAngle.current = getAngle(e);
      velocity.current = 0;
      if(activeChannel !== null) setActiveChannel(null);
  };
  
  const onPointerMove = (e: React.PointerEvent) => {
      if(!isDragging.current || !power) return;
      const newAngle = getAngle(e);
      let delta = newAngle - lastAngle.current;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      lastAngle.current = newAngle;
      
      velocity.current = delta * 0.02; 
      
      setKnobRot(prev => prev + delta);
      currentFreqRef.current += velocity.current;
      if (currentFreqRef.current < MIN_FREQ) {
          currentFreqRef.current = MIN_FREQ;
          velocity.current = 0;
      }
      if (currentFreqRef.current > MAX_FREQ) {
          currentFreqRef.current = MAX_FREQ;
          velocity.current = 0;
      }
      setFrequency(Math.round(currentFreqRef.current * 10) / 10);
  };

  const onPointerUp = (e: React.PointerEvent) => {
      isDragging.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  // Transport
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (mode !== 'host') return;
    if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();

    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('audio/'));
    const newTracks = files.map(f => ({
      id: Math.random().toString(36).substr(2, 9),
      file: f,
      name: f.name.replace(/\.[^/.]+$/, ""),
      url: URL.createObjectURL(f)
    }));

    setPlaylist(prev => [...prev, ...newTracks]);
  }, [mode]);

  const broadcastState = (type: string, title: string) => {
    peerConnections.forEach(conn => {
      if (conn.open) conn.send({ type, title });
    });
  };

  const playTrack = (index: number) => {
    if (index >= 0 && index < playlist.length && audioRef.current) {
        if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
        audioRef.current.srcObject = null;
        audioRef.current.src = playlist[index].url;
        audioRef.current.play().then(() => {
            setIsPlaying(true);
            setCurrentTrackIndex(index);
            broadcastState('now_playing', playlist[index].name);
            
            if (currentPeerRef.current && streamDestRef.current) {
               activeCallsRef.current.forEach(c => c.close());
               activeCallsRef.current = [];
               peerConnections.forEach(conn => {
                   if (currentPeerRef.current) {
                       const call = currentPeerRef.current.call(conn.peer, streamDestRef.current.stream);
                       activeCallsRef.current.push(call);
                   }
               });
            }
        }).catch(console.error);
    }
  };

  const togglePlayMode = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
      broadcastState('now_playing', 'Paused');
    } else {
      if (currentTrackIndex === -1 && playlist.length > 0) playTrack(0);
      else {
        audioRef.current.play();
        setIsPlaying(true);
        broadcastState('now_playing', playlist[currentTrackIndex]?.name || 'Playing...');
      }
    }
  };

  const skipForward = () => {
    if (currentTrackIndex < playlist.length - 1) playTrack(currentTrackIndex + 1);
    else {
      if (audioRef.current) audioRef.current.pause();
      setIsPlaying(false);
      setCurrentTrackIndex(-1);
      broadcastState('now_playing', 'Station Idle');
    }
  };

  return (
    <div 
      className="w-full min-h-[100dvh] bg-zinc-400 text-zinc-800 flex flex-col p-4 md:p-8 selection:bg-amber-500 selection:text-white overflow-y-auto overflow-x-hidden relative"
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={handleDrop}
    >
      <audio ref={audioRef} onEnded={skipForward} className="hidden" crossOrigin="anonymous" />
      
      {/* Background Ambience */}
      <div className="absolute inset-0 pointer-events-none opacity-20 mix-blend-overlay bg-[repeating-linear-gradient(transparent,transparent_2px,#fff_2px,#fff_4px)]"></div>

      <div className="flex flex-col md:flex-row gap-4 md:gap-8 w-full max-w-5xl m-auto relative z-10 bg-zinc-200 p-4 md:p-8 rounded-xl shadow-2xl border-t border-l border-white/60 border-b-zinc-400 border-r-zinc-400 mb-8 md:mb-auto">
         
         {/* Main Interface */}
         <div className="flex-1 flex flex-col gap-6 order-2 md:order-1">
            
            {/* LCD Header */}
            <div className="bg-zinc-800 border-4 border-zinc-900 border-b-zinc-700/50 p-4 shrink-0 md:p-6 rounded-md shadow-[inset_0_0_30px_rgba(0,0,0,0.8)] flex flex-col justify-between h-32 md:h-48 relative overflow-hidden font-mono">
                <div className="absolute inset-0 pointer-events-none opacity-10 bg-[radial-gradient(ellipse_at_center,rgba(245,158,11,0.2)_0%,transparent_100%)]"></div>
                
                <div className="flex justify-between items-start text-amber-500/50 text-[9px] md:text-[10px] uppercase tracking-widest relative z-10">
                    <span>{CHANNELS.includes(frequency) && mode !== 'tuning' ? 'CHANNEL LOCKED' : 'FREE TUNING'}</span>
                    <span className={power && mode === 'host' ? 'text-red-500 font-bold animate-pulse' : ''}>
                        {power ? (activeChannel ? 'SYS: ONLINE' : 'SYS: SCANNING') : 'SYS: OFFLINE'}
                    </span>
                </div>

                <div className={`text-center font-bold text-5xl md:text-[5rem] leading-none tracking-widest flex items-baseline justify-center gap-2 md:gap-4 transition-colors duration-500 relative z-10 ${power ? 'text-amber-500 drop-shadow-[0_0_12px_rgba(245,158,11,0.7)]' : 'text-zinc-900 drop-shadow-none'}`}>
                    {power ? frequency.toFixed(1) : '--.-'}
                    <span className="text-xl md:text-2xl opacity-50">MHz</span>
                </div>

                <div className="flex justify-between items-end text-amber-500/70 text-[9px] md:text-[10px] uppercase font-bold tracking-widest relative z-10">
                    <span className={mode === 'locked_rx' ? 'opacity-100 text-amber-500 drop-shadow-[0_0_5px_rgba(245,158,11,0.5)]' : ''}>RX: {mode === 'locked_rx' ? 'OK' : 'WAIT'}</span>
                    <span className={mode === 'host' ? 'opacity-100 text-red-500 drop-shadow-[0_0_5px_rgba(239,68,68,0.5)]' : ''}>TX: {mode === 'host' ? 'ON AIR' : mode === 'locked_empty' ? 'READY' : 'WAIT'}</span>
                </div>
            </div>

            {/* Tuning Dial Strip */}
            <div className={`h-16 md:h-24 shrink-0 w-full border border-zinc-900 bg-zinc-800 rounded-sm shadow-inner relative overflow-hidden transition-opacity duration-1000 ${power ? 'opacity-100' : 'opacity-30'} font-mono`}>
                <div className="absolute left-1/2 top-0 bottom-0 w-[2px] bg-red-500 shadow-[0_0_8px_red] z-20"></div>
                <div className="absolute top-0 bottom-0 pointer-events-none" style={{
                    left: `calc(50% - ${(frequency - MIN_FREQ) * 200}px)`,
                    width: `${(MAX_FREQ - MIN_FREQ) * 200}px`,
                    background: 'repeating-linear-gradient(to right, transparent, transparent 19px, rgba(255,255,255,0.05) 19px, rgba(255,255,255,0.05) 20px)',
                    transition: isDragging.current ? 'none' : 'left 0.1s linear'
                }}>
                    {CHANNELS.map(ch => (
                         <div key={ch} className="absolute flex flex-col items-center -translate-x-1/2 h-full justify-end pb-2" style={{
                             left: `${(ch - MIN_FREQ) * 200}px`
                         }}>
                             <div className="w-[3px] h-8 bg-zinc-500 shadow-[0_0_4px_rgba(255,255,255,0.2)]"></div>
                             <span className="text-[12px] mt-1 font-bold text-zinc-400">{ch}</span>
                         </div>
                     ))}
                </div>
            </div>
            
            {/* Dynamic Status / Host Area */}
            <div className="flex-1 border-t-2 border-l-2 border-white/60 border-b-2 border-r-2 border-zinc-400 p-1 bg-zinc-300 min-h-[160px] md:min-h-[220px] shrink-0 rounded text-zinc-800 font-mono">
                <div className="h-full border border-black/10 p-4 flex flex-col rounded bg-zinc-200">
                    {!power ? (
                        <div className="flex-1 flex items-center justify-center opacity-40 text-xs tracking-widest font-bold">AWAITING POWER</div>
                    ) : mode === 'tuning' ? (
                        <div className="flex-1 flex flex-col items-center justify-center opacity-60 text-xs tracking-widest gap-4 font-bold">
                            <div className="w-8 h-8 border-4 border-zinc-500 border-t-transparent rounded-full animate-spin"></div>
                            SCANNING SECTOR
                        </div>
                    ) : mode === 'locked_rx' ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-center">
                            <Music size={40} className="text-zinc-600 animate-pulse mb-6 drop-shadow-sm"/>
                            <span className="text-[10px] uppercase opacity-70 mb-2 tracking-widest font-bold">RECEIVING TRANSMISSION</span>
                            <span className="text-xl font-black truncate max-w-full px-4 text-zinc-900 bg-black/5 p-2 rounded">{nowPlaying || 'STATION LIVE'}</span>
                        </div>
                    ) : mode === 'locked_empty' ? (
                        <div className="flex-1 flex flex-col items-center justify-center gap-8">
                            <span className="text-sm uppercase opacity-70 tracking-widest font-bold">FREQUENCY AVAILABLE</span>
                            <button 
                               onClick={hostStation} 
                               className="px-8 py-4 border-2 border-zinc-400 hover:bg-zinc-800 hover:text-white hover:border-zinc-800 font-black tracking-widest text-sm transition-all shadow-sm active:scale-95 rounded bg-zinc-100"
                            >
                                COMMENCE BROADCAST
                            </button>
                        </div>
                    ) : mode === 'host' && (
                        <div className="flex flex-col md:flex-row w-full h-full gap-2 md:gap-4">
                            <div className="flex-1 border-2 border-zinc-300 flex flex-col min-h-[150px] bg-zinc-100 relative rounded">
                               <div className="p-2 border-b-2 border-zinc-300 text-[9px] uppercase opacity-70 font-bold">
                                  PLAYLIST QUEUE // DROP MP3
                               </div>
                               <div className="flex-1 overflow-y-auto w-full absolute top-[33px] bottom-0 left-0 right-0">
                                   {playlist.length === 0 ? (
                                       <div className="h-full flex flex-col items-center justify-center text-[10px] uppercase opacity-50 border-2 border-dashed border-zinc-400 m-2 text-center p-4 rounded font-bold">
                                          <UploadCloud size={32} className="mb-2"/>
                                          DRAG & DROP LOCAL MP3<br/>TO QUEUE TX
                                       </div>
                                   ) : (
                                       <div className="pb-2">
                                           {playlist.map((track, i) => (
                                               <div 
                                                 key={track.id}
                                                 onClick={() => playTrack(i)}
                                                 className={`px-3 py-2 border-b border-zinc-200 text-xs truncate cursor-pointer hover:bg-zinc-200 transition-colors ${currentTrackIndex === i ? 'bg-zinc-800 text-white font-bold' : 'text-zinc-600 font-bold'}`}
                                               >
                                                  {i + 1}. {track.name}
                                               </div>
                                           ))}
                                       </div>
                                   )}
                               </div>
                            </div>
                             <div className="w-full md:w-32 flex flex-row md:flex-col justify-between shrink-0 gap-2">
                                 <div className="border border-zinc-300 p-2 md:p-4 bg-zinc-100 flex flex-col gap-1 md:gap-2 flex-1 md:flex-none rounded text-center">
                                    <span className="text-[9px] uppercase opacity-70 font-bold">CONNECTIONS</span>
                                    <div className="text-xl md:text-3xl font-black text-zinc-800">
                                        {peerConnections.length}
                                    </div>
                                 </div>
                                 <div className="flex flex-row md:flex-col gap-2 flex-1 md:flex-none">
                                    <button onClick={togglePlayMode} className="w-full py-2 md:py-4 flex items-center justify-center border border-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors bg-zinc-100 rounded shadow-sm flex-1 md:flex-none">
                                         {isPlaying ? <Pause size={20}/> : <Play size={20}/>}
                                    </button>
                                    <button onClick={skipForward} className="w-full py-2 md:py-4 flex items-center justify-center border border-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors bg-zinc-100 rounded shadow-sm flex-1 md:flex-none">
                                         <SkipForward size={20}/>
                                    </button>
                                 </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

         </div>

         {/* Hardware Controls */}
         <div className="w-full md:w-64 flex flex-row md:flex-col gap-4 md:gap-6 shrink-0 justify-between font-sans order-1 md:order-2">
            
            <div className="border-t-2 border-l-2 border-white/60 border-b-2 border-r-2 border-zinc-400 p-4 md:p-6 flex flex-col items-center gap-4 md:gap-10 bg-zinc-200 flex-1 justify-center relative touch-none pointer-events-auto select-none rounded box-border shadow-inner"
               onPointerDown={(e) => {
                 if(power && e.target === e.currentTarget && knobRef.current) {
                      onPointerDown(e);
                 }
               }}
            >
                <span className="text-[9px] md:text-[10px] uppercase tracking-widest opacity-60 font-bold w-full text-center border-b border-black/10 pb-2 pointer-events-none text-zinc-800">MAIN TUNING</span>
                <div 
                   ref={knobRef}
                   className="w-28 h-28 md:w-40 md:h-40 shrink-0 rounded-full border border-zinc-300 shadow-[0_15px_30px_rgba(0,0,0,0.4),0_8px_10px_rgba(0,0,0,0.2),inset_0_2px_5px_rgba(255,255,255,0.8),inset_0_-2px_10px_rgba(0,0,0,0.1)] relative bg-gradient-to-br from-zinc-100 to-zinc-400 cursor-grab active:cursor-grabbing flex items-center justify-center touch-none group"
                   onPointerDown={onPointerDown}
                   onPointerMove={onPointerMove}
                   onPointerUp={onPointerUp}
                   onPointerCancel={onPointerUp}
                >
                    <div className="absolute inset-2 rounded-full border border-zinc-300 bg-gradient-to-tl from-zinc-200 to-zinc-300 shadow-inner"></div>
                    <div className="absolute inset-x-6 inset-y-6 md:inset-x-8 md:inset-y-8 rounded-full border border-zinc-400 bg-gradient-to-br from-zinc-100 to-zinc-300 shadow-[inset_0_2px_5px_rgba(255,255,255,0.7)]"></div>
                    <div className="w-full h-full rounded-full relative z-10 transition-transform duration-75 pointer-events-none" style={{ transform: `rotate(${knobRot}deg)` }}>
                        <div className={`absolute top-2 md:top-3 left-1/2 -translate-x-1/2 w-2 h-6 md:w-3 md:h-8 rounded-full shadow-inner transition-colors border border-black/10 ${power ? 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]' : 'bg-red-800 shadow-[inset_0_2px_5px_rgba(0,0,0,0.4)]'}`}></div>
                    </div>
                </div>
                <span className="text-[8px] md:text-[9px] uppercase tracking-widest font-bold opacity-50 pointer-events-none text-zinc-800">DRAG TO TUNE</span>
            </div>

            <div className="border-t-2 border-l-2 border-white/60 border-b-2 border-r-2 border-zinc-400 rounded p-4 md:p-6 flex flex-col items-center gap-4 md:gap-6 bg-zinc-200 shadow-inner flex-1 md:flex-none justify-center">
                <span className="text-[9px] md:text-[10px] uppercase tracking-widest font-bold opacity-60 w-full text-center border-b border-black/10 pb-2 text-zinc-800">SYSTEM POWER</span>
                <button 
                   onClick={togglePower}
                   className={`w-16 h-16 md:w-20 md:h-20 rounded-full border-2 flex items-center justify-center transition-all duration-300 shrink-0 ${power ? 'border-red-500 bg-red-100 text-red-600 shadow-[0_0_20px_rgba(239,68,68,0.4),inset_0_3px_10px_rgba(255,255,255,0.9)] hover:shadow-[0_0_30px_rgba(239,68,68,0.6)]' : 'border-zinc-300 bg-zinc-300 text-zinc-500 shadow-[2px_5px_10px_rgba(0,0,0,0.2),inset_0_3px_10px_rgba(255,255,255,0.9)] hover:bg-zinc-200'}`}
                >
                    <Power className="w-8 h-8 md:w-auto md:h-auto" />
                </button>
            </div>

         </div>
      </div>
    </div>
  );
}
