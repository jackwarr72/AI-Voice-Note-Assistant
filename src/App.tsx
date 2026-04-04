import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, 
  Square, 
  Play, 
  Trash2, 
  Download, 
  LogOut, 
  LogIn, 
  Loader2, 
  FileAudio, 
  ChevronRight, 
  CheckCircle2, 
  MessageSquare, 
  ListTodo, 
  HelpCircle,
  History,
  Plus,
  Check,
  CheckCheck,
  Send,
  RefreshCw
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  signInWithPopup, 
  onAuthStateChanged, 
  signOut, 
  User 
} from 'firebase/auth';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  addDoc, 
  deleteDoc, 
  doc, 
  setDoc,
  getDoc,
  getDocs
} from 'firebase/firestore';
import { auth, db, googleProvider } from './firebase';
import { VoiceNote, AudioInsights } from './types';
import { processAudioWithGemini } from './lib/gemini';
import { cn } from './lib/utils';
import { ErrorBoundary } from './components/ErrorBoundary';

// --- Components ---

const Button = ({ 
  children, 
  onClick, 
  variant = 'primary', 
  className, 
  disabled, 
  loading 
}: { 
  children: React.ReactNode; 
  onClick?: () => void; 
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline'; 
  className?: string; 
  disabled?: boolean;
  loading?: boolean;
}) => {
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm',
    secondary: 'bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 shadow-sm',
    danger: 'bg-red-500 text-white hover:bg-red-600 shadow-sm',
    ghost: 'bg-transparent text-gray-600 hover:bg-gray-100',
    outline: 'bg-transparent text-indigo-600 border border-indigo-600 hover:bg-indigo-50'
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center px-4 py-2 rounded-lg font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        className
      )}
    >
      {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
      {children}
    </button>
  );
};

const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cn('bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden', className)}>
    {children}
  </div>
);

const Tooltip = ({ children, text }: { children: React.ReactNode; text: string }) => {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="relative inline-block" onMouseEnter={() => setIsVisible(true)} onMouseLeave={() => setIsVisible(false)}>
      {children}
      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, y: 5, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 5, scale: 0.95 }}
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-gray-900 text-white text-[10px] font-medium rounded whitespace-nowrap z-50 pointer-events-none shadow-lg"
          >
            {text}
            <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-gray-900" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// --- Error Handling ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Main App ---

import { io, Socket } from "socket.io-client";

