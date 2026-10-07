import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';

import { requestOtp } from '../api/auth';
import { ApiError } from '../api/errors';
import { PrimaryButton } from '../components/PrimaryButton';
import { AuthStackParamList } from '../navigation/types';
import { colors, spacing } from '../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'PhoneEntry'>;

// Accepts the same local formats the backend normalizes (08012345678, +234…,
// 234…). This is a light client-side pre-check only to avoid an obviously-bad
// round trip; the backend's normalizePhone is the source of truth.
function looksLikeNgPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) return digits.length === 11;
  if (digits.startsWith('234')) return digits.length === 13;
  return digits.length === 10; // bare subscriber number
}

export function PhoneEntryScreen({ navigation }: Props) {
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = looksLikeNgPhone(phone) && !submitting;

  async function onSubmit() {
    setError(null);

    if (!looksLikeNgPhone(phone)) {
      setError('Enter a valid Nigerian phone number, e.g. 0801 234 5678.');
      return;
    }

    setSubmitting(true);
    try {
      // Use the backend-normalized phone (234…) for the next screen so verify
      // sends exactly what request recorded.
      const { phone: normalized } = await requestOtp(phone.trim());
      navigation.navigate('OtpEntry', { phone: normalized });
    } catch (e) {
      const err = e as ApiError;
      // 400 invalid format, 429 cooldown/cap, 502 SMS failure, network — the
      // backend's own message is user-facing and specific, so show it directly.
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.content}>
        <Text style={styles.title}>What's your number?</Text>
        <Text style={styles.subtitle}>
          We'll text you a 6-digit code to verify your phone.
        </Text>

        <TextInput
          style={styles.input}
          value={phone}
          onChangeText={(t) => {
            setPhone(t);
            if (error) setError(null);
          }}
          placeholder="0801 234 5678"
          placeholderTextColor={colors.textMuted}
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          returnKeyType="done"
          onSubmitEditing={onSubmit}
          editable={!submitting}
          maxLength={20}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <PrimaryButton
        title="Send code"
        onPress={onSubmit}
        loading={submitting}
        disabled={!canSubmit}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
    justifyContent: 'space-between',
  },
  content: {
    marginTop: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 15,
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 18,
    color: colors.text,
  },
  error: {
    color: colors.danger,
    marginTop: spacing.md,
    fontSize: 14,
  },
});
