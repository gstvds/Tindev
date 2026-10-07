import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { ApiError } from '../api/errors';
import {
  Candidate,
  getDiscovery,
  postSwipe,
  SwipeAction,
  VerificationTier,
} from '../api/discovery';
import { PrimaryButton } from '../components/PrimaryButton';
import { AppStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme';

// A formed match we can act on: the candidate to show in the confirmation, plus
// the matchId the "Send a message" button needs to open the chat.
type MatchedState = { candidate: Candidate; matchId: string };

type DiscoveryNav = NativeStackNavigationProp<AppStackParamList, 'Home'>;

// The real Home experience: a one-card-at-a-time discovery feed. Candidates come
// from GET /discovery (paged); Pass/Like buttons POST /swipes; a mutual like
// (isMatch) surfaces a match confirmation before moving on. No gesture physics
// yet — buttons only; swipe-to-decide can be a later polish pass.

// Compute whole years from an ISO dob. Returns null for missing/unparseable
// dates or nonsense ages so the card can just omit "age" rather than show junk.
function ageFromDob(dob?: string): number | null {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const monthDelta = now.getMonth() - born.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < born.getDate())) age -= 1;
  if (age < 13 || age > 120) return null;
  return age;
}

// The primary photo's URL (backend guarantees exactly one primary), falling back
// to the first photo, or null when a candidate somehow has none.
function primaryPhotoUrl(candidate: Candidate): string | null {
  const photos = candidate.photos ?? [];
  if (photos.length === 0) return null;
  return (photos.find((p) => p.isPrimary) ?? photos[0]).url;
}

// The trust signal. Discovery only returns phone-verified-or-better users, so
// `null` shouldn't occur — we still handle it (render nothing) rather than assert.
function VerificationBadge({ tier }: { tier: VerificationTier }) {
  if (tier !== 'phone' && tier !== 'nin') return null;
  const isNin = tier === 'nin';
  return (
    <View style={[styles.badge, isNin ? styles.badgeNin : styles.badgePhone]}>
      <Text style={[styles.badgeText, isNin ? styles.badgeTextNin : styles.badgeTextPhone]}>
        {isNin ? '✓✓ NIN Verified' : '✓ Phone Verified'}
      </Text>
    </View>
  );
}

type Screen = 'loading' | 'ready' | 'error';