// ... existing types ...

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [processingCount, setProcessingCount] = useState(0);
  const [processingMessage, setProcessingMessage] = useState('Analyzing with Gemini...');
  const [socketStatus, setSocketStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const processingQueue = useRef<Set<string>>(new Set());
  const [selectedNote, setSelectedNote] = useState<VoiceNote | null>(null);
  
  const isProcessing = processingCount > 0;
  // WhatsApp State
  const [whatsappStatus, setWhatsappStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [whatsappQR, setWhatsappQR] = useState<string | null>(null);
  const [sentMessages, setSentMessages] = useState<{ [id: string]: { status: number, text: string } }>({});
  const socketRef = useRef<Socket | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const noteRefs = useRef<{ [key: string]: HTMLButtonElement | null }>({});

  // WhatsApp Socket Connection
  useEffect(() => {
    if (!user) return;

    const socket = io({
      transports: ["polling", "websocket"],
      reconnectionAttempts: Infinity,
      timeout: 30000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Socket connected:', socket.id);
      setSocketStatus('connected');
      setError(null); // Clear any previous socket errors
      socket.emit('ping');
      if (user) {
        socket.emit('init-whatsapp', user.uid);
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
      setSocketStatus('disconnected');
    });

    socket.on('pong', () => {
      console.log('Socket pong received');
    });

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err);
      setSocketStatus('disconnected');
      if (err.message === 'timeout') {
        setError('Connection timed out. Retrying...');
      } else {
        setError(`Socket error: ${err.message}`);
      }
    });

    socket.on('whatsapp-qr', (qr: string) => {
      setWhatsappQR(qr);
      setWhatsappStatus('disconnected');
    });

    socket.on('whatsapp-status', (status: 'connected' | 'disconnected') => {
      setWhatsappStatus(status === 'connected' ? 'connected' : 'disconnected');
      if (status === 'connected') setWhatsappQR(null);
    });

    socket.on('whatsapp-message-sent', (data: { success: boolean, id: string, text: string }) => {
      if (data.success) {
        setSentMessages(prev => ({ ...prev, [data.id]: { status: 1, text: data.text } }));
      }
    });

    socket.on('whatsapp-message-update', (data: { id: string, status: number }) => {
      setSentMessages(prev => {
        if (prev[data.id]) {
          return { ...prev, [data.id]: { ...prev[data.id], status: data.status } };
        }
        return prev;
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [user]);

  // Pending Transcriptions Listener (Automation)
  useEffect(() => {
    if (!user) return;

    const path = 'pending_transcriptions';
    const q = query(
      collection(db, path),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      console.log(`Pending transcriptions snapshot received. Count: ${snapshot.size}`);
      for (const docChange of snapshot.docChanges()) {
        if (docChange.type === 'added') {
          const data = docChange.doc.data();
          const docId = docChange.doc.id;
          
          if (processingQueue.current.has(docId)) continue;
          
          console.log(`Processing new pending transcription: ${docId}`);
          processingQueue.current.add(docId);
          setProcessingCount(prev => prev + 1);
          // Process automatically
          processPendingTranscription(docId, data.audioBase64, data.mimeType, data.filename, data.remoteJid)
            .finally(() => setProcessingCount(prev => Math.max(0, prev - 1)));
        }
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    });

    return () => unsubscribe();
  }, [user]);

  const processPendingTranscription = async (docId: string, base64: string, mimeType: string, filename: string, remoteJid?: string) => {
    if (!user) return;
    
    try {
      console.log(`Calling Gemini for transcription: ${docId}`);
      // Call Gemini
      const result = await processAudioWithGemini(base64, mimeType);
      
      console.log(`Gemini transcription successful for ${docId}, saving to voice_notes...`);
      // Save to Voice Notes
      const path = 'voice_notes';
      try {
        await addDoc(collection(db, path), {
          userId: user.uid,
          remoteJid: remoteJid || null,
          filename: filename,
          transcript: result.transcript,
          insights: result.insights,
          createdAt: new Date().toISOString()
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, path);
      }

      console.log(`Deleting pending transcription: ${docId}`);
      // Delete from Pending
      const pendingPath = 'pending_transcriptions';
      try {
        await deleteDoc(doc(db, pendingPath, docId));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, pendingPath);
      }
      processingQueue.current.delete(docId);
    } catch (error) {
      console.error('Error processing pending transcription:', error);
      processingQueue.current.delete(docId);
    }
  };

  const sendToWhatsApp = (text: string) => {
    if (!user || !selectedNote?.remoteJid || !socketRef.current) return;
    
    socketRef.current.emit('send-whatsapp-message', {
      userId: user.uid,
      remoteJid: selectedNote.remoteJid,
      text
    });
  };

  const reconnectWhatsApp = () => {
    if (user && socketRef.current) {
      setWhatsappQR(null);
      setWhatsappStatus('connecting');
      socketRef.current.emit('init-whatsapp', user.uid);
    }
  };

  const resetWhatsApp = () => {
    if (user && socketRef.current) {
      setWhatsappQR(null);
      setWhatsappStatus('disconnected');
      socketRef.current.emit('reset-whatsapp', user.uid);
    }
  };

  const manualSync = async () => {
    if (!user) return;
    setProcessingMessage('Syncing WhatsApp notes...');
    const path = 'pending_transcriptions';
    try {
      const q = query(
        collection(db, path),
        where('userId', '==', user.uid)
      );
      const snapshot = await getDocs(q);
      console.log(`Manual sync found ${snapshot.size} pending transcriptions`);
      
      if (snapshot.size === 0) {
        setNotification({ message: 'No pending transcriptions found.', type: 'success' });
        return;
      }

      for (const docSnap of snapshot.docs) {
        const data = docSnap.data();
        if (processingQueue.current.has(docSnap.id)) continue;
        processingQueue.current.add(docSnap.id);
        setProcessingCount(prev => prev + 1);
        processPendingTranscription(docSnap.id, data.audioBase64, data.mimeType, data.filename, data.remoteJid)
          .finally(() => setProcessingCount(prev => Math.max(0, prev - 1)));
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }
  };

  // Scroll to selected note
  useEffect(() => {
    if (selectedNote && noteRefs.current[selectedNote.id]) {
      noteRefs.current[selectedNote.id]?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [selectedNote]);

  // Clear notification after 5 seconds
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // Dynamic Loading Messages
  useEffect(() => {
    if (isProcessing) {
      const messages = [
        'Uploading audio...',
        'Transcribing voice note...',
        'Extracting key insights...',
        'Generating suggested replies...',
        'Finalizing analysis...'
      ];
      let i = 0;
      const interval = setInterval(() => {
        setProcessingMessage(messages[i % messages.length]);
        i++;
      }, 3000);
      return () => clearInterval(interval);
    } else {
      setProcessingMessage('Analyzing with Gemini...');
    }
  }, [isProcessing]);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setLoading(false);
      
      if (u) {
        // Ensure user profile exists in Firestore
        const path = `users/${u.uid}`;
        try {
          const userRef = doc(db, path);
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
            await setDoc(userRef, {
              uid: u.uid,
              email: u.email || '',
              displayName: u.displayName || 'Anonymous',
              photoURL: u.photoURL || '',
              role: 'user'
            });
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, path);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Firestore Listener
  useEffect(() => {
    if (!user) {
      setVoiceNotes([]);
      return;
    }

    const path = 'voice_notes';
    const q = query(
      collection(db, path),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const notes = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as VoiceNote));
      
      // Sort in memory to avoid the need for a composite index (userId + createdAt)
      notes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      
      setVoiceNotes(notes);
      setLoading(false);
      setError(null);
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    });

    return () => unsubscribe();
  }, [user]);

  // Recording Timer
  useEffect(() => {
    if (isRecording) {
      timerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setRecordingTime(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setSelectedNote(null);
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await processAudio(audioBlob, `Recording ${new Date().toLocaleString()}`);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting recording:', error);
      setNotification({ message: 'Could not access microphone. Please check permissions.', type: 'error' });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('audio/')) {
        setNotification({ message: 'Please upload an audio file.', type: 'error' });
        return;
      }
      processAudio(file, file.name);
    }
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const processAudio = async (blob: Blob, filename: string) => {
    if (!user) return;
    setProcessingCount(prev => prev + 1);
    
    try {
      // Convert blob to base64
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        try {
          const base64Audio = (reader.result as string).split(',')[1];
          
          // Call Gemini
          const result = await processAudioWithGemini(base64Audio, blob.type);
          
          // Save to Firestore
          const path = 'voice_notes';
          try {
            await addDoc(collection(db, path), {
              userId: user.uid,
              filename: filename,
              transcript: result.transcript,
              insights: result.insights,
              createdAt: new Date().toISOString()
            });
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, path);
          }
        } catch (error) {
          console.error('Error in processAudio inner:', error);
          setNotification({ message: 'Failed to process audio. Please try again.', type: 'error' });
        } finally {
          setProcessingCount(prev => Math.max(0, prev - 1));
        }
      };
    } catch (error) {
      console.error('Error processing audio:', error);
      setProcessingCount(prev => Math.max(0, prev - 1));
      setNotification({ message: 'Failed to process audio. Please try again.', type: 'error' });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Optional: Add a temporary toast or visual feedback
  };

  const deleteNote = async (id: string) => {
    const path = `voice_notes/${id}`;
    try {
      await deleteDoc(doc(db, path));
      if (selectedNote?.id === id) setSelectedNote(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, path);
    }
  };

  const exportToCSV = () => {
    if (voiceNotes.length === 0) return;
    
    const headers = ['ID', 'Filename', 'Created At', 'Transcript', 'Summary', 'Key Points', 'Questions', 'Suggested Replies'];
    const rows = voiceNotes.map(note => [
      note.id,
      note.filename,
      note.createdAt,
      `"${note.transcript.replace(/"/g, '""')}"`,
      `"${note.insights.summary.replace(/"/g, '""')}"`,
      `"${note.insights.key_points.join(' | ').replace(/"/g, '""')}"`,
      `"${note.insights.questions.join(' | ').replace(/"/g, '""')}"`,
      `"${note.insights.suggested_replies.join(' | ').replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers, ...rows].map(e => e.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `voice_notes_export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-6">
        <div className="max-w-md w-full text-center space-y-8">
          <div className="flex justify-center">
            <div className="p-4 bg-indigo-100 rounded-2xl">
              <Mic className="w-12 h-12 text-indigo-600" />
            </div>
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-bold text-gray-900 tracking-tight">AI Voice Assistant</h1>
            <p className="text-gray-600 text-lg">
              Transcribe and analyze your voice notes with the power of Gemini AI.
            </p>
          </div>
          <Button onClick={handleLogin} className="w-full py-4 text-lg" variant="primary">
            <LogIn className="w-5 h-5 mr-2" />
            Sign in with Google
          </Button>
          <p className="text-xs text-gray-400">
            Securely store and manage your voice insights in the cloud.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Notifications */}
      <AnimatePresence>
        {notification && (
          <motion.div
            initial={{ opacity: 0, y: -50 }}
            animate={{ opacity: 1, y: 20 }}
            exit={{ opacity: 0, y: -50 }}
            className={cn(
              "fixed top-0 left-1/2 -translate-x-1/2 z-50 px-6 py-3 rounded-full shadow-lg flex items-center space-x-2 text-sm font-medium",
              notification.type === 'success' ? "bg-green-600 text-white" : "bg-red-600 text-white"
            )}
          >
            {notification.type === 'success' ? <Check className="w-4 h-4" /> : <HelpCircle className="w-4 h-4" />}
            <span>{notification.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="p-2 bg-indigo-600 rounded-lg">
              <Mic className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-xl text-gray-900 hidden sm:block">AI Voice Note Assistant</span>
          </div>
          
          <div className="flex items-center space-x-4">
            <div className={cn(
              "w-2 h-2 rounded-full",
              socketStatus === 'connected' ? "bg-green-500" : "bg-red-500"
            )} title={socketStatus === 'connected' ? "Socket Connected" : "Socket Disconnected"} />
            
            <Tooltip text="Download history as CSV">
              <Button variant="ghost" onClick={exportToCSV} disabled={voiceNotes.length === 0} className="hidden sm:flex">
                <Download className="w-4 h-4 mr-2" />
                Export CSV
              </Button>
            </Tooltip>
            <div className="h-8 w-px bg-gray-200 hidden sm:block"></div>
            <div className="flex items-center space-x-3">
              <img src={user.photoURL || ''} alt="" className="w-8 h-8 rounded-full border border-gray-200" />
              <Tooltip text="Sign out">
                <Button variant="ghost" onClick={handleLogout} className="p-2">
                  <LogOut className="w-5 h-5" />
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>
      </header>

      {error && (
        <div className="bg-red-50 border-b border-red-100 p-3">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center space-x-3 text-sm text-red-600">
            <HelpCircle className="w-4 h-4 shrink-0" />
            <p className="font-medium">{error}</p>
          </div>
        </div>
      )}

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col lg:flex-row gap-8">
        {/* Left Column: Recording & List */}
        <div className="w-full lg:w-1/3 flex flex-col gap-6">
          {/* Recording Card */}
          <Card className="p-6 bg-indigo-600 text-white border-none shadow-lg shadow-indigo-200">
            <h2 className="text-lg font-semibold mb-4 flex items-center">
              <Plus className="w-5 h-5 mr-2" />
              New Voice Note
            </h2>
            
            <div className="flex flex-col items-center justify-center py-8 space-y-6">
              <div className="relative">
                {isRecording && (
                  <motion.div
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1.5, opacity: 0.3 }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="absolute inset-0 bg-white rounded-full"
                  />
                )}
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  disabled={isProcessing}
                  className={cn(
                    "relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 shadow-xl",
                    isRecording ? "bg-white text-red-600" : "bg-white text-indigo-600 hover:scale-105",
                    isProcessing && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {isProcessing ? (
                    <Loader2 className="w-10 h-10 animate-spin" />
                  ) : isRecording ? (
                    <Square className="w-8 h-8 fill-current" />
                  ) : (
                    <Mic className="w-10 h-10" />
                  )}
                </button>
              </div>
              
              <div className="text-center">
                <p className="text-2xl font-mono font-bold tracking-wider">
                  {formatTime(recordingTime)}
                </p>
                <p className="text-indigo-100 text-sm mt-1">
                  {isProcessing ? processingMessage : isRecording ? 'Recording...' : 'Tap to start recording'}
                </p>
              </div>

              <div className="w-full pt-4 border-t border-indigo-500/30">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  accept="audio/*"
                  className="hidden"
                />
                <Tooltip text="Analyze an existing audio file">
                  <Button 
                    variant="secondary" 
                    className="w-full bg-indigo-500/20 border-indigo-400/30 text-white hover:bg-indigo-500/40"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isRecording || isProcessing}
                  >
                    <Download className="w-4 h-4 mr-2 rotate-180" />
                    Upload Audio File
                  </Button>
                </Tooltip>
              </div>
            </div>
          </Card>

  // WhatsApp Sync Section
  <Card className="p-4 bg-indigo-900 text-white border-none shadow-lg">
    <div className="flex items-center justify-between mb-4">
      <div className="flex flex-col">
        <h3 className="text-xs font-bold uppercase tracking-wider opacity-80">WhatsApp Sync</h3>
        <div className="flex items-center mt-1">
          <div className={cn(
            "w-2 h-2 rounded-full mr-1.5",
            whatsappStatus === 'connected' ? "bg-green-400 animate-pulse" : (whatsappStatus === 'connecting' ? "bg-yellow-400 animate-pulse" : "bg-red-400")
          )} />
          <span className="text-[10px] uppercase font-medium">
            {whatsappStatus}
          </span>
        </div>
      </div>
      <MessageSquare className="w-5 h-5 opacity-50" />
    </div>

    {whatsappStatus !== 'connected' && (
      <div className="space-y-3">
        {whatsappStatus === 'connecting' ? (
          <div className="py-8 text-center bg-white/10 rounded-lg">
            <Loader2 className="w-8 h-8 animate-spin mx-auto text-indigo-200" />
            <p className="text-[10px] text-indigo-200 mt-3 font-medium">Establishing secure connection...</p>
          </div>
        ) : whatsappQR ? (
          <div className="bg-white p-2 rounded-lg flex flex-col items-center">
            <img src={whatsappQR} alt="WhatsApp QR Code" className="w-32 h-32" />
            <p className="text-[10px] text-gray-500 mt-2 text-center font-medium">
              Scan with WhatsApp to link your account
            </p>
            <button 
              onClick={reconnectWhatsApp}
              className="mt-2 text-[10px] text-indigo-600 font-bold hover:underline"
            >
              Refresh QR
            </button>
          </div>
        ) : (
          <div className="py-4 text-center">
            <Loader2 className="w-6 h-6 animate-spin mx-auto opacity-50" />
            <p className="text-[10px] opacity-50 mt-2">Generating QR Code...</p>
            <button 
              onClick={reconnectWhatsApp}
              className="mt-2 text-[10px] text-indigo-300 font-bold hover:underline"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    )}

            {whatsappStatus === 'connected' && (
              <div className="space-y-3">
                <p className="text-xs opacity-70 leading-relaxed">
                  Your account is linked. New voice notes will be automatically transcribed and analyzed.
                </p>
                <div className="flex items-center space-x-3">
                  <button 
                    onClick={manualSync}
                    disabled={isProcessing}
                    className="text-[10px] text-indigo-300 font-bold hover:underline flex items-center disabled:opacity-50"
                  >
                    <RefreshCw className={cn("w-3 h-3 mr-1", isProcessing && "animate-spin")} />
                    Sync Now
                  </button>
                  <button 
                    onClick={resetWhatsApp}
                    className="text-[10px] text-red-300 font-bold hover:underline"
                  >
                    Disconnect Account
                  </button>
                </div>
              </div>
            )}
          </Card>

          {/* List Card */}
          <Card className="flex-1 flex flex-col">
            <div className="p-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900 flex items-center">
                <History className="w-4 h-4 mr-2" />
                History
              </h2>
              <span className="text-xs font-medium text-gray-500 bg-white px-2 py-1 rounded-full border border-gray-200">
                {voiceNotes.length} notes
              </span>
            </div>
            
            <div className="flex-1 overflow-y-auto max-h-[500px]">
              {voiceNotes.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="bg-gray-100 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4">
                    <FileAudio className="w-6 h-6 text-gray-400" />
                  </div>
                  <p className="text-gray-500 font-medium">No notes yet</p>
                  <p className="text-gray-400 text-sm">Your recordings will appear here</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {voiceNotes.map((note) => (
                    <div
                      key={note.id}
                      ref={(el) => (noteRefs.current[note.id] = el)}
                      onClick={() => setSelectedNote(note)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setSelectedNote(note);
                        }
                      }}
                      className={cn(
                        "w-full p-4 text-left hover:bg-gray-50 transition-colors flex items-center justify-between group cursor-pointer outline-none focus:bg-gray-50",
                        selectedNote?.id === note.id && "bg-indigo-50 hover:bg-indigo-50 focus:bg-indigo-50"
                      )}
                    >
                      <div className="flex items-center space-x-3 overflow-hidden">
                        <div className={cn(
                          "w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0",
                          selectedNote?.id === note.id ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-500 group-hover:bg-white"
                        )}>
                          <FileAudio className="w-5 h-5" />
                        </div>
                        <div className="overflow-hidden">
                          <p className={cn(
                            "font-medium truncate",
                            selectedNote?.id === note.id ? "text-indigo-900" : "text-gray-900"
                          )}>
                            {note.filename}
                          </p>
                          <p className="text-xs text-gray-500 flex items-center">
                            {note.remoteJid && (
                              <span className="inline-flex items-center text-green-600 mr-2 font-bold">
                                <MessageSquare className="w-3 h-3 mr-0.5" />
                                WA
                              </span>
                            )}
                            {new Date(note.createdAt).toLocaleDateString()} • {new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                          <Tooltip text="Delete recording">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteNote(note.id);
                              }}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </Tooltip>
                        </div>
                        <ChevronRight className={cn(
                          "w-4 h-4 transition-transform",
                          selectedNote?.id === note.id ? "text-indigo-400 translate-x-1" : "text-gray-300 group-hover:translate-x-1"
                        )} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Right Column: Details */}
        <div className="flex-1">
          <AnimatePresence mode="wait">
            {selectedNote ? (
              <motion.div
                key={selectedNote.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-6"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <h2 className="text-2xl font-bold text-gray-900">{selectedNote.filename}</h2>
                    {selectedNote.remoteJid && (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-800">
                        <MessageSquare className="w-3 h-3 mr-1" />
                        WhatsApp
                      </span>
                    )}
                  </div>
                  <Tooltip text="Delete this note">
                    <Button variant="ghost" onClick={() => deleteNote(selectedNote.id)} className="text-red-500 hover:text-red-600 hover:bg-red-50">
                      <Trash2 className="w-5 h-5" />
                    </Button>
                  </Tooltip>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Summary & Key Points */}
                  <div className="space-y-6">
                    <Card className="p-6">
                      <h3 className="text-sm font-bold text-indigo-600 uppercase tracking-wider mb-3 flex items-center">
                        <CheckCircle2 className="w-4 h-4 mr-2" />
                        Summary
                      </h3>
                      <p className="text-gray-700 leading-relaxed">
                        {selectedNote.insights.summary}
                      </p>
                    </Card>

                    <Card className="p-6">
                      <h3 className="text-sm font-bold text-indigo-600 uppercase tracking-wider mb-4 flex items-center">
                        <ListTodo className="w-4 h-4 mr-2" />
                        Key Points
                      </h3>
                      <ul className="space-y-3">
                        {selectedNote.insights.key_points.map((point, i) => (
                          <li key={i} className="flex items-start">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 mt-2 mr-3 flex-shrink-0" />
                            <span className="text-gray-700">{point}</span>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  </div>

                  {/* Questions & Replies */}
                  <div className="space-y-6">
                    <Card className="p-6">
                      <h3 className="text-sm font-bold text-indigo-600 uppercase tracking-wider mb-4 flex items-center">
                        <HelpCircle className="w-4 h-4 mr-2" />
                        Questions Identified
                      </h3>
                      {selectedNote.insights.questions.length > 0 ? (
                        <ul className="space-y-3">
                          {selectedNote.insights.questions.map((q, i) => (
                            <li key={i} className="flex items-start">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-2 mr-3 flex-shrink-0" />
                              <span className="text-gray-700 italic">"{q}"</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-gray-400 text-sm italic">No specific questions found.</p>
                      )}
                    </Card>

                    <Card className="p-6 bg-indigo-50 border-indigo-100">
                      <h3 className="text-sm font-bold text-indigo-600 uppercase tracking-wider mb-4 flex items-center">
                        <MessageSquare className="w-4 h-4 mr-2" />
                        Suggested Replies
                      </h3>
                      <div className="space-y-3">
                        {selectedNote.insights.suggested_replies.map((reply, i) => {
                          // Find if this reply was sent
                          const sentMsgId = Object.keys(sentMessages).find(id => sentMessages[id].text === reply);
                          const status = sentMsgId ? sentMessages[sentMsgId].status : 0;

                          return (
                            <div key={i} className="bg-white p-3 rounded-lg border border-indigo-100 text-gray-700 text-sm shadow-sm group/reply relative">
                              {reply}
                              <div className="absolute top-2 right-2 flex items-center space-x-1 opacity-0 group-hover/reply:opacity-100 transition-opacity">
                                <Tooltip text="Copy to clipboard">
                                  <button 
                                    onClick={() => copyToClipboard(reply)}
                                    className="p-1.5 bg-indigo-50 text-indigo-600 rounded-md hover:bg-indigo-100"
                                  >
                                    <Download className="w-3.5 h-3.5 rotate-180" />
                                  </button>
                                </Tooltip>
                                
                                {selectedNote.remoteJid && (
                                  <Tooltip text={
                                    status === 0 ? "Send to WhatsApp" :
                                    status === 1 || status === 2 ? "Message Sent" :
                                    status === 3 ? "Message Delivered" :
                                    status >= 4 ? "Message Read" : "Unknown Status"
                                  }>
                                    <button 
                                      onClick={() => sendToWhatsApp(reply)}
                                      disabled={status > 0}
                                      className={cn(
                                        "p-1.5 rounded-md transition-all duration-200",
                                        status === 0 ? "bg-green-50 text-green-600 hover:bg-green-100" : 
                                        status >= 4 ? "bg-blue-50 text-blue-500" :
                                        "bg-gray-50 text-gray-400"
                                      )}
                                    >
                                      {status === 0 && <Send className="w-3.5 h-3.5" />}
                                      {(status === 1 || status === 2) && <Check className="w-3.5 h-3.5" />}
                                      {status === 3 && <CheckCheck className="w-3.5 h-3.5" />}
                                      {status >= 4 && <CheckCheck className="w-3.5 h-3.5" />}
                                    </button>
                                  </Tooltip>
                                )}
                              </div>
                              
                              {status > 0 && (
                                <div className={cn(
                                  "mt-2 flex items-center text-[10px] font-medium",
                                  status >= 4 ? "text-blue-500" : "text-gray-400"
                                )}>
                                  <span className="mr-1">Status:</span>
                                  {status === 1 && "Sent"}
                                  {status === 2 && "Sent"}
                                  {status === 3 && "Delivered"}
                                  {status >= 4 && "Read"}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </Card>
                  </div>
                </div>

                {/* Transcript */}
                <Card className="p-6">
                  <h3 className="text-sm font-bold text-indigo-600 uppercase tracking-wider mb-4">Full Transcript</h3>
                  <div className="bg-gray-50 p-4 rounded-lg border border-gray-100">
                    <p className="text-gray-600 whitespace-pre-wrap leading-relaxed italic">
                      "{selectedNote.transcript}"
                    </p>
                  </div>
                </Card>
              </motion.div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center p-12 text-center bg-white rounded-xl border border-dashed border-gray-300">
                <div className="bg-gray-50 p-6 rounded-full mb-6">
                  <Play className="w-12 h-12 text-gray-300" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-2">Select a note to view insights</h3>
                <p className="text-gray-500 max-w-xs mx-auto">
                  Choose a recording from your history to see the transcription, summary, and suggested actions.
                </p>
              </div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
    </ErrorBoundary>
  );
}
