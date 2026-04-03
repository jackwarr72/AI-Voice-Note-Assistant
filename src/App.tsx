import React, { useState, useEffect, useRef, Component } from 'react';
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
  Plus
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
  getDoc
} from 'firebase/firestore';
import { auth, db, googleProvider } from './firebase';
import { VoiceNote, AudioInsights } from './types';
import { processAudioWithGemini } from './lib/gemini';
import { cn } from './lib/utils';

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

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingMessage, setProcessingMessage] = useState('Analyzing with Gemini...');
  const [selectedNote, setSelectedNote] = useState<VoiceNote | null>(null);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

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
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const notes = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as VoiceNote));
      setVoiceNotes(notes);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
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
      alert('Could not access microphone. Please check permissions.');
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
        alert('Please upload an audio file.');
        return;
      }
      processAudio(file, file.name);
    }
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const processAudio = async (blob: Blob, filename: string) => {
    if (!user) return;
    setIsProcessing(true);
    
    try {
      // Convert blob to base64
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
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
          handleFirestoreError(error, OperationType.CREATE, path);
        }
        
        setIsProcessing(false);
      };
    } catch (error) {
      console.error('Error processing audio:', error);
      setIsProcessing(false);
      alert('Failed to process audio. Please try again.');
    }
  };

  const deleteNote = async (id: string) => {
    if (!confirm('Are you sure you want to delete this note?')) return;
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
    <div className="min-h-screen bg-gray-50 flex flex-col">
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
            <Button variant="ghost" onClick={exportToCSV} disabled={voiceNotes.length === 0} className="hidden sm:flex">
              <Download className="w-4 h-4 mr-2" />
              Export CSV
            </Button>
            <div className="h-8 w-px bg-gray-200 hidden sm:block"></div>
            <div className="flex items-center space-x-3">
              <img src={user.photoURL || ''} alt="" className="w-8 h-8 rounded-full border border-gray-200" />
              <Button variant="ghost" onClick={handleLogout} className="p-2">
                <LogOut className="w-5 h-5" />
              </Button>
            </div>
          </div>
        </div>
      </header>

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
                <Button 
                  variant="secondary" 
                  className="w-full bg-indigo-500/20 border-indigo-400/30 text-white hover:bg-indigo-500/40"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isRecording || isProcessing}
                >
                  <Download className="w-4 h-4 mr-2 rotate-180" />
                  Upload Audio File
                </Button>
              </div>
            </div>
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
                    <button
                      key={note.id}
                      onClick={() => setSelectedNote(note)}
                      className={cn(
                        "w-full p-4 text-left hover:bg-gray-50 transition-colors flex items-center justify-between group",
                        selectedNote?.id === note.id && "bg-indigo-50 hover:bg-indigo-50"
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
                          <p className="text-xs text-gray-500">
                            {new Date(note.createdAt).toLocaleDateString()} • {new Date(note.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className={cn(
                        "w-4 h-4 transition-transform",
                        selectedNote?.id === note.id ? "text-indigo-400 translate-x-1" : "text-gray-300 group-hover:translate-x-1"
                      )} />
                    </button>
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
                  <h2 className="text-2xl font-bold text-gray-900">{selectedNote.filename}</h2>
                  <Button variant="ghost" onClick={() => deleteNote(selectedNote.id)} className="text-red-500 hover:text-red-600 hover:bg-red-50">
                    <Trash2 className="w-5 h-5" />
                  </Button>
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
                        {selectedNote.insights.suggested_replies.map((reply, i) => (
                          <div key={i} className="bg-white p-3 rounded-lg border border-indigo-100 text-gray-700 text-sm shadow-sm">
                            {reply}
                          </div>
                        ))}
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
  );
}
