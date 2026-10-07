import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { ApiError } from '../api/errors';
import {
  listMatches,
  MatchSummary,
  otherUserName,
  otherUserPhotoUrl,
} from '../api/messaging';
import { PrimaryButton } from '../components/PrimaryButton';
import { AppStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme';

// A minimal list of the user's active matches (GET /matches). Each row opens the
// chat for that match. Deliberately lightweight — no last-message previews or
// unread counts (those would need the conversations list); this exists so a match
// dismissed from the overlay is still reachable.

type MatchesNav = NativeStackNavigationProp<AppStackParamList, 'Matches'>;

type LoadState = 'loading' | 'ready' | 'error';

function MatchRow({ match, onPress }: { match: MatchSummary; onPress: () => void }) {
  const name = otherUserName(match.otherUser);
  const photoUrl = otherUserPhotoUrl(match.otherUser);
  const isNin = match.otherUser.verificationTier === 'nin';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {photoUrl ? (
        <Image source={{ uri: photoUrl }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarPlaceholder]}>
          <Text style={styles.avatarInitial}>{name.charAt(0).toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.rowText}>
        <Text style={styles.rowName}>{name}</Text>
        <Text style={styles.rowHint}>
          {isNin ? '✓✓ NIN verified' : '✓ Phone verified'} · Tap to chat
        </Text>
      </View>
    </Pressable>
  );
}

export function MatchesScreen() {
  const navigation = useNavigation<MatchesNav>();
  const [state, setState] = useState<LoadState>('loading');
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setErrorMessage(null);
    try {
      const result = await listMatches();
      setMatches(result);
      setState('ready');
    } catch (e) {
      const err = e as ApiError;
      setErrorMessage(err.message);
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openChat = useCallback(
    (match: MatchSummary) => {
      navigation.navigate('Chat', {
        matchId: match.id,
        otherUserName: otherUserName(match.otherUser),
        otherUserPhotoUrl: otherUserPhotoUrl(match.otherUser),
      });
    },
    [navigation],
  );

  if (state === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={styles.stateContainer}>
        <View style={styles.stateContent}>
          <Text style={styles.stateTitle}>Couldn’t load your matches</Text>
          <Text style={styles.stateText}>{errorMessage}</Text>
        </View>
        <PrimaryButton title="Try again" onPress={() => void load()} />
      </View>
    );
  }

  if (matches.length === 0) {
    return (
      <View style={styles.stateContainer}>
        <View style={styles.stateContent}>
          <Text style={styles.stateTitle}>No matches yet</Text>
          <Text style={styles.stateText}>
            When you and someone else like each other, they’ll show up here. Keep
            swiping in Discover.
          </Text>
        </View>
        <PrimaryButton title="Refresh" onPress={() => void load()} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.list}
      data={matches}
      keyExtractor={(m) => m.id}
      renderItem={({ item }) => <MatchRow match={item} onPress={() => openChat(item)} />}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      contentContainerStyle={styles.listContent}
    />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  list: {
    flex: 1,
    backgroundColor: colors.background,
  },
  listContent: {
    padding: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowPressed: {
    opacity: 0.7,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.surface,
  },
  avatarPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatarInitial: {
    color: colors.textMuted,
    fontSize: 22,
    fontWeight: '800',
  },
  rowText: {
    flex: 1,
  },
  rowName: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  rowHint: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
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
