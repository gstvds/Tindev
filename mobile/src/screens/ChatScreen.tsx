import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { ApiError } from '../api/errors';
import {
  Conversation,
  getMessages,
  getOrCreateConversation,
  Message,
  otherUserName,
} from '../api/messaging';
import { ConnectionState, useChatSocket } from '../realtime/chatSocket';
import { SafetyBanner } from '../components/SafetyBanner';
import { PrimaryButton } from '../components/PrimaryButton';
import { AppStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme';

// The conversation screen. Reached from the match overlay or the matches list,
// keyed by matchId. On open it (1) resolves the conversation via
// POST /matches/:id/conversation, (2) loads history from
// GET /conversations/:id/messages, and (3) opens the Socket.IO connection for
// live message:receive / typing / read. A standing anti-scam SafetyBanner sits
// above the thread, and connection state is shown honestly so the user knows when
// a message can't be sent.

type ChatRoute = RouteProp<AppStackParamList, 'Chat'>;
type ChatNav = NativeStackNavigationProp<AppStackParamList, 'Chat'>;

type LoadState = 'loading' | 'ready' | 'error';

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// One message bubble. `mine` decides side + colour; a flagged message carries an
// inline scam warning under it (the standing banner covers the general case, this
// pins it to the specific message the backend flagged).
function MessageBubble({ message, mine }: { message: Message; mine: boolean }) {
  return (
    <View style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowTheirs]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={styles.bubbleText}>{message.text}</Text>
        {message.flagged ? (
          <Text style={styles.flagWarning}>⚠️ Possible scam — never send money or bank details.</Text>
        ) : null}
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{formatTime(message.createdAt)}</Text>
          {mine ? (
            <Text style={styles.metaText}>{message.readAt ? ' · Read' : ' · Sent'}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function ChatScreen() {
  const route = useRoute<ChatRoute>();
  const navigation = useNavigation<ChatNav>();
  const { matchId, otherUserName: paramName } = route.params;

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [peerTyping, setPeerTyping] = useState(false);

  // Backward paging bookkeeping (older messages).
  const nextPageRef = useRef(2); // page 1 loads on open; older pages start at 2
  const hasMoreRef = useRef(false);
  const loadingOlderRef = useRef(false);

  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const otherId = conversation?.otherUser.id ?? null;
  const isMine = useCallback((m: Message) => m.senderId !== otherId, [otherId]);

  // --- Socket wiring ------------------------------------------------------
  // Handlers are recreated each render (capturing the latest conversation), and
  // the hook keeps a ref to them so the socket itself opens only once.
  const socket = useChatSocket({
    onMessage: (m) => {
      const conv = conversation;
      if (!conv || m.conversationId !== conv.id) return; // not this thread
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [m, ...prev]));
      // The peer sent to me → mark the thread read so their bubbles flip to Read.
      if (m.senderId === conv.otherUser.id) socket.markRead(conv.id);
    },
    onTyping: (e) => {
      const conv = conversation;
      if (!conv || e.conversationId !== conv.id) return;
      if (e.userId === conv.otherUser.id) setPeerTyping(e.isTyping);
    },
    onRead: (e) => {
      const conv = conversation;
      if (!conv || e.conversationId !== conv.id) return;
      // The peer read MY messages → stamp readAt on my unread ones.
      if (e.readerId !== conv.otherUser.id) return;
      setMessages((prev) =>
        prev.map((m) => (m.senderId !== conv.otherUser.id && !m.readAt ? { ...m, readAt: e.readAt } : m)),
      );
    },
  });

  // --- Open: resolve conversation + load first page of history ------------
  const open = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const conv = await getOrCreateConversation(matchId);
      const page = await getMessages(conv.id, 1);
      setConversation(conv);
      setMessages(page.messages); // already newest-first — matches the inverted list
      hasMoreRef.current = page.hasMore;
      nextPageRef.current = 2;
      setLoadState('ready');
    } catch (e) {
      const err = e as ApiError;
      setLoadError(err.message);
      setLoadState('error');
    }
  }, [matchId]);

  useEffect(() => {
    void open();
  }, [open]);

  // Title: show the passed-in name immediately, then the resolved one.
  useLayoutEffect(() => {
    const title = conversation ? otherUserName(conversation.otherUser) : paramName || 'Chat';
    navigation.setOptions({ title });
  }, [navigation, conversation, paramName]);

  // Once connected with a resolved thread, mark it read (clears the peer's unread
  // count for messages already in the history we just loaded). `markRead` is a
  // stable callback and `connectionState` only changes on a real transition, so
  // this fires on connect / thread-resolve rather than on every render.
  const { connectionState, markRead } = socket;
  useEffect(() => {
    if (loadState === 'ready' && conversation && connectionState === 'connected') {
      markRead(conversation.id);
    }
  }, [loadState, conversation, connectionState, markRead]);

  // Clean up the typing debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, []);

  const loadOlder = useCallback(async () => {
    const conv = conversation;
    if (!conv || loadingOlderRef.current || !hasMoreRef.current) return;
    loadingOlderRef.current = true;
    try {
      const page = await getMessages(conv.id, nextPageRef.current);
      nextPageRef.current += 1;
      hasMoreRef.current = page.hasMore;
      // Older messages go on the END of the newest-first array.
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...page.messages.filter((m) => !seen.has(m.id))];
      });
    } catch {
      // A failed older-page fetch leaves the thread usable; the next scroll retries.
    } finally {
      loadingOlderRef.current = false;
    }
  }, [conversation]);

  function onChangeInput(text: string) {
    setInput(text);
    const conv = conversation;
    if (!conv) return;
    socket.setTyping(conv.id, true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => socket.setTyping(conv.id, false), 2000);
  }

  async function handleSend() {
    const text = input.trim();
    const conv = conversation;
    if (!text || !conv || sending) return;
    setSending(true);
    setSendError(null);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    socket.setTyping(conv.id, false);
    try {
      const msg = await socket.sendMessage(conv.id, text);
      setMessages((prev) => (prev.some((x) => x.id === msg.id) ? prev : [msg, ...prev]));
      setInput('');
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Failed to send message.');
    } finally {
      setSending(false);
    }
  }

  // --- Full-screen states -------------------------------------------------
  if (loadState === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (loadState === 'error') {
    return (
      <View style={styles.stateContainer}>
        <View style={styles.stateContent}>
          <Text style={styles.stateTitle}>Couldn’t open this chat</Text>
          <Text style={styles.stateText}>{loadError}</Text>
        </View>
        <PrimaryButton title="Try again" onPress={() => void open()} />
      </View>
    );
  }

  const connected = connectionState === 'connected';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <SafetyBanner />

      <ConnectionNotice state={connectionState} />

      <FlatList
        inverted
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <MessageBubble message={item} mine={isMine(item)} />}
        contentContainerStyle={styles.listContent}
        onEndReached={() => void loadOlder()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          <View style={styles.emptyThread}>
            <Text style={styles.emptyText}>
              Say hello 👋 This is the start of your conversation.
            </Text>
          </View>
        }
      />

      {peerTyping ? <Text style={styles.typing}>Typing…</Text> : null}

      {sendError ? (
        <View style={styles.sendErrorBanner}>
          <Text style={styles.sendErrorText}>{sendError}</Text>
        </View>
      ) : null}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={onChangeInput}
          placeholder={connected ? 'Message…' : 'Reconnecting…'}
          placeholderTextColor={colors.textMuted}
          multiline
          editable={connected}
        />
        <Pressable
          onPress={() => void handleSend()}
          disabled={!connected || !input.trim() || sending}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          style={({ pressed }) => [
            styles.sendBtn,
            (!connected || !input.trim() || sending) && styles.sendBtnDisabled,
            pressed && styles.sendBtnPressed,
          ]}
        >
          {sending ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.sendLabel}>Send</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

