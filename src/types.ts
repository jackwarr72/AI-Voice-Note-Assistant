export interface AudioInsights {
  summary: string;
  key_points: string[];
  questions: string[];
  suggested_replies: string[];
}

export interface VoiceNote {
  id: string;
  userId: string;
  filename: string;
  transcript: string;
  insights: AudioInsights;
  createdAt: string; // ISO 8601
  audioUrl?: string; // If we store it in Storage, but for now we'll just process it
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string;
  role: 'user' | 'admin';
}
