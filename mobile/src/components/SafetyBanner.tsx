import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../theme';

// The standing anti-scam reminder shown at the top of every chat (brand mockup:
// "Never send money to a match"). It is ALWAYS visible — deliberately not tied to
// a flagged message — because the most damaging asks arrive wrapped in a warm,
// trusting conversation. Non-dismissible for this slice; it's a small, permanent
// safety rail, not a one-time notice.
export function SafetyBanner() {
  return (
    <View style={styles.banner} accessibilityRole="alert">
      <Text style={styles.icon}>🛡️</Text>
      <View style={styles.textWrap}>
        <Text style={styles.title}>Never send money to a match</Text>
        <Text style={styles.body}>
          Not even to a verified one. Requests for cash, gift cards, crypto, or bank
          details are how scams start — report anyone who asks.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    padding: spacing.md,
    borderRadius: 12,
    // A warm, on-brand tint (primary orange) rather than alarm red — it's a
    // standing reminder, present every time, not an error state.
    backgroundColor: 'rgba(240, 96, 58, 0.12)',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  icon: {
    fontSize: 18,
    lineHeight: 22,
  },
  textWrap: {
    flex: 1,
  },
  title: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '800',
  },
  body: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
});