// A thin bar that appears only when the socket isn't connected, so a dropped
// connection is never silent.
function ConnectionNotice({ state }: { state: ConnectionState }) {
  if (state === 'connected') return null;
  const connecting = state === 'connecting';
  return (
    <View style={[styles.connBar, connecting ? styles.connConnecting : styles.connOffline]}>
      <Text style={connecting ? styles.connConnectingText : styles.connOfflineText}>
        {connecting ? 'Connecting…' : 'You’re offline. Messages will send once you reconnect.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  listContent: {
    padding: spacing.md,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  emptyThread: {
    // The list is inverted, so flip the empty state upright.
    transform: [{ scaleY: -1 }],
    alignItems: 'center',
    paddingVertical: spacing.xl,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
  },
  bubbleRow: {
    flexDirection: 'row',
    marginVertical: spacing.xs,
  },
  rowMine: {
    justifyContent: 'flex-end',
  },
  rowTheirs: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubbleMine: {
    backgroundColor: colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleTheirs: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 20,
  },
  flagWarning: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  metaRow: {
    flexDirection: 'row',
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  metaText: {
    color: colors.textMuted,
    fontSize: 11,
  },
  typing: {
    color: colors.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
  },
  connBar: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  connConnecting: {
    backgroundColor: colors.surface,
  },
  connConnectingText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  connOffline: {
    backgroundColor: 'rgba(255, 107, 107, 0.15)',
  },
  connOfflineText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '600',
  },
  sendErrorBanner: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.xs,
    padding: spacing.sm,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 107, 107, 0.12)',
    borderWidth: 1,
    borderColor: colors.danger,
  },
  sendErrorText: {
    color: colors.danger,
    fontSize: 13,
    textAlign: 'center',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
  },
  sendBtn: {
    borderRadius: 12,
    backgroundColor: colors.primary,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    backgroundColor: colors.primaryDisabled,
  },
  sendBtnPressed: {
    opacity: 0.85,
  },
  sendLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  stateContainer: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    justifyContent: 'space-between',
  },
  stateContent: {
    flex: 1,
    justifyContent: 'center',
  },
  stateTitle: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
  },
  stateText: {
    color: colors.textMuted,
    fontSize: 15,
    marginTop: spacing.sm,
    lineHeight: 22,
  },
});
