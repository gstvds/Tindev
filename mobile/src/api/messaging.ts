import { apiClient } from './client';
import { VerificationTier } from './discovery';

// Typed wrappers around the chat REST endpoints the chat + matches screens need:
//   POST /matches/:id/conversation  — get-or-create the thread for a match
//   GET  /conversations/:id/messages — paginated history (newest first)
//   GET  /matches                    — the user's active matches
// Real-time delivery (message:receive / typing / read) rides the Socket.IO
// connection in ../realtime/chatSocket; this file is the request/response half.
// All three are authenticated; the shared client attaches the bearer token.

// A photo as returned inside another user's PUBLIC profile on match/conversation
// payloads. Same subdoc as ProfilePhoto but we only read url + isPrimary here.
export type PublicPhoto = {
  url: string;
  isPrimary: boolean;
};

// The subset of the other participant's public profile the chat UI reads. The
// backend strips discoverySettings before returning it (ConversationController /
// MatchController.publicProfile), and it can be null if they never set one up.
export type OtherUserProfile = {
  userId: string;
  name?: string | null;
  photos?: PublicPhoto[];
} | null;

// The "other" side of a match/conversation, with their derived verificationTier
// (spec §4.7 — always present, even when null, so the chat can show the badge).
export type OtherUser = {
  id: string;
  verificationTier: VerificationTier;
  profile: OtherUserProfile;
};

// One chat message. Identical shape whether it arrives from REST history or the
// socket (backend serialize()), so a fetched and a live message render the same.
// `senderId` is the only identity we need: in a two-person thread a message is
// "mine" exactly when senderId !== otherUser.id.
export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
  flagged: boolean; // anti-scam heuristic tripped (never blocks — see SafetyBanner)
  readAt: string | null; // ISO date once the peer has read it, else null
  createdAt: string; // ISO date, server timestamp
};

// A chat thread, as returned by POST /matches/:id/conversation. `id` is the
// conversationId every messaging op is keyed on.
export type Conversation = {
  id: string;
  matchId: string;
  lastMessageAt: string;
  otherUser: OtherUser;
};

// One entry of GET /matches — the matchId is `id`; opening a chat resolves it to
// a conversation via getOrCreateConversation.
export type MatchSummary = {
  id: string;
  matchedAt: string;
  status: 'active' | 'unmatched';
  otherUser: OtherUser;
};

// POST /matches/:id/conversation — get-or-create the conversation for a match the
// caller is part of. Idempotent server-side (201 first time, 200 after); we don't
// distinguish, we just need the thread. 404s (as an ApiError) if the match isn't
// the caller's — the chat screen surfaces that as a load error.
export async function getOrCreateConversation(matchId: string): Promise<Conversation> {
  const { data } = await apiClient.post<{ conversation: Conversation }>(
    `/matches/${matchId}/conversation`,
  );
  return data.conversation;
}

// GET /conversations/:id/messages — one page of history, newest first. `hasMore`
// lets the chat page backwards (older messages) without a count query.
export type MessagesPage = {
  page: number;
  limit: number;
  hasMore: boolean;
  messages: Message[];
};

export async function getMessages(conversationId: string, page = 1): Promise<MessagesPage> {
  const { data } = await apiClient.get<MessagesPage>(
    `/conversations/${conversationId}/messages`,
    { params: { page } },
  );
  return data;
}

// GET /matches — the caller's active matches, newest first. Drives the matches
// list; each row opens a chat by its match id.
export async function listMatches(): Promise<MatchSummary[]> {
  const { data } = await apiClient.get<{ matches: MatchSummary[] }>('/matches');
  return data.matches;
}

// The other user's primary photo url (backend guarantees exactly one primary),
// falling back to the first photo, or null when they have none.
export function otherUserPhotoUrl(other: OtherUser | null | undefined): string | null {
  const photos = other?.profile?.photos ?? [];
  if (photos.length === 0) return null;
  return (photos.find((p) => p.isPrimary) ?? photos[0]).url;
}

// A display name for the other user, with a sensible fallback.
export function otherUserName(other: OtherUser | null | undefined): string {
  return other?.profile?.name?.trim() || 'Your match';
}