export function DiscoveryScreen() {
  const { height } = useWindowDimensions();
  const photoHeight = Math.round(height * 0.42);
  const navigation = useNavigation<DiscoveryNav>();

  // The loaded deck and a cursor into it. We keep swiped cards in the array and
  // just advance the cursor — simpler than splicing, and the backend already
  // excludes swiped users from later pages so there's no risk of re-showing them.
  const [deck, setDeck] = useState<Candidate[]>([]);
  const [cursor, setCursor] = useState(0);
  const [screen, setScreen] = useState<Screen>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Paging bookkeeping. `hasMore` mirrors the server flag; `loadingMore` guards
  // against firing two page fetches at once (prefetch + exhaustion).
  const nextPageRef = useRef(1);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // In-flight swipe + any resulting match to confirm, and a transient banner for
  // a swipe that failed (so we don't advance past an un-recorded decision).
  const [swiping, setSwiping] = useState(false);
  const [matched, setMatched] = useState<MatchedState | null>(null);
  const [swipeError, setSwipeError] = useState<string | null>(null);

  const current: Candidate | undefined = deck[cursor];

  // Fetch the next page and append it. Used both for the very first load (reset)
  // and for prefetching as the user nears the end of the loaded deck.
  const loadNextPage = useCallback(async (reset: boolean) => {
    if (loadingMoreRef.current) return;
    if (!reset && !hasMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    if (reset) {
      nextPageRef.current = 1;
      hasMoreRef.current = true;
      setScreen('loading');
      setErrorMessage(null);
    }
    try {
      const res = await getDiscovery(nextPageRef.current);
      nextPageRef.current += 1;
      hasMoreRef.current = res.hasMore;
      setDeck((prev) => (reset ? res.candidates : [...prev, ...res.candidates]));
      if (reset) setCursor(0);
      setScreen('ready');
    } catch (e) {
      const err = e as ApiError;
      // A failed first load is a full-screen retriable error; a failed prefetch
      // leaves the current deck usable, so we swallow it and let the next
      // advance retry (hasMore is untouched).
      if (reset) {
        setErrorMessage(err.message);
        setScreen('error');
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void loadNextPage(true);
  }, [loadNextPage]);

  // Prefetch the next page once the user is within two cards of the end, so the
  // deck rarely runs dry between decisions.
  useEffect(() => {
    if (screen !== 'ready') return;
    if (hasMoreRef.current && cursor >= deck.length - 2) {
      void loadNextPage(false);
    }
  }, [cursor, deck.length, screen, loadNextPage]);

  async function decide(action: SwipeAction) {
    if (!current || swiping) return;
    setSwiping(true);
    setSwipeError(null);
    try {
      const res = await postSwipe(current.userId, action);
      // Show the match confirmation for a mutual like, then advance either way so
      // dismissing the confirmation reveals the next card. Capture the matchId from
      // the swipe response — the overlay's "Send a message" needs it to open a chat.
      if (res.isMatch && res.match) setMatched({ candidate: current, matchId: res.match._id });
      setCursor((c) => c + 1);
    } catch (e) {
      const err = e as ApiError;
      setSwipeError(err.message);
    } finally {
      setSwiping(false);
    }
  }

  // --- Full-screen states -------------------------------------------------

  if (screen === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (screen === 'error') {
    return (
      <View style={styles.stateContainer}>
        <View style={styles.stateContent}>
          <Text style={styles.stateTitle}>Couldn’t load discovery</Text>
          <Text style={styles.stateText}>{errorMessage}</Text>
        </View>
        <PrimaryButton title="Try again" onPress={() => void loadNextPage(true)} />
      </View>
    );
  }

  // The match overlay is rendered in the shared tail return below — NOT inside
  // the has-a-card branch. A like can both form a match AND advance past the last
  // card in the same decision: `decide` calls setMatched(current) and
  // setCursor(c+1) together, so on the next render `current` is undefined and the
  // deck-exhausted body shows. If the overlay lived only in the card branch, that
  // `!current` path would pre-empt it and the "It's a match!" screen would never
  // appear (the deck would just drop to the empty state — the reported bug).
  let body: React.ReactNode;
  if (!current) {
    // Deck exhausted. If more pages are still loading, show a spinner; otherwise
    // it's a genuine empty pool — a clear message with a refresh, not a blank.
    if (loadingMore || hasMoreRef.current) {
      body = (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      );
    } else {
      body = (
        <View style={styles.stateContainer}>
          <View style={styles.stateContent}>
            <Text style={styles.stateTitle}>You’re all caught up</Text>
            <Text style={styles.stateText}>
              There’s no one new to show right now. Check back a little later — new
              people join all the time.
            </Text>
          </View>
          <PrimaryButton title="Refresh" onPress={() => void loadNextPage(true)} />
        </View>
      );
    }
  } else {
    // --- The card ---------------------------------------------------------
    const age = ageFromDob(current.dob);
    const photoUrl = primaryPhotoUrl(current);
    const location = [current.lga, current.state].filter(Boolean).join(', ');

    body = (
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.card}>
            <View style={[styles.photoWrap, { height: photoHeight }]}>
              {photoUrl ? (
                <Image source={{ uri: photoUrl }} style={styles.photo} />
              ) : (
                <View style={[styles.photo, styles.photoPlaceholder]}>
                  <Text style={styles.photoPlaceholderText}>No photo</Text>
                </View>
              )}
              <View style={styles.badgeOverlay}>
                <VerificationBadge tier={current.user.verificationTier} />
              </View>
            </View>

            <View style={styles.info}>
              <Text style={styles.name}>
                {current.name ?? 'Someone'}
                {age !== null ? <Text style={styles.age}>, {age}</Text> : null}
              </Text>
              {location ? <Text style={styles.location}>{location}</Text> : null}

              {current.bio ? <Text style={styles.bio}>{current.bio}</Text> : null}

              {current.interests && current.interests.length > 0 ? (
                <View style={styles.interests}>
                  {current.interests.map((interest) => (
                    <View key={interest} style={styles.interestChip}>
                      <Text style={styles.interestText}>{interest}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </View>
        </ScrollView>

        {swipeError ? (
          <View style={styles.swipeErrorBanner}>
            <Text style={styles.swipeErrorText}>{swipeError}</Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            onPress={() => void decide('pass')}
            disabled={swiping}
            accessibilityRole="button"
            accessibilityLabel="Pass"
            style={({ pressed }) => [
              styles.actionBtn,
              styles.passBtn,
              swiping && styles.actionDisabled,
              pressed && !swiping && styles.pressed,
            ]}
          >
            <Text style={[styles.actionLabel, styles.passLabel]}>Pass</Text>
          </Pressable>
          <Pressable
            onPress={() => void decide('like')}
            disabled={swiping}
            accessibilityRole="button"
            accessibilityLabel="Like"
            style={({ pressed }) => [
              styles.actionBtn,
              styles.likeBtn,
              swiping && styles.actionDisabled,
              pressed && !swiping && styles.pressed,
            ]}
          >
            {swiping ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <Text style={[styles.actionLabel, styles.likeLabel]}>Like</Text>
            )}
          </Pressable>
        </View>
      </View>
    );
  }

  // Body (card / spinner / empty) with the match confirmation layered on top,
  // regardless of deck state, so a match that also empties the deck still shows.
  return (
    <>
      {body}
      {matched ? (
        <MatchOverlay
          candidate={matched.candidate}
          onDismiss={() => setMatched(null)}
          onSendMessage={() => {
            const { candidate, matchId } = matched;
            setMatched(null);
            navigation.navigate('Chat', {
              matchId,
              otherUserName: candidate.name,
              otherUserPhotoUrl: primaryPhotoUrl(candidate),
            });
          }}
        />
      ) : null}
    </>
  );
}

// A simple full-screen match confirmation shown over the deck when a like is
// mutual. "Send a message" opens the chat for this match; "Keep swiping" dismisses
// and returns to the next card underneath.
function MatchOverlay({
  candidate,
  onDismiss,
  onSendMessage,
}: {
  candidate: Candidate;
  onDismiss: () => void;
  onSendMessage: () => void;
}) {
  const photoUrl = primaryPhotoUrl(candidate);
  return (
    <View style={styles.matchOverlay}>
      <Text style={styles.matchTitle}>It’s a match! 🎉</Text>
      <Text style={styles.matchSubtitle}>
        You and {candidate.name ?? 'this person'} liked each other.
      </Text>
      {photoUrl ? <Image source={{ uri: photoUrl }} style={styles.matchPhoto} /> : null}
      <View style={styles.matchButton}>
        <PrimaryButton title="Send a message" onPress={onSendMessage} />
      </View>
      <Pressable
        onPress={onDismiss}
        hitSlop={8}
        accessibilityRole="button"
        style={styles.matchSecondary}
      >
        <Text style={styles.matchSecondaryText}>Keep swiping</Text>
      </Pressable>
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
  scroll: {
    padding: spacing.lg,
    paddingBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  photoWrap: {
    width: '100%',
    backgroundColor: colors.background,
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  photoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoPlaceholderText: {
    color: colors.textMuted,
    fontSize: 15,
  },
  badgeOverlay: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  badgeNin: {
    backgroundColor: colors.primary,
  },
  badgePhone: {
    backgroundColor: 'rgba(11, 18, 32, 0.75)',
    borderWidth: 1,
    borderColor: colors.border,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '800',
  },
  badgeTextNin: {
    color: colors.text,
  },
  badgeTextPhone: {
    color: colors.text,
  },
  info: {
    padding: spacing.md,
  },
  name: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
  },
  age: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '400',
  },
  location: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: spacing.xs,
  },
  bio: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    marginTop: spacing.md,
  },
  interests: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  interestChip: {
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  interestText: {
    color: colors.textMuted,
    fontSize: 13,
  },
  swipeErrorBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.sm,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 107, 107, 0.12)',
    borderWidth: 1,
    borderColor: colors.danger,
  },
  swipeErrorText: {
    color: colors.danger,
    fontSize: 13,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionBtn: {
    flex: 1,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  passBtn: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  likeBtn: {
    backgroundColor: colors.primary,
  },
  actionDisabled: {
    opacity: 0.6,
  },
  pressed: {
    opacity: 0.85,
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: '700',
  },
  passLabel: {
    color: colors.textMuted,
  },
  likeLabel: {
    color: colors.text,
  },
  // Shared full-screen state (error / empty pool) layout.
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
  matchOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(11, 18, 32, 0.96)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  matchTitle: {
    color: colors.primary,
    fontSize: 32,
    fontWeight: '800',
    textAlign: 'center',
  },
  matchSubtitle: {
    color: colors.text,
    fontSize: 16,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 22,
  },
  matchPhoto: {
    width: 160,
    height: 160,
    borderRadius: 80,
    marginTop: spacing.xl,
    borderWidth: 2,
    borderColor: colors.primary,
  },
  matchButton: {
    alignSelf: 'stretch',
    marginTop: spacing.xl,
  },
  matchSecondary: {
    marginTop: spacing.md,
    padding: spacing.sm,
  },
  matchSecondaryText: {
    color: colors.textMuted,
    fontSize: 15,
    fontWeight: '700',
  },
});
